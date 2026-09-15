import { registerAssistant } from "./assistant.ts";
import type { ModelTransport } from "./assistant-model.ts";
import { projectCatalogUnitNames } from "../../../packages/db/src/room-catalog-labels.ts";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { version as applicationVersion } from "../../../package.json";
import compress from "@fastify/compress";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { registerPmsIntegration } from "./integration.ts";
import { registerExternalPayments } from "./external-payments.ts";
import { registerAccountManagement } from "./account-management.ts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import Fastify, { type FastifyRequest } from "fastify";
import type { Kysely, Transaction } from "kysely";
import {
  commandCapabilities,
  commandCatalogTypes,
  currentReleaseFeatures,
  DomainError,
  type CommandEnvelope,
  type AuthPrincipal,
  type CommandCapability,
  type CommandCatalogType,
  type CreateQuoteCommandInputDto,
  type InventoryUnitKind,
  type RoomStatusBoardQueryDto,
  type HistoricalRecoverableCommandType
} from "@qintopia/contracts";
import { humanGrantableCommandTypes, stableHash } from "@qintopia/domain";
import {
  createCommandPreview,
  databaseReady,
  executeQuoteCommand,
  findCommandResult,
  getCommand,
  getMemberView,
  getOrderView,
  listOrders,
  type OrderListQuery,
  getReceipt,
  getRoomStatusBoard,
  listAvailability,
  listMemberPage,
  loadReferenceCatalog,
  propertyLocalToday,
  projectStoredPreviewForRead,
  auditCommandResourceNotFound,
  authorizeCommandAccess,
  writeSecurityAuthorizationAudit,
  withCommandAuthorizationAudit,
  resolveCommandResult,
  confirmCommandPreview,
  type ConfirmRequest,
  type Database
} from "@qintopia/db";
import {
  isKnownCredentialAuthenticationError,
  login,
  logout,
  requirePrincipal,
  requirePropertyAccess,
  requireScopedResourceAccess
} from "./auth.ts";
import {
  AuditResponseSchema,
  AvailabilityUnitSchema,
  CommandEnvelopeSchema,
  HistoricalCommandPreviewResponseSchema,
  HistoricalCommandResultRecoverySchema,
  ConfirmSchema,
  ErrorResponse,
  FactResponseSchema,
  HistoricalCreateOrderReplayEnvelopeSchema,
  Id,
  IdParams,
  LocalDate,
  LoginResponseSchema,
  LoginSchema,
  MaintenanceLocksQuerySchema,
  MaintenanceLocksResponseSchema,
  MeResponseSchema,
  MemberResponseSchema,
  MembersListResponseSchema,
  MembersQuerySchema,
  MetaResponseSchema,
  OrderDetailResponseSchema,
  OrderStatusSchema,
  OrdersListResponseSchema,
  OrdersQuerySchema,
  PreviewParams,
  QuoteRequestSchema,
  QuoteCommandResponseSchema,
  ReferenceCatalogResponseSchema,
  HistoricalReceiptReadSchema,
  HistoricalRecoverableCommandTypeSchema,
  RoomStatusBoardSchema,
  RoomStatusQuerySchema,
  ResolveCommandResultSchema,
  HistoricalStoredPreviewResponseSchema,
  TokenTargetsResponseSchema,
  TokensResponseSchema,
  WriteHeaders
} from "./schemas.ts";

const InternalErrorResponses = { 500: ErrorResponse } as const;
const commandPreviewRequestBodies = new WeakMap<object, unknown>();
const defaultLocalWebPort = 4173;
const commandCapabilitySet = new Set<string>(commandCapabilities);
const historicalReadGrantTypes = ["PLACE_INTERNAL_USE", "RELEASE_INTERNAL_USE", "BACKFILL_COMPLETED_STAY"] as const;
const commandGrantSet = new Set<string>([...humanGrantableCommandTypes, ...historicalReadGrantTypes]);
const tokenLifecycleCommandTypes = ["ISSUE_TOKEN", "ROTATE_TOKEN", "REVOKE_TOKEN"] as const;

type ProjectablePrincipal = Pick<AuthPrincipal, "subjectId" | "credentialType" | "displayName" | "propertyAccess"> & {
  credentialId?: string;
  propertyCommandGrants?: ReadonlyMap<string, ReadonlySet<unknown>>;
  tokenCommandCeiling?: ReadonlySet<unknown> | null;
};

function isCommandCapability(value: unknown): value is CommandCapability {
  return typeof value === "string" && commandCapabilitySet.has(value);
}

function isCommandGrant(value: unknown): value is CommandCatalogType {
  return typeof value === "string" && commandGrantSet.has(value);
}

function commandFeatureEnabledForProjection(commandType: CommandCapability): boolean {
  if (commandType === "COMPLETE_CLEANING") return currentReleaseFeatures.cleaningWorkflow;
  if (commandType === "CORRECT_HISTORICAL_STAY_ARRANGEMENTS") return currentReleaseFeatures.historicalStayArrangementCorrection;
  if (commandType === "CORRECT_MEMBER_PROFILE") return currentReleaseFeatures.memberProfileCorrection;
  if (commandType === "CORRECT_MEMBERSHIP_EFFECTIVE_DATE") return currentReleaseFeatures.membershipEffectiveDateCorrection;
  if (commandType === "BACKFILL_HISTORICAL_MEMBERSHIP") return currentReleaseFeatures.historicalMembershipBackfill;
  if (commandType === "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY") return currentReleaseFeatures.membershipConversionVoidCorrection;
  return true;
}

function sortedExactCommandCapabilities(commands: ReadonlySet<unknown> | undefined): CommandCapability[] {
  if (!commands) return [];
  return humanGrantableCommandTypes.filter((commandType) => commands.has(commandType));
}

function sortedExactCommandGrants(commands: ReadonlySet<unknown> | undefined): CommandCatalogType[] {
  if (!commands) return [];
  return commandCatalogTypes.filter((commandType) => commandGrantSet.has(commandType) && commands.has(commandType));
}

export function projectTokenListCommandCeiling(
  accessCeiling: "READ" | "WRITE",
  persistedCommands: ReadonlySet<unknown> | readonly unknown[]
) {
  if (accessCeiling === "READ") {
    return {
      commandCeiling: [],
      persistedCommandCeiling: [],
      historicalReadCeilingPreserved: false
    };
  }

  const persistedSet = new Set(persistedCommands);
  const commandCeiling = sortedExactCommandCapabilities(persistedSet)
    .filter(commandFeatureEnabledForProjection);
  const persistedCommandCeiling = sortedExactCommandGrants(persistedSet);
  return {
    commandCeiling,
    persistedCommandCeiling,
    historicalReadCeilingPreserved: persistedCommandCeiling.some((commandType) => !commandCeiling.includes(commandType as CommandCapability))
  };
}

function tokenCeilingFilteredGrants<T extends CommandCatalogType>(principal: ProjectablePrincipal, grants: T[]): T[] {
  if (principal.credentialType !== "TOKEN") return grants;
  if (!principal.tokenCommandCeiling) return [];
  return grants.filter((commandType) => principal.tokenCommandCeiling?.has(commandType));
}

function effectiveAllowedCommands(principal: ProjectablePrincipal, propertyId: string): CommandCapability[] {
  if (principal.propertyAccess.get(propertyId) !== "WRITE") return [];
  return tokenCeilingFilteredGrants(principal, sortedExactCommandCapabilities(principal.propertyCommandGrants?.get(propertyId)))
    .filter(commandFeatureEnabledForProjection);
}

export function tokenManagementQueryCommand(
  principal: ProjectablePrincipal,
  propertyId: string,
  candidates: readonly (typeof tokenLifecycleCommandTypes)[number][] = tokenLifecycleCommandTypes
): (typeof tokenLifecycleCommandTypes)[number] {
  const subjectGrants = principal.propertyCommandGrants?.get(propertyId);
  return candidates.find((commandType) => (
    subjectGrants?.has(commandType)
    && (principal.credentialType !== "TOKEN" || principal.tokenCommandCeiling?.has(commandType))
  )) ?? candidates[0] ?? "ISSUE_TOKEN";
}

async function authorizeTokenManagementQuery<T>(
  db: Kysely<Database>,
  principal: AuthPrincipal,
  propertyId: string,
  candidates: readonly (typeof tokenLifecycleCommandTypes)[number][],
  query: (trx: Transaction<Database>) => Promise<T>
): Promise<T> {
  const commandType = tokenManagementQueryCommand(principal, propertyId, candidates);
  return withCommandAuthorizationAudit(db, () => db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    await authorizeCommandAccess(db, trx, principal, {
      propertyId,
      commandType,
      stage: "COMMAND",
      mode: "READ"
    });
    return query(trx);
  }));
}

export function projectMeResponse(principal: ProjectablePrincipal) {
  const propertyCommandGrants = Object.fromEntries([...principal.propertyAccess.keys()].map((propertyId) => [
    propertyId,
    tokenCeilingFilteredGrants(principal, sortedExactCommandGrants(principal.propertyCommandGrants?.get(propertyId)))
  ]));
  const allowedActions = Object.fromEntries([...principal.propertyAccess.keys()].map((propertyId) => [
    propertyId,
    effectiveAllowedCommands(principal, propertyId)
  ]));
  return {
    subjectId: principal.subjectId,
    displayName: principal.displayName,
    credentialType: principal.credentialType,
    propertyAccess: Object.fromEntries(principal.propertyAccess),
    propertyCommandGrants,
    allowedActions
  };
}

async function tokenCommandCeilingsByTokenId(db: Kysely<Database>, tokenIds: readonly string[]) {
  if (!tokenIds.length) return new Map<string, CommandCatalogType[]>();
  const rows = await db.selectFrom("token_command_ceilings")
    .select(["token_id", "command_type"])
    .where("token_id", "in", tokenIds)
    .orderBy("token_id")
    .orderBy("command_type")
    .execute();
  const grouped = new Map<string, Set<CommandCatalogType>>();
  for (const row of rows) {
    if (!isCommandGrant(row.command_type)) continue;
    const commands = grouped.get(row.token_id) ?? new Set<CommandCatalogType>();
    commands.add(row.command_type);
    grouped.set(row.token_id, commands);
  }
  return new Map([...grouped].map(([tokenId, commands]) => [tokenId, sortedExactCommandGrants(commands)]));
}

async function commandGrantsBySubjectId(db: Kysely<Database>, propertyId: string, subjectIds: readonly string[]) {
  if (!subjectIds.length) return new Map<string, CommandCapability[]>();
  const rows = await db.selectFrom("subject_command_grants")
    .select(["subject_id", "command_type"])
    .where("property_id", "=", propertyId)
    .where("subject_id", "in", subjectIds)
    .orderBy("subject_id")
    .orderBy("command_type")
    .execute();
  const grouped = new Map<string, Set<CommandCapability>>();
  for (const row of rows) {
    if (!isCommandCapability(row.command_type)) continue;
    const commands = grouped.get(row.subject_id) ?? new Set<CommandCapability>();
    commands.add(row.command_type);
    grouped.set(row.subject_id, commands);
  }
  return new Map([...grouped].map(([subjectId, commands]) => [subjectId, sortedExactCommandCapabilities(commands)]));
}

export function webOriginAllowlist(
  configuredOrigin = process.env.WEB_ORIGIN,
  configuredWebPort = process.env.WEB_PORT
): readonly string[] {
  const configured = configuredOrigin?.trim();
  if (configured) return [configured];

  const configuredPort = configuredWebPort?.trim();
  const localWebPort = configuredPort ? Number(configuredPort) : defaultLocalWebPort;
  const safeLocalWebPort = Number.isInteger(localWebPort) && localWebPort > 0 && localWebPort <= 65_535
    ? localWebPort
    : defaultLocalWebPort;
  return [`http://127.0.0.1:${safeLocalWebPort}`, `http://localhost:${safeLocalWebPort}`];
}

function correlationId(request: { headers: Record<string, unknown>; id: string }): string {
  const header = request.headers["x-correlation-id"];
  return typeof header === "string" && header ? header : request.id;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function missingWriteHeaderError(error: unknown): { code: "IDEMPOTENCY_KEY_REQUIRED" | "CORRELATION_ID_REQUIRED"; message: string } | undefined {
  const validation = (error as { validation?: Array<{ keyword?: string; params?: { missingProperty?: string } }> }).validation;
  const missing = validation?.find((item) => item.keyword === "required")?.params?.missingProperty?.toLowerCase();
  if (missing === "idempotency-key") return { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency-Key header is required" };
  if (missing === "x-correlation-id") return { code: "CORRELATION_ID_REQUIRED", message: "X-Correlation-ID header is required" };
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

type KnownCredentialCommandAuditContext = {
  propertyId: string;
  commandType: CommandCatalogType;
  stage: "PREVIEW" | "CONFIRM" | "STORED_PREVIEW" | "RECEIPT" | "COMMAND" | "FIND" | "RESOLVE";
  idempotencyKey?: string;
  correlationId?: string;
};

function exactAuditCommandType(value: unknown): CommandCatalogType | undefined {
  if (typeof value !== "string") return undefined;
  const commandType = value.startsWith("PREVIEW:") ? value.slice("PREVIEW:".length) : value;
  return (commandCatalogTypes as readonly string[]).includes(commandType)
    ? commandType as CommandCatalogType
    : undefined;
}

function commandAuditContextFromValues(
  request: FastifyRequest,
  values: {
    propertyId?: unknown;
    commandType?: unknown;
    stage: KnownCredentialCommandAuditContext["stage"];
    idempotencyKey?: unknown;
    correlationId?: unknown;
  }
): KnownCredentialCommandAuditContext | undefined {
  const commandType = exactAuditCommandType(values.commandType);
  if (typeof values.propertyId !== "string" || !values.propertyId.trim() || !commandType) return undefined;
  const requestIdempotencyKey = request.headers["idempotency-key"];
  const idempotencyKey = typeof values.idempotencyKey === "string" && values.idempotencyKey.trim()
    ? values.idempotencyKey.trim()
    : typeof requestIdempotencyKey === "string" && requestIdempotencyKey.trim()
      ? requestIdempotencyKey.trim()
      : undefined;
  const storedCorrelationId = typeof values.correlationId === "string" && values.correlationId.trim()
    ? values.correlationId.trim()
    : undefined;
  return {
    propertyId: values.propertyId.trim(),
    commandType,
    stage: values.stage,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    correlationId: storedCorrelationId ?? correlationId(request)
  };
}

async function knownCredentialCommandAuditContext(
  db: Kysely<Database>,
  request: FastifyRequest
): Promise<KnownCredentialCommandAuditContext | undefined> {
  const path = request.url.split("?", 1)[0] ?? request.url;
  const body = record(request.body);
  const query = record(request.query);
  const params = record(request.params);

  if (request.method === "POST" && path === "/api/v1/quotes") {
    return commandAuditContextFromValues(request, {
      propertyId: body?.propertyId,
      commandType: "CREATE_QUOTE",
      stage: "COMMAND"
    });
  }
  if (request.method === "POST" && path === "/api/v1/command-previews") {
    return commandAuditContextFromValues(request, {
      propertyId: record(body?.input)?.propertyId,
      commandType: body?.commandType,
      stage: "PREVIEW"
    });
  }
  if (request.method === "POST" && /^\/api\/v1\/command-previews\/[^/]+\/confirm$/.test(path)) {
    const previewId = /^\/api\/v1\/command-previews\/([^/]+)\/confirm$/.exec(path)?.[1];
    if (previewId) {
      const preview = await db.selectFrom("command_previews")
        .select(["property_id", "command_type"])
        .where("id", "=", decodeURIComponent(previewId))
        .executeTakeFirst();
      if (preview) {
        return commandAuditContextFromValues(request, {
          propertyId: preview.property_id,
          commandType: preview.command_type,
          stage: "CONFIRM"
        });
      }
    }
    return commandAuditContextFromValues(request, {
      propertyId: body?.propertyId,
      commandType: body?.commandType,
      stage: "CONFIRM"
    });
  }
  if (request.method === "GET" && path === "/api/v1/command-results") {
    return commandAuditContextFromValues(request, {
      propertyId: query?.propertyId,
      commandType: query?.commandType,
      stage: "FIND",
      idempotencyKey: query?.idempotencyKey
    });
  }
  if (request.method === "POST" && path === "/api/v1/command-results/resolve") {
    return commandAuditContextFromValues(request, {
      propertyId: body?.propertyId,
      commandType: body?.commandType,
      stage: "RESOLVE",
      idempotencyKey: body?.idempotencyKey
    });
  }
  if (request.method === "GET" && path === "/api/v1/tokens") {
    return commandAuditContextFromValues(request, {
      propertyId: query?.propertyId,
      commandType: "ISSUE_TOKEN",
      stage: "COMMAND"
    });
  }
  if (request.method === "GET" && /^\/api\/v1\/properties\/[^/]+\/token-targets$/.test(path)) {
    return commandAuditContextFromValues(request, {
      propertyId: params?.id,
      commandType: "ISSUE_TOKEN",
      stage: "COMMAND"
    });
  }

  const storedPreviewId = request.method === "GET"
    ? /^\/api\/v1\/command-previews\/([^/]+)$/.exec(path)?.[1]
    : undefined;
  if (storedPreviewId) {
    const preview = await db.selectFrom("command_previews")
      .select(["property_id", "command_type"])
      .where("id", "=", decodeURIComponent(storedPreviewId))
      .executeTakeFirst();
    return preview ? commandAuditContextFromValues(request, {
      propertyId: preview.property_id,
      commandType: preview.command_type,
      stage: "STORED_PREVIEW"
    }) : undefined;
  }

  const receiptId = request.method === "GET" ? /^\/api\/v1\/receipts\/([^/]+)$/.exec(path)?.[1] : undefined;
  if (receiptId) {
    const command = await db.selectFrom("command_receipts")
      .innerJoin("command_executions", "command_executions.id", "command_receipts.command_id")
      .select([
        "command_executions.property_id",
        "command_executions.command_type",
        "command_executions.idempotency_key",
        "command_executions.correlation_id"
      ])
      .where("command_receipts.id", "=", decodeURIComponent(receiptId))
      .executeTakeFirst();
    return command ? commandAuditContextFromValues(request, {
      propertyId: command.property_id,
      commandType: command.command_type,
      stage: "RECEIPT",
      idempotencyKey: command.idempotency_key,
      correlationId: command.correlation_id
    }) : undefined;
  }

  const commandId = request.method === "GET" ? /^\/api\/v1\/commands\/([^/]+)$/.exec(path)?.[1] : undefined;
  if (!commandId) return undefined;
  const command = await db.selectFrom("command_executions")
    .select(["property_id", "command_type", "idempotency_key", "correlation_id"])
    .where("id", "=", decodeURIComponent(commandId))
    .executeTakeFirst();
  return command ? commandAuditContextFromValues(request, {
    propertyId: command.property_id,
    commandType: command.command_type,
    stage: "COMMAND",
    idempotencyKey: command.idempotency_key,
    correlationId: command.correlation_id
  }) : undefined;
}

async function replayHistoricalCreateOrderPreview(
  db: Kysely<Database>,
  principal: Awaited<ReturnType<typeof requirePrincipal>>,
  envelope: unknown,
  headers: Record<string, unknown>
) {
  if (!Value.Check(HistoricalCreateOrderReplayEnvelopeSchema, envelope)
    || !Value.Check(WriteHeaders, headers)) return undefined;

  const idempotencyKey = typeof headers["idempotency-key"] === "string"
    ? headers["idempotency-key"].trim()
    : "";
  const correlation = typeof headers["x-correlation-id"] === "string"
    ? headers["x-correlation-id"].trim()
    : "";
  if (!idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required", 400);
  if (!correlation) throw new DomainError("CORRELATION_ID_REQUIRED", "X-Correlation-ID header is required", 400);

  const propertyId = envelope.input.propertyId;
  const replay = await withCommandAuthorizationAudit(db, () => db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    await authorizeCommandAccess(db, trx, principal, {
      propertyId,
      commandType: "CREATE_ORDER",
      stage: "REPLAY",
      mode: "READ",
      idempotencyKey,
      correlationId: correlation
    });
    const execution = await trx.selectFrom("command_executions as execution")
      .leftJoin("command_receipts as receipt", "receipt.command_id", "execution.id")
      .select(["execution.id", "execution.request_hash", "receipt.id as receipt_id"])
      .where("execution.subject_id", "=", principal.subjectId)
      .where("execution.property_id", "=", propertyId)
      .where("execution.command_type", "=", "PREVIEW:CREATE_ORDER")
      .where("execution.idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (!execution || execution.request_hash !== stableHash(envelope)) return undefined;
    if (!execution.receipt_id) {
      throw new DomainError(
        "COMMAND_STATUS_UNKNOWN",
        "The historical Preview command is still executing or its final state is unknown",
        409,
        true,
        { commandId: execution.id }
      );
    }
    return { receiptId: execution.receipt_id };
  }));
  if (!replay) return undefined;
  const receipt = await getReceipt(db, principal, replay.receiptId);
  const preview = record(receipt.result)?.preview;
  if (!record(preview)) throw new DomainError("INTERNAL_ERROR", "Historical Preview receipt is malformed", 500);
  return { preview, receipt };
}

export async function buildServer(db: Kysely<Database>, options: { assistantTransport?: ModelTransport } = {}) {
  const allowedWebOrigins = webOriginAllowlist();
  const app = Fastify({ ajv: { customOptions: { discriminator: true } }, logger: { level: process.env.LOG_LEVEL ?? "info" }, genReqId: () => crypto.randomUUID() });
  await app.register(compress, { global: true, threshold: 1_024 });
  await app.register(cookie);
  await app.register(cors, { origin: [...allowedWebOrigins], credentials: true });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) => new DomainError("RATE_LIMITED", `Rate limit exceeded; retry after ${context.after}`, 429, true)
  });
  const checkBearerAuthenticationRate = app.createRateLimit({
    max: positiveIntegerEnv("BEARER_AUTH_RATE_LIMIT_MAX", 600),
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip
  });
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "QinTopia PMS Core Operations API", version: applicationVersion },
      servers: [{ url: "/" }],
      tags: [
        { name: "auth" }, { name: "queries" }, { name: "commands" }, { name: "receipts" }, { name: "operations" }
      ],
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" }, sessionCookie: { type: "apiKey", in: "cookie", name: "qintopia_session" } } },
      security: [{ bearerAuth: [] }, { sessionCookie: [] }]
    }
  });
  await app.register(swaggerUi, { routePrefix: "/docs", uiConfig: { docExpansion: "list", deepLinking: true } });

  app.addHook("onRequest", async (request, reply) => {
    if (request.raw.url?.startsWith("/api/v1/")
      && request.raw.url !== "/api/v1/auth/login"
      && request.raw.url !== "/api/v1/openapi.json"
      && request.headers.authorization?.startsWith("Bearer ")) {
      const rate = await checkBearerAuthenticationRate(request);
      if (!rate.isAllowed && rate.isExceeded) {
        reply.header("retry-after", rate.ttlInSeconds);
        throw new DomainError("RATE_LIMITED", `Bearer authentication rate limit exceeded; retry after ${rate.ttlInSeconds} seconds`, 429, true);
      }
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && request.cookies.qintopia_session) {
      const origin = request.headers.origin;
      if (origin && !allowedWebOrigins.includes(origin)) {
        throw new DomainError("RESOURCE_SCOPE_DENIED", "Cross-origin session write is not allowed", 403);
      }
    }
  });

  app.setErrorHandler(async (error, request, reply) => {
    const requestCorrelationId = correlationId(request);
    if (isKnownCredentialAuthenticationError(error)) {
      try {
        const auditContext = await knownCredentialCommandAuditContext(db, request);
        if (auditContext) {
          await writeSecurityAuthorizationAudit(db, {
            principal: error.identity,
            propertyId: auditContext.propertyId,
            commandType: auditContext.commandType,
            stage: auditContext.stage,
            idempotencyKey: auditContext.idempotencyKey,
            correlationId: auditContext.correlationId,
            denialReason: error.denialReason
          });
        }
      } catch (auditError) {
        request.log.error({ err: auditError, correlationId: requestCorrelationId }, "Authorization denial audit failed");
        return reply.code(500).send({
          code: "INTERNAL_ERROR",
          message: "Internal server error",
          correlationId: requestCorrelationId,
          retryable: false
        });
      }
    }

    const known = error instanceof DomainError ? error : undefined;
    const generic = error as { statusCode?: unknown; message?: unknown };
    const missingHeader = known ? undefined : missingWriteHeaderError(error);
    const statusCode = known?.statusCode ?? (typeof generic.statusCode === "number" ? generic.statusCode : 500);
    if (statusCode >= 500) {
      request.log.error({ err: error, correlationId: requestCorrelationId }, "Request failed");
      return reply.code(statusCode).send({
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        correlationId: requestCorrelationId,
        retryable: known?.retryable ?? false
      });
    }
    const code = known?.code ?? missingHeader?.code ?? (statusCode < 500 ? "VALIDATION_ERROR" : "INTERNAL_ERROR");
    reply.code(statusCode).send({
      code,
      message: known?.message ?? missingHeader?.message ?? (statusCode < 500 && typeof generic.message === "string" ? generic.message : "Internal server error"),
      correlationId: requestCorrelationId,
      retryable: known?.retryable ?? false,
      ...(known?.details ? { details: known.details } : {})
    });
  });

  app.get("/api/v1/version", { schema: { tags: ["operations"], security: [], response: { 200: Type.Object({ version: Type.String() }), ...InternalErrorResponses } } }, async () => ({ version: applicationVersion }));
  app.get("/health/live", { schema: { tags: ["operations"], security: [], response: { 200: Type.Object({ status: Type.Literal("ok") }) } } }, async () => ({ status: "ok" as const }));
  app.get("/health/ready", { schema: { tags: ["operations"], security: [], response: { 200: Type.Object({ status: Type.Literal("ready") }), 503: ErrorResponse } } }, async (_request, reply) => {
    if (!(await databaseReady(db))) {
      reply.code(503);
      throw new DomainError("SERVICE_NOT_READY", "Database migration is not ready", 503, true);
    }
    return { status: "ready" as const };
  });

  app.post("/api/v1/auth/login", {
    config: { rateLimit: { max: positiveIntegerEnv("LOGIN_RATE_LIMIT_MAX", 8), timeWindow: "1 minute", groupId: "login" } },
    schema: { tags: ["auth"], security: [], body: LoginSchema, response: { 200: LoginResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } }
  }, async (request, reply) => {
    const body = request.body as { username: string; password: string };
    return login(db, body.username, body.password, reply);
  });
  app.post("/api/v1/auth/logout", { schema: { tags: ["auth"], response: { 204: Type.Null(), 401: ErrorResponse, 403: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } } }, async (request, reply) => {
    await logout(db, request, reply);
    return reply.code(204).send();
  });
  app.get("/api/v1/me", { schema: { tags: ["auth"], response: { 200: MeResponseSchema, 401: ErrorResponse, 403: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } } }, async (request) => {
    const principal = await requirePrincipal(db, request);
    return projectMeResponse(principal);
  });

  registerAccountManagement(app, db);
  registerAssistant(app, db, options.assistantTransport);
  registerRoomCatalog(app, db);
  registerPmsIntegration(app, db);
  registerExternalPayments(app, db);

  app.get("/api/v1/meta", { schema: { tags: ["queries"], response: { 200: MetaResponseSchema, 401: ErrorResponse, 403: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } } }, async (request) => {
    const principal = await requirePrincipal(db, request);
    const propertyIds = [...principal.propertyAccess.keys()];
    const [properties, units, policies, membershipProducts] = await Promise.all([
      propertyIds.length ? db.selectFrom("properties").selectAll().where("id", "in", propertyIds).orderBy("code").execute() : [],
      propertyIds.length ? db.selectFrom("inventory_units").selectAll().where("property_id", "in", propertyIds).where("active", "=", true).orderBy("code").execute() : [],
      propertyIds.length ? db.selectFrom("pricing_policy_versions").selectAll().where("property_id", "in", propertyIds).orderBy("code").execute() : [],
      propertyIds.length ? db.selectFrom("membership_products").selectAll().where("status", "=", "PUBLISHED").orderBy("code").execute() : []
    ]);
    return { properties, inventoryUnits: await projectCatalogUnitNames(db, units), pricingPolicyVersions: policies, members: [], memberContracts: [], membershipProducts };
  });

  app.get("/api/v1/properties/:id/availability", {
    schema: {
      tags: ["queries"], params: IdParams,
      querystring: Type.Object({
        arrivalDate: LocalDate,
        departureDate: LocalDate,
        unitKind: Type.Optional(Type.Union([Type.Literal("ROOM"), Type.Literal("BED")])),
        excludeOrderId: Type.Optional(Id)
      }, { additionalProperties: false }),
      response: { 200: Type.Object({ propertyId: Type.String(), units: Type.Array(AvailabilityUnitSchema) }, { additionalProperties: false }), 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses }
    }
  }, async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as { arrivalDate: string; departureDate: string; unitKind?: InventoryUnitKind; excludeOrderId?: string };
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, id, "READ");
    return {
      propertyId: id,
      units: await listAvailability(db, id, query.arrivalDate, query.departureDate, query.unitKind, query.excludeOrderId)
    };
  });

  app.get("/api/v1/properties/:id/room-status", {
    schema: {
      tags: ["queries"],
      summary: "Read the authoritative room and bed status projection",
      params: IdParams,
      querystring: RoomStatusQuerySchema,
      response: {
        200: RoomStatusBoardSchema,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
        429: ErrorResponse,
        ...InternalErrorResponses
      }
    }
  }, async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as RoomStatusBoardQueryDto;
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, id, "READ");
    return getRoomStatusBoard(db, {
      propertyId: id,
      arrivalDate: query.arrivalDate,
      departureDate: query.departureDate,
      accessLevel: principal.propertyAccess.get(id)!,
      commandGrants: new Set(effectiveAllowedCommands(principal, id)),
      requestingSubjectId: principal.subjectId,
      ...(query.page !== undefined ? { page: query.page } : {}),
      ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
      ...(query.search !== undefined ? { search: query.search } : {}),
      ...(query.roomType !== undefined ? { roomType: query.roomType } : {}),
      ...(query.salesMode !== undefined ? { salesMode: query.salesMode } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.minCapacity !== undefined ? { minCapacity: query.minCapacity } : {}),
      ...(query.unitKind !== undefined ? { unitKind: query.unitKind } : {})
    });
  });

  app.get("/api/v1/properties/:id/reference-catalog", {
    schema: {
      tags: ["queries"],
      params: IdParams,
      response: {
        200: ReferenceCatalogResponseSchema,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
        429: ErrorResponse,
        ...InternalErrorResponses
      }
    }
  }, async (request) => {
    const { id } = request.params as { id: string };
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, id, "READ");
    const catalog = await loadReferenceCatalog(db, id);
    if (!catalog) throw new DomainError("NOT_FOUND", "Reference catalog not found", 404);
    return catalog;
  });

  app.post("/api/v1/quotes", {
    config: { rateLimit: { max: positiveIntegerEnv("QUOTE_RATE_LIMIT_MAX", 120), timeWindow: "1 minute", groupId: "quotes" } },
    schema: {
      tags: ["commands"],
      summary: "Create a recoverable quote",
      description: "Low-risk single-stage command. READ access is sufficient; Preview and Confirm do not apply.",
      headers: WriteHeaders,
      body: QuoteRequestSchema,
      response: { 200: QuoteCommandResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses }
    }
  }, async (request) => {
    const body = request.body as CreateQuoteCommandInputDto;
    const principal = await requirePrincipal(db, request);
    return executeQuoteCommand(db, principal, body, {
      idempotencyKey: request.headers["idempotency-key"] as string | undefined,
      correlationId: request.headers["x-correlation-id"] as string | undefined
    });
  });

  app.get("/api/v1/orders", {
    schema: { tags: ["queries"], summary: "Search orders (default 50, maximum 100 per page), or read current work by workDate", querystring: OrdersQuerySchema, response: { 200: OrdersListResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } }
  }, async (request) => {
    const query = request.query as OrderListQuery;
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, query.propertyId, "READ");
    return listOrders(db, query);
  });

  app.get("/api/v1/orders/:id", { schema: { tags: ["queries"], params: IdParams, response: { 200: OrderDetailResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } } }, async (request) => {
    const principal = await requirePrincipal(db, request);
    const orderId = (request.params as { id: string }).id;
    const order = await db.selectFrom("orders").select("property_id").where("id", "=", orderId).executeTakeFirst();
    if (!order) throw new DomainError("NOT_FOUND", "Order not found", 404);
    requireScopedResourceAccess(principal, order.property_id);
    return getOrderView(db, orderId, principal.propertyAccess.get(order.property_id)!, new Set(effectiveAllowedCommands(principal, order.property_id)));
  });

  app.get("/api/v1/members", { schema: { tags: ["queries"], querystring: MembersQuerySchema, response: { 200: MembersListResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } } }, async (request) => {
    const query = request.query as { propertyId: string; query?: string; beforeId?: string; pageSize?: number; memberId?: string; phone?: string; hasContract?: boolean };
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, query.propertyId, "READ");
    return listMemberPage(db, query.propertyId, query.query, query);
  });

  app.get("/api/v1/members/:id", { schema: { tags: ["queries"], params: IdParams, querystring: Type.Object({ propertyId: Id }, { additionalProperties: false }), response: { 200: MemberResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } } }, async (request) => {
    const id = (request.params as { id: string }).id;
    const propertyId = (request.query as { propertyId: string }).propertyId;
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, propertyId, "READ");
    return getMemberView(db, propertyId, id);
  });

  app.get("/api/v1/tokens", {
    schema: { tags: ["queries"], querystring: Type.Object({ propertyId: Id }, { additionalProperties: false }), response: { 200: TokensResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } }
  }, async (request) => {
    const propertyId = (request.query as { propertyId: string }).propertyId;
    const principal = await requirePrincipal(db, request);
    return authorizeTokenManagementQuery(db, principal, propertyId, tokenLifecycleCommandTypes, async (trx) => {
      const tokens = await trx.selectFrom("api_tokens")
        .innerJoin("subjects", "subjects.id", "api_tokens.subject_id")
        .select([
          "api_tokens.subject_id as subjectId",
          "subjects.display_name as displayName",
          "api_tokens.id",
          "api_tokens.label",
          "api_tokens.access_ceiling",
          "api_tokens.property_scope",
          "api_tokens.expires_at",
          "api_tokens.revoked_at",
          "api_tokens.rotated_from_id",
          "api_tokens.replaced_by_id",
          "api_tokens.created_at"
        ])
        .where("api_tokens.property_scope", "=", propertyId)
        .orderBy("api_tokens.created_at", "desc")
        .execute();
      const ceilingsByTokenId = await tokenCommandCeilingsByTokenId(trx, tokens.map((token) => token.id));
      return {
        tokens: tokens.map((token) => ({
          ...token,
          ...projectTokenListCommandCeiling(token.access_ceiling, ceilingsByTokenId.get(token.id) ?? [])
        }))
      };
    });
  });

  app.get("/api/v1/properties/:id/token-targets", {
    schema: { tags: ["queries"], params: IdParams, response: { 200: TokenTargetsResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } }
  }, async (request) => {
    const { id: propertyId } = request.params as { id: string };
    const principal = await requirePrincipal(db, request);
    return authorizeTokenManagementQuery(db, principal, propertyId, ["ISSUE_TOKEN"], async (trx) => {
      const subjects = await trx.selectFrom("subject_property_grants")
        .innerJoin("subjects", "subjects.id", "subject_property_grants.subject_id")
        .select([
          "subjects.id as subjectId",
          "subjects.display_name as displayName",
          "subject_property_grants.access_level as accessLevel"
        ])
        .where("subject_property_grants.property_id", "=", propertyId)
        .where("subjects.status", "=", "ACTIVE")
        .orderBy("subjects.display_name")
        .orderBy("subjects.id")
        .execute();
      const grantsBySubjectId = await commandGrantsBySubjectId(trx, propertyId, subjects.map((subject) => subject.subjectId));
      return {
        subjects: subjects.map((subject) => ({
          ...subject,
          commandGrants: grantsBySubjectId.get(subject.subjectId) ?? []
        }))
      };
    });
  });

  app.get("/api/v1/maintenance-locks", {
    schema: {
      tags: ["queries"],
      querystring: MaintenanceLocksQuerySchema,
      response: { 200: MaintenanceLocksResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses }
    }
  }, async (request) => {
    const query = request.query as { propertyId: string; status?: "ACTIVE" | "RELEASED" };
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, query.propertyId, "READ");
    let selection = db.selectFrom("maintenance_locks").selectAll().where("property_id", "=", query.propertyId);
    if (query.status) selection = selection.where("status", "=", query.status);
    const maintenanceLocks = await selection
      .orderBy("property_id")
      .orderBy("status")
      .orderBy("arrival_date")
      .orderBy("id")
      .execute();
    return { maintenanceLocks };
  });

  app.get("/api/v1/facts/:id", { schema: { tags: ["queries"], params: IdParams, response: { 200: FactResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } } }, async (request) => {
    const factId = (request.params as { id: string }).id;
    const principal = await requirePrincipal(db, request);
    const collection = await db.selectFrom("collection_facts").innerJoin("orders", "orders.id", "collection_facts.order_id")
      .select(["collection_facts.fact_id", "collection_facts.order_id", "collection_facts.fact_type", "collection_facts.amount_minor", "collection_facts.net_effect_minor", "collection_facts.currency", "collection_facts.references_fact_id", "collection_facts.reverses_fact_id", "collection_facts.method", "collection_facts.note", "collection_facts.transaction_reference", "collection_facts.refund_reference", "collection_facts.cash_collector", "collection_facts.pricing_revision_id", "collection_facts.created_at", "orders.property_id"])
      .where("collection_facts.fact_id", "=", factId).executeTakeFirst();
    if (collection) {
      requireScopedResourceAccess(principal, collection.property_id);
      return collection;
    }
    const entitlement = await db.selectFrom("entitlement_ledger").innerJoin("entitlement_lots", "entitlement_lots.id", "entitlement_ledger.lot_id")
      .innerJoin("member_contracts", "member_contracts.id", "entitlement_lots.contract_id").selectAll("entitlement_ledger")
      .select("member_contracts.property_id").where("entitlement_ledger.fact_id", "=", factId).executeTakeFirst();
    if (!entitlement) throw new DomainError("NOT_FOUND", "Fact not found", 404);
    requireScopedResourceAccess(principal, entitlement.property_id);
    return entitlement;
  });

  app.post("/api/v1/command-previews", {
    attachValidation: true,
    preValidation: async (request) => {
      commandPreviewRequestBodies.set(request, structuredClone(request.body));
    },
    config: { rateLimit: { max: positiveIntegerEnv("COMMAND_PREVIEW_RATE_LIMIT_MAX", 120), timeWindow: "1 minute", groupId: "command-previews" } },
    schema: { tags: ["commands"], headers: WriteHeaders, body: CommandEnvelopeSchema, response: { 200: HistoricalCommandPreviewResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } }
  }, async (request) => {
    if (request.validationError) {
      const historicalEnvelope = commandPreviewRequestBodies.get(request);
      if (!Value.Check(HistoricalCreateOrderReplayEnvelopeSchema, historicalEnvelope)
        || !Value.Check(WriteHeaders, request.headers)) {
        throw request.validationError;
      }
      const principal = await requirePrincipal(db, request);
      const replay = await replayHistoricalCreateOrderPreview(
        db,
        principal,
        historicalEnvelope,
        request.headers
      );
      if (replay) return replay;
      throw request.validationError;
    }
    const principal = await requirePrincipal(db, request);
    const envelope = request.body as CommandEnvelope;
    return createCommandPreview(db, principal, envelope, {
      idempotencyKey: request.headers["idempotency-key"] as string | undefined,
      correlationId: request.headers["x-correlation-id"] as string | undefined
    });
  });

  app.get("/api/v1/command-previews/:previewId", {
    schema: { tags: ["commands"], params: PreviewParams, response: { 200: HistoricalStoredPreviewResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } }
  }, async (request) => {
    const principal = await requirePrincipal(db, request);
    return withCommandAuthorizationAudit(db, () => db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      const preview = await trx.selectFrom("command_previews").selectAll()
        .where("id", "=", (request.params as { previewId: string }).previewId)
        .executeTakeFirst();
      if (!preview) throw new DomainError("PREVIEW_NOT_FOUND", "Preview not found", 404);
      if (preview.subject_id !== principal.subjectId) {
        return auditCommandResourceNotFound(db, {
          principal,
          propertyId: preview.property_id,
          commandType: preview.command_type,
          stage: "STORED_PREVIEW",
          message: "Preview not found"
        });
      }
      await authorizeCommandAccess(db, trx, principal, {
        propertyId: preview.property_id,
        commandType: preview.command_type,
        stage: "STORED_PREVIEW",
        mode: "READ"
      });
      return projectStoredPreviewForRead(trx, preview);
    }));
  });

  app.post("/api/v1/command-previews/:previewId/confirm", {
    config: { rateLimit: { max: positiveIntegerEnv("COMMAND_CONFIRM_RATE_LIMIT_MAX", 120), timeWindow: "1 minute", groupId: "command-confirms" } },
    schema: { tags: ["commands"], headers: WriteHeaders, params: PreviewParams, body: ConfirmSchema, response: { 200: HistoricalReceiptReadSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: Type.Union([HistoricalReceiptReadSchema, ErrorResponse]), 429: ErrorResponse, ...InternalErrorResponses } }
  }, async (request, reply) => {
    const principal = await requirePrincipal(db, request);
    const previewId = (request.params as { previewId: string }).previewId;
    const receipt = await confirmCommandPreview(db, principal, previewId, request.body as ConfirmRequest, {
      idempotencyKey: request.headers["idempotency-key"] as string | undefined,
      correlationId: request.headers["x-correlation-id"] as string | undefined
    });
    if (!receipt.businessCommitted) reply.code(409);
    return receipt;
  });

  app.get("/api/v1/receipts/:id", { schema: { tags: ["receipts"], params: IdParams, response: { 200: HistoricalReceiptReadSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } } }, async (request) => {
    const principal = await requirePrincipal(db, request);
    return getReceipt(db, principal, (request.params as { id: string }).id);
  });
  app.get("/api/v1/commands/:id", { schema: { tags: ["receipts"], params: IdParams, response: { 200: HistoricalCommandResultRecoverySchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } } }, async (request) => {
    const principal = await requirePrincipal(db, request);
    return getCommand(db, principal, (request.params as { id: string }).id);
  });
  app.get("/api/v1/command-results", {
    schema: { tags: ["receipts"], querystring: Type.Object({ propertyId: Id, commandType: HistoricalRecoverableCommandTypeSchema, idempotencyKey: Type.String({ minLength: 1, maxLength: 160 }) }, { additionalProperties: false }), response: { 200: HistoricalCommandResultRecoverySchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses } }
  }, async (request) => {
    const principal = await requirePrincipal(db, request);
    const query = request.query as { propertyId: string; commandType: HistoricalRecoverableCommandType; idempotencyKey: string };
    return findCommandResult(db, principal, query.propertyId, query.commandType, query.idempotencyKey);
  });

  app.post("/api/v1/command-results/resolve", {
    config: { rateLimit: { max: positiveIntegerEnv("COMMAND_RESULT_RESOLVE_RATE_LIMIT_MAX", 120), timeWindow: "1 minute", groupId: "command-result-resolutions" } },
    schema: {
      tags: ["receipts"],
      headers: WriteHeaders,
      body: ResolveCommandResultSchema,
      response: {
        200: HistoricalCommandResultRecoverySchema,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        409: ErrorResponse,
        429: ErrorResponse,
        ...InternalErrorResponses
      }
    }
  }, async (request) => {
    const principal = await requirePrincipal(db, request);
    return resolveCommandResult(
      db,
      principal,
      request.body as {
        propertyId: string;
        commandType: HistoricalRecoverableCommandType;
        idempotencyKey: string;
      },
      {
        idempotencyKey: request.headers["idempotency-key"] as string | undefined,
        correlationId: request.headers["x-correlation-id"] as string | undefined
      }
    );
  });

  app.get("/api/v1/audit", {
    schema: {
      tags: ["receipts"],
      querystring: Type.Object({ propertyId: Id, correlationId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }, { additionalProperties: false }),
      response: { 200: AuditResponseSchema, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 429: ErrorResponse, ...InternalErrorResponses }
    }
  }, async (request) => {
    const query = request.query as { propertyId: string; correlationId?: string; limit?: number };
    const principal = await requirePrincipal(db, request);
    requirePropertyAccess(principal, query.propertyId, "READ");
    let selection = db.selectFrom("audit_entries")
      .innerJoin("command_executions", "command_executions.id", "audit_entries.command_id")
      .select([
        "audit_entries.id", "audit_entries.subject_id", "audit_entries.credential_id", "audit_entries.action", "audit_entries.decision",
        "audit_entries.command_id", "audit_entries.correlation_id", "audit_entries.reason", "audit_entries.target_refs", "audit_entries.metadata", "audit_entries.created_at"
      ])
      .where("command_executions.property_id", "=", query.propertyId);
    if (query.correlationId) selection = selection.where("audit_entries.correlation_id", "=", query.correlationId);
    return { entries: await selection.orderBy("audit_entries.created_at", "desc").limit(query.limit ?? 100).execute() };
  });

  app.get("/api/v1/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if (existsSync(webRoot)) {
    await app.register(async (webApp) => {
      await webApp.register(fastifyStatic, { root: webRoot });
      webApp.setNotFoundHandler(async (request, reply) => {
        if (request.raw.url?.startsWith("/api/") || request.raw.url?.startsWith("/health/")) {
          return reply.code(404).send({ code: "NOT_FOUND", message: "Route not found", correlationId: request.id, retryable: false });
        }
        return reply.sendFile("index.html");
      });
    });
  }

  app.addHook("onClose", async () => db.destroy());
  return app;
}
import { registerRoomCatalog } from "./room-catalog.ts";

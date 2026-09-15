import type { Kysely, Transaction } from "kysely";
import {
  commandCatalogTypes,
  DomainError,
  type AccessLevel,
  type AuthPrincipal,
  type CommandCatalogType,
  type ErrorCode
} from "@qintopia/contracts";
import {
  accessAllows,
  commandFeatureEnabled,
  evaluateCommandAuthorization,
  isHumanGrantableCommandCapability,
  newId,
  sha256
} from "@qintopia/domain";
import type { Database } from "./schema.ts";

export type CommandAuthorizationStage =
  | "PREVIEW"
  | "CONFIRM"
  | "STORED_PREVIEW"
  | "RECEIPT"
  | "COMMAND"
  | "FIND"
  | "RESOLVE"
  | "REPLAY";

type LockedTokenSnapshot = {
  subjectId: string;
  propertyScope: string;
  accessCeiling: AccessLevel;
  expiresAt: Date;
  revokedAt: Date | null;
};

type CredentialSnapshot =
  | {
      credentialType: "SESSION";
      tokenCommandCeiling: null;
      propertyAccess: AccessLevel;
      expiresAt: null;
      lockedTokens: ReadonlyMap<string, LockedTokenSnapshot>;
      lockedTokenCeilings: ReadonlyMap<string, ReadonlySet<string>>;
    }
  | {
      credentialType: "TOKEN";
      tokenCommandCeiling: ReadonlySet<string>;
      propertyAccess: AccessLevel;
      expiresAt: Date;
      lockedTokens: ReadonlyMap<string, LockedTokenSnapshot>;
      lockedTokenCeilings: ReadonlyMap<string, ReadonlySet<string>>;
    };

export type CommandAuthorizationTokenLifecycleConstraint =
  | {
      kind: "ISSUE_TOKEN";
      subjectId: unknown;
      accessCeiling: unknown;
      commandCeiling: unknown;
      expiresAt: unknown;
    }
  | {
      kind: "ROTATE_TOKEN";
      tokenId: unknown;
      commandCeiling: unknown;
      expiresAt?: unknown;
    }
  | {
      kind: "REVOKE_TOKEN";
      tokenId: unknown;
    };

export type CommandAuthorizationLockScope = {
  relatedSubjectIds?: readonly string[];
  relatedTokenIds?: readonly string[];
  tokenLifecycleConstraint?: CommandAuthorizationTokenLifecycleConstraint;
};

type SecurityAuditPrincipal = Pick<AuthPrincipal, "subjectId" | "credentialId" | "credentialType">;

export type SecurityAuditContext = {
  principal: SecurityAuditPrincipal;
  propertyId: string;
  commandType: CommandCatalogType;
  stage: CommandAuthorizationStage;
  idempotencyKey: string | undefined;
  correlationId: string | undefined;
};

export class CommandAuthorizationError extends DomainError {
  readonly denialReason: string;
  readonly auditContext: SecurityAuditContext;
  auditWritten = false;

  constructor(options: SecurityAuditContext & {
    code: ErrorCode;
    message: string;
    statusCode: number;
    denialReason: string;
  }) {
    super(options.code, options.message, options.statusCode);
    this.name = "CommandAuthorizationError";
    this.denialReason = options.denialReason;
    this.auditContext = {
      principal: options.principal,
      propertyId: options.propertyId,
      commandType: options.commandType,
      stage: options.stage,
      idempotencyKey: options.idempotencyKey,
      correlationId: options.correlationId
    };
  }
}

export function isCommandAuthorizationError(error: unknown): error is CommandAuthorizationError {
  return error instanceof CommandAuthorizationError;
}

function asCommandCatalogType(value: string): CommandCatalogType | undefined {
  const base = value.startsWith("PREVIEW:") ? value.slice("PREVIEW:".length) : value;
  return (commandCatalogTypes as readonly string[]).includes(base) ? base as CommandCatalogType : undefined;
}

export function baseCommandCatalogType(commandType: string): CommandCatalogType {
  const base = asCommandCatalogType(commandType);
  if (!base) throw new Error(`Unsupported command catalog type: ${commandType}`);
  return base;
}

export async function loadPropertyCommandGrantSnapshot(
  db: Kysely<Database> | Transaction<Database>,
  subjectId: string
): Promise<ReadonlyMap<string, ReadonlySet<CommandCatalogType>>> {
  const rows = await db.selectFrom("subject_command_grants")
    .select(["property_id", "command_type"])
    .where("subject_id", "=", subjectId)
    .orderBy("property_id")
    .orderBy("command_type")
    .execute();
  const grouped = new Map<string, Set<CommandCatalogType>>();
  for (const row of rows) {
    const commandType = asCommandCatalogType(row.command_type);
    if (!commandType) continue;
    const propertyCommands = grouped.get(row.property_id) ?? new Set<CommandCatalogType>();
    propertyCommands.add(commandType);
    grouped.set(row.property_id, propertyCommands);
  }
  return grouped;
}

export async function loadTokenCommandCeilingSnapshot(
  db: Kysely<Database> | Transaction<Database>,
  tokenId: string
): Promise<ReadonlySet<CommandCatalogType>> {
  const rows = await db.selectFrom("token_command_ceilings")
    .select("command_type")
    .where("token_id", "=", tokenId)
    .orderBy("command_type")
    .execute();
  return new Set(rows.flatMap((row) => {
    const commandType = asCommandCatalogType(row.command_type);
    return commandType ? [commandType] : [];
  }));
}

async function lockedSubjectCommandGrants(
  trx: Transaction<Database>,
  subjectId: string,
  propertyId: string
): Promise<ReadonlySet<string>> {
  const rows = await trx.selectFrom("subject_command_grants")
    .select("command_type")
    .where("subject_id", "=", subjectId)
    .where("property_id", "=", propertyId)
    .orderBy("command_type")
    .forShare()
    .execute();
  return new Set(rows.map((row) => row.command_type));
}

async function lockedTokenCommandCeiling(
  trx: Transaction<Database>,
  tokenId: string,
  subjectId: string,
  propertyId: string
): Promise<ReadonlySet<string>> {
  const rows = await trx.selectFrom("token_command_ceilings")
    .select("command_type")
    .where("token_id", "=", tokenId)
    .where("subject_id", "=", subjectId)
    .where("property_id", "=", propertyId)
    .orderBy("command_type")
    .forShare()
    .execute();
  return new Set(rows.map((row) => row.command_type));
}

function credentialFingerprint(principal: SecurityAuditPrincipal): string {
  return sha256(`${principal.credentialType}:${principal.credentialId}`);
}

export async function writeSecurityAuthorizationAudit(auditDb: Kysely<Database>, options: SecurityAuditContext & {
  denialReason: string;
}): Promise<void> {
  await auditDb.transaction().execute((trx) => trx.insertInto("security_audit_entries").values({
    id: newId("audit"),
    property_id: options.propertyId,
    subject_id: options.principal.subjectId,
    command_type: options.commandType,
    stage: options.stage,
    denial_reason: options.denialReason,
    credential_type: options.principal.credentialType,
    credential_fingerprint: credentialFingerprint(options.principal),
    correlation_id: options.correlationId?.trim() ?? "",
    idempotency_key_hash: sha256(options.idempotencyKey?.trim() ?? ""),
    metadata: {
      authorization: "COMMAND_AUTHORIZATION_V1",
      credentialFingerprintHash: "sha256"
    }
  }).execute());
}

export async function auditCommandAuthorizationDenial(
  auditDb: Kysely<Database>,
  error: CommandAuthorizationError
): Promise<void> {
  if (error.auditWritten) return;
  await writeSecurityAuthorizationAudit(auditDb, {
    ...error.auditContext,
    denialReason: error.denialReason
  });
  error.auditWritten = true;
}

export async function withCommandAuthorizationAudit<T>(
  auditDb: Kysely<Database>,
  work: () => Promise<T>
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isCommandAuthorizationError(error)) {
      await auditCommandAuthorizationDenial(auditDb, error);
    }
    throw error;
  }
}

export function auditCommandResourceNotFound(_auditDb: Kysely<Database>, options: {
  principal: AuthPrincipal;
  propertyId: string;
  commandType: string;
  stage: CommandAuthorizationStage;
  idempotencyKey?: string | undefined;
  correlationId?: string | undefined;
  message: string;
  code?: ErrorCode;
  denialReason?: string;
}): never {
  throw new CommandAuthorizationError({
    principal: options.principal,
    propertyId: options.propertyId,
    commandType: baseCommandCatalogType(options.commandType),
    stage: options.stage,
    idempotencyKey: options.idempotencyKey,
    correlationId: options.correlationId,
    denialReason: options.denialReason ?? "SUBJECT_SCOPE_MISSING",
    code: options.code ?? "NOT_FOUND",
    message: options.message,
    statusCode: 404
  });
}

function deny(options: SecurityAuditContext & {
  denialReason: string;
  message: string;
  code?: ErrorCode;
  statusCode?: number;
}): never {
  throw new CommandAuthorizationError({
    ...options,
    code: options.code ?? "INSUFFICIENT_ACCESS",
    statusCode: options.statusCode ?? 403
  });
}

export function throwCommandAuthorizationDenial(options: SecurityAuditContext & {
  denialReason: string;
  message: string;
  code?: ErrorCode;
  statusCode?: number;
}): never {
  return deny(options);
}

function sortedUniqueIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

async function preflightTokenLifecycleCallerCapability(
  trx: Transaction<Database>,
  principal: AuthPrincipal,
  propertyId: string,
  commandType: CommandCatalogType,
  auditContext: SecurityAuditContext
): Promise<void> {
  const subject = await trx.selectFrom("subjects")
    .select("status")
    .where("id", "=", principal.subjectId)
    .executeTakeFirst();
  if (!subject) {
    return deny({
      ...auditContext,
      denialReason: "SUBJECT_MISSING",
      message: "Subject is unavailable",
      code: "AUTHENTICATION_REQUIRED",
      statusCode: 401
    });
  }

  const propertyGrant = await trx.selectFrom("subject_property_grants")
    .select("access_level")
    .where("subject_id", "=", principal.subjectId)
    .where("property_id", "=", propertyId)
    .executeTakeFirst();
  if (!propertyGrant) {
    return deny({
      ...auditContext,
      denialReason: "PROPERTY_SCOPE_MISSING",
      message: "Resource not found",
      code: "NOT_FOUND",
      statusCode: 404
    });
  }

  const commandGrant = await trx.selectFrom("subject_command_grants")
    .select("command_type")
    .where("subject_id", "=", principal.subjectId)
    .where("property_id", "=", propertyId)
    .where("command_type", "=", commandType)
    .executeTakeFirst();

  let credentialPropertyAccess: AccessLevel = propertyGrant.access_level;
  let tokenCommandCeiling: ReadonlySet<string> | null = null;
  if (principal.credentialType === "SESSION") {
    const session = await trx.selectFrom("web_sessions")
      .select(["subject_id", "expires_at", "revoked_at"])
      .where("id", "=", principal.credentialId)
      .executeTakeFirst();
    if (!session
      || session.subject_id !== principal.subjectId
      || session.revoked_at
      || new Date(session.expires_at).getTime() <= Date.now()) {
      return deny({
        ...auditContext,
        denialReason: "SESSION_INVALID",
        message: "Session is invalid or expired",
        code: "AUTHENTICATION_REQUIRED",
        statusCode: 401
      });
    }
  } else {
    const token = await trx.selectFrom("api_tokens")
      .select(["subject_id", "property_scope", "access_ceiling", "expires_at", "revoked_at"])
      .where("id", "=", principal.credentialId)
      .executeTakeFirst();
    if (!token || token.subject_id !== principal.subjectId) {
      return deny({
        ...auditContext,
        denialReason: "TOKEN_INVALID",
        message: "Bearer token is invalid",
        code: "AUTHENTICATION_REQUIRED",
        statusCode: 401
      });
    }
    if (token.property_scope !== propertyId) {
      return deny({
        ...auditContext,
        denialReason: "PROPERTY_SCOPE_MISSING",
        message: "Resource not found",
        code: "NOT_FOUND",
        statusCode: 404
      });
    }
    if (token.revoked_at) {
      return deny({
        ...auditContext,
        denialReason: "TOKEN_REVOKED",
        message: "Bearer token has been revoked",
        code: "TOKEN_REVOKED",
        statusCode: 401
      });
    }
    if (new Date(token.expires_at).getTime() <= Date.now()) {
      return deny({
        ...auditContext,
        denialReason: "TOKEN_EXPIRED",
        message: "Bearer token has expired",
        code: "TOKEN_EXPIRED",
        statusCode: 401
      });
    }
    credentialPropertyAccess = propertyGrant.access_level === "READ" || token.access_ceiling === "READ"
      ? "READ"
      : "WRITE";
    const tokenCeiling = await trx.selectFrom("token_command_ceilings")
      .select("command_type")
      .where("token_id", "=", principal.credentialId)
      .where("subject_id", "=", principal.subjectId)
      .where("property_id", "=", propertyId)
      .where("command_type", "=", commandType)
      .executeTakeFirst();
    tokenCommandCeiling = tokenCeiling ? new Set([tokenCeiling.command_type]) : new Set();
  }

  const evaluation = evaluateCommandAuthorization({
    commandType,
    subjectStatus: subject.status,
    propertyAccess: credentialPropertyAccess,
    subjectCommandGrants: commandGrant ? new Set([commandGrant.command_type]) : new Set(),
    credentialType: principal.credentialType,
    tokenCommandCeiling,
    featureEnabled: commandFeatureEnabled(commandType)
  });
  if (evaluation.allowed) return;

  return deny({
    ...auditContext,
    denialReason: evaluation.reason ?? "SUBJECT_COMMAND_GRANT_MISSING",
    message: evaluation.reason === "FEATURE_DISABLED"
      ? "Command feature is disabled in this release"
      : evaluation.reason === "TOKEN_COMMAND_CEILING_MISSING"
        ? "Token command ceiling does not include this command"
        : evaluation.reason === "PROPERTY_WRITE_REQUIRED"
          ? "WRITE access is required"
          : evaluation.reason === "SUBJECT_DISABLED"
            ? "Subject is disabled"
            : "Exact command grant is required",
    code: evaluation.reason === "SUBJECT_DISABLED" ? "SUBJECT_DISABLED" : "INSUFFICIENT_ACCESS"
  });
}

async function lockCredentialSnapshot(
  trx: Transaction<Database>,
  principal: AuthPrincipal,
  propertyId: string,
  tokenLifecycle: boolean,
  auditContext: SecurityAuditContext,
  scope: Pick<CommandAuthorizationLockScope, "relatedSubjectIds" | "relatedTokenIds">
): Promise<CredentialSnapshot> {
  let session: { subject_id: string; expires_at: Date; revoked_at: Date | null } | undefined;
  if (principal.credentialType === "SESSION") {
    session = await trx.selectFrom("web_sessions")
      .select(["subject_id", "expires_at", "revoked_at"])
      .where("id", "=", principal.credentialId)
      .forShare()
      .executeTakeFirst();
  }

  const tokenIds = sortedUniqueIds([
    ...(principal.credentialType === "TOKEN" ? [principal.credentialId] : []),
    ...(scope.relatedTokenIds ?? [])
  ]);
  const lockedTokens = new Map<string, LockedTokenSnapshot>();
  for (const tokenId of tokenIds) {
    let tokenQuery = trx.selectFrom("api_tokens")
      .select(["subject_id", "property_scope", "access_ceiling", "expires_at", "revoked_at"])
      .where("id", "=", tokenId);
    tokenQuery = tokenLifecycle ? tokenQuery.forUpdate() : tokenQuery.forShare();
    const token = await tokenQuery.executeTakeFirst();
    if (!token) {
      if (tokenId !== principal.credentialId || principal.credentialType !== "TOKEN") {
        return deny({
          ...auditContext,
          denialReason: "SUBJECT_SCOPE_MISSING",
          message: "Token not found",
          code: "NOT_FOUND",
          statusCode: 404
        });
      }
      return deny({
        ...auditContext,
        denialReason: "TOKEN_INVALID",
        message: "Bearer token is invalid",
        code: "AUTHENTICATION_REQUIRED",
        statusCode: 401
      });
    }
    const isCallerToken = principal.credentialType === "TOKEN" && tokenId === principal.credentialId;
    if (isCallerToken && token.subject_id !== principal.subjectId) {
      return deny({
        ...auditContext,
        denialReason: "TOKEN_INVALID",
        message: "Bearer token is invalid",
        code: "AUTHENTICATION_REQUIRED",
        statusCode: 401
      });
    }
    if (isCallerToken && token.property_scope !== propertyId) {
      return deny({
        ...auditContext,
        denialReason: "PROPERTY_SCOPE_MISSING",
        message: "Resource not found",
        code: "NOT_FOUND",
        statusCode: 404
      });
    }
    if (!isCallerToken && (token.property_scope !== propertyId || !(scope.relatedSubjectIds ?? []).includes(token.subject_id))) {
      return deny({
        ...auditContext,
        denialReason: "SUBJECT_SCOPE_MISSING",
        message: "Token not found",
        code: "NOT_FOUND",
        statusCode: 404
      });
    }
    lockedTokens.set(tokenId, {
      subjectId: token.subject_id,
      propertyScope: token.property_scope,
      accessCeiling: token.access_ceiling,
      expiresAt: new Date(token.expires_at),
      revokedAt: token.revoked_at
    });
  }

  const lockedTokenCeilings = new Map<string, ReadonlySet<string>>();
  for (const tokenId of tokenIds) {
    const token = lockedTokens.get(tokenId)!;
    lockedTokenCeilings.set(tokenId, await lockedTokenCommandCeiling(trx, tokenId, token.subjectId, propertyId));
  }

  if (principal.credentialType === "TOKEN") {
    const token = lockedTokens.get(principal.credentialId);
    if (!token || token.subjectId !== principal.subjectId) {
      return deny({
        ...auditContext,
        denialReason: "TOKEN_INVALID",
        message: "Bearer token is invalid",
        code: "AUTHENTICATION_REQUIRED",
        statusCode: 401
      });
    }
    if (token.revokedAt) {
      return deny({
        ...auditContext,
        denialReason: "TOKEN_REVOKED",
        message: "Bearer token has been revoked",
        code: "TOKEN_REVOKED",
        statusCode: 401
      });
    }
    if (token.expiresAt.getTime() <= Date.now()) {
      return deny({
        ...auditContext,
        denialReason: "TOKEN_EXPIRED",
        message: "Bearer token has expired",
        code: "TOKEN_EXPIRED",
        statusCode: 401
      });
    }
    return {
      credentialType: "TOKEN",
      propertyAccess: token.accessCeiling,
      tokenCommandCeiling: lockedTokenCeilings.get(principal.credentialId) ?? new Set(),
      expiresAt: token.expiresAt,
      lockedTokens,
      lockedTokenCeilings
    };
  }

  if (!session || session.subject_id !== principal.subjectId || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
    return deny({
      ...auditContext,
      denialReason: "SESSION_INVALID",
      message: "Session is invalid or expired",
      code: "AUTHENTICATION_REQUIRED",
      statusCode: 401
    });
  }
  return {
    credentialType: "SESSION",
    propertyAccess: "WRITE",
    tokenCommandCeiling: null,
    expiresAt: null,
    lockedTokens,
    lockedTokenCeilings
  };
}

function requiredConstraintString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DomainError("VALIDATION_ERROR", `${field} is required`);
  }
  return value.trim();
}

function requiredAccessLevel(value: unknown, field: string): AccessLevel {
  const accessLevel = requiredConstraintString(value, field);
  if (accessLevel !== "READ" && accessLevel !== "WRITE") {
    throw new DomainError("VALIDATION_ERROR", `${field} must be READ or WRITE`);
  }
  return accessLevel;
}

function requiredExactCommandCeiling(value: unknown, field: string): string[] {
  const commandCeiling = exactCommandCeiling(value, field);
  if (!commandCeiling) throw new DomainError("VALIDATION_ERROR", `${field} is required`);
  return commandCeiling;
}

function timestampMillis(value: Date | string, field: string): number {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new DomainError("VALIDATION_ERROR", `${field} must be an RFC 3339 date-time`);
  return timestamp;
}

type ResolvedTokenLifecycleConstraint =
  | {
      kind: "ISSUE_TOKEN";
      targetSubjectId: string;
      requestedAccessCeiling: unknown;
      requestedCommandCeiling: unknown;
      requestedExpiresAt: unknown;
    }
  | {
      kind: "ROTATE_TOKEN";
      targetTokenId: string;
      targetSubjectId: string;
      requestedCommandCeiling: unknown;
      requestedExpiresAt?: unknown;
    }
  | {
      kind: "REVOKE_TOKEN";
      targetTokenId: string;
      targetSubjectId: string;
    };

async function resolveTokenLifecycleConstraint(
  trx: Transaction<Database>,
  propertyId: string,
  constraint: CommandAuthorizationTokenLifecycleConstraint | undefined,
  auditContext: SecurityAuditContext
): Promise<ResolvedTokenLifecycleConstraint | undefined> {
  if (!constraint) return undefined;
  if (constraint.kind === "ISSUE_TOKEN") {
    return {
      kind: "ISSUE_TOKEN",
      targetSubjectId: requiredConstraintString(constraint.subjectId, "subjectId"),
      requestedAccessCeiling: constraint.accessCeiling,
      requestedCommandCeiling: constraint.commandCeiling,
      requestedExpiresAt: constraint.expiresAt
    };
  }

  const targetTokenId = requiredConstraintString(constraint.tokenId, "tokenId");
  const targetToken = await trx.selectFrom("api_tokens")
    .select(["id", "subject_id", "property_scope"])
    .where("id", "=", targetTokenId)
    .executeTakeFirst();
  if (!targetToken || targetToken.property_scope !== propertyId) {
    return deny({
      ...auditContext,
      denialReason: "SUBJECT_SCOPE_MISSING",
      message: "Token not found",
      code: "NOT_FOUND",
      statusCode: 404
    });
  }
  if (constraint.kind === "REVOKE_TOKEN") {
    return {
      kind: "REVOKE_TOKEN",
      targetTokenId: targetToken.id,
      targetSubjectId: targetToken.subject_id
    };
  }
  return {
    kind: "ROTATE_TOKEN",
    targetTokenId: targetToken.id,
    targetSubjectId: targetToken.subject_id,
    requestedCommandCeiling: constraint.commandCeiling,
    ...(constraint.expiresAt === undefined
      ? {}
      : { requestedExpiresAt: constraint.expiresAt })
  };
}

function lockedTokenTargetSubjectState(
  targetSubjectId: string,
  lockedSubjects: ReadonlyMap<string, { id: string; status: "ACTIVE" | "DISABLED" }>,
  lockedPropertyGrants: ReadonlyMap<string, { access_level: AccessLevel }>,
  lockedCommandGrants: ReadonlyMap<string, ReadonlySet<string>>,
  auditContext: SecurityAuditContext
): {
  status: "ACTIVE" | "DISABLED";
  propertyAccess: AccessLevel;
  commandGrants: ReadonlySet<string>;
} {
  const subject = lockedSubjects.get(targetSubjectId);
  const propertyGrant = lockedPropertyGrants.get(targetSubjectId);
  if (!subject || !propertyGrant) {
    return deny({
      ...auditContext,
      denialReason: "SUBJECT_SCOPE_MISSING",
      message: "Resource not found",
      code: "NOT_FOUND",
      statusCode: 404
    });
  }
  return {
    status: subject.status,
    propertyAccess: propertyGrant.access_level,
    commandGrants: lockedCommandGrants.get(targetSubjectId) ?? new Set()
  };
}

function effectiveCallerCommandGrants(
  subjectCommandGrants: ReadonlySet<string>,
  credential: CredentialSnapshot
): ReadonlySet<string> {
  const currentlyEnabledSubjectGrants = new Set([...subjectCommandGrants].filter((commandType) => (
    isHumanGrantableCommandCapability(commandType) && commandFeatureEnabled(commandType)
  )));
  if (credential.credentialType !== "TOKEN") return currentlyEnabledSubjectGrants;
  return new Set([...currentlyEnabledSubjectGrants].filter((commandType) => credential.tokenCommandCeiling.has(commandType)));
}

function denyIfCommandCeilingExceeds(
  requestedCommandCeiling: readonly string[],
  allowedCommands: ReadonlySet<string>,
  auditContext: SecurityAuditContext,
  denialReason: string,
  message: string
): void {
  if (requestedCommandCeiling.some((commandType) => !allowedCommands.has(commandType))) {
    return deny({
      ...auditContext,
      denialReason,
      message
    });
  }
}

function denyIfCallerTokenExpiryExceeded(
  credential: CredentialSnapshot,
  requestedExpiresAt: Date | string,
  auditContext: SecurityAuditContext
): void {
  if (credential.credentialType !== "TOKEN") return;
  if (timestampMillis(requestedExpiresAt, "expiresAt") > credential.expiresAt.getTime()) {
    return deny({
      ...auditContext,
      denialReason: "TOKEN_EXPIRY_CEILING_EXCEEDED",
      message: "A Token cannot issue or rotate a Token beyond its own expiry"
    });
  }
}

function assertResolvedTokenLifecycleConstraint(
  resolvedConstraint: ResolvedTokenLifecycleConstraint | undefined,
  credential: CredentialSnapshot,
  subjectCommandGrants: ReadonlySet<string>,
  lockedSubjects: ReadonlyMap<string, { id: string; status: "ACTIVE" | "DISABLED" }>,
  lockedPropertyGrants: ReadonlyMap<string, { access_level: AccessLevel }>,
  lockedCommandGrants: ReadonlyMap<string, ReadonlySet<string>>,
  auditContext: SecurityAuditContext
): void {
  if (!resolvedConstraint) return;
  const callerEffectiveCommands = effectiveCallerCommandGrants(subjectCommandGrants, credential);

  if (resolvedConstraint.kind === "ISSUE_TOKEN") {
    const requestedAccessCeiling = requiredAccessLevel(resolvedConstraint.requestedAccessCeiling, "accessCeiling");
    const requestedCommandCeiling = requiredExactCommandCeiling(resolvedConstraint.requestedCommandCeiling, "commandCeiling");
    const requestedExpiresAt = requiredConstraintString(resolvedConstraint.requestedExpiresAt, "expiresAt");
    const target = lockedTokenTargetSubjectState(
      resolvedConstraint.targetSubjectId,
      lockedSubjects,
      lockedPropertyGrants,
      lockedCommandGrants,
      auditContext
    );
    if (target.status !== "ACTIVE") {
      return deny({
        ...auditContext,
        denialReason: "TOKEN_TARGET_SUBJECT_DISABLED",
        message: "Subject is disabled",
        code: "SUBJECT_DISABLED"
      });
    }
    if (!accessAllows(target.propertyAccess, requestedAccessCeiling)) {
      return deny({
        ...auditContext,
        denialReason: "TOKEN_TARGET_ACCESS_CEILING_EXCEEDED",
        message: "Token access ceiling cannot exceed the target subject's property access"
      });
    }
    if (requestedAccessCeiling === "READ" && requestedCommandCeiling.length > 0) {
      throw new DomainError("VALIDATION_ERROR", "READ tokens cannot carry command ceilings");
    }
    denyIfCommandCeilingExceeds(
      requestedCommandCeiling,
      target.commandGrants,
      auditContext,
      "TOKEN_TARGET_COMMAND_CEILING_EXCEEDED",
      "Token command ceiling cannot exceed the target subject's exact command grants"
    );
    denyIfCommandCeilingExceeds(
      requestedCommandCeiling,
      callerEffectiveCommands,
      auditContext,
      "TOKEN_COMMAND_CEILING_ESCALATION",
      "Token command ceiling cannot exceed the caller's current command scope"
    );
    denyIfCallerTokenExpiryExceeded(credential, requestedExpiresAt, auditContext);
    return;
  }

  const targetToken = credential.lockedTokens.get(resolvedConstraint.targetTokenId);
  if (!targetToken) {
    return deny({
      ...auditContext,
      denialReason: "SUBJECT_SCOPE_MISSING",
      message: "Token not found",
      code: "NOT_FOUND",
      statusCode: 404
    });
  }
  const target = lockedTokenTargetSubjectState(
    targetToken.subjectId,
    lockedSubjects,
    lockedPropertyGrants,
    lockedCommandGrants,
    auditContext
  );
  if (target.status !== "ACTIVE") {
    return deny({
      ...auditContext,
      denialReason: "TOKEN_TARGET_SUBJECT_DISABLED",
      message: "Subject is disabled",
      code: "SUBJECT_DISABLED"
    });
  }
  if (resolvedConstraint.kind === "REVOKE_TOKEN") return;

  if (!accessAllows(target.propertyAccess, targetToken.accessCeiling)) {
    return deny({
      ...auditContext,
      denialReason: "TOKEN_TARGET_ACCESS_CEILING_EXCEEDED",
      message: "Token access ceiling cannot exceed the target subject's property access"
    });
  }
  if (targetToken.revokedAt) {
    return deny({
      ...auditContext,
      denialReason: "TOKEN_TARGET_REVOKED",
      message: "Token is already revoked"
    });
  }
  if (targetToken.expiresAt.getTime() <= Date.now()) {
    return deny({
      ...auditContext,
      denialReason: "TOKEN_TARGET_EXPIRED",
      message: "Token has expired"
    });
  }

  const requestedCommandCeiling = requiredExactCommandCeiling(resolvedConstraint.requestedCommandCeiling, "commandCeiling");
  denyIfCommandCeilingExceeds(
    requestedCommandCeiling,
    target.commandGrants,
    auditContext,
    "TOKEN_TARGET_COMMAND_CEILING_EXCEEDED",
    "Token command ceiling cannot exceed the target subject's exact command grants"
  );
  denyIfCommandCeilingExceeds(
    requestedCommandCeiling,
    callerEffectiveCommands,
    auditContext,
    "TOKEN_COMMAND_CEILING_ESCALATION",
    "Token command ceiling cannot exceed the caller's current command scope"
  );
  const requestedExpiresAt = resolvedConstraint.requestedExpiresAt === undefined
    ? targetToken.expiresAt
    : requiredConstraintString(resolvedConstraint.requestedExpiresAt, "expiresAt");
  denyIfCallerTokenExpiryExceeded(credential, requestedExpiresAt, auditContext);
}

export async function authorizeCommandAccess(
  _auditDb: Kysely<Database>,
  trx: Transaction<Database>,
  principal: AuthPrincipal,
  options: {
    propertyId: string;
    commandType: string;
    stage: CommandAuthorizationStage;
    idempotencyKey?: string | undefined;
    correlationId?: string | undefined;
    mode: "EXECUTE" | "READ";
  } & CommandAuthorizationLockScope
): Promise<void> {
  const commandType = baseCommandCatalogType(options.commandType);
  const tokenLifecycle = commandType === "ISSUE_TOKEN" || commandType === "ROTATE_TOKEN" || commandType === "REVOKE_TOKEN";
  const auditContext: SecurityAuditContext = {
    principal,
    propertyId: options.propertyId,
    commandType,
    stage: options.stage,
    idempotencyKey: options.idempotencyKey,
    correlationId: options.correlationId
  };

  if (commandType === "MANAGE_ROOM_CATALOG") {
    const admin = await trx.selectFrom("staff_profile_assignments").select("profile")
      .where("subject_id", "=", principal.subjectId).where("property_id", "=", options.propertyId).where("profile", "=", "ADMIN").executeTakeFirst();
    if (!admin || principal.credentialType !== "SESSION") deny({ ...auditContext, denialReason: "ADMIN_SESSION_REQUIRED", message: "仅管理员登录后可维护房型与价格" });
  }

  if (tokenLifecycle && options.mode === "EXECUTE") {
    await preflightTokenLifecycleCallerCapability(trx, principal, options.propertyId, commandType, auditContext);
  }

  const resolvedTokenLifecycleConstraint = await resolveTokenLifecycleConstraint(
    trx,
    options.propertyId,
    options.tokenLifecycleConstraint,
    auditContext
  );
  const targetSubjectIds = resolvedTokenLifecycleConstraint
    ? [resolvedTokenLifecycleConstraint.targetSubjectId]
    : [];
  const targetTokenIds = resolvedTokenLifecycleConstraint && resolvedTokenLifecycleConstraint.kind !== "ISSUE_TOKEN"
    ? [resolvedTokenLifecycleConstraint.targetTokenId]
    : [];
  const subjectIds = sortedUniqueIds([
    principal.subjectId,
    ...(options.relatedSubjectIds ?? []),
    ...targetSubjectIds
  ]);
  const lockedSubjects = new Map<string, { id: string; status: "ACTIVE" | "DISABLED" }>();
  for (const subjectId of subjectIds) {
    let subjectQuery = trx.selectFrom("subjects")
      .select(["id", "status"])
      .where("id", "=", subjectId);
    subjectQuery = tokenLifecycle ? subjectQuery.forUpdate() : subjectQuery.forShare();
    const lockedSubject = await subjectQuery.executeTakeFirst();
    if (!lockedSubject) {
      if (subjectId !== principal.subjectId) {
        return deny({
          ...auditContext,
          denialReason: "SUBJECT_SCOPE_MISSING",
          message: "Resource not found",
          code: "NOT_FOUND",
          statusCode: 404
        });
      }
      return deny({
        ...auditContext,
        denialReason: "SUBJECT_MISSING",
        message: "Subject is unavailable",
        code: "AUTHENTICATION_REQUIRED",
        statusCode: 401
      });
    }
    lockedSubjects.set(subjectId, lockedSubject);
  }
  const subject = lockedSubjects.get(principal.subjectId);
  if (!subject) {
    return deny({
      ...auditContext,
      denialReason: "SUBJECT_MISSING",
      message: "Subject is unavailable",
      code: "AUTHENTICATION_REQUIRED",
      statusCode: 401
    });
  }

  const lockedPropertyGrants = new Map<string, { access_level: AccessLevel }>();
  for (const subjectId of subjectIds) {
    const lockedGrant = await trx.selectFrom("subject_property_grants")
      .select("access_level")
      .where("subject_id", "=", subjectId)
      .where("property_id", "=", options.propertyId)
      .forShare()
      .executeTakeFirst();
    if (!lockedGrant) {
      return deny({
        ...auditContext,
        denialReason: subjectId === principal.subjectId ? "PROPERTY_SCOPE_MISSING" : "SUBJECT_SCOPE_MISSING",
        message: "Resource not found",
        code: "NOT_FOUND",
        statusCode: 404
      });
    }
    lockedPropertyGrants.set(subjectId, lockedGrant);
  }
  const grant = lockedPropertyGrants.get(principal.subjectId);
  if (!grant) {
    return deny({
      ...auditContext,
      denialReason: "PROPERTY_SCOPE_MISSING",
      message: "Resource not found",
      code: "NOT_FOUND",
      statusCode: 404
    });
  }

  const lockedCommandGrants = new Map<string, ReadonlySet<string>>();
  for (const subjectId of subjectIds) {
    lockedCommandGrants.set(subjectId, await lockedSubjectCommandGrants(trx, subjectId, options.propertyId));
  }
  const subjectCommandGrants = lockedCommandGrants.get(principal.subjectId) ?? new Set();
  const credential = await lockCredentialSnapshot(trx, principal, options.propertyId, tokenLifecycle, auditContext, {
    relatedSubjectIds: subjectIds,
    relatedTokenIds: sortedUniqueIds([
      ...(options.relatedTokenIds ?? []),
      ...targetTokenIds
    ])
  });
  const propertyAccess = credential.credentialType === "TOKEN"
    ? (grant.access_level === "READ" || credential.propertyAccess === "READ" ? "READ" : "WRITE")
    : grant.access_level;

  if (commandType === "CREATE_QUOTE") {
    if (subject.status !== "ACTIVE") {
      return deny({
        principal,
        propertyId: options.propertyId,
        commandType,
        stage: options.stage,
        denialReason: "SUBJECT_DISABLED",
        idempotencyKey: options.idempotencyKey,
        correlationId: options.correlationId,
        message: "Subject is disabled",
        code: "SUBJECT_DISABLED"
      });
    }
    if (!accessAllows(propertyAccess, "READ")) {
      return deny({
        ...auditContext,
        denialReason: "PROPERTY_SCOPE_MISSING",
        message: "Resource not found",
        code: "NOT_FOUND",
        statusCode: 404
      });
    }
    return;
  }

  if (options.mode === "READ") {
    if (subject.status !== "ACTIVE") {
      return deny({
        principal,
        propertyId: options.propertyId,
        commandType,
        stage: options.stage,
        denialReason: "SUBJECT_DISABLED",
        idempotencyKey: options.idempotencyKey,
        correlationId: options.correlationId,
        message: "Subject is disabled",
        code: "SUBJECT_DISABLED"
      });
    }
    if (isHumanGrantableCommandCapability(commandType) && propertyAccess !== "WRITE") {
      return deny({
        ...auditContext,
        denialReason: "PROPERTY_WRITE_REQUIRED",
        message: "WRITE access is required"
      });
    }
    if (!accessAllows(propertyAccess, "READ")) {
      return deny({
        ...auditContext,
        denialReason: "PROPERTY_SCOPE_MISSING",
        message: "Resource not found",
        code: "NOT_FOUND",
        statusCode: 404
      });
    }
    if (!subjectCommandGrants.has(commandType)) {
      return deny({
        principal,
        propertyId: options.propertyId,
        commandType,
        stage: options.stage,
        denialReason: "SUBJECT_COMMAND_GRANT_MISSING",
        idempotencyKey: options.idempotencyKey,
        correlationId: options.correlationId,
        message: "Exact command grant is required"
      });
    }
    if (credential.credentialType === "TOKEN" && !credential.tokenCommandCeiling.has(commandType)) {
      return deny({
        principal,
        propertyId: options.propertyId,
        commandType,
        stage: options.stage,
        denialReason: "TOKEN_COMMAND_CEILING_MISSING",
        idempotencyKey: options.idempotencyKey,
        correlationId: options.correlationId,
        message: "Token command ceiling does not include this command"
      });
    }
    return;
  }

  const evaluation = evaluateCommandAuthorization({
    commandType,
    subjectStatus: subject.status,
    propertyAccess,
    subjectCommandGrants,
    credentialType: credential.credentialType,
    tokenCommandCeiling: credential.tokenCommandCeiling,
    featureEnabled: commandFeatureEnabled(commandType)
  });
  if (evaluation.allowed) {
    assertResolvedTokenLifecycleConstraint(
      resolvedTokenLifecycleConstraint,
      credential,
      subjectCommandGrants,
      lockedSubjects,
      lockedPropertyGrants,
      lockedCommandGrants,
      auditContext
    );
    return;
  }

  return deny({
    principal,
    propertyId: options.propertyId,
    commandType,
    stage: options.stage,
    denialReason: evaluation.reason ?? "SUBJECT_COMMAND_GRANT_MISSING",
    idempotencyKey: options.idempotencyKey,
    correlationId: options.correlationId,
    message: evaluation.reason === "FEATURE_DISABLED"
      ? "Command feature is disabled in this release"
      : evaluation.reason === "TOKEN_COMMAND_CEILING_MISSING"
        ? "Token command ceiling does not include this command"
        : evaluation.reason === "PROPERTY_WRITE_REQUIRED"
          ? "WRITE access is required"
          : evaluation.reason === "SUBJECT_DISABLED"
            ? "Subject is disabled"
            : "Exact command grant is required",
    code: evaluation.reason === "SUBJECT_DISABLED" ? "SUBJECT_DISABLED" : "INSUFFICIENT_ACCESS"
  });
}

export async function effectiveSubjectCommandGrants(
  trx: Transaction<Database>,
  principal: AuthPrincipal,
  propertyId: string
): Promise<ReadonlySet<string>> {
  const subjectGrants = await lockedSubjectCommandGrants(trx, principal.subjectId, propertyId);
  const currentlyEnabledSubjectGrants = new Set([...subjectGrants].filter((commandType) => (
    isHumanGrantableCommandCapability(commandType) && commandFeatureEnabled(commandType)
  )));
  if (principal.credentialType !== "TOKEN") return currentlyEnabledSubjectGrants;
  const tokenCeiling = await lockedTokenCommandCeiling(trx, principal.credentialId, principal.subjectId, propertyId);
  return new Set([...currentlyEnabledSubjectGrants].filter((commandType) => commandType !== "MANAGE_ROOM_CATALOG" && tokenCeiling.has(commandType)));
}

export function exactCommandCeiling(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new DomainError("VALIDATION_ERROR", `${field} must be an array of exact command names`);
  }
  const normalized = [...new Set(value.map((entry) => (entry as string).trim()))].sort();
  if (normalized.some((entry) => (!isHumanGrantableCommandCapability(entry) || entry === "MANAGE_ROOM_CATALOG"))) {
    throw new DomainError("VALIDATION_ERROR", `${field} contains a non-grantable command`);
  }
  return normalized;
}

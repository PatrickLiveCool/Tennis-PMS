import type { AssistantSettings, AssistantSettingsInput, AssistantChatRequest, AssistantChatReply, AssistantQuestionFeedback } from "../../../packages/contracts/src/assistant.ts";
import type { AccountManagementContext, AccountManagementRequest, AccountManagementResult, MemberDeletionPreview, CommandEnvelope, CommandReason, CommandType, HistoricalCommandType, ReceiptDto, RoomStatusBoardDto, RoomStatusBoardQueryDto } from "@qintopia/contracts";
import type {
  AvailabilityDto,
  ClientCommandMetadata,
  CommandPreviewResponse,
  CreateQuoteCommandResponseDto,
  MaintenanceLockDto,
  MemberSummaryDto,
  MemberViewDto,
  MetaDto,
  OrderRowDto,
  PrincipalDto,
  HistoricalRecoverableCommandType,
  TokenDto,
  TokenTargetDto
} from "./types";
import { parseAvailability } from "./availabilityValidation";
import type { ExternalPaymentList } from "../../../packages/contracts/src/external-payments.ts";

interface ErrorPayload {
  code?: unknown;
  message?: unknown;
  correlationId?: unknown;
  retryable?: unknown;
  details?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(status: number, payload: ErrorPayload) {
    super(typeof payload.message === "string" ? payload.message : `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = typeof payload.code === "string" ? payload.code : "REQUEST_FAILED";
    this.correlationId = typeof payload.correlationId === "string" ? payload.correlationId : "";
    this.retryable = payload.retryable === true;
    this.details = payload.details;
  }
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return response.json();
  const text = await response.text();
  return text ? { message: text } : undefined;
}

function isReceipt(value: unknown): value is ReceiptDto {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.executionStatus === "string" && typeof record.businessCommitted === "boolean";
}

let sessionGeneration = 0;
let sessionExpired = false;
const sessionExpiredListeners = new Set<() => void>();

export function onSessionExpired(listener: () => void): () => void {
  sessionExpiredListeners.add(listener);
  return () => { sessionExpiredListeners.delete(listener); };
}

function expireSession(generation: number) {
  if (generation !== sessionGeneration || sessionExpired) return;
  sessionExpired = true;
  sessionGeneration += 1;
  for (const listener of sessionExpiredListeners) listener();
}

async function request<T>(path: string, init: RequestInit = {}, acceptRejectedReceipt = false): Promise<T> {
  const generation = sessionGeneration;
  if (sessionExpired && !path.startsWith("/api/v1/auth/")) {
    throw new ApiError(401, { code: "AUTHENTICATION_REQUIRED", message: "登录已过期，请重新登录" });
  }
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers
    }
  });
  // An old account's late read or command result cannot enter a new workspace.
  // A plain Error keeps a possibly submitted command in UNKNOWN recovery.
  if (generation !== sessionGeneration) throw new Error("登录身份已变化，请重新登录后查询原操作结果");
  if (response.status === 401 && path !== "/api/v1/auth/login") expireSession(generation);
  const body = await parseBody(response);
  if (response.status !== 401 && generation !== sessionGeneration) throw new Error("登录身份已变化，请查询原操作结果");
  if (!response.ok && !(acceptRejectedReceipt && isReceipt(body))) {
    throw new ApiError(response.status, (body ?? {}) as ErrorPayload);
  }
  return body as T;
}

function commandHeaders(scope: string) {
  const nonce = crypto.randomUUID();
  return {
    "Idempotency-Key": `web-${scope}-${nonce}`,
    "X-Correlation-ID": `web-${nonce}`
  };
}

function metadataHeaders(metadata: ClientCommandMetadata) {
  return {
    "Idempotency-Key": metadata.idempotencyKey,
    "X-Correlation-ID": metadata.correlationId
  };
}

function normalizeCommandResult(
  result: Partial<ReceiptDto> & Pick<ReceiptDto, "executionStatus" | "businessCommitted">
): ReceiptDto {
  return {
    receiptId: result.receiptId ?? "",
    commandId: result.commandId ?? "",
    executionStatus: result.executionStatus,
    businessCommitted: result.businessCommitted,
    correlationId: result.correlationId ?? "",
    ...(result.result ? { result: result.result } : {}),
    ...(result.error ? { error: result.error } : {}),
    resourceRefs: result.resourceRefs ?? [],
    factRefs: result.factRefs ?? [],
    ...(result.committedAt ? { committedAt: result.committedAt } : {})
  };
}

export const api = {
  assistantSettings: (propertyId: string) => request<AssistantSettings>(`/api/v1/assistant/settings?propertyId=${encodeURIComponent(propertyId)}`),
  assistantSave: (body: AssistantSettingsInput) => request<AssistantSettings>("/api/v1/assistant/settings", { method: "PUT", body: JSON.stringify(body) }),
  assistantTest: (body: AssistantSettingsInput) => request<{ message: string }>("/api/v1/assistant/test", { method: "POST", body: JSON.stringify(body) }),
  assistantChat: (body: AssistantChatRequest, signal: AbortSignal) => request<AssistantChatReply>("/api/v1/assistant/chat", { method: "POST", body: JSON.stringify(body), signal }),
  assistantFeedback: (questionId: string, propertyId: string, feedback: AssistantQuestionFeedback) => request<{ saved: true }>(`/api/v1/assistant/questions/${encodeURIComponent(questionId)}/feedback`, { method: "POST", body: JSON.stringify({ propertyId, feedback }) }),
  roomCatalog: (propertyId: string) => request<RoomCatalogView>(`/api/v1/properties/${encodeURIComponent(propertyId)}/room-catalog`),
  roomRateTrial: (propertyId: string, body: { anchors: RoomRateAnchors; arrivalDate: string; departureDate: string; multiplier: number }) =>
    request<{ nights: number; anchorNights: number; amountMinor: number }>(`/api/v1/properties/${encodeURIComponent(propertyId)}/room-rate-trial`, { method: "POST", body: JSON.stringify(body) }),
  externalPayments: (query: Record<string, string>, signal?: AbortSignal) => request<ExternalPaymentList>(
    `/api/v1/external-payments?${new URLSearchParams(query)}`, signal ? { signal } : {}),
  commandMetadata: (scope: string): ClientCommandMetadata => {
    const headers = commandHeaders(scope);
    return { idempotencyKey: headers["Idempotency-Key"], correlationId: headers["X-Correlation-ID"] };
  },
  me: () => request<PrincipalDto>("/api/v1/me"),
  accountManagement: (propertyId: string) => request<AccountManagementContext>(`/api/v1/account-management?${new URLSearchParams({ propertyId })}`),
  manageAccount: (body: AccountManagementRequest) => request<AccountManagementResult>("/api/v1/account-management", { method: "POST", body: JSON.stringify(body) }),
  memberDeletionPreview: (propertyId: string, memberId: string) => request<MemberDeletionPreview>(`/api/v1/members/${encodeURIComponent(memberId)}/deletion-preview?${new URLSearchParams({ propertyId })}`),
  login: async (username: string, password: string) => {
    sessionGeneration += 1;
    sessionExpired = false;
    await request<unknown>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    return request<PrincipalDto>("/api/v1/me");
  },
  logout: () => request<void>("/api/v1/auth/logout", { method: "POST" }),
  meta: () => request<MetaDto>("/api/v1/meta"),
  availability: (
    propertyId: string,
    arrivalDate: string,
    departureDate: string,
    unitKind?: "ROOM" | "BED",
    excludeOrderId?: string
  ) => {
    const query = new URLSearchParams({ arrivalDate, departureDate });
    if (unitKind) query.set("unitKind", unitKind);
    if (excludeOrderId) query.set("excludeOrderId", excludeOrderId);
    return request<unknown>(`/api/v1/properties/${encodeURIComponent(propertyId)}/availability?${query.toString()}`)
      .then((value) => parseAvailability(value, { propertyId, arrivalDate, departureDate, ...(unitKind ? { unitKind } : {}) }));
  },
  roomStatus: (
    propertyId: string,
    input: RoomStatusBoardQueryDto,
    signal?: AbortSignal
  ) => {
    const query = new URLSearchParams({
      arrivalDate: input.arrivalDate,
      departureDate: input.departureDate,
      page: String(input.page ?? 0),
      pageSize: String(input.pageSize ?? 40)
    });
    if (input.search) query.set("search", input.search);
    if (input.roomType) query.set("roomType", input.roomType);
    if (input.salesMode) query.set("salesMode", input.salesMode);
    if (input.status) query.set("status", input.status);
    if (input.minCapacity !== undefined) query.set("minCapacity", String(input.minCapacity));
    if (input.unitKind) query.set("unitKind", input.unitKind);
    return request<RoomStatusBoardDto>(
      `/api/v1/properties/${encodeURIComponent(propertyId)}/room-status?${query.toString()}`,
      signal ? { signal } : {}
    );
  },
  maintenanceLocks: (propertyId: string, status: "ACTIVE" | "RELEASED" = "ACTIVE") => {
    const query = new URLSearchParams({ propertyId, status });
    return request<{ maintenanceLocks: MaintenanceLockDto[] }>(`/api/v1/maintenance-locks?${query.toString()}`);
  },
  quote: (input: {
    propertyId: string;
    inventoryUnitId: string;
    stayType?: string;
    arrivalDate: string;
    departureDate: string;
    pricingPolicyVersionId: string;
    memberId?: string;
  }, metadata: ClientCommandMetadata, signal?: AbortSignal) => request<CreateQuoteCommandResponseDto>("/api/v1/quotes", {
    method: "POST",
    headers: metadataHeaders(metadata),
    body: JSON.stringify(input),
    ...(signal ? { signal } : {})
  }),
  orders: (propertyId: string, status?: string, options: { reconversionMemberId?: string; beforeId?: string; pageSize?: number; query?: string; workDate?: string; funds?: "BALANCE_DUE" | "OVERPAID"; orderIds?: string[]; signal?: AbortSignal } = {}) => {
    const query = new URLSearchParams({ propertyId });
    if (status) query.set("status", status);
    for (const id of options.orderIds ?? []) query.append("orderIds", id);
    if (options.query?.trim()) query.set("query", options.query.trim());
    if (options.funds) query.set("funds", options.funds);
    if (options.workDate) query.set("workDate", options.workDate);
    if (options.reconversionMemberId) query.set("reconversionMemberId", options.reconversionMemberId);
    if (options.beforeId) query.set("beforeId", options.beforeId);
    if (options.pageSize !== undefined) query.set("pageSize", String(options.pageSize));
    return request<{ businessDate: string; orders: OrderRowDto[]; nextCursor?: string | null }>(`/api/v1/orders?${query.toString()}`, options.signal ? { signal: options.signal } : {});
  },
  order: (orderId: string, signal?: AbortSignal) => request<unknown>(
    `/api/v1/orders/${encodeURIComponent(orderId)}`,
    signal ? { signal } : {}
  ).then(async (value) => (await import("./orderViewValidation")).parseOrderView(value)),
  members: (propertyId: string, memberQuery?: string, options: { beforeId?: string; pageSize?: number; memberId?: string; phone?: string; hasContract?: boolean; signal?: AbortSignal } = {}) => {
    const query = new URLSearchParams({ propertyId });
    if (memberQuery?.trim()) query.set("query", memberQuery.trim());
    for (const key of ["beforeId", "pageSize", "memberId", "phone", "hasContract"] as const) {
      if (options[key] !== undefined) query.set(key, String(options[key]));
    }
    return request<{ members: MemberSummaryDto[]; nextCursor: string | null }>(`/api/v1/members?${query.toString()}`, options.signal ? { signal: options.signal } : {});
  },
  member: (memberId: string, propertyId: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ propertyId });
    return request<MemberViewDto>(`/api/v1/members/${encodeURIComponent(memberId)}?${query.toString()}`, signal ? { signal } : {});
  },
  tokens: (propertyId: string) => {
    const query = new URLSearchParams({ propertyId });
    return request<{ tokens: TokenDto[] }>(`/api/v1/tokens?${query.toString()}`);
  },
  tokenTargets: (propertyId: string) => request<{ subjects: TokenTargetDto[] }>(
    `/api/v1/properties/${encodeURIComponent(propertyId)}/token-targets`
  ),
  preview: (envelope: CommandEnvelope, metadata: ClientCommandMetadata, signal?: AbortSignal) => request<CommandPreviewResponse>("/api/v1/command-previews", {
    method: "POST",
    headers: metadataHeaders(metadata),
    body: JSON.stringify(envelope),
    ...(signal ? { signal } : {})
  }),
  confirm: (
    previewId: string,
    propertyId: string,
    commandType: CommandType,
    effectHash: string,
    reason: CommandReason,
    idempotencyKey: string,
    signal?: AbortSignal
  ) => request<ReceiptDto>(`/api/v1/command-previews/${encodeURIComponent(previewId)}/confirm`, {
    method: "POST",
    headers: {
      "Idempotency-Key": idempotencyKey,
      "X-Correlation-ID": `web-confirm-${crypto.randomUUID()}`
    },
    body: JSON.stringify({ propertyId, commandType, confirmation: true, expectedEffectHash: effectHash, reason }),
    ...(signal ? { signal } : {})
  }, true),
  recoveryKey: (commandType: HistoricalCommandType) => `web-confirm-${commandType.toLowerCase()}-${crypto.randomUUID()}`,
  commandResult: (propertyId: string, commandType: HistoricalRecoverableCommandType, idempotencyKey: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ propertyId, commandType, idempotencyKey });
    return request<Partial<ReceiptDto> & Pick<ReceiptDto, "executionStatus" | "businessCommitted">>(`/api/v1/command-results?${query.toString()}`, signal ? { signal } : {})
      .then(normalizeCommandResult);
  },
  resolveCommandResult: (
    propertyId: string,
    commandType: HistoricalRecoverableCommandType,
    idempotencyKey: string,
    signal?: AbortSignal
  ) => {
    const metadata = api.commandMetadata("resolve-command-result");
    return request<Partial<ReceiptDto> & Pick<ReceiptDto, "executionStatus" | "businessCommitted">>(
      "/api/v1/command-results/resolve",
      {
        method: "POST",
        headers: metadataHeaders(metadata),
        body: JSON.stringify({ propertyId, commandType, idempotencyKey }),
        ...(signal ? { signal } : {})
      }
    ).then(normalizeCommandResult);
  }
};

export type { ClientCommandMetadata } from "./types";
import type { RoomCatalogView, RoomRateAnchors } from "@qintopia/contracts";

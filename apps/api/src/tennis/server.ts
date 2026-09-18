import { randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type pg from "pg";
import {
  authenticate,
  authenticateForContextSelection,
  createTenantStaff,
  listPlatformTenants,
  listTenantStaff,
  login,
  logout,
  provisionTenant,
  selectSessionContext,
  setPlatformTenantStatus,
  updateTenantStaff,
  type AuthContext,
  type SessionView,
} from "../../../../packages/db/src/tennis/auth.ts";
import { TenantAccessError } from "../../../../packages/db/src/tennis/access.ts";
import {
  accessibleCourts,
  accessibleVenues,
  bookingCustomers,
  financeLedger,
  orderDetail,
  orderList,
  venueSchedule,
} from "../../../../packages/db/src/tennis/views.ts";
import {
  createCourt,
  createVenue,
  listDiscounts,
  saveDiscount,
  setCourtPrice,
  updateCourt,
  updateVenue,
} from "../../../../packages/db/src/tennis/catalog.ts";
import {
  cancelUnpaidOrder,
  cancelFreeOrderLines,
  confirmQuote,
  createQuote,
  expireDueOrders,
  getCommandReceipt,
  listOrders,
  requireBookingVenue,
} from "../../../../packages/db/src/tennis/booking.ts";
import {
  createCustomer,
  isCustomerActor,
  requireCustomer,
  searchCustomers,
  withBookingTransaction,
  type BookingActor,
} from "../../../../packages/db/src/tennis/customers.ts";
import {
  occupyCourt,
  releaseCourtOccupancy,
  rescheduleCourtOccupancy,
} from "../../../../packages/db/src/tennis/inventory.ts";
import {
  beginOrderPayment,
  getOrderPayment,
  settleVerifiedPayment,
} from "../../../../packages/db/src/tennis/payments.ts";
import {
  getRefund,
  requestOrderRefund,
  retryFailedRefund,
  settleVerifiedRefund,
} from "../../../../packages/db/src/tennis/refunds.ts";
import { getWallet, recordOfflineTopup } from "../../../../packages/db/src/tennis/wallet.ts";
import {
  beginTopupPayment,
  createTopupQuote,
  getTopupPayment,
  listTopupOffers,
  saveTopupOffer,
  settleVerifiedTopup,
} from "../../../../packages/db/src/tennis/topups.ts";
import { LocalMockPaymentGateway } from "../../../../packages/db/src/tennis/mock-payments.ts";
import { registerAssistantRoutes } from "./assistant-routes.ts";
import type { AgentTransport } from "../../../../packages/db/src/tennis/external-agent.ts";
import {
  previewOrderAmendment,
  confirmOrderAmendment,
  beginAmendmentPayment,
  cancelOrderAmendment,
  getOrderAmendment,
  listOrderAmendments,
  expireDueAmendments,
} from "../../../../packages/db/src/tennis/amendments.ts";
import { requestOrderRefundGroup, getRefundGroup } from "../../../../packages/db/src/tennis/refunds.ts";

export interface TennisServerOptions {
  db: pg.Pool;
  gateway: LocalMockPaymentGateway;
  allowSimulation: boolean;
  origins?: string[];
  runExpiryWorker?: boolean;
  logger?: boolean;
  aiEncryptionKey?: Buffer;
  agentTransport?: AgentTransport;
}
class HttpError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(code);
  }
}
const id = Type.String({ minLength: 1, maxLength: 200 });
const name = Type.String({ minLength: 1, maxLength: 200 });
const cents = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const revision = Type.Integer({ minimum: 1 });
const timestamp = Type.String({ minLength: 20, maxLength: 40 });
const reason = Type.String({ minLength: 1, maxLength: 2000 });
const commandKey = Type.String({ minLength: 8, maxLength: 128 });
const obj = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const params = (request: FastifyRequest) => request.params as Record<string, string>;
const query = (request: FastifyRequest) => request.query as Record<string, string | undefined>;
const messages: Record<string, string> = {
  ASSISTANT_NOT_CONFIGURED: "AI 助手尚未连接外部服务，请联系平台运营方配置。",
  ASSISTANT_BUSY: "上一条消息正在处理中，请稍后查看原会话结果。",
  ASSISTANT_RESULT_UNKNOWN: "AI 助手的处理结果尚未确认，请转人工核对原订单和付款后继续，避免重复交易。",
  HUMAN_HANDOFF_ACTIVE: "会话已转人工处理，请由工作人员继续办理。",
  AGENT_DELEGATION_REVOKED: "本次智能体授权已失效，请重新核对会话状态。",
  AGENT_SCOPE_DENIED: "本次智能体授权不包含该场馆。",
  INVALID_AGENT_CONFIG: "请检查外部服务地址及配置。公网地址需要 HTTPS。",
  INVALID_CREDENTIALS: "账号或密码不正确，请重新输入。",
  SESSION_EXPIRED: "登录已失效，请重新登录。",
  AUTH_CONTEXT_REVOKED: "当前身份权限已变更，请重新选择工作空间。",
  CSRF_REJECTED: "页面验证已更新，请刷新后重试。",
  WORKSPACE_CHANGED: "工作空间已切换，请在当前租户重新操作。",
  ORIGIN_REJECTED: "此访问来源未获允许。",
  SELECT_TENANT: "请先选择要办理业务的租户。",
  TENANT_ACCESS_DENIED: "当前账号没有此操作或场馆的权限。",
  PLATFORM_ACCESS_DENIED: "此设置仅限平台运营人员。",
  RESOURCE_NOT_FOUND: "记录不存在或不在当前可访问范围内。",
  RESOURCE_UNAVAILABLE: "该场馆或球场当前不可售。",
  INVENTORY_CONFLICT: "所选球场或时间已被占用，请刷新排场后重新选择。",
  QUOTE_EXPIRED: "报价已过期，请重新获取报价。",
  QUOTE_ALREADY_USED: "该报价已用于订单，请打开原订单继续办理。",
  STALE_ORDER: "订单已被更新，请刷新后再确认。",
  STALE_CONFIGURATION: "配置已被其他工作人员更新，请刷新后修改。",
  INSUFFICIENT_BALANCE: "可用余额不足，请减少余额支付金额或先充值。",
  PAYMENT_ALREADY_PENDING: "本单已有待处理付款，请查看原付款结果。",
  ORDER_NOT_PAYABLE: "订单当前不能付款，请查看订单状态。",
  REFUND_EXCEEDS_PAYMENT: "退款金额超过本明细或原支付来源的可退金额。",
  INVALID_REFUND: "请检查退款明细及金额。",
  ORDER_REQUIRES_REFUND: "此单已有付款，请通过退款流程处理。",
  AFFECTED_OCCUPANCIES: "此修改会影响已有预约，请先处理相关预约。",
  DISCOUNT_OVERLAP: "折扣与已有规则重叠，请调整日期、时间或球场范围。",
  PRICE_NOT_CONFIGURED: "请先配置球场单价、营业时间及最短可售时长。",
  BELOW_MINIMUM_DURATION: "选择的时长短于场馆最短可售时长。",
  OUTSIDE_OPENING_HOURS: "选择的时间不在营业时段内。",
  IDEMPOTENCY_KEY_REUSED: "该操作编号已用于其他内容，请先核实原操作结果。",
  PHONE_ALREADY_EXISTS: "该手机号已有客户档案，请搜索后选择。",
  INVALID_DATE: "请选择有效日期。",
  INVALID_HOLD: "保留预约需要未来的付款截止时间和原因。",
  PAST_INTERVAL: "不能预订已经开始的时段。",
  USERNAME_ALREADY_EXISTS: "此登录账号已被使用。",
  INVALID_TENANT_STATUS: "请核对租户状态并填写操作原因。",
  STALE_TENANT_STATUS: "租户状态已变化，请刷新列表后重新核对。",
  LAST_TENANT_ADMIN: "租户至少需要保留一名有效管理员。",
  INVALID_ACCOUNT: "请检查账号、姓名及密码；密码至少 12 位。",
  SIMULATION_DISABLED: "此环境未启用模拟支付。",
};
export async function buildTennisServer(options: TennisServerOptions) {
  const { db, gateway } = options;
  const app = Fastify({
    logger: options.logger
      ? {
          redact: [
            "req.headers.cookie",
            "req.headers.authorization",
            "req.body.password",
            "req.body.adminPassword",
            "req.body.apiKey",
          ],
        }
      : false,
    bodyLimit: 128 * 1024,
    ajv: { customOptions: { removeAdditional: false } },
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  const origins = new Set(
    options.origins ?? ["http://127.0.0.1:4273", "http://localhost:4273", "http://127.0.0.1:4200"],
  );
  const contexts = new WeakMap<FastifyRequest, AuthContext>();
  const session = (request: FastifyRequest) => {
    const value = contexts.get(request);
    if (!value) throw new HttpError("SESSION_EXPIRED", 401);
    return value;
  };
  const actor = (request: FastifyRequest): BookingActor => {
    const value = session(request).actor;
    if (!value) throw new HttpError("SELECT_TENANT", 409);
    return value;
  };
  const staff = (request: FastifyRequest) => {
    const value = actor(request);
    if (isCustomerActor(value)) throw new TenantAccessError("TENANT_ACCESS_DENIED");
    return value;
  };
  const view = (input: SessionView | AuthContext) => {
    const { sessionId: _id, actor: _actor, ...safe } = input as AuthContext;
    return { ...safe, localSimulation: options.allowSimulation };
  };
  const simulation = () => {
    if (!options.allowSimulation) throw new HttpError("SIMULATION_DISABLED", 403);
  };
  app.setErrorHandler((error, request, reply) => {
    const candidate = error as Error & { code?: string; statusCode?: number; validation?: unknown };
    let code = candidate.validation
      ? "INVALID_REQUEST"
      : (candidate.code ?? (candidate.message === "INVALID_DATE" ? "INVALID_DATE" : "INTERNAL_ERROR"));
    if (!/^[A-Z_]+$/.test(code) || code.startsWith("FST_"))
      code = candidate.statusCode && candidate.statusCode < 500 ? "INVALID_REQUEST" : "INTERNAL_ERROR";
    const status = candidate.validation
      ? 400
      : (candidate.statusCode ??
        (code === "SESSION_EXPIRED" || code === "INVALID_CREDENTIALS"
          ? 401
          : ["TENANT_ACCESS_DENIED", "PLATFORM_ACCESS_DENIED", "AUTH_CONTEXT_REVOKED"].includes(code)
            ? 403
            : code === "RESOURCE_NOT_FOUND"
              ? 404
              : code === "INTERNAL_ERROR"
                ? 500
                : 409));
    if (status >= 500) request.log.error({ err: error }, "Tennis request failed");
    return reply
      .code(status)
      .send({
        error: {
          code,
          message:
            messages[code] ??
            (status >= 500
              ? "系统暂时无法处理，请保留当前输入并查询原操作结果。"
              : "当前操作未完成，请检查输入或刷新记录后重试。"),
        },
      });
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff");
    const origin = request.headers.origin;
    if (origin && !origins.has(origin)) throw new HttpError("ORIGIN_REJECTED", 403);
    const pathname = request.url.split("?")[0];
    if (pathname === "/health" || pathname === "/api/tennis/auth/login" || pathname?.startsWith("/api/tennis/agent/"))
      return;
    const recoveryRoute = ["/api/tennis/session", "/api/tennis/session/context", "/api/tennis/auth/logout"].includes(
      pathname ?? "",
    );
    const context = await (recoveryRoute ? authenticateForContextSelection : authenticate)(
      db,
      request.cookies.tennis_session ?? "",
    );
    contexts.set(request, context);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const supplied = request.headers["x-csrf-token"];
      if (
        typeof supplied !== "string" ||
        Buffer.byteLength(supplied) !== Buffer.byteLength(context.csrfToken) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(context.csrfToken))
      )
        throw new HttpError("CSRF_REJECTED", 403);
      if (request.headers["x-workspace-version"] !== String(context.contextVersion))
        throw new HttpError("WORKSPACE_CHANGED", 409);
    }
  });
  const base = "/api/tennis";
  function get(path: string, work: (request: FastifyRequest) => Promise<unknown> | unknown) {
    app.get(`${base}${path}`, async (request) => work(request));
  }
  function write<S extends TSchema>(
    method: "POST" | "PATCH" | "PUT",
    path: string,
    schema: S,
    work: (request: FastifyRequest, input: Static<S>) => Promise<unknown> | unknown,
  ) {
    app.route<{ Body: Static<S> }>({
      method,
      url: `${base}${path}`,
      schema: { body: schema },
      handler: async (request) => work(request, request.body),
    });
  }
  app.get("/health", async () => {
    await db.query("SELECT 1");
    return { ok: true, product: "Tennis PMS", paymentMode: "MOCK" };
  });
  app.post<{ Body: { username: string; password: string } }>(
    `${base}/auth/login`,
    {
      schema: {
        body: obj({
          username: Type.String({ minLength: 1, maxLength: 100 }),
          password: Type.String({ minLength: 1, maxLength: 256 }),
        }),
      },
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const result = await login(db, request.body);
      reply.setCookie("tennis_session", result.token, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        secure: false,
        maxAge: 8 * 3600,
      });
      return view(result.session);
    },
  );
  get("/session", (request) => view(session(request)));
  get("/config", () => ({
    localSimulation: options.allowSimulation,
    currency: "CNY",
    granularityMinutes: 15,
    defaultDurationMinutes: 60,
  }));
  write(
    "POST",
    "/session/context",
    obj({
      tenantId: Type.Union([id, Type.Null()]),
      kind: Type.Union([Type.Literal("staff"), Type.Literal("customer"), Type.Literal("platform")]),
    }),
    async (request, input) => view(await selectSessionContext(db, request.cookies.tennis_session!, input)),
  );
  app.post(`${base}/auth/logout`, async (request, reply) => {
    await logout(db, request.cookies.tennis_session!);
    reply.clearCookie("tennis_session", { path: "/" });
    return { ok: true };
  });
  get("/platform/tenants", (request) => listPlatformTenants(db, session(request).subjectId));
  write(
    "POST",
    "/platform/tenants",
    obj({
      name,
      adminUsername: name,
      adminDisplayName: name,
      adminPassword: Type.String({ minLength: 12, maxLength: 256 }),
    }),
    (request, input) => provisionTenant(db, session(request).subjectId, input),
  );
  write(
    "POST",
    "/platform/tenants/:id/status",
    obj({ active: Type.Boolean(), expectedActive: Type.Boolean(), reason }),
    (request, input) =>
      setPlatformTenantStatus(db, session(request).subjectId, { ...input, tenantId: params(request).id! }),
  );
  const permission = Type.Union(
    ["read", "book", "manage_assets", "manage_prices", "refund", "hold_unpaid", "manage_members"].map((value) =>
      Type.Literal(
        value as "read" | "book" | "manage_assets" | "manage_prices" | "refund" | "hold_unpaid" | "manage_members",
      ),
    ),
  );
  const grant = {
    role: Type.Union([Type.Literal("ADMIN"), Type.Literal("STAFF"), Type.Literal("VIEWER")]),
    permissions: Type.Array(permission, { uniqueItems: true }),
    allVenues: Type.Boolean(),
    venueIds: Type.Array(id, { uniqueItems: true, maxItems: 100 }),
    active: Type.Boolean(),
  };
  get("/staff", (request) => listTenantStaff(db, staff(request)));
  write(
    "POST",
    "/staff",
    obj({ ...grant, username: name, displayName: name, password: Type.String({ minLength: 12, maxLength: 256 }) }),
    (request, input) => createTenantStaff(db, staff(request), input),
  );
  write("PATCH", "/staff/:id", obj(grant), (request, input) =>
    updateTenantStaff(db, staff(request), params(request).id!, input),
  );
  get("/venues", (request) => accessibleVenues(db, actor(request)));
  write(
    "POST",
    "/venues",
    obj({ name, address: Type.Optional(Type.String({ maxLength: 1000 })), timezone: name }),
    (request, input) => createVenue(db, staff(request), input),
  );
  const opening = obj({
    weekday: Type.Integer({ minimum: 0, maximum: 6 }),
    startMinute: Type.Integer({ minimum: 0, maximum: 1440 }),
    endMinute: Type.Integer({ minimum: 0, maximum: 1440 }),
  });
  write(
    "PATCH",
    "/venues/:id",
    obj({
      expectedRevision: revision,
      name,
      address: Type.String({ maxLength: 1000 }),
      timezone: name,
      active: Type.Boolean(),
      openingHours: Type.Array(opening, { maxItems: 100 }),
      minimumBookingMinutes: Type.Integer({ minimum: 15, maximum: 1440 }),
    }),
    (request, input) => updateVenue(db, staff(request), { ...input, id: params(request).id! }),
  );
  get("/venues/:id/courts", (request) => accessibleCourts(db, actor(request), params(request).id!));
  write("POST", "/venues/:id/courts", obj({ name, indoor: Type.Boolean() }), (request, input) =>
    createCourt(db, staff(request), { ...input, venueId: params(request).id! }),
  );
  write(
    "PATCH",
    "/venues/:venueId/courts/:id",
    obj({ expectedRevision: revision, name, indoor: Type.Boolean(), active: Type.Boolean() }),
    (request, input) =>
      updateCourt(db, staff(request), { ...input, id: params(request).id!, venueId: params(request).venueId! }),
  );
  write(
    "PATCH",
    "/venues/:venueId/courts/:id/price",
    obj({ expectedRevision: revision, hourlyPriceCents: cents }),
    (request, input) =>
      setCourtPrice(db, staff(request), { ...input, courtId: params(request).id!, venueId: params(request).venueId! }),
  );
  get("/venues/:id/discounts", (request) => listDiscounts(db, staff(request), params(request).id!));
  const discountRule = obj({
    id: Type.Optional(id),
    name,
    venueId: id,
    courtIds: Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true }),
    dateFrom: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    dateTo: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
    weekdays: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { minItems: 1, maxItems: 7, uniqueItems: true }),
    startMinute: Type.Integer({ minimum: 0, maximum: 1440 }),
    endMinute: Type.Integer({ minimum: 0, maximum: 1440 }),
    discountBps: Type.Integer({ minimum: 0, maximum: 10000 }),
  });
  write(
    "POST",
    "/venues/:id/discounts",
    obj({ rule: discountRule, expectedRevision: Type.Optional(revision), active: Type.Boolean() }),
    (request, input) => {
      if (input.rule.venueId !== params(request).id) throw new HttpError("INVALID_REQUEST", 400);
      return saveDiscount(db, staff(request), input);
    },
  );
  get("/venues/:id/schedule", (request) =>
    venueSchedule(db, actor(request), params(request).id!, query(request).date ?? ""),
  );
  get("/venues/:id/finance", (request) =>
    financeLedger(db, actor(request), params(request).id!, query(request).date ?? ""),
  );
  get("/venues/:id/booking-customers", (request) =>
    bookingCustomers(db, actor(request), params(request).id!, query(request).q ?? ""),
  );
  get("/customers", async (request) => {
    const principal = actor(request);
    if (isCustomerActor(principal))
      return withBookingTransaction(db, principal, async (tx) => [
        await requireCustomer(tx, principal, principal.customerId),
      ]);
    return searchCustomers(db, principal, query(request).q ?? "");
  });
  write(
    "POST",
    "/customers",
    obj({ nickname: name, phone: Type.Optional(Type.Union([Type.String({ maxLength: 30 }), Type.Null()])) }),
    (request, input) => createCustomer(db, staff(request), input),
  );
  get("/customers/:id/wallet", (request) => getWallet(db, actor(request), params(request).id!));
  const line = obj({ courtId: id, startAt: timestamp, endAt: timestamp });
  write(
    "POST",
    "/quotes",
    obj({ venueId: id, customerId: id, lines: Type.Array(line, { minItems: 1, maxItems: 100 }) }),
    (request, input) => createQuote(db, actor(request), input),
  );
  write(
    "POST",
    "/quotes/:id/confirm",
    obj({ commandKey, staffHold: Type.Optional(obj({ until: timestamp, reason })) }),
    (request, input) => confirmQuote(db, actor(request), { ...input, quoteId: params(request).id! }),
  );
  get("/venues/:id/orders", (request) => orderList(db, actor(request), params(request).id!));
  get("/orders/:id", (request) => orderDetail(db, actor(request), params(request).id!));
  write("POST", "/orders/:id/cancel", obj({ commandKey, expectedRevision: revision, reason }), (request, input) =>
    cancelUnpaidOrder(db, actor(request), { ...input, orderId: params(request).id! }),
  );
  write(
    "POST",
    "/orders/:id/cancel-free-lines",
    obj({
      commandKey,
      expectedRevision: revision,
      reason,
      lineIds: Type.Array(id, { minItems: 1, maxItems: 100, uniqueItems: true }),
    }),
    (request, input) => cancelFreeOrderLines(db, staff(request), { ...input, orderId: params(request).id! }),
  );
  write(
    "POST",
    "/orders/:id/payments",
    obj({ walletCents: cents, commandKey, staffReason: Type.Optional(reason) }),
    (request, input) => beginOrderPayment(db, actor(request), gateway, { ...input, orderId: params(request).id! }),
  );
  get("/payments/:id", (request) => getOrderPayment(db, actor(request), params(request).id!));
  const simulateBody = obj({ status: Type.Union([Type.Literal("SUCCEEDED"), Type.Literal("FAILED")]) });
  write("POST", "/payments/:id/simulate", simulateBody, async (request, input) => {
    simulation();
    const principal = actor(request);
    const payment = await getOrderPayment(db, principal, params(request).id!);
    await withBookingTransaction(db, principal, async (tx) =>
      requireBookingVenue(tx, principal, payment.venueId, "book"),
    );
    if (
      payment.provider === "WALLET" ||
      payment.providerTransactionId ||
      (input.status === "FAILED" && payment.status !== "PENDING")
    )
      return payment;
    const signed = gateway.signForLocalSimulator({
      provider: "MOCK",
      paymentId: payment.id,
      merchantId: payment.merchantId,
      eventId: randomUUID(),
      transactionId: `mock-order:${payment.id}`,
      status: input.status,
      amountCents: payment.externalCents,
      currency: "CNY",
      issuedAt: Date.now(),
    });
    return settleVerifiedPayment(db, gateway.verify(signed.body, signed.signature));
  });
  write(
    "POST",
    "/orders/:id/refunds",
    obj({
      expectedRevision: revision,
      reason,
      commandKey,
      lines: Type.Array(obj({ lineId: id, refundCents: cents, cancel: Type.Boolean() }), {
        minItems: 1,
        maxItems: 100,
      }),
    }),
    (request, input) => requestOrderRefundGroup(db, staff(request), { ...input, orderId: params(request).id! }),
  );
  get("/refund-groups/:id", (request) => getRefundGroup(db, actor(request), params(request).id!));
  get("/orders/:id/amendments", (request) => listOrderAmendments(db, actor(request), params(request).id!));
  get("/amendments/:id", (request) => getOrderAmendment(db, actor(request), params(request).id!));
  write(
    "POST",
    "/orders/:id/amendments",
    obj({
      expectedRevision: revision,
      reason,
      changes: Type.Array(obj({ lineId: id, courtId: id, startAt: timestamp, endAt: timestamp }), {
        minItems: 1,
        maxItems: 100,
      }),
    }),
    (request, input) => previewOrderAmendment(db, staff(request), { ...input, orderId: params(request).id! }),
  );
  write(
    "POST",
    "/amendments/:id/confirm",
    obj({
      commandKey,
      approvedRefundLines: Type.Optional(Type.Array(obj({ lineId: id, refundCents: cents }), { maxItems: 100 })),
    }),
    (request, input) => confirmOrderAmendment(db, staff(request), { ...input, amendmentId: params(request).id! }),
  );
  write("POST", "/amendments/:id/cancel", obj({ commandKey, reason }), (request, input) =>
    cancelOrderAmendment(db, staff(request), { ...input, amendmentId: params(request).id! }),
  );
  write(
    "POST",
    "/amendments/:id/payments",
    obj({ commandKey, walletCents: cents, staffReason: Type.Optional(reason) }),
    (request, input) =>
      beginAmendmentPayment(db, actor(request), gateway, { ...input, amendmentId: params(request).id! }),
  );
  get("/refunds/:id", (request) => getRefund(db, actor(request), params(request).id!));
  write("POST", "/refunds/:id/retry", obj({ commandKey }), (request, input) =>
    retryFailedRefund(db, staff(request), params(request).id!, input.commandKey),
  );
  write("POST", "/refunds/:id/simulate", simulateBody, async (request, input) => {
    simulation();
    const principal = staff(request);
    const refund = await getRefund(db, principal, params(request).id!);
    await withBookingTransaction(db, principal, async (tx) =>
      requireBookingVenue(tx, principal, refund.venueId, "refund"),
    );
    if (refund.status === "SUCCEEDED" || refund.externalCents === 0) return refund;
    const payment = await getOrderPayment(db, principal, refund.paymentId);
    const signed = gateway.signForLocalSimulator({
      eventType: "REFUND",
      provider: "MOCK",
      merchantId: payment.merchantId,
      refundId: refund.id,
      eventId: randomUUID(),
      transactionId: payment.providerTransactionId!,
      providerRefundId: `mock-refund:${refund.id}`,
      status: input.status,
      amountCents: refund.externalCents,
      currency: "CNY",
      issuedAt: Date.now(),
    });
    return settleVerifiedRefund(db, gateway.verifyRefund(signed.body, signed.signature));
  });
  write(
    "POST",
    "/customers/:id/topups/offline",
    obj({ venueId: id, principalCents: cents, giftCents: cents, receiptReference: name, reason, commandKey }),
    (request, input) => recordOfflineTopup(db, staff(request), { ...input, customerId: params(request).id! }),
  );
  get("/topup-offers", (request) => listTopupOffers(db, actor(request)));
  write(
    "POST",
    "/topup-offers",
    obj({
      id: Type.Optional(id),
      expectedRevision: Type.Optional(revision),
      name,
      principalCents: cents,
      giftCents: cents,
      active: Type.Boolean(),
    }),
    (request, input) => saveTopupOffer(db, staff(request), input),
  );
  write(
    "POST",
    "/customers/:id/topup-quotes",
    obj({ venueId: id, principalCents: Type.Optional(cents), offerId: Type.Optional(id) }),
    (request, input) => createTopupQuote(db, actor(request), { ...input, customerId: params(request).id! }),
  );
  write("POST", "/topup-quotes/:id/confirm", obj({ commandKey }), (request, input) =>
    beginTopupPayment(db, actor(request), gateway, { ...input, quoteId: params(request).id! }),
  );
  get("/topups/:id", (request) => getTopupPayment(db, actor(request), params(request).id!));
  write("POST", "/topups/:id/simulate", simulateBody, async (request, input) => {
    simulation();
    const payment = await getTopupPayment(db, actor(request), params(request).id!);
    if (payment.status === "SUCCEEDED") return payment;
    const signed = gateway.signForLocalSimulator({
      provider: "MOCK",
      paymentId: payment.id,
      merchantId: payment.merchantId,
      eventId: randomUUID(),
      transactionId: `mock-topup:${payment.id}`,
      status: input.status,
      amountCents: payment.principalCents,
      currency: "CNY",
      issuedAt: Date.now(),
    });
    return settleVerifiedTopup(db, gateway.verify(signed.body, signed.signature));
  });
  get("/receipts/:id", (request) => getCommandReceipt(db, actor(request), params(request).id!));
  write(
    "POST",
    "/occupancies",
    obj({
      id,
      courtId: id,
      kind: Type.Union([Type.Literal("COURSE"), Type.Literal("MAINTENANCE")]),
      sourceId: id,
      startAt: timestamp,
      endAt: timestamp,
    }),
    async (request, input) => {
      await occupyCourt(db, staff(request), input);
      return { id: input.id };
    },
  );
  write(
    "PATCH",
    "/occupancies/:id",
    obj({ expectedRevision: revision, courtId: id, startAt: timestamp, endAt: timestamp }),
    async (request, input) => {
      await rescheduleCourtOccupancy(
        db,
        staff(request),
        params(request).id!,
        input.expectedRevision,
        input.courtId,
        input,
      );
      return { ok: true };
    },
  );
  write("POST", "/occupancies/:id/release", obj({ expectedRevision: revision }), async (request, input) => {
    await releaseCourtOccupancy(db, staff(request), params(request).id!, input.expectedRevision);
    return { ok: true };
  });
  let worker: ReturnType<typeof setInterval> | undefined;
  if (options.aiEncryptionKey)
    registerAssistantRoutes(app, {
      db,
      key: options.aiEncryptionKey,
      gateway,
      actor,
      subject: (request) => session(request).subjectId,
      ...(options.agentTransport ? { transport: options.agentTransport } : {}),
    });
  let ticking = false;
  if (options.runExpiryWorker) {
    worker = setInterval(() => {
      if (ticking) return;
      ticking = true;
      void expireDueOrders(db)
        .then(() => expireDueAmendments(db))
        .catch((error) => app.log.error({ err: error }, "Hold expiry failed"))
        .finally(() => {
          ticking = false;
        });
    }, 15000);
    worker.unref();
  }
  app.addHook("onClose", async () => {
    if (worker) clearInterval(worker);
  });
  return app;
}

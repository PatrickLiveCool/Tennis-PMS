import type pg from "pg";
import { accessibleCourts, orderDetail, venueSchedule } from "../../../../packages/db/src/tennis/views.ts";
import { withBookingTransaction, type BookingActor } from "../../../../packages/db/src/tennis/customers.ts";
import { requireBookingVenue } from "../../../../packages/db/src/tennis/booking.ts";
import { isWithinOpeningHours } from "../../../../packages/domain/src/tennis-pricing.ts";
import { parseCourtInterval } from "../../../../packages/domain/src/court-interval.ts";
import type { AssistantSelection, BackofficeAction, BackofficeRun } from "../../../../packages/db/src/tennis/backoffice-assistant.ts";

export class AssistantPreparationError extends Error {}

function dateAt(iso: string, timezone: string) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  return ["year", "month", "day"].map((k) => p.find((v) => v.type === k)!.value).join("-");
}
export async function prepareAssistantAction(db: pg.Pool, actor: BookingActor, run: BackofficeRun, name: string, args: Record<string, string>): Promise<BackofficeAction> {
  const kind = name === "prepare_booking" ? "booking" : args.action;
  if (!["booking", "pay", "amend", "cancel", "refund"].includes(kind!)) throw new AssistantPreparationError("请明确要办理的业务。");
  await withBookingTransaction(db, actor, (tx) => requireBookingVenue(tx, actor, run.venue.id, kind === "refund" ? "refund" : "book"));
  const courts = await accessibleCourts(db, actor, run.venue.id);
  const resolveCourt = (name: string) => {
    const matches = courts.filter((c) => c.name.replace(/\s/g, "") === name.trim().replace(/\s/g, ""));
    if (matches.length !== 1) throw new AssistantPreparationError("请使用球场查询返回的完整名称，重名球场请在页面选择。");
    return matches[0]!;
  };
  const specified = (): AssistantSelection[] => {
    if (!args.courtNames || !args.startAt || !args.endAt) throw new AssistantPreparationError("请补齐球场、开始和结束时间（含时区）。");
    if (![args.startAt, args.endAt].every((t) => /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(t))) throw new AssistantPreparationError("时间必须包含时区。");
    parseCourtInterval({ startAt: args.startAt, endAt: args.endAt });
    return args.courtNames.split(/[,，]/).map((name) => ({ courtId: resolveCourt(name).id, startAt: new Date(args.startAt!).toISOString(), endAt: new Date(args.endAt!).toISOString() }));
  };
  const check = async (lines: AssistantSelection[], excludeOrder?: string) => {
    if (!lines.length || lines.length > 32) throw new AssistantPreparationError("请先选场，或说明需要的球场和时间。");
    for (const line of lines) {
      const interval = parseCourtInterval(line);
      if (interval.start <= Date.now() || interval.end - interval.start > 86400000) throw new AssistantPreparationError("请选择未来一天以内的使用时段。");
      const snapshot = await venueSchedule(db, actor, run.venue.id, dateAt(line.startAt, run.venue.timezone));
      const court = snapshot.courts.find((c) => c.id === line.courtId);
      if (!court?.active || !snapshot.venue.active || court.hourlyPriceCents === null ||
        interval.end - interval.start < (snapshot.venue.minimumBookingMinutes ?? 60) * 60000 ||
        !isWithinOpeningHours(line, run.venue.timezone, snapshot.venue.openingHours)) throw new AssistantPreparationError("所选时段不符合营业时间、最短时长或球场可售条件。");
      // Check both venue-local dates for intervals ending after midnight.
      const endDate = dateAt(new Date(interval.end - 1).toISOString(), run.venue.timezone);
      const snapshots = endDate === snapshot.date ? [snapshot] : [snapshot, await venueSchedule(db, actor, run.venue.id, endDate)];
      if (snapshots.some((s) => s.occupancies.some((o) => o.courtId === line.courtId && o.orderId !== excludeOrder && o.startAt < line.endAt && o.endAt > line.startAt))) throw new AssistantPreparationError("所选时段已有占用，请重新选择。");
      if (lines.some((other) => other !== line && other.courtId === line.courtId && other.startAt < line.endAt && other.endAt > line.startAt)) throw new AssistantPreparationError("所选时段相互重叠。");
    }
  };
  if (kind === "booking") {
    const lines = args.source === "selection" ? (run.context.selection ?? []).map((l) => ({ ...l, startAt: new Date(l.startAt).toISOString(), endAt: new Date(l.endAt).toISOString() })) : specified();
    await check(lines);
    return { page: "schedule", label: "带入预订草稿", preparation: { kind, lines } };
  }
  if (!run.context.orderId) throw new AssistantPreparationError("请先打开需要办理的订单，再询问此订单。");
  const order = await orderDetail(db, actor, run.context.orderId);
  if (order.venueId !== run.venue.id) throw new AssistantPreparationError("订单不属于当前场馆。");
  const unsettled = order.payments.some((p) => ["PENDING", "REFUND_REQUIRED"].includes(p.status));
  const unpaid = order.status === "HELD" && order.paymentStatus === "UNPAID";
  if ((kind === "pay" || kind === "cancel") && (!unpaid || unsettled)) throw new AssistantPreparationError("请先核对付款状态；该订单当前不能按未付款订单办理。");
  if (kind === "refund" && !["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(order.paymentStatus)) throw new AssistantPreparationError("当前订单没有可办理此流程的付款记录。");
  if (kind === "amend" && (!(unpaid || order.status === "CONFIRMED") || unsettled)) throw new AssistantPreparationError("当前订单状态不能改期，请先核对付款。");
  const preparation: NonNullable<BackofficeAction["preparation"]> = { kind: kind as "pay" | "cancel" | "refund" | "amend", ...(args.reason ? { reason: args.reason } : {}) };
  if (kind === "amend" && (args.startAt || args.endAt || args.courtNames)) {
    const lineIndex = Number(args.lineIndex);
    if (!Number.isInteger(lineIndex) || lineIndex < 1 || !order.lines[lineIndex - 1] || order.lines[lineIndex - 1]!.cancelledAt) throw new AssistantPreparationError("请明确要调整的订单明细序号。");
    const lines = specified();
    if (lines.length !== 1) throw new AssistantPreparationError("每个改期方案先指定一条明细与目标球场。");
    if (order.lines.some((line, index) => index !== lineIndex - 1 && !line.cancelledAt && line.courtId === lines[0]!.courtId && line.startAt < lines[0]!.endAt && line.endAt > lines[0]!.startAt)) throw new AssistantPreparationError("目标时段与订单内其他明细重叠。");
    await check(lines, order.id);
    preparation.lines = lines;
    preparation.lineId = order.lines[lineIndex - 1]!.id;
  }
  return { page: "orders", orderId: order.id, label: ({ pay: "准备付款", amend: "准备改期 / 改场", refund: "准备退款", cancel: "准备取消预约" })[preparation.kind as "pay" | "amend" | "refund" | "cancel"], preparation };
}

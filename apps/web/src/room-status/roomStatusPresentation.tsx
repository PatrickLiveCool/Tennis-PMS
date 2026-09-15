import { useSyncExternalStore, type ComponentType, type SVGProps } from "react";
import {
  AlertTriangle,
  Ban,
  BedDouble,
  CalendarClock,
  CheckCircle2,
  CircleHelp,
  RefreshCw,
  Sparkles,
  Wrench
} from "lucide-react";
import type {
  RoomStatusActionCode,
  RoomStatusBedOccupancyDto,
  RoomStatusBlockingFactKind,
  FreeStayCategoryCode,
  RoomStatusIntervalDto,
  RoomStatusSourceCategory,
  RoomStatusSourceKind,
  RoomStatusStatus,
  RoomStatusUnitDto
} from "@qintopia/contracts";

type OccupantLabelSource = Pick<RoomStatusBedOccupancyDto["occupants"][number], "primaryOccupantLabel">;
type IntervalBusinessLabelSource = Pick<RoomStatusIntervalDto,
  "sourceKind" | "status" | "label" | "primaryOccupantLabel" | "occupantCount"> & {
    occupants: readonly RoomStatusIntervalDto["occupants"][number][];
  };

export function roomStatusBedOccupantLabel(occupant: OccupantLabelSource): string {
  return occupant.primaryOccupantLabel?.trim() || "历史未记录";
}

export function roomStatusBedOccupantLabels(occupants: readonly OccupantLabelSource[]): string[] {
  return occupants.map(roomStatusBedOccupantLabel);
}

export function roomStatusOccupantLabelLines(labels: readonly string[]): string[] {
  const lines: string[] = [];
  for (let index = 0; index < labels.length; index += 2) {
    lines.push(labels.slice(index, index + 2).join("、"));
  }
  return lines;
}

export function roomStatusIntervalOccupantLabels(interval: { occupants: readonly RoomStatusIntervalDto["occupants"][number][] }): string[] {
  return interval.occupants.map((occupant) => occupant.nickname?.trim() || "历史未记录");
}

export function roomStatusIntervalBusinessLabel(interval: IntervalBusinessLabelSource): string {
  if (interval.status === "UNKNOWN") return "状态未知";
  if (interval.sourceKind === "ORDER" || interval.sourceKind === "FREE_STAY") {
    const labels = roomStatusIntervalOccupantLabels(interval);
    const fallback = interval.primaryOccupantLabel?.trim() || "历史未记录";
    return `${labels.length ? labels.join("、") : fallback} · ${interval.occupantCount}人`;
  }
  return interval.label;
}

type IntervalGridUnitSource = Pick<RoomStatusUnitDto, "id" | "kind" | "code"> & {
  children: readonly Pick<RoomStatusUnitDto, "id" | "kind" | "code">[];
};
type IntervalGridLabelSource = Pick<RoomStatusIntervalDto,
  "sourceKind" | "status" | "actualInventoryUnitId" | "label" | "primaryOccupantLabel" | "occupantCount"> & {
    occupants: readonly RoomStatusIntervalDto["occupants"][number][];
  };

function roomStatusBedShortCode(code: string): string {
  return code.split("-").at(-1)?.trim() || code;
}

export function roomStatusIntervalGridLabel(
  interval: IntervalGridLabelSource,
  displayUnit: IntervalGridUnitSource
): string {
  if (interval.sourceKind !== "MAINTENANCE" || interval.status !== "MAINTENANCE") {
    return roomStatusIntervalBusinessLabel(interval);
  }
  if (displayUnit.kind !== "ROOM") return "维修/锁房";
  const bed = displayUnit.children.find((candidate) => candidate.kind === "BED"
    && candidate.id === interval.actualInventoryUnitId);
  return bed ? `${roomStatusBedShortCode(bed.code)} 维修/锁房` : "维修/锁房";
}

type StatusIcon = ComponentType<SVGProps<SVGSVGElement> & { size?: string | number }>;

export interface RoomStatusPresentation {
  label: string;
  Icon: StatusIcon;
  color?: string;
}

export const roomStatusPresentation: Record<RoomStatusStatus, RoomStatusPresentation> = {
  AVAILABLE: { label: "可售", Icon: CheckCircle2 },
  RESERVED: { label: "已预订", Icon: CalendarClock, color: "#F97316" },
  IN_HOUSE: { label: "在住", Icon: BedDouble, color: "#0969DA" },
  CLEANING: { label: "待清洁", Icon: Sparkles },
  MAINTENANCE: { label: "维修 / 锁房", Icon: Wrench },
  UNAVAILABLE: { label: "不可售", Icon: Ban },
  SETTLED: { label: "已结单", Icon: CheckCircle2 },
  ARREARS: { label: "欠款", Icon: AlertTriangle },
  STALE: { label: "数据陈旧", Icon: RefreshCw },
  UNKNOWN: { label: "状态未知", Icon: CircleHelp }
};

type ReservedTimingSource = Pick<RoomStatusIntervalDto,
  "sourceKind" | "status" | "sourceStartDate" | "orderArrivalDate"> &
  Partial<Pick<RoomStatusIntervalDto, "operationalAttention">>;

export type RoomStatusAttentionLabel = "待退房" | "欠款" | "逾期" | "未退";

const roomStatusAttentionPriority: Record<RoomStatusAttentionLabel, number> = {
  "待退房": 0,
  "未退": 1,
  "逾期": 2,
  "欠款": 3
};

export interface RoomStatusBadgeSummary<T> {
  visible: readonly T[];
  hiddenCount: number;
  title: string;
}

export function roomStatusOrderedAttentionLabels(
  labels: readonly RoomStatusAttentionLabel[]
): RoomStatusAttentionLabel[] {
  return [...new Set(labels)].sort((left, right) => roomStatusAttentionPriority[left] - roomStatusAttentionPriority[right]);
}

export function roomStatusAttentionBadgeSummary(
  labels: readonly RoomStatusAttentionLabel[]
): RoomStatusBadgeSummary<RoomStatusAttentionLabel> {
  const ordered = roomStatusOrderedAttentionLabels(labels);
  return {
    visible: ordered.slice(0, 1),
    hiddenCount: Math.max(0, ordered.length - 1),
    title: ordered.join("、")
  };
}

export function roomStatusLifecycleStatus(status: RoomStatusStatus): RoomStatusStatus {
  return status === "ARREARS" ? "SETTLED" : status;
}

export function roomStatusIntervalAttentionLabels(
  interval: Pick<RoomStatusIntervalDto, "status" | "attention" | "operationalAttention">
): RoomStatusAttentionLabel[] {
  const labels: RoomStatusAttentionLabel[] = [];
  if (interval.status === "ARREARS" || interval.attention === "ARREARS") labels.push("欠款");
  if (interval.operationalAttention === "DUE_OUT") labels.push("待退房");
  if (interval.operationalAttention === "OVERDUE_RESERVED") labels.push("逾期");
  if (interval.operationalAttention === "OVERDUE_IN_HOUSE") labels.push("未退");
  return labels;
}

export function roomStatusPhysicalOccupancyRatio(
  registeredOccupantCount: number,
  unit: Pick<RoomStatusUnitDto, "physicalBedCount">
): string {
  const occupants = Number.isFinite(registeredOccupantCount)
    ? Math.max(0, Math.trunc(registeredOccupantCount))
    : 0;
  const physicalBedCount = unit.physicalBedCount !== null
    && Number.isFinite(unit.physicalBedCount)
    && unit.physicalBedCount > 0
    ? Math.trunc(unit.physicalBedCount)
    : null;
  return `${occupants}/${physicalBedCount ?? "?"}`;
}

export function RoomStatusAttentionBadges({ labels }: { labels: readonly RoomStatusAttentionLabel[] }) {
  return labels.map((label) => <span key={label} className="room-status-mobile-attention">{label}</span>);
}

export type RoomStatusSourceBadgeTone = "channel" | "free" | "member";

export interface RoomStatusSourceBadge {
  category: Exclude<RoomStatusSourceCategory, "DIRECT">;
  label: "Y" | "X" | "M" | "F" | "H";
  title: string;
  tone: RoomStatusSourceBadgeTone;
}

const roomStatusSourceBadgeByCategory: Partial<Record<RoomStatusSourceCategory, RoomStatusSourceBadge>> = {
  YOUMUDAO: { category: "YOUMUDAO", label: "Y", title: "游牧岛", tone: "channel" },
  CTRIP: { category: "CTRIP", label: "X", title: "携程", tone: "channel" },
  MEITUAN: { category: "MEITUAN", label: "M", title: "美团", tone: "channel" },
  FREE_STAY: { category: "FREE_STAY", label: "F", title: "免费入住", tone: "free" },
  MEMBER: { category: "MEMBER", label: "H", title: "会员权益", tone: "member" }
};

const roomStatusFreeStayCategoryLabels: Record<FreeStayCategoryCode, string> = {
  VOLUNTEER: "义工",
  RECEPTION: "接待"
};

export function roomStatusSourceBadge(
  interval: Pick<RoomStatusIntervalDto, "sourceCategory">
): RoomStatusSourceBadge | null {
  return interval.sourceCategory ? roomStatusSourceBadgeByCategory[interval.sourceCategory] ?? null : null;
}

export function roomStatusSourceBadgeKey(badge: RoomStatusSourceBadge): string {
  return badge.category;
}

export function roomStatusSourceBadgesForIntervals(
  intervals: readonly Pick<RoomStatusIntervalDto, "sourceCategory">[]
): RoomStatusSourceBadge[] {
  const byKey = new Map<string, RoomStatusSourceBadge>();
  for (const interval of intervals) {
    const badge = roomStatusSourceBadge(interval);
    if (!badge) continue;
    byKey.set(roomStatusSourceBadgeKey(badge), badge);
  }
  return [...byKey.values()];
}

export function roomStatusSourceBadgeSummary(
  badges: readonly RoomStatusSourceBadge[],
  attentionCount: number
): RoomStatusBadgeSummary<RoomStatusSourceBadge> {
  const availableSlots = attentionCount > 1 ? 2 : attentionCount === 1 ? 3 : 4;
  const maxVisible = badges.length > availableSlots ? availableSlots - 1 : availableSlots;
  return {
    visible: badges.slice(0, maxVisible),
    hiddenCount: Math.max(0, badges.length - maxVisible),
    title: badges.map((badge) => badge.title).join("、")
  };
}

export function roomStatusFreeStayCategoryLabel(code: FreeStayCategoryCode | null | undefined): string | null {
  return code ? roomStatusFreeStayCategoryLabels[code] ?? null : null;
}

export function roomStatusFreeStayMetaLabels(
  interval: Pick<RoomStatusIntervalDto, "sourceKind" | "sourceCategory" | "freeStayCategoryCode">
): string[] {
  if (interval.sourceKind !== "FREE_STAY" && interval.sourceCategory !== "FREE_STAY") return [];
  return ["免费", roomStatusFreeStayCategoryLabel(interval.freeStayCategoryCode)].filter((label): label is string => Boolean(label));
}

export function RoomStatusSourceBadges({
  badges,
  hiddenCount = 0,
  title
}: {
  badges: readonly RoomStatusSourceBadge[];
  hiddenCount?: number;
  title?: string;
}) {
  if (!badges.length && hiddenCount <= 0) return null;
  return (
    <span className="room-status-source-badges" aria-hidden="true" title={title || badges.map((badge) => badge.title).join("、")}>
      {badges.map((badge) => (
        <span
          key={roomStatusSourceBadgeKey(badge)}
          className={`room-status-source-badge is-${badge.tone}`}
          title={badge.title}
        >{badge.label}</span>
      ))}
      {hiddenCount > 0 ? <span className="room-status-source-badge is-overflow" title={title || badges.map((badge) => badge.title).join("、")}>+{hiddenCount}</span> : null}
    </span>
  );
}

export function RoomStatusGridAttentionBadges({
  summary
}: {
  summary: RoomStatusBadgeSummary<RoomStatusAttentionLabel>;
}) {
  if (!summary.visible.length) return null;
  return (
    <span className="room-status-bed-attention-tags" aria-hidden="true" title={summary.title}>
      {summary.visible.map((label) => (
        <span key={label} className="room-status-bed-attention-tag">{label}</span>
      ))}
      {summary.hiddenCount > 0 ? <span className="room-status-bed-attention-tag is-overflow" title={summary.title}>+{summary.hiddenCount}</span> : null}
    </span>
  );
}

export function RoomStatusFreeStayMetaBadges({ labels }: { labels: readonly string[] }) {
  return labels.map((label) => <span key={label} className="room-status-quick-meta-tag">{label}</span>);
}

export function roomStatusIntervalIsOverdueReserved(
  interval: ReservedTimingSource,
  businessDate?: string
): boolean {
  if (interval.operationalAttention !== undefined) {
    return interval.operationalAttention === "OVERDUE_RESERVED";
  }
  return Boolean(businessDate
    && (interval.sourceKind === "ORDER" || interval.sourceKind === "FREE_STAY")
    && interval.status === "RESERVED"
    && (interval.orderArrivalDate ?? interval.sourceStartDate) < businessDate);
}

export function roomStatusIntervalStatusLabel(
  interval: ReservedTimingSource,
  businessDate?: string
): string {
  return roomStatusIntervalIsOverdueReserved(interval, businessDate)
    ? "逾期预订"
    : roomStatusPresentation[roomStatusLifecycleStatus(interval.status)].label;
}

export const roomStatusSourceLabels: Record<RoomStatusSourceKind, string> = {
  ORDER: "正常订单",
  FREE_STAY: "免费入住",
  MAINTENANCE: "维修锁房",
  CLEANING: "清洁任务",
  UNIT_UNSELLABLE: "库存不可售"
};

export const roomStatusBlockingFactLabels: Record<RoomStatusBlockingFactKind, string> = {
  CLAIM: "库存 Claim",
  DUE_OUT: "计划退房日待办理退房事实",
  LODGING_ORDER: "住宿订单事实",
  OVERDUE_IN_HOUSE: "逾期未退在住事实",
  UNIT_UNSELLABLE: "库存不可售事实"
};

export const roomStatusActionLabels: Record<RoomStatusActionCode, string> = {
  CREATE_ORDER: "创建正常住宿订单",
  CREATE_FREE_STAY: "创建免费入住",
  BACKFILL_ORDER: "补录住宿",
  LOCK_MAINTENANCE: "放置维修锁房",
  OPEN_ORDER: "打开订单",
  RELEASE_MAINTENANCE: "释放维修锁房",
  COMPLETE_CLEANING: "完成清洁"
};

type RoomStatusSalesPresentationUnit = Pick<RoomStatusUnitDto, "kind" | "salesMode">;
type RoomStatusUnitIdentity = Pick<RoomStatusUnitDto, "kind" | "code" | "name" | "buildingCode"> & Partial<Pick<RoomStatusUnitDto, "roomTypeCode">>;

function roomStatusUnitNameParts(unit: RoomStatusUnitIdentity): string[] {
  if (!unit.name.includes("·") && unit.name.startsWith(`${unit.code} `)) {
    return [unit.code, unit.name.slice(unit.code.length + 1).trim()];
  }
  return unit.name.split(/\s*·\s*/).map((part) => part.trim()).filter(Boolean);
}

function roomStatusNameDescription(unit: RoomStatusUnitIdentity): string {
  const parts = roomStatusUnitNameParts(unit);
  const roomCode = unit.kind === "BED" ? unit.code.replace(/-[^-]+$/, "") : unit.code;
  if (parts[0] === unit.code || parts[0] === roomCode) parts.shift();
  return parts.join(" ");
}

function roomStatusLegacyBedDescription(unit: RoomStatusUnitIdentity): string | null {
  if (unit.kind !== "BED") return null;
  const legacyBed = /^Room\s+\S+\s*\/\s*Bed\s+([A-Za-z0-9]+)$/i.exec(unit.name.trim());
  if (legacyBed) return `床位 ${legacyBed[1]!.toUpperCase()}`;
  return null;
}

function roomStatusShouldUseRoomTypeDescription(unit: RoomStatusUnitIdentity, description: string): boolean {
  return unit.kind === "ROOM"
    && Boolean(unit.roomTypeCode)
    && (!description || description === "房间" || /^Room\s+\S+$/i.test(description));
}

function roomStatusIsGenericRoomDescription(unit: RoomStatusUnitIdentity, description: string): boolean {
  return unit.kind === "ROOM"
    && (!description || description === "房间" || /^Room\s+\S+$/i.test(description));
}

export function roomStatusUnitDescription(unit: RoomStatusUnitIdentity): string {
  const legacyBedDescription = roomStatusLegacyBedDescription(unit);
  if (legacyBedDescription) return legacyBedDescription;

  const description = roomStatusNameDescription(unit);
  if (roomStatusShouldUseRoomTypeDescription(unit, description)) return roomStatusRoomTypeLabel(unit.roomTypeCode!);
  if (roomStatusIsGenericRoomDescription(unit, description)) return "房间";
  return description || (unit.kind === "ROOM" ? "房间" : "床位");
}

export function roomStatusUnitLocationLabel(unit: RoomStatusUnitIdentity): string {
  return [unit.buildingCode ? `${unit.buildingCode}栋` : null, unit.code].filter(Boolean).join(" ");
}

export function roomStatusUnitLabel(unit: RoomStatusUnitIdentity): string {
  const parts = roomStatusUnitNameParts(unit);
  const roomCode = unit.kind === "BED" ? unit.code.replace(/-[^-]+$/, "") : unit.code;
  const nameCarriesLocation = parts[0] === unit.code || parts[0] === roomCode;
  const description = roomStatusNameDescription(unit);
  const legacyBedDescription = roomStatusLegacyBedDescription(unit);
  const localLabel = legacyBedDescription
    ? [roomCode, legacyBedDescription].join(" ")
    : roomStatusShouldUseRoomTypeDescription(unit, description)
    ? [unit.code, roomStatusRoomTypeLabel(unit.roomTypeCode!)].join(" ")
    : roomStatusIsGenericRoomDescription(unit, description)
    ? [unit.code, "房间"].join(" ")
    : nameCarriesLocation ? parts.join(" ") : [unit.code, ...parts].join(" ");
  return [unit.buildingCode ? `${unit.buildingCode}栋` : null, localLabel].filter(Boolean).join(" ");
}

const roomTypeLabelByCode: Record<string, string> = {
  private_bath_standard: "标间（独卫）",
  private_bath_king: "大床房（独卫）",
  private_bath_single: "单人间（独卫）",
  private_bath_suite: "套房（独卫）",
  shared_bath_standard: "标间（公卫）",
  shared_bath_single: "单人间（公卫）",
  shared_bath_double: "两人间（公卫）",
  shared_bath_quad: "四人间（公卫）",
  PUBLIC_FOUR_BED: "四人间（公卫）",
  SHARED_BATH_SINGLE: "单人间（公卫）",
  PRIVATE_BATH_SINGLE: "单人间（独卫）"
};

export function roomStatusRoomTypeLabel(code: string): string {
  const direct = roomTypeLabelByCode[code];
  if (direct) return direct;
  const normalized = code.trim().toLocaleLowerCase("en-US");
  const layout = normalized.includes("quad") || normalized.includes("four")
    ? "四人间"
    : normalized.includes("double")
      ? "两人间"
      : normalized.includes("single")
        ? "单人间"
        : normalized.includes("standard")
          ? "标间"
          : normalized.includes("king")
            ? "大床房"
            : normalized.includes("suite")
              ? "套房"
              : "未命名房型";
  const bathroom = normalized.includes("shared") || normalized.includes("public")
    ? "（公卫）"
    : normalized.includes("private") || normalized.includes("ensuite")
      ? "（独卫）"
      : "";
  return `${layout}${bathroom}`;
}

export function roomStatusSelectedSaleLabel(unit: RoomStatusSalesPresentationUnit): string {
  if (unit.salesMode === "UNAVAILABLE") return "不可售";
  return unit.kind === "ROOM" ? "整房销售" : "单床销售";
}

export function roomStatusSaleCapabilityLabel(unit: RoomStatusSalesPresentationUnit): string {
  if (unit.salesMode === "UNAVAILABLE") return "当前不可售";
  if (unit.salesMode === "BED_SPLIT") return "支持整房及单床销售";
  return "仅整房销售";
}

export function roomStatusRowSalesLabel(unit: RoomStatusSalesPresentationUnit): string {
  if (unit.salesMode === "UNAVAILABLE") return "不可售";
  if (unit.kind === "BED") return "单床销售";
  return unit.salesMode === "BED_SPLIT" ? "整房/单床" : "整房销售";
}

export function roomStatusOccupancyCapacity(unit: Pick<RoomStatusUnitDto, "occupancyCapacity">): number {
  return unit.occupancyCapacity;
}

export function formatRoomStatusDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  return `${Number(match[2])}月${Number(match[3])}日`;
}

export function formatRoomStatusDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(parsed);
}

export function RoomStatusMark({ status, compact = false, label }: { status: RoomStatusStatus; compact?: boolean; label?: string }) {
  const lifecycleStatus = roomStatusLifecycleStatus(status);
  const presentation = roomStatusPresentation[lifecycleStatus];
  const Icon = presentation.Icon;
  return (
    <span className={`room-status-mark room-status-mark-${lifecycleStatus.toLowerCase().replaceAll("_", "-")}${compact ? " room-status-mark-compact" : ""}`}>
      <Icon aria-hidden="true" size={compact ? 14 : 16} />
      <span>{label ?? presentation.label}</span>
    </span>
  );
}

export function RoomStatusWarning({ children }: { children: string }) {
  return (
    <span className="room-status-warning">
      <AlertTriangle aria-hidden="true" size={15} />
      {children}
    </span>
  );
}

const mobileMediaQuery = "(max-width: 767px)";

function subscribeToMobileViewport(onStoreChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(mobileMediaQuery);
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
}

function mobileViewportSnapshot(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(mobileMediaQuery).matches;
}

export function useRoomStatusMobileViewport(): boolean {
  return useSyncExternalStore(subscribeToMobileViewport, mobileViewportSnapshot, () => false);
}

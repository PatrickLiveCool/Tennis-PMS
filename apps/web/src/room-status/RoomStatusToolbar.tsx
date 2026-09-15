import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Eraser, Search } from "lucide-react";
import {
  hasActiveRoomStatusFilters,
  type RoomStatusFilterOptions,
  type RoomStatusFilters
} from "./roomStatusState";
import { roomStatusRoomTypeLabel } from "./roomStatusPresentation";

const salesModeLabels = {
  WHOLE_ROOM: "整房销售",
  BED_SPLIT: "可按床销售",
  UNAVAILABLE: "不可售"
} as const;

const statusLabels = {
  AVAILABLE: "可售",
  RESERVED: "已预订",
  IN_HOUSE: "在住",
  CLEANING: "待清洁",
  MAINTENANCE: "维修 / 锁房",
  UNAVAILABLE: "不可售",
  SETTLED: "已结单",
  ARREARS: "欠款",
  STALE: "数据陈旧",
  UNKNOWN: "状态未知"
} as const;

export interface RoomStatusRange {
  arrivalDate: string;
  departureDate: string;
}

export interface RoomStatusToolbarProps {
  filters: RoomStatusFilters;
  filterOptions: RoomStatusFilterOptions;
  focusSearchRequestToken?: number;
  actions?: ReactNode;
  onFiltersChange: (filters: RoomStatusFilters) => void;
  onClearFilters: () => void;
}

function updateFilter<K extends keyof RoomStatusFilters>(
  filters: RoomStatusFilters,
  key: K,
  value: RoomStatusFilters[K],
  onChange: (filters: RoomStatusFilters) => void
) {
  onChange({ ...filters, [key]: value });
}

export function RoomStatusToolbar({
  filters,
  filterOptions,
  focusSearchRequestToken = 0,
  actions,
  onFiltersChange,
  onClearFilters
}: RoomStatusToolbarProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedCount = Number(filters.salesMode !== "ALL") + Number(filters.kind !== "ALL") + Number(filters.minimumCapacity !== null);
  const filtersActive = hasActiveRoomStatusFilters(filters);
  const toolbarRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    const page = toolbar?.closest<HTMLElement>(".room-status-page");
    if (!toolbar || !page) return;
    const updateHeight = () => {
      page.style.setProperty("--room-status-sticky-toolbar-height", `${toolbar.getBoundingClientRect().height}px`);
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(toolbar);
    return () => {
      observer.disconnect();
      page.style.removeProperty("--room-status-sticky-toolbar-height");
    };
  }, []);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastFocusSearchRequestToken = useRef(focusSearchRequestToken);

  useEffect(() => {
    if (focusSearchRequestToken === lastFocusSearchRequestToken.current) return;
    lastFocusSearchRequestToken.current = focusSearchRequestToken;
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusSearchRequestToken]);

  return (
    <section ref={toolbarRef} className="room-status-toolbar" aria-label="房态范围与筛选">
      <div className="room-status-filter-row">
        <label className="room-status-search-field">搜索房间或床位
          <span>
            <Search aria-hidden="true" size={16} />
            <input
              ref={searchInputRef}
              type="search"
              value={filters.search}
              placeholder="房号、名称、楼栋或价格产品"
              onChange={(event) => updateFilter(filters, "search", event.target.value, onFiltersChange)}
            />
          </span>
        </label>
        <label>房型
          <select value={filters.roomTypeCode} onChange={(event) => updateFilter(filters, "roomTypeCode", event.target.value, onFiltersChange)}>
            <option value="ALL">全部房型</option>
            {filterOptions.roomTypeCodes.map((code) => <option key={code} value={code}>{filterOptions.roomTypeLabels?.[code] ?? roomStatusRoomTypeLabel(code)}</option>)}
          </select>
        </label>
        <label>状态
          <select value={filters.status} onChange={(event) => updateFilter(filters, "status", event.target.value as RoomStatusFilters["status"], onFiltersChange)}>
            <option value="ALL">全部状态</option>
            {filterOptions.statuses.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}
          </select>
        </label>
        <div className="room-status-toolbar-quick-actions">
          <button type="button" className="room-status-button room-status-button-secondary advanced-filter-toggle" aria-expanded={advancedOpen} aria-controls="room-status-advanced-filters" onClick={() => setAdvancedOpen((value) => !value)}>{advancedOpen ? "收起筛选" : "更多筛选"}{advancedCount ? `（${advancedCount}）` : ""}</button>
          {actions ? <div className="room-status-toolbar-actions">{actions}</div> : null}
        </div>
        <div id="room-status-advanced-filters" className={`room-status-advanced-filters${advancedOpen ? " is-open" : ""}`}>
          <label>销售模式
            <select value={filters.salesMode} onChange={(event) => updateFilter(filters, "salesMode", event.target.value as RoomStatusFilters["salesMode"], onFiltersChange)}>
              <option value="ALL">全部模式</option>
              {filterOptions.salesModes.map((mode) => <option key={mode} value={mode}>{salesModeLabels[mode]}</option>)}
            </select>
          </label>
          <label>房间或床位
            <select value={filters.kind} onChange={(event) => updateFilter(filters, "kind", event.target.value as RoomStatusFilters["kind"], onFiltersChange)}>
              <option value="ALL">房间和床位</option>
              <option value="ROOM">房间</option>
              <option value="BED">床位</option>
            </select>
          </label>
          <label>房间容量
            <select
              value={filters.minimumCapacity ?? "ALL"}
              onChange={(event) => updateFilter(filters, "minimumCapacity", event.target.value === "ALL" ? null : Number(event.target.value), onFiltersChange)}
            >
              <option value="ALL">不限房间容量</option>
              {filterOptions.capacities.map((capacity) => <option key={capacity} value={capacity}>{capacity} 人及以上</option>)}
            </select>
          </label>
        </div>
        {filtersActive ? <div className="room-status-filter-summary">
          {filtersActive ? (
            <button type="button" className="room-status-button room-status-button-secondary" onClick={onClearFilters}>
              <Eraser aria-hidden="true" size={16} />清除筛选
            </button>
          ) : null}
        </div> : null}
      </div>
    </section>
  );
}

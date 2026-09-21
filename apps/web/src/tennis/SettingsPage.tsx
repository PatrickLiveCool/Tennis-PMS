import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { TennisApi } from "./api";
import type { CourtRecord, Session, VenueRecord } from "./types";
import { permits } from "./types";
import {
  cents,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  minuteLabel,
  Modal,
  money,
  PageHeading,
  Panel,
  useLoad,
} from "./components";
import { PricingPanel } from "./PricingPanel";
import { BookingPolicyPanel } from "./BookingPolicyPanel";
import { StaffPanel } from "./StaffPanel";
import { TenantGatewayPanel } from "./GatewayPanel";

export const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
export function MinuteSelect({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {Array.from({ length: 97 }, (_, index) => index * 15).map((m) => (
        <option key={m} value={m}>
          {minuteLabel(m)}
        </option>
      ))}
    </select>
  );
}
export function SettingsPage({
  api,
  session,
  venue,
  onVenueChange,
}: {
  api: TennisApi;
  session: Session;
  venue: VenueRecord;
  onVenueChange: () => void;
}) {
  const [tab, setTab] = useState("assets");
  const courts = useLoad(() => api<CourtRecord[]>(`/venues/${venue.id}/courts`), [api, venue.id]);
  const [court, setCourt] = useState<CourtRecord | "new" | null>(null);
  const [newVenue, setNewVenue] = useState(false);
  const canAssets = permits(session, "manage_assets"),
    canPrices = permits(session, "manage_prices");
  const admin = session.tenants.some((t) => t.id === session.tenantId && t.kind === "staff" && t.role === "ADMIN");
  return (
    <>
      <PageHeading title="场地与定价" description="场馆 / 校区下面包含多片球场。每个租户独立管理价格与资产。">
        {canAssets && (
          <button className="button button-secondary" onClick={() => setNewVenue(true)}>
            <Plus size={16} />
            新增场馆
          </button>
        )}
      </PageHeading>
      <div className="tennis-tabs">
        <button className={tab === "assets" ? "active" : ""} onClick={() => setTab("assets")}>
          场地资产
        </button>
        <button className={tab === "discounts" ? "active" : ""} onClick={() => setTab("discounts")}>
          时段折扣
        </button>
        {admin && (
          <>
            <button className={tab === "policy" ? "active" : ""} onClick={() => setTab("policy")}>
              预订期限
            </button>
            <button className={tab === "topups" ? "active" : ""} onClick={() => setTab("topups")}>
              充值方案
            </button>
            <button className={tab === "staff" ? "active" : ""} onClick={() => setTab("staff")}>
              员工权限
            </button>
            <button className={tab === "gateway" ? "active" : ""} onClick={() => setTab("gateway")}>
              渠道身份
            </button>
          </>
        )}
      </div>
      {tab === "assets" ? (
        <div className="tennis-settings-layout">
          <VenueEditor
            key={`${venue.id}:${venue.catalogRevision}`}
            api={api}
            venue={venue}
            canEdit={canAssets}
            onSaved={onVenueChange}
          />
          <Panel
            title="球场与小时价"
            action={
              canAssets && (
                <button className="button button-secondary button-small" onClick={() => setCourt("new")}>
                  <Plus size={15} />
                  添加球场
                </button>
              )
            }
          >
            <ErrorNotice error={courts.error} retry={() => void courts.refresh()} />
            {!courts.data ? (
              <LoadingBlock />
            ) : !courts.data.length ? (
              <EmptyState title="暂无球场" detail="添加球场后设置小时价，完成营业配置即可开始销售。" />
            ) : (
              courts.data.map((item) => (
                <div className="tennis-ledger-row" key={item.id}>
                  <div>
                    <strong>
                      {item.name} · {item.indoor ? "室内" : "室外"}{item.surface === "CLAY" ? " · 红土场" : ""}
                    </strong>
                    <span>
                      {item.active ? "启用" : "停用"} · {money(item.hourlyPriceCents)} / 小时
                    </span>
                  </div>
                  {(canAssets || canPrices) && (
                    <button className="button button-secondary button-small" onClick={() => setCourt(item)}>
                      编辑
                    </button>
                  )}
                </div>
              ))
            )}
          </Panel>
        </div>
      ) : tab === "policy" && admin ? (
        <BookingPolicyPanel key={`${session.subjectId}:${session.tenantId}:${session.contextVersion}`} api={api} />
      ) : tab === "gateway" && admin ? (
        <TenantGatewayPanel
          api={api}
          scope={`${session.subjectId}:${session.kind}:${session.tenantId}:${session.contextVersion}`}
        />
      ) : tab === "staff" ? (
        <StaffPanel api={api} />
      ) : (
        <PricingPanel
          api={api}
          venue={venue}
          courts={courts.data ?? []}
          canEdit={canPrices}
          mode={tab === "topups" ? "topups" : "discounts"}
        />
      )}
      {court && (
        <CourtEditor
          api={api}
          venue={venue}
          court={court}
          canAssets={canAssets}
          canPrices={canPrices}
          onClose={() => setCourt(null)}
          onSaved={() => {
            void courts.refresh();
            onVenueChange();
          }}
        />
      )}
      {newVenue && (
        <NewVenue
          api={api}
          onClose={() => setNewVenue(false)}
          onSaved={() => {
            setNewVenue(false);
            onVenueChange();
          }}
        />
      )}
    </>
  );
}
function VenueEditor({
  api,
  venue,
  canEdit,
  onSaved,
}: {
  api: TennisApi;
  venue: VenueRecord;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState({
    name: venue.name,
    address: venue.address,
    timezone: venue.timezone,
    active: venue.active,
    minimumBookingMinutes: venue.minimumBookingMinutes ?? 15,
    openingHours: venue.openingHours,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/venues/${venue.id}`, "PATCH", { ...draft, expectedRevision: venue.catalogRevision });
      onSaved();
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="场馆营业设置">
      <form
        className="tennis-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <ErrorNotice error={error} />
        <fieldset disabled={!canEdit || busy}>
          <div className="tennis-form">
            <label>
              场馆名称
              <input value={draft.name} required onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label>
              地址
              <input value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
            </label>
            <div className="tennis-two">
              <label>
                场馆时区
                <input
                  value={draft.timezone}
                  required
                  onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
                />
              </label>
              <label>
                最短可售时长（分钟）
                <input
                  type="number"
                  min="15"
                  max="1440"
                  step="15"
                  required
                  value={draft.minimumBookingMinutes}
                  onChange={(e) => setDraft({ ...draft, minimumBookingMinutes: Number(e.target.value) })}
                />
              </label>
            </div>
            <label className="tennis-check">
              <input
                type="checkbox"
                checked={draft.active}
                onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
              />
              场馆营业
            </label>
            <div className="panel-heading">
              <h3>每周营业时段</h3>
              <button
                className="button button-secondary button-small"
                type="button"
                onClick={() =>
                  setDraft({
                    ...draft,
                    openingHours: [...draft.openingHours, { weekday: 1, startMinute: 480, endMinute: 1320 }],
                  })
                }
              >
                <Plus size={14} />
                添加
              </button>
            </div>
            {draft.openingHours.map((w, i) => (
              <div className="tennis-opening-row" key={i}>
                <select
                  aria-label={`营业时段 ${i + 1} 星期`}
                  value={w.weekday}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      openingHours: draft.openingHours.map((item, index) =>
                        index === i ? { ...item, weekday: Number(e.target.value) } : item,
                      ),
                    })
                  }
                >
                  {weekdays.map((day, index) => (
                    <option value={index} key={day}>
                      {day}
                    </option>
                  ))}
                </select>
                <MinuteSelect
                  label={`营业时段 ${i + 1} 开始`}
                  value={w.startMinute}
                  onChange={(value) =>
                    setDraft({
                      ...draft,
                      openingHours: draft.openingHours.map((item, index) =>
                        index === i ? { ...item, startMinute: value } : item,
                      ),
                    })
                  }
                />
                <span>至</span>
                <MinuteSelect
                  label={`营业时段 ${i + 1} 结束`}
                  value={w.endMinute}
                  onChange={(value) =>
                    setDraft({
                      ...draft,
                      openingHours: draft.openingHours.map((item, index) =>
                        index === i ? { ...item, endMinute: value } : item,
                      ),
                    })
                  }
                />
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`删除营业时段 ${i + 1}`}
                  onClick={() =>
                    setDraft({ ...draft, openingHours: draft.openingHours.filter((_, index) => index !== i) })
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        </fieldset>
        <p className="tennis-muted">同一天可设置多段营业窗口。影响既有预约的停业或营业时间缩短，需要先处理相关预约。</p>
        {canEdit && (
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? "正在保存…" : "保存营业设置"}
          </button>
        )}
      </form>
    </Panel>
  );
}
export function NewVenue({ api, onClose, onSaved }: { api: TennisApi; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="新增场馆 / 校区" onClose={onClose} closeDisabled={busy}>
      <form
        className="tennis-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void api("/venues", "POST", { name, address, timezone: "Asia/Shanghai" })
            .then(onSaved)
            .catch(setError)
            .finally(() => setBusy(false));
        }}
      >
        <ErrorNotice error={error} />
        <label>
          名称
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          地址
          <input value={address} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <p className="tennis-muted">新场馆需补齐营业时间、最短时长和球场价格。</p>
        <button className="button button-primary" disabled={busy}>
          创建场馆
        </button>
      </form>
    </Modal>
  );
}
function CourtEditor({
  api,
  venue,
  court,
  canAssets,
  canPrices,
  onClose,
  onSaved,
}: {
  api: TennisApi;
  venue: VenueRecord;
  court: CourtRecord | "new";
  canAssets: boolean;
  canPrices: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [current, setCurrent] = useState(court === "new" ? null : court);
  const [name, setName] = useState(current?.name ?? "");
  const [indoor, setIndoor] = useState(current?.indoor ?? false);
  const [surface, setSurface] = useState<CourtRecord["surface"]>(current?.surface ?? "UNSPECIFIED");
  const [active, setActive] = useState(current?.active ?? true);
  const [price, setPrice] = useState(current?.hourlyPriceCents == null ? "" : String(current.hourlyPriceCents / 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState("");
  async function save(kind: "asset" | "price") {
    setBusy(true);
    setError(undefined);
    try {
      const result =
        kind === "price" && current
          ? await api<CourtRecord>(`/venues/${venue.id}/courts/${current.id}/price`, "PATCH", {
              expectedRevision: current.revision,
              hourlyPriceCents: cents(price),
            })
          : current
            ? await api<CourtRecord>(`/venues/${venue.id}/courts/${current.id}`, "PATCH", {
                expectedRevision: current.revision,
                name,
                indoor,
                surface,
                active,
              })
            : await api<CourtRecord>(`/venues/${venue.id}/courts`, "POST", { name, indoor, surface });
      setCurrent(result);
      setMessage(kind === "price" ? "标准小时价已保存。" : "球场资料已保存，请核对小时价格。");
      onSaved();
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={current ? "编辑球场" : "添加球场"} onClose={onClose} closeDisabled={busy}>
      <div className="tennis-form">
        <ErrorNotice error={error} />
        {message && <p className="tennis-success">{message}</p>}
        <label>
          球场名称
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={!canAssets || busy} />
        </label>
        <label>
          场地材质
          <select value={surface} onChange={(e) => setSurface(e.target.value as CourtRecord["surface"])} disabled={!canAssets || busy}>
            <option value="UNSPECIFIED">未标注材质</option>
            <option value="CLAY">红土场</option>
          </select>
        </label>
        <label className="tennis-check">
          <input
            type="checkbox"
            checked={indoor}
            onChange={(e) => setIndoor(e.target.checked)}
            disabled={!canAssets || busy}
          />
          室内球场
        </label>
        {current && (
          <label className="tennis-check">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              disabled={!canAssets || busy}
            />
            启用球场
          </label>
        )}
        {canAssets && (
          <button className="button button-primary" disabled={busy || !name.trim()} onClick={() => void save("asset")}>
            {current ? "保存球场资料" : "创建球场"}
          </button>
        )}
        {current && (
          <>
            <hr />
            <label>
              标准小时价（元 / 小时）
              <input
                type="number"
                min="0"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                disabled={!canPrices || busy}
              />
            </label>
            <p className="tennis-muted">按实际时段折算，跨折扣时段分段计价；新设置不追溯修改已确认订单。</p>
            {canPrices && (
              <button
                className="button button-primary"
                disabled={busy || price === ""}
                onClick={() => void save("price")}
              >
                保存小时价格
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

import { CourtEditor } from "./CourtEditor";
import { InfoHint } from "./InfoHint";
import { courtDescription, missingCourtPurchaseFields } from "../../../../packages/domain/src/tennis-court-profile";
import { courtPurchaseFieldNames } from "./court-purchase-fields";
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
      <PageHeading title="场地设置">
        {canAssets && (
          <button className="button button-secondary" onClick={() => setNewVenue(true)}>
            <Plus size={16} />
            新增场馆
          </button>
        )}
      </PageHeading>
      <div className="tennis-tabs">
        <button className={tab === "assets" ? "active" : ""} onClick={() => setTab("assets")}>
          球场资料
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
              canAssets && canPrices && (
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
              <EmptyState title="暂无球场" detail="添加球场并补齐必填资料后，即可接受预订。" />
            ) : (
              courts.data.map((item) => (
                <div className="tennis-ledger-row" key={item.id}>
                  <div>
                    <strong>
                      {item.name} · {courtDescription(item)}
                    </strong>
                    <span>
                      {item.active ? "启用" : "停用"} · {money(item.hourlyPriceCents)} / 小时
                    </span>
                    {missingCourtPurchaseFields(item).length > 0 && <span className="tennis-warning-text">待补齐：{missingCourtPurchaseFields(item).map((field) => courtPurchaseFieldNames[field]).join("、")}</span>}
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
              <h3>每周营业时段 <InfoHint label="营业时段说明">同一天可以添加多段营业时间，例如上午和晚间。</InfoHint></h3>
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
        <p className="tennis-muted">停业或缩短营业时间前，请先处理受影响的预约。</p>
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
        <p className="tennis-muted">创建后，请设置营业时间和球场价格。</p>
        <button className="button button-primary" disabled={busy}>
          创建场馆
        </button>
      </form>
    </Modal>
  );
}

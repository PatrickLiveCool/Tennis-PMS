import { useState } from "react";
import type { TennisApi } from "./api";
import type { CourtRecord, SavedDiscount, TopupOffer, VenueRecord } from "./types";
import {
  cents,
  dateValue,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  minuteLabel,
  Modal,
  money,
  Panel,
  useLoad,
} from "./components";
import { MinuteSelect, weekdays } from "./SettingsPage";
export function PricingPanel({
  api,
  venue,
  courts,
  canEdit,
  mode,
}: {
  api: TennisApi;
  venue: VenueRecord;
  courts: CourtRecord[];
  canEdit: boolean;
  mode: "discounts" | "topups";
}) {
  return mode === "topups" ? (
    <Offers api={api} />
  ) : (
    <Discounts api={api} venue={venue} courts={courts} canEdit={canEdit} />
  );
}
function Discounts({
  api,
  venue,
  courts,
  canEdit,
}: {
  api: TennisApi;
  venue: VenueRecord;
  courts: CourtRecord[];
  canEdit: boolean;
}) {
  const rules = useLoad(() => api<SavedDiscount[]>(`/venues/${venue.id}/discounts`), [api, venue.id]);
  const [editing, setEditing] = useState<SavedDiscount | "new" | null>(null);
  return (
    <Panel
      title="分时折扣"
      action={
        canEdit && (
          <button className="button button-primary" onClick={() => setEditing("new")}>
            新增折扣
          </button>
        )
      }
    >
      <p className="tennis-muted">同片球场同一时段只应用一条有效折扣；重叠规则需调整后才能生效。</p>
      <ErrorNotice error={rules.error} retry={() => void rules.refresh()} />
      {!rules.data ? (
        <LoadingBlock />
      ) : !rules.data.length ? (
        <EmptyState title="尚未设置时段折扣" detail="未命中折扣时，按球场标准小时价计算。" />
      ) : (
        rules.data.map((rule) => (
          <div className="tennis-ledger-row" key={rule.id}>
            <div>
              <strong>
                {rule.name} · {rule.discountBps / 1000} 折
              </strong>
              <span>
                {rule.dateFrom} 至 {rule.dateTo} · {minuteLabel(rule.startMinute)}–{minuteLabel(rule.endMinute)} ·{" "}
                {rule.weekdays.map((d) => weekdays[d]).join("、")}
              </span>
              <span>
                {rule.courtIds.map((id) => courts.find((c) => c.id === id)?.name ?? "球场").join("、")} ·{" "}
                {rule.active ? "启用" : "停用"}
              </span>
            </div>
            {canEdit && (
              <button className="button button-secondary" onClick={() => setEditing(rule)}>
                编辑
              </button>
            )}
          </div>
        ))
      )}
      {editing && (
        <DiscountEditor
          api={api}
          venue={venue}
          courts={courts}
          current={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void rules.refresh();
          }}
        />
      )}
    </Panel>
  );
}
function DiscountEditor({
  api,
  venue,
  courts,
  current,
  onClose,
  onSaved,
}: {
  api: TennisApi;
  venue: VenueRecord;
  courts: CourtRecord[];
  current: SavedDiscount | "new";
  onClose: () => void;
  onSaved: () => void;
}) {
  const source = current === "new" ? null : current;
  const [draft, setDraft] = useState({
    name: source?.name ?? "",
    dateFrom: source?.dateFrom ?? dateValue(),
    dateTo: source?.dateTo ?? dateValue(),
    weekdays: source?.weekdays ?? [1, 2, 3, 4, 5],
    startMinute: source?.startMinute ?? 480,
    endMinute: source?.endMinute ?? 1080,
    courtIds: source?.courtIds ?? [],
    discount: String((source?.discountBps ?? 8000) / 1000),
    active: source?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      const { discount, active, ...rest } = draft;
      await api(`/venues/${venue.id}/discounts`, "POST", {
        rule: {
          ...rest,
          venueId: venue.id,
          discountBps: Math.round(Number(discount) * 1000),
          ...(source ? { id: source.id } : {}),
        },
        active,
        ...(source ? { expectedRevision: source.revision } : {}),
      });
      onSaved();
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={source ? "编辑时段折扣" : "新增时段折扣"} onClose={onClose} closeDisabled={busy}>
      <form
        className="tennis-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <ErrorNotice error={error} />
        <label>
          规则名称
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required />
        </label>
        <div className="tennis-two">
          <label>
            开始日期
            <input
              type="date"
              value={draft.dateFrom}
              onChange={(e) => setDraft({ ...draft, dateFrom: e.target.value })}
              required
            />
          </label>
          <label>
            结束日期
            <input
              type="date"
              value={draft.dateTo}
              min={draft.dateFrom}
              onChange={(e) => setDraft({ ...draft, dateTo: e.target.value })}
              required
            />
          </label>
        </div>
        <div className="tennis-check-group">
          {weekdays.map((day, index) => (
            <label className="tennis-check" key={day}>
              <input
                type="checkbox"
                checked={draft.weekdays.includes(index)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    weekdays: e.target.checked ? [...draft.weekdays, index] : draft.weekdays.filter((d) => d !== index),
                  })
                }
              />
              {day}
            </label>
          ))}
        </div>
        <div className="tennis-two">
          <label>
            使用开始
            <MinuteSelect
              label="折扣开始时间"
              value={draft.startMinute}
              onChange={(value) => setDraft({ ...draft, startMinute: value })}
            />
          </label>
          <label>
            使用结束
            <MinuteSelect
              label="折扣结束时间"
              value={draft.endMinute}
              onChange={(value) => setDraft({ ...draft, endMinute: value })}
            />
          </label>
        </div>
        <fieldset>
          <legend>适用球场</legend>
          <div className="tennis-check-group">
            {courts.map((court) => (
              <label className="tennis-check" key={court.id}>
                <input
                  type="checkbox"
                  checked={draft.courtIds.includes(court.id)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      courtIds: e.target.checked
                        ? [...draft.courtIds, court.id]
                        : draft.courtIds.filter((id) => id !== court.id),
                    })
                  }
                />
                {court.name}
              </label>
            ))}
          </div>
        </fieldset>
        <label>
          折扣（例如 8 表示八折）
          <input
            type="number"
            step="0.001"
            min="0"
            max="10"
            value={draft.discount}
            onChange={(e) => setDraft({ ...draft, discount: e.target.value })}
            required
          />
        </label>
        <label className="tennis-check">
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
          />
          启用规则
        </label>
        <button className="button button-primary" disabled={busy || !draft.courtIds.length || !draft.weekdays.length}>
          {busy ? "正在保存…" : "保存折扣"}
        </button>
      </form>
    </Modal>
  );
}
function Offers({ api }: { api: TennisApi }) {
  const data = useLoad(() => api<TopupOffer[]>("/topup-offers"), [api]);
  const [edit, setEdit] = useState<TopupOffer | "new" | null>(null);
  return (
    <Panel
      title="线上充值方案"
      action={
        <button className="button button-primary" onClick={() => setEdit("new")}>
          新增方案
        </button>
      }
    >
      <ErrorNotice error={data.error} />
      {data.data?.map((offer) => (
        <div className="tennis-ledger-row" key={offer.id}>
          <div>
            <strong>{offer.name}</strong>
            <span>
              实付 {money(offer.principalCents)}，赠送 {money(offer.giftCents)} · {offer.active ? "可选" : "停用"}
            </span>
          </div>
          <button className="button button-secondary" onClick={() => setEdit(offer)}>
            编辑
          </button>
        </div>
      ))}
      {data.data?.length === 0 && (
        <EmptyState title="暂无充值方案" detail="客户仍可按人民币自定义金额充值；新增方案可设置赠送金额。" />
      )}
      {edit && (
        <OfferEditor
          api={api}
          source={edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            void data.refresh();
          }}
        />
      )}
    </Panel>
  );
}
function OfferEditor({
  api,
  source,
  onClose,
  onSaved,
}: {
  api: TennisApi;
  source: TopupOffer | "new";
  onClose: () => void;
  onSaved: () => void;
}) {
  const current = source === "new" ? null : source;
  const [name, setName] = useState(current?.name ?? "");
  const [amount, setAmount] = useState(String((current?.principalCents ?? 0) / 100));
  const [gift, setGift] = useState(String((current?.giftCents ?? 0) / 100));
  const [active, setActive] = useState(current?.active ?? true);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="充值方案" onClose={onClose} closeDisabled={busy}>
      <form
        className="tennis-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void Promise.resolve()
            .then(() =>
              api("/topup-offers", "POST", {
                name,
                principalCents: cents(amount),
                giftCents: cents(gift),
                active,
                ...(current ? { id: current.id, expectedRevision: current.revision } : {}),
              }),
            )
            .then(onSaved)
            .catch(setError)
            .finally(() => setBusy(false));
        }}
      >
        <ErrorNotice error={error} />
        <label>
          方案名称
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          实付本金（元）
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </label>
        <label>
          赠送金额（元）
          <input type="number" min="0" step="0.01" value={gift} onChange={(e) => setGift(e.target.value)} required />
        </label>
        <label className="tennis-check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          启用
        </label>
        <button className="button button-primary" disabled={busy}>
          保存充值方案
        </button>
      </form>
    </Modal>
  );
}

import { InfoHint } from "./InfoHint";
import { TopupHistoryPanel } from "./TopupHistoryPanel";
import { useRef, useState } from "react";
import { Plus, Wallet as WalletIcon } from "lucide-react";
import type { TennisApi } from "./api";
import type { CustomerRecord, Session, TopupOffer, TopupPayment, TopupQuote, VenueRecord, Wallet } from "./types";
import { permits } from "./types";
import { CustomerPicker } from "./CustomerPicker";
import { PaymentChannelPanel } from "./PaymentChannelPanel";
import {
  Badge,
  cents,
  dateTime,
  EmptyState,
  ErrorNotice,
  label,
  LoadingBlock,
  Modal,
  money,
  PageHeading,
  Panel,
  pendingCommands,
  RefreshButton,
  useCommand,
  useDraft,
  useLoad,
} from "./components";

export function MembersPage({
  api,
  session,
  venue,
  scope,
}: {
  api: TennisApi;
  session: Session;
  venue: VenueRecord;
  scope: string;
}) {
  const [customer, setCustomer] = useDraft<CustomerRecord | null>(`tennis:member:${scope}`, null);
  const customerId = session.customerId ?? customer?.id;
  const [historyCursors, setHistoryCursors] = useDraft<string[]>(
    `tennis:wallet-pages:${scope}:${customerId ?? "none"}`,
    [],
  );
  const cursor = historyCursors.at(-1);
  const wallet = useLoad(
    () =>
      customerId
        ? api<Wallet>(
            `/customers/${customerId}/wallet?pageSize=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          )
        : Promise.resolve(null),
    [api, customerId, cursor],
  );
  const [topupRevision, setTopupRevision] = useState(0);
  const refreshWallet = () => {
    setTopupRevision((value) => value + 1);
    if (historyCursors.length) setHistoryCursors([]);
    else void wallet.refresh();
  };
  const [topup, setTopup] = useState(false);
  return (
    <>
      <PageHeading title="会员储值">
        <RefreshButton onClick={refreshWallet} busy={wallet.busy} />
      </PageHeading>
      <div className="tennis-members-layout">
        {session.kind !== "customer" && (
          <Panel title="客户档案">
            <CustomerPicker
              api={api}
              value={customer}
              onChange={setCustomer}
              canCreate={permits(session, "manage_members")}
            />
          </Panel>
        )}
        <div>
          <ErrorNotice error={wallet.error} retry={() => void wallet.refresh()} />
          {!customerId ? (
            <Panel>
              <EmptyState title="选择一个客户" detail="可按姓名或手机号查找，查看余额、充值和消费流水。" />
            </Panel>
          ) : wallet.busy && !wallet.data ? (
            <LoadingBlock />
          ) : wallet.data ? (
            <>
              <Panel
                title={customer?.nickname ?? "我的余额"}
                action={
                  <button className="button button-primary" onClick={() => setTopup(true)}>
                    <Plus size={16} />
                    充值
                  </button>
                }
              >
                <div className="tennis-balance">
                  <WalletIcon size={22} />
                  <div>
                    <span>可用余额 <InfoHint label="余额使用说明">同一商家的各场馆通用。先使用较早充值的余额，每次按该笔充值的本金和赠送比例扣除。会员身份不额外打折。</InfoHint></span>
                    <strong>{money(wallet.data.balance.availableCents)}</strong>
                  </div>
                </div>
                <div className="tennis-stats">
                  <div>
                    <span>账户总额</span>
                    <strong>{money(wallet.data.balance.totalCents)}</strong>
                  </div>
                  <div>
                    <span>付款预留</span>
                    <strong>{money(wallet.data.balance.reservedCents)}</strong>
                  </div>
                  <div>
                    <span>剩余本金</span>
                    <strong>{money(wallet.data.balance.principalCents)}</strong>
                  </div>
                  <div>
                    <span>剩余赠送</span>
                    <strong>{money(wallet.data.balance.giftCents)}</strong>
                  </div>
                </div>
              </Panel>
              <TopupHistoryPanel
                api={api}
                session={session}
                venue={venue}
                scope={scope}
                customerId={customerId}
                revision={topupRevision}
                onChanged={refreshWallet}
              />
              <Panel title="资金明细" action={<InfoHint label="资金明细说明">每笔金额分为本金和赠送。付款预留期间，这部分余额暂时不能使用；释放后恢复可用。</InfoHint>}>
                {wallet.data.entries.length === 0 ? (
                  <EmptyState title="暂无资金明细" detail="充值、付款预留、扣款和退款会在这里记录。" />
                ) : (
                  <div className="tennis-table-scroll">
                    <table className="tennis-table">
                      <thead>
                        <tr>
                          <th>时间</th>
                          <th>事项</th>
                          <th>本金</th>
                          <th>赠送</th>
                          <th>合计</th>
                        </tr>
                      </thead>
                      <tbody>
                        {wallet.data.entries.map((entry) => (
                          <tr key={entry.id}>
                            <td>{dateTime(entry.createdAt, venue.timezone)}</td>
                            <td>
                              {label(entry.kind)}
                              <small>记录 {entry.sourceId.slice(0, 8)}</small>
                            </td>
                            <td className="tennis-numeric">{money(entry.principalCents)}</td>
                            <td className="tennis-numeric">{money(entry.giftCents)}</td>
                            <td className="tennis-numeric">{money(entry.principalCents + entry.giftCents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="tennis-actions">
                  <button
                    className="button button-secondary"
                    disabled={wallet.busy || historyCursors.length === 0}
                    onClick={() => setHistoryCursors((previous) => previous.slice(0, -1))}
                  >
                    上一页
                  </button>
                  <span className="tennis-muted">第 {historyCursors.length + 1} 页</span>
                  <button
                    className="button button-secondary"
                    disabled={wallet.busy || !wallet.data.nextCursor}
                    onClick={() => {
                      const next = wallet.data?.nextCursor;
                      if (next) setHistoryCursors((previous) => [...previous, next]);
                    }}
                  >
                    更早明细
                  </button>
                </div>
              </Panel>
            </>
          ) : null}
        </div>
      </div>
      {topup && customerId && (
        <TopupDialog
          api={api}
          session={session}
          venue={venue}
          scope={scope}
          customerId={customerId}
          onClose={() => {
            setTopup(false);
            refreshWallet();
          }}
          onChanged={refreshWallet}
        />
      )}
    </>
  );
}
function TopupDialog({
  api,
  session,
  venue,
  scope,
  customerId,
  onClose,
  onChanged,
}: {
  api: TennisApi;
  session: Session;
  venue: VenueRecord;
  scope: string;
  customerId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useDraft(`tennis:topup:${scope}:${customerId}`, {
    mode: "online",
    amount: "",
    gift: "0",
    offerId: "",
    reference: "",
    reason: "",
    quote: null as TopupQuote | null,
    payment: null as TopupPayment | null,
  });
  const version = useRef(0);
  const offers = useLoad(() => api<TopupOffer[]>("/topup-offers"), [api]);
  const command = useCommand(scope);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const offer = offers.data?.find((o) => o.id === draft.offerId);
  function update(patch: Partial<typeof draft>) {
    version.current++;
    setDraft((current) => ({ ...current, ...patch, quote: null }));
    setNotice("");
  }
  async function offline() {
    try {
      const payload = {
        venueId: venue.id,
        principalCents: cents(draft.amount),
        giftCents: cents(draft.gift),
        receiptReference: draft.reference,
        reason: draft.reason,
      };
      const result = await command.execute(`wallet.offline:${customerId}`, payload, (key) =>
        api(`/customers/${customerId}/topups/offline`, "POST", { ...payload, commandKey: key }),
      );
      if (result) {
        setNotice("线下收款已登记，余额已入账。");
        setDraft((current) => ({ ...current, amount: "", gift: "0", reference: "", reason: "" }));
        onChanged();
      }
    } catch (next) {
      setError(next);
    }
  }
  async function getQuote() {
    if (pendingCommands(scope).some((p) => p.intent.startsWith("topup.confirm:"))) {
      setError(new Error("上一笔充值结果还未确认，请先核对。"));
      return;
    }
    const started = version.current;
    setQuoteBusy(true);
    setError(undefined);
    try {
      const quote = await api<TopupQuote>(`/customers/${customerId}/topup-quotes`, "POST", {
        venueId: venue.id,
        ...(draft.offerId ? { offerId: draft.offerId } : { principalCents: cents(draft.amount) }),
      });
      if (started === version.current) setDraft((current) => ({ ...current, quote }));
    } catch (next) {
      setError(next);
    } finally {
      setQuoteBusy(false);
    }
  }
  async function confirm() {
    if (!draft.quote) return;
    const result = await command.execute(`topup.confirm:${draft.quote.id}`, { quoteId: draft.quote.id }, (key) =>
      api<TopupPayment>(`/topup-quotes/${draft.quote!.id}/confirm`, "POST", { commandKey: key }),
    );
    if (result) {
      setDraft((current) => ({ ...current, payment: result, quote: null }));
      onChanged();
    }
  }
  async function refreshPayment() {
    if (!draft.payment) return;
    try {
      const payment = await api<TopupPayment>(`/topups/${draft.payment.id}`);
      setDraft((current) => ({ ...current, payment }));
      onChanged();
    } catch (next) {
      setError(next);
    }
  }
  async function simulate(status: "SUCCEEDED" | "FAILED") {
    if (!draft.payment) return;
    const result = await command.execute(`topup.simulate:${draft.payment.id}:${status}`, { status }, (key) =>
      api<TopupPayment>(`/topups/${draft.payment!.id}/simulate`, "POST", { status }),
    );
    if (result) {
      setDraft((current) => ({ ...current, payment: result }));
      onChanged();
    }
  }
  return (
    <Modal title="会员充值" onClose={onClose} closeDisabled={command.busy || quoteBusy}>
      <div className="tennis-form">
        <ErrorNotice error={error ?? command.error ?? offers.error} />
        {notice && (
          <div className="tennis-success" role="status">
            {notice}
          </div>
        )}
        {draft.payment ? (
          <>
            <h3>充值付款单</h3>
            <div className="tennis-money-row">
              <span>实付本金</span>
              <strong>{money(draft.payment.principalCents)}</strong>
            </div>
            <div className="tennis-money-row">
              <span>赠送金额</span>
              <strong>{money(draft.payment.giftCents)}</strong>
            </div>
            <Badge value={draft.payment.status} />
            <PaymentChannelPanel
              api={api}
              kind="topup"
              sourceId={draft.payment.id}
              scope={`${scope}:${session.contextVersion}`}
              businessStatus={draft.payment.status}
              timezone={venue.timezone}
              canOperate={session.kind === "customer" || permits(session, "manage_members")}
              businessBusy={command.busy}
              onChanged={refreshPayment}
            />
            <p className="tennis-note">
              {draft.payment.provider === "MOCK"
                ? "本地模拟充值，不会发生真实扣费。"
                : "付款成功后，充值金额才会到账。"}
            </p>
            <div className="tennis-actions">
              <RefreshButton busy={command.busy} onClick={() => void refreshPayment()} />
              {session.localSimulation && draft.payment.provider === "MOCK" && draft.payment.status === "PENDING" && (
                <>
                  <button
                    className="button button-primary"
                    disabled={command.busy}
                    onClick={() => void simulate("SUCCEEDED")}
                  >
                    模拟充值成功
                  </button>
                  <button
                    className="button button-secondary"
                    disabled={command.busy}
                    onClick={() => void simulate("FAILED")}
                  >
                    模拟失败
                  </button>
                </>
              )}
              {draft.payment.status !== "PENDING" && (
                <button
                  className="button button-secondary"
                  onClick={() => update({ payment: null, amount: "", offerId: "" })}
                >
                  完成 / 再次充值
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            {permits(session, "manage_members") && (
              <div className="tennis-tabs">
                <button
                  type="button"
                  className={draft.mode === "online" ? "active" : ""}
                  disabled={command.busy}
                  onClick={() => update({ mode: "online" })}
                >
                  线上充值
                </button>
                <button
                  type="button"
                  className={draft.mode === "offline" ? "active" : ""}
                  disabled={command.busy}
                  onClick={() => update({ mode: "offline" })}
                >
                  登记线下实收
                </button>
              </div>
            )}
            {draft.mode === "online" ? (
              draft.quote ? (
                <>
                  <div className="tennis-money-row">
                    <span>实付</span>
                    <strong>{money(draft.quote.principalCents)}</strong>
                  </div>
                  <div className="tennis-money-row">
                    <span>赠送</span>
                    <strong>{money(draft.quote.giftCents)}</strong>
                  </div>
                  <div className="tennis-money-row tennis-total">
                    <span>可消费金额</span>
                    <strong>{money(draft.quote.principalCents + draft.quote.giftCents)}</strong>
                  </div>
                  <p className="tennis-muted">
                    方案有效至 {dateTime(draft.quote.expiresAt, venue.timezone)}，付款成功后入账。
                  </p>
                  <div className="tennis-actions">
                    <button className="button button-secondary" disabled={command.busy} onClick={() => update({})}>
                      返回修改
                    </button>
                    <button className="button button-primary" disabled={command.busy} onClick={() => void confirm()}>
                      确认充值方案
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <label>
                    充值方案
                    <select value={draft.offerId} onChange={(e) => update({ offerId: e.target.value })}>
                      <option value="">自定义金额（不赠送）</option>
                      {offers.data
                        ?.filter((o) => o.active)
                        .map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name} · 实付 {money(o.principalCents)} / 赠送 {money(o.giftCents)}
                          </option>
                        ))}
                    </select>
                  </label>
                  {!offer && (
                    <label>
                      充值本金（元）
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={draft.amount}
                        onChange={(e) => update({ amount: e.target.value })}
                      />
                    </label>
                  )}
                  <button
                    className="button button-primary"
                    disabled={quoteBusy || (!offer && !draft.amount)}
                    onClick={() => void getQuote()}
                  >
                    {quoteBusy ? "正在生成方案…" : "核对充值方案"}
                  </button>
                </>
              )
            ) : (
              <>
                <label>
                  已收金额（元）
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={draft.amount}
                    onChange={(e) => update({ amount: e.target.value })}
                  />
                </label>
                <label>
                  赠送金额（元）
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={draft.gift}
                    onChange={(e) => update({ gift: e.target.value })}
                  />
                </label>
                <label>
                  收款凭证号
                  <input
                    value={draft.reference}
                    onChange={(e) => update({ reference: e.target.value })}
                    maxLength={200}
                    placeholder="转账流水号或收款登记编号"
                  />
                </label>
                <label>
                  收款说明
                  <textarea
                    value={draft.reason}
                    onChange={(e) => update({ reason: e.target.value })}
                    maxLength={2000}
                  />
                </label>
                <p className="tennis-note">
                  请确认款项已经收到。提交后，本金和赠送金额会计入客户余额。
                </p>
                <button
                  className="button button-primary"
                  disabled={command.busy || !draft.amount || !draft.reference.trim() || !draft.reason.trim()}
                  onClick={() => void offline()}
                >
                  {command.busy ? "正在登记…" : "确认已收款并入账"}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

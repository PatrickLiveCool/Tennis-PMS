import { InfoHint } from "./InfoHint";
import { useRef, useState } from "react";
import type { TennisApi } from "./api";
import type { TopupPayment, Session, VenueRecord } from "./types";
import { permits } from "./types";
import {
  Badge,
  dateTime,
  EmptyState,
  ErrorNotice,
  LoadingBlock,
  Modal,
  money,
  Panel,
  pendingCommands,
  RefreshButton,
  useCommand,
  useDraft,
  useLoad,
} from "./components";
import { PaymentChannelPanel } from "./PaymentChannelPanel";

interface CommonProps {
  api: TennisApi;
  session: Session;
  venue: VenueRecord;
  scope: string;
  onChanged: () => void;
}
export function TopupHistoryPanel(props: CommonProps & { customerId: string; revision: number }) {
  return <TopupHistory key={`${props.scope}:${props.customerId}`} {...props} />;
}
function TopupHistory({
  api,
  session,
  venue,
  scope,
  customerId,
  revision,
  onChanged,
}: CommonProps & { customerId: string; revision: number }) {
  const [query, setQuery] = useDraft(`tennis:topup-directory:${scope}:${customerId}`, {
    status: "",
    cursors: [] as string[],
  });
  const [selected, setSelected] = useState<string | null>(null);
  const cursor = query.cursors.at(-1);
  const page = useLoad(
    () =>
      api<{ items: TopupPayment[]; nextCursor: string | null }>(
        `/venues/${venue.id}/customers/${customerId}/topups?pageSize=20${query.status ? `&status=${query.status}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    [api, venue.id, customerId, query.status, cursor, revision],
  );
  return (
    <>
      <Panel title="线上充值记录" action={<RefreshButton busy={page.busy} onClick={() => void page.refresh()} />}>
        <p className="tennis-muted">{venue.name}</p>
        <label>
          充值状态{" "}
          <select
            aria-label="充值记录状态"
            value={query.status}
            onChange={(e) => setQuery({ status: e.target.value, cursors: [] })}
          >
            <option value="">全部</option>
            <option value="PENDING">待付款 / 待核对</option>
            <option value="FAILED">失败</option>
            <option value="SUCCEEDED">已入账</option>
          </select>
        </label>
        <ErrorNotice error={page.error} retry={() => void page.refresh()} />
        {page.busy && !page.data ? (
          <LoadingBlock />
        ) : page.data ? (
          <>
            {!!page.error && <p className="tennis-note">刷新失败，以下为上次结果。</p>}
            {!page.data.items.length ? (
              <EmptyState title="暂无符合条件的充值" detail="可调整筛选条件，或新建充值。" />
            ) : (
              <div className="tennis-table-scroll">
                <table className="tennis-table">
                  <thead>
                    <tr>
                      <th>时间 / 原单</th>
                      <th>本金</th>
                      <th>赠送</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.data.items.map((item) => (
                      <tr key={item.id}>
                        <td>
                          {dateTime(item.createdAt, venue.timezone)}
                          <small>{item.id.slice(0, 8)}</small>
                        </td>
                        <td>{money(item.principalCents)}</td>
                        <td>{money(item.giftCents)}</td>
                        <td>
                          <Badge value={item.status} />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="button button-secondary button-small"
                            onClick={() => setSelected(item.id)}
                          >
                            核对原充值
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="tennis-actions">
              <button
                type="button"
                className="button button-secondary"
                disabled={page.busy || !query.cursors.length}
                onClick={() => setQuery((q) => ({ ...q, cursors: q.cursors.slice(0, -1) }))}
              >
                上一页
              </button>
              <span>第 {query.cursors.length + 1} 页</span>
              <button
                type="button"
                className="button button-secondary"
                disabled={page.busy || !page.data.nextCursor}
                onClick={() => {
                  const next = page.data?.nextCursor;
                  if (next) setQuery((q) => ({ ...q, cursors: [...q.cursors, next] }));
                }}
              >
                更早充值
              </button>
            </div>
          </>
        ) : null}
      </Panel>
      {selected && (
        <TopupRecordDialog
          api={api}
          session={session}
          venue={venue}
          scope={scope}
          topupId={selected}
          onClose={() => setSelected(null)}
          onChanged={() => {
            void page.refresh();
            onChanged();
          }}
        />
      )}
    </>
  );
}
export function TopupRecordDialog(props: CommonProps & { topupId: string; onClose: () => void }) {
  return <TopupRecord key={`${props.scope}:${props.topupId}`} {...props} />;
}
function TopupRecord({
  api,
  session,
  venue,
  scope,
  topupId,
  onClose,
  onChanged,
}: CommonProps & { topupId: string; onClose: () => void }) {
  const payment = useLoad(async () => {
    const row = await api<TopupPayment>(`/topups/${encodeURIComponent(topupId)}`);
    if (row.id !== topupId || row.venueId !== venue.id)
      throw new Error("当前场馆无法查看这笔充值，请重新打开记录。");
    return row;
  }, [api, topupId, venue.id]);
  const command = useCommand(scope);
  const simulating = useRef(false);
  const [unknown, setUnknown] = useState(() =>
    pendingCommands(scope).some((item) => item.intent.startsWith(`topup.simulate:${topupId}:`)),
  );
  const canOperate = session.kind === "customer" || permits(session, "manage_members");
  const current = payment.data;
  async function refresh() {
    await payment.refresh();
    onChanged();
  }
  async function simulate(status: "SUCCEEDED" | "FAILED") {
    if (
      simulating.current ||
      unknown ||
      !current ||
      current.status !== "PENDING" ||
      !session.localSimulation ||
      current.provider !== "MOCK" ||
      !canOperate ||
      payment.error
    )
      return;
    simulating.current = true;
    try {
      const result = await command.execute(`topup.simulate:${topupId}:${status}`, { status }, () =>
        api<TopupPayment>(`/topups/${topupId}/simulate`, "POST", { status }),
      );
      if (!result) setUnknown(true);
      await refresh();
    } finally {
      simulating.current = false;
    }
  }
  return (
    <Modal title="核对原充值" onClose={onClose} closeDisabled={command.busy}>
      <div className="tennis-form">
        <ErrorNotice error={payment.error ?? command.error} retry={() => void refresh()} />
        {!current ? (
          payment.busy ? (
            <LoadingBlock />
          ) : null
        ) : (
          <>
            <p className="tennis-muted" style={{ overflowWrap: "anywhere" }}>
              充值 {current.id.slice(0, 8)} <InfoHint label="充值编号">{current.id}</InfoHint>
            </p>
            <Badge value={current.status} />
            <div className="tennis-money-row">
              <span>实付本金</span>
              <strong>{money(current.principalCents)}</strong>
            </div>
            <div className="tennis-money-row">
              <span>到账赠送</span>
              <strong>{money(current.giftCents)}</strong>
            </div>
            <p>
              创建于 {dateTime(current.createdAt, venue.timezone)}
              {current.settledAt ? ` · 入账于 ${dateTime(current.settledAt, venue.timezone)}` : ""}
            </p>
            {current.status === "SUCCEEDED" && (
              <p className="tennis-success">这笔充值已入账。</p>
            )}
            {unknown && current.status === "PENDING" && (
              <p className="tennis-note">模拟充值结果尚未确认，请先查询结果。</p>
            )}
            <PaymentChannelPanel
              api={api}
              kind="topup"
              sourceId={topupId}
              scope={scope}
              businessStatus={current.status}
              timezone={venue.timezone}
              canOperate={canOperate && !payment.error}
              businessBusy={command.busy}
              onChanged={refresh}
            />
            <div className="tennis-actions">
              <RefreshButton busy={command.busy || payment.busy} onClick={() => void refresh()} />
              {session.localSimulation && current.provider === "MOCK" && current.status === "PENDING" && canOperate && (
                <>
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={command.busy || !!payment.error || unknown}
                    onClick={() => void simulate("SUCCEEDED")}
                  >
                    模拟充值成功
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={command.busy || !!payment.error || unknown}
                    onClick={() => void simulate("FAILED")}
                  >
                    模拟充值失败
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

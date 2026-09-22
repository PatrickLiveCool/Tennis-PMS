import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Search, UserPlus, X } from "lucide-react";
import { TennisApiError, type TennisApi } from "./api";
import type { CustomerRecord } from "./types";
import type { MemberDirectoryPage } from "../../../../packages/db/src/tennis/member-directory";
import { EmptyState, ErrorNotice, LoadingBlock, Modal, readStored, writeStored } from "./components";

export function MemberDirectory({ api, scope, revision, selected, onSelect }: {
  api: TennisApi;
  scope: string;
  revision: number;
  selected: CustomerRecord | null;
  onSelect: (customer: CustomerRecord | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<unknown>();
  const [retry, setRetry] = useState(0);
  const [create, setCreate] = useState(false);
  const serial = useRef(0);
  const loadingMore = useRef(false);
  const initialized = useRef(false);
  const previousSearch = useRef("");
  const selectionVersion = useRef(0);
  const latest = useRef({ selected, onSelect });
  latest.current = { selected, onSelect };
  const listRef = useRef<HTMLDivElement>(null);
  const [preferredId] = useState(() =>
    readStored<string | null>(`tennis:member-context:${scope}`, null)
      ?? readStored<CustomerRecord | null>(`tennis:member:${scope}`, null)?.id,
  );
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  useLayoutEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    if (!list || !active) return;
    const viewport = list.getBoundingClientRect();
    const row = active.getBoundingClientRect();
    if (row.top < viewport.top) list.scrollTop += row.top - viewport.top;
    else if (row.bottom > viewport.bottom) list.scrollTop += row.bottom - viewport.bottom;
  }, [selected?.id]);

  const path = `/customers/directory?pageSize=50&q=${encodeURIComponent(search)}`;
  useEffect(() => {
    const request = ++serial.current;
    const selectionAtStart = selectionVersion.current;
    const searchChanged = search !== previousSearch.current;
    loadingMore.current = false;
    setBusy(true);
    setError(undefined);
    if (searchChanged) {
      setCustomers([]);
      setNextCursor(null);
      if (listRef.current) listRef.current.scrollTop = 0;
    }
    const preferred = !initialized.current && preferredId
      ? api<CustomerRecord>(`/customers/${encodeURIComponent(preferredId)}`).catch((reason: unknown) => {
          if (reason instanceof TennisApiError && reason.status === 404) return null;
          throw reason;
        })
      : Promise.resolve(null);
    void Promise.all([api<MemberDirectoryPage>(path), preferred]).then(([page, preferredCustomer]) => {
      if (request !== serial.current) return;
      setCustomers(page.customers);
      setNextCursor(page.nextCursor);
      if (selectionAtStart === selectionVersion.current) {
        const current = latest.current.selected;
        const listed = page.customers.find((item) => item.id === current?.id);
        const match = listed?.active ? listed : undefined;
        const target = !initialized.current && !search && preferredCustomer?.active
          ? preferredCustomer
          : match ?? ((!search || !searchChanged) && current && !listed ? current : page.customers.find((item) => item.active) ?? null);
        latest.current.onSelect(target);
      }
      initialized.current = true;
      previousSearch.current = search;
      if (readStored(`tennis:member-context:${scope}`, null) === preferredId)
        writeStored(`tennis:member-context:${scope}`, null);
    }).catch((reason: unknown) => {
      if (request === serial.current) setError(reason);
    }).finally(() => {
      if (request === serial.current) setBusy(false);
    });
    return () => { serial.current++; };
  }, [api, path, revision, retry, scope]);

  async function loadMore() {
    if (!nextCursor || busy || loadingMore.current || query.trim() !== search) return;
    const request = serial.current;
    const selectionAtStart = selectionVersion.current;
    loadingMore.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const page = await api<MemberDirectoryPage>(`${path}&cursor=${encodeURIComponent(nextCursor)}`);
      if (request !== serial.current) return;
      setCustomers((previous) => {
        const ids = new Set(previous.map((item) => item.id));
        return [...previous, ...page.customers.filter((item) => !ids.has(item.id))];
      });
      setNextCursor(page.nextCursor);
      if (!latest.current.selected && selectionAtStart === selectionVersion.current)
        latest.current.onSelect(page.customers.find((item) => item.active) ?? null);
    } catch (reason) {
      if (request === serial.current) setError(reason);
    } finally {
      if (request === serial.current) { loadingMore.current = false; setBusy(false); }
    }
  }
  function select(customer: CustomerRecord) {
    selectionVersion.current++;
    initialized.current = true;
    onSelect(customer);
  }
  // Keep a recent business customer visible even when their alphabetical position
  // falls beyond the loaded pages. Search results always follow the query.
  const visibleCustomers = !search && selected && !customers.some((item) => item.id === selected.id)
    ? [selected, ...customers]
    : customers;
  return <section className="tennis-member-directory" aria-labelledby="tennis-member-list-title">
    <div className="tennis-member-list-heading">
      <h2 id="tennis-member-list-title">会员清单</h2>
      <button className="button button-secondary button-small" onClick={() => setCreate(true)}>
        <UserPlus size={15} aria-hidden="true" />新增会员
      </button>
    </div>
    <div className="tennis-member-search">
      <div className="tennis-search">
        <Search size={17} aria-hidden="true" />
        <input type="search" aria-label="搜索会员姓名或手机号" placeholder="姓名 / 手机号" maxLength={200}
          value={query} onChange={(event) => setQuery(event.target.value)} />
        {query && <button className="icon-button" aria-label="清除会员搜索" onClick={() => setQuery("")}><X size={15} /></button>}
      </div>
    </div>
    <div className="tennis-member-list-scroll" ref={listRef} aria-busy={busy || query.trim() !== search}
      onScroll={(event) => {
        const node = event.currentTarget;
        if (!error && node.scrollHeight - node.scrollTop - node.clientHeight < 100) void loadMore();
      }}>
      <ErrorNotice error={error} retry={() => setRetry((value) => value + 1)} />
      {!visibleCustomers.length && busy ? <LoadingBlock label="正在加载会员" /> : null}
      {!visibleCustomers.length && !busy && !error && <EmptyState
        title={search ? "未找到会员" : "暂无会员"}
        detail={search ? "换个姓名或手机号试试。" : "点击新增会员，登记第一位会员。"} />}
      <ul className="tennis-member-list">
        {visibleCustomers.map((customer) => <li key={customer.id}>
          <button className="tennis-member-list-item" aria-pressed={customer.id === selected?.id}
            disabled={!customer.active} onClick={() => select(customer)}>
            <strong>{customer.nickname}</strong>
            {customer.id === selected?.id && <Check size={16} aria-hidden="true" />}
            <span>{customer.phone ?? "未登记手机号"}{!customer.active ? " · 已停用" : ""}</span>
          </button>
        </li>)}
      </ul>
      {nextCursor && <button className="button button-secondary tennis-member-load-more" disabled={busy}
        onClick={() => void loadMore()}>{busy ? "正在加载…" : "加载更多会员"}</button>}
    </div>
    {create && <NewMemberDialog api={api} onClose={() => setCreate(false)} onCreated={(customer) => {
      select(customer);
      setQuery("");
      setSearch("");
      setCreate(false);
      setRetry((value) => value + 1);
    }} />}
  </section>;
}

function NewMemberDialog({ api, onClose, onCreated }: {
  api: TennisApi; onClose: () => void; onCreated: (customer: CustomerRecord) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  return <Modal title="新增会员" onClose={onClose} closeDisabled={busy}>
    <form className="tennis-form" onSubmit={async (event) => {
      event.preventDefault();
      setBusy(true); setError(undefined);
      try { onCreated(await api<CustomerRecord>("/customers", "POST", { nickname: name, phone })); }
      catch (reason) { setError(reason); }
      finally { setBusy(false); }
    }}>
      <ErrorNotice error={error} />
      <label>姓名<input autoFocus required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>手机号<input type="tel" autoComplete="tel" required value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
      <button type="submit" className="button button-primary" disabled={busy}>{busy ? "正在登记…" : "登记并选择"}</button>
    </form>
  </Modal>;
}

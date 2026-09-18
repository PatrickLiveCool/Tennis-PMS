import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import type { TennisApi } from "./api";
import type { CustomerRecord } from "./types";
import { ErrorNotice, Modal, useLoad } from "./components";

export function CustomerPicker({
  api,
  value,
  onChange,
  disabled = false,
  canCreate = true,
  venueId,
}: {
  api: TennisApi;
  value: CustomerRecord | null;
  onChange: (customer: CustomerRecord) => void;
  disabled?: boolean;
  canCreate?: boolean;
  venueId?: string;
}) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [create, setCreate] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const customers = useLoad(
    () =>
      api<CustomerRecord[]>(
        `${venueId ? `/venues/${venueId}/booking-customers` : "/customers"}?q=${encodeURIComponent(search)}`,
      ),
    [api, search, venueId],
  );
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      const customer = await api<CustomerRecord>("/customers", "POST", { nickname: name, phone });
      onChange(customer);
      setCreate(false);
      setExpanded(false);
      void customers.refresh();
    } catch (next) {
      setError(next);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="tennis-customer-picker">
      <label className="tennis-label">预订人</label>
      {value && (
        <div className="tennis-selected-customer">
          <div>
            <strong>{value.nickname}</strong>
            <span>{value.phone ?? "未登记电话"}</span>
          </div>
          <button
            className="button button-secondary button-small"
            type="button"
            onClick={() => setExpanded(!expanded)}
            disabled={disabled}
          >
            更换
          </button>
        </div>
      )}
      {(!value || expanded) && (
        <>
          <div className="tennis-search">
            <Search size={17} aria-hidden="true" />
            <input
              aria-label="搜索客户姓名或手机号"
              value={query}
              onFocus={() => setExpanded(true)}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="姓名或手机号"
              disabled={disabled}
            />
          </div>
          <ErrorNotice error={customers.error} retry={() => void customers.refresh()} />
          <div className="tennis-customer-results">
            {customers.data?.slice(0, 12).map((customer) => (
              <button
                key={customer.id}
                type="button"
                className="tennis-customer-option"
                disabled={disabled}
                onClick={() => {
                  onChange(customer);
                  setExpanded(false);
                }}
              >
                <strong>{customer.nickname}</strong>
                <span>{customer.phone ?? "无电话"}</span>
              </button>
            ))}
            {customers.data?.length === 0 && <p className="tennis-muted">没有找到客户，可登记后继续。</p>}
          </div>
          {canCreate && (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setCreate(true)}
              disabled={disabled}
            >
              <Plus size={16} aria-hidden="true" />
              新增客户
            </button>
          )}
        </>
      )}
      {create && (
        <Modal title="登记新客户" onClose={() => setCreate(false)} closeDisabled={busy}>
          <form
            className="tennis-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <ErrorNotice error={error} />
            <label>
              称呼
              <input autoFocus required value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              手机号
              <input
                type="tel"
                autoComplete="tel"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="用于识别本租户内的客户"
              />
            </label>
            <p className="tennis-muted">客户资料仅在当前租户内使用；相同手机号不会合并其他租户的档案。</p>
            <button className="button button-primary" disabled={busy} type="submit">
              {busy ? "正在登记…" : "登记并选择"}
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}

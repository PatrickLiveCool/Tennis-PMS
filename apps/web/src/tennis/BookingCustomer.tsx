import { useEffect, useState } from "react";
import type { TennisApi } from "./api";
import type { CustomerRecord } from "./types";
import { ErrorNotice, useLoad } from "./components";

export interface GuestDraft {
  nickname: string;
  phone: string;
}
/** Draft-only inputs: typing/searching never creates a customer or wallet. */
export function BookingCustomer({
  api,
  venueId,
  customer,
  guest,
  disabled,
  onGuest,
  onCustomer,
}: {
  api: TennisApi;
  venueId: string;
  customer: CustomerRecord | null;
  guest: GuestDraft;
  disabled: boolean;
  onGuest: (guest: GuestDraft) => void;
  onCustomer: (customer: CustomerRecord | null) => void;
}) {
  const [search, setSearch] = useState("");
  const query = guest.phone.trim().replace(/[\s()-]/g, "") || guest.nickname.trim();
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const matches = useLoad(
    () =>
      search
        ? api<CustomerRecord[]>(`/venues/${venueId}/booking-customers?q=${encodeURIComponent(search)}`)
        : Promise.resolve([]),
    [api, venueId, search],
  );
  return (
    <div className="tennis-booking-customer">
      <h3>预订人</h3>
      {customer ? (
        <div className="tennis-selected-customer">
          <div>
            <strong>{customer.nickname}</strong>
            <span>
              {customer.phone ??
                (customer.hasContact ? "已有联系方式 · 按权限隐藏" : "未登记联系方式，无法通知")}
            </span>
          </div>
          <button
            className="button button-secondary button-small"
            disabled={disabled}
            onClick={() => onCustomer(null)}
          >
            更换
          </button>
        </div>
      ) : (
        <>
          <div className="tennis-form">
            <label>
              称呼
              <input
                autoComplete="off"
                value={guest.nickname}
                maxLength={200}
                disabled={disabled}
                placeholder="直接填写临时客，或查找已有客户"
                onChange={(e) => onGuest({ ...guest, nickname: e.target.value })}
              />
            </label>
            <label>
              手机号（选填）
              <input
                type="tel"
                autoComplete="off"
                value={guest.phone}
                maxLength={30}
                disabled={disabled}
                placeholder="填写后可识别已有客户"
                onChange={(e) => onGuest({ ...guest, phone: e.target.value })}
              />
            </label>
          </div>
          <ErrorNotice error={matches.error} retry={() => void matches.refresh()} />
          {matches.data && matches.data.length > 0 && (
            <div className="tennis-booking-matches">
              <p className="tennis-muted">找到已有客户，点击复用；同名不会自动合并。</p>
              {matches.data.slice(0, 6).map((item) => (
                <button
                  key={item.id}
                  className="tennis-customer-option"
                  disabled={disabled}
                  onClick={() => onCustomer(item)}
                >
                  <strong>{item.nickname}</strong>
                  <span>{item.hasContact ? "已有联系方式" : "无联系方式"} · 选择此人</span>
                </button>
              ))}
            </div>
          )}
          <p className="tennis-muted">
            {guest.phone
              ? "同租户手机号已有档案时，请选择已有客户。"
              : "可只填称呼；未留联系方式时无法发送通知。"}{" "}
            无需办会员或充值。
          </p>
        </>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { parseBookingPhone, invalidGuestPhoneMessage } from "../../../../packages/domain/src/customer-contact";
import type { TennisApi } from "./api";
import type { CustomerRecord } from "./types";
import { ErrorNotice, useLoad } from "./components";
import { InfoHint } from "./InfoHint";

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
  const invalidPhone = parseBookingPhone(guest.phone) === undefined;
  const needsPhone = !customer || !customer.phone && !customer.hasContact;
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
      <div className="tennis-heading-with-help">
        <h3>预订人</h3>
        <InfoHint label="预订人填写说明">姓名和手机号都要填。手机号填 11 位；找到已有客户后，直接选择即可。</InfoHint>
      </div>
      {customer ? (
        <div className="tennis-selected-customer">
          <div>
            <strong>{customer.nickname}</strong>
            <span>
              {customer.phone ??
                (customer.hasContact ? "已留手机号" : "请补充手机号")}
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
              <span>姓名<span className="tennis-required" aria-hidden="true">*</span></span>
              <input
                required
                aria-label="姓名"
                autoComplete="off"
                value={guest.nickname}
                maxLength={200}
                disabled={disabled}
                placeholder="输入姓名或搜索客户"
                onChange={(e) => onGuest({ ...guest, nickname: e.target.value })}
              />
            </label>
            <label>
              <span>手机号<span className="tennis-required" aria-hidden="true">*</span></span>
              <input
                type="tel"
                required
                aria-label="手机号"
                inputMode="numeric"
                aria-invalid={invalidPhone}
                aria-describedby={invalidPhone ? "booking-phone-error" : undefined}
                autoComplete="off"
                value={guest.phone}
                maxLength={30}
                disabled={disabled}
                placeholder="11 位手机号"
                onChange={(e) => onGuest({ ...guest, phone: e.target.value })}
              />
            </label>
            {invalidPhone && <p id="booking-phone-error" className="tennis-error" role="alert">{invalidGuestPhoneMessage}</p>}
          </div>
          <ErrorNotice error={matches.error} retry={() => void matches.refresh()} />
          {matches.data && matches.data.length > 0 && (
            <div className="tennis-booking-matches">
              <p className="tennis-muted">选择已有客户</p>
              {matches.data.slice(0, 6).map((item) => (
                <button
                  key={item.id}
                  className="tennis-customer-option"
                  disabled={disabled}
                  onClick={() => onCustomer(item)}
                >
                  <strong>{item.nickname}</strong>
                  <span>{item.hasContact ? "已留手机号" : "未留手机号"}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {customer && needsPhone && <div className="tennis-form tennis-booking-contact">
        <label><span>手机号<span className="tennis-required" aria-hidden="true">*</span></span><input type="tel" inputMode="numeric" required aria-label="手机号" autoComplete="off" maxLength={30}
          value={guest.phone} disabled={disabled} placeholder="11 位手机号"
          aria-invalid={invalidPhone} aria-describedby={invalidPhone ? "booking-contact-error" : undefined}
          onChange={(event) => onGuest({ ...guest, phone: event.target.value })} /></label>
        {invalidPhone && <p id="booking-contact-error" className="tennis-error" role="alert">{invalidGuestPhoneMessage}</p>}
      </div>}
    </div>
  );
}

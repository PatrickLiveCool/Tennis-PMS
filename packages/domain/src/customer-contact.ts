/** null means optional/blank; undefined means supplied but invalid. */
export function parseCustomerPhone(value?: string | null): string | null | undefined {
  if (!value?.trim()) return null;
  const compact = value.replace(/[\s()-]/g, "");
  const phone = /^1[3-9]\d{9}$/.test(compact) ? `+86${compact}` : compact;
  return /^\+[1-9]\d{6,14}$/.test(phone) ? phone : undefined;
}
/** Booking accepts mainland mobile numbers. +86 is only a compatible saved/pasted form. */
export function parseBookingPhone(value?: string | null): string | null | undefined {
  const phone = parseCustomerPhone(value);
  return phone === null || (phone !== undefined && /^\+861[3-9]\d{9}$/.test(phone)) ? phone : undefined;
}
// Retain the requested format warning; the later mandatory-phone rule supersedes the old skip-phone wording.
export const invalidGuestPhoneMessage = "手机号格式不正确。请填写有效的 11 位中国大陆手机号，无需国家区号。手机号为必填项，填写后才能继续预订。";

import { describe, expect, it } from "vitest";
import { parseBookingPhone, parseCustomerPhone } from "./customer-contact";

describe("optional customer contact", () => {
  it.each([undefined, null, "", "   "])("allows a guest without a phone: %s", (input) => {
    expect(parseCustomerPhone(input)).toBeNull();
  });
  it.each([["13800000001", "+8613800000001"], ["138 0000 0001", "+8613800000001"], ["+1 (202) 555-0123", "+12025550123"]])("normalizes %s", (input, expected) => {
    expect(parseCustomerPhone(input)).toBe(expected);
  });
  it.each(["123", "随便填写", "1380000000", "+0123456789", "+1234567890123456"])("rejects a supplied invalid number: %s", (input) => {
    expect(parseCustomerPhone(input)).toBeUndefined();
  });
});

describe("mainland mobile input for bookings", () => {
  it.each(["13800000001", "138 0000 0001", "+8613800000001"])("accepts the same eleven-digit mobile without requiring a country code: %s", (input) => {
    expect(parseBookingPhone(input)).toBe("+8613800000001");
  });
  it.each(["1380000000", "138000000011", "12800000001", "+861380000000", "+12025550123", "01012345678"])("rejects wrong length, non-mobile or foreign numbers: %s", (input) => {
    expect(parseBookingPhone(input)).toBeUndefined();
  });
  it("represents a missing phone separately so the booking boundary can require it", () => {
    expect(parseBookingPhone("")).toBeNull();
  });
});

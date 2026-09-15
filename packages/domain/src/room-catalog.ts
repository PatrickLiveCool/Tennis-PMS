import { DomainError, type ManagedRoomType, type RoomRateAnchors, type RoomRateChange } from "@qintopia/contracts";
import { calculateDurationBandTotalMinor } from "./pricing.ts";
import { enumerateServiceDates } from "./dates.ts";

export function validateRoomRateAnchors(value: unknown): RoomRateAnchors {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("VALIDATION_ERROR", "请填写四个档位的价格");
  const anchors = value as Record<string, unknown>;
  if (Object.keys(anchors).sort().join(",") !== "1,14,30,7"
    || !["1", "7", "14", "30"].every((key) => Number.isSafeInteger(anchors[key]) && Number(anchors[key]) > 0 && Number(anchors[key]) <= 20_000_000)) {
    throw new DomainError("VALIDATION_ERROR", "四档价格须为大于 0、不超过 20 万元的金额，最多两位小数");
  }
  return { "1": Number(anchors["1"]), "7": Number(anchors["7"]), "14": Number(anchors["14"]), "30": Number(anchors["30"]) };
}

export function catalogAnchorsAt(
  date: string, baseline: Record<string, RoomRateAnchors>, types: ManagedRoomType[], rates: RoomRateChange[]
): Record<string, RoomRateAnchors> {
  const result = structuredClone(baseline);
  for (const type of types) {
    const last = rates.filter((rate) => rate.typeCode === type.code && rate.effectiveFrom <= date)
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.version - b.version).at(-1);
    const source = type.products.find((product) => product.multiplier === 1 && baseline[product.code]);
    const anchors = last?.anchors ?? (source ? baseline[source.code] : undefined);
    if (!anchors) continue;
    for (const product of type.products) {
      result[product.code] = Object.fromEntries(Object.entries(anchors).map(([key, value]) => [key, value * product.multiplier])) as RoomRateAnchors;
    }
  }
  return result;
}

export function trialRoomRate(anchors: unknown, arrivalDate: string, departureDate: string, multiplier = 1) {
  const validated = validateRoomRateAnchors(anchors);
  if (!Number.isInteger(multiplier) || multiplier < 1 || multiplier > 100) throw new DomainError("VALIDATION_ERROR", "销售数量无效");
  const nights = enumerateServiceDates(arrivalDate, departureDate).length;
  const multiplied = Object.fromEntries(Object.entries(validated).map(([key, value]) => [key, value * multiplier])) as RoomRateAnchors;
  const calculated = calculateDurationBandTotalMinor(nights, multiplied);
  return { nights, anchorNights: nights >= 30 ? 30 : nights >= 14 ? 14 : nights >= 7 ? 7 : 1,
    amountMinor: calculated.roundedMinor };
}

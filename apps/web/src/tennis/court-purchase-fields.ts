import type { CourtPurchaseField } from "../../../../packages/domain/src/tennis-court-profile";

export const courtPurchaseFieldNames: Record<CourtPurchaseField, string> = {
  name: "球场名称",
  hourlyPriceCents: "小时价格",
  environment: "室内 / 室外 / 顶棚",
  surface: "场地材质",
  specification: "场地规格",
};

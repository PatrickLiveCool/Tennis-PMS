/** Selling attributes are descriptive; prices and inventory remain separate facts. */
export const courtSurfaces = {
  UNSPECIFIED: "未标注材质", ACRYLIC: "丙烯酸硬地", CUSHIONED_ACRYLIC: "弹性丙烯酸硬地",
  CLAY: "红土场", ARTIFICIAL_CLAY: "人造红土", GRASS: "天然草地", ARTIFICIAL_GRASS: "人造草地",
  POLYURETHANE: "聚氨酯 / 硅 PU", RUBBER: "橡胶面层", CARPET: "地毯场",
  ASPHALT: "沥青面层", CONCRETE: "混凝土面层", TILE: "拼装地板", OTHER: "其他材质",
} as const;
export const courtEnvironments = { INDOOR: "室内", OUTDOOR: "室外", COVERED: "有顶棚（侧面开放）" } as const;
export const courtSpecifications = {
  UNSPECIFIED: "未标注规格", STANDARD: "标准全场（单打 / 双打）", SINGLES: "标准单打场",
  PRACTICE: "练习场 / 非标准场", MINI_RED: "儿童短场（红球）", MINI_ORANGE: "儿童中场（橙球）", OTHER: "其他规格",
} as const;
export const courtLighting = { UNSPECIFIED: "未标注", AVAILABLE: "有照明", NONE: "无照明" } as const;
export const courtClimate = { UNSPECIFIED: "未标注", AIR_CONDITIONED: "有空调", VENTILATED: "仅通风设备", NONE: "无空调 / 通风设备" } as const;
export type CourtSurface = keyof typeof courtSurfaces;
export type CourtEnvironment = keyof typeof courtEnvironments;
export interface CourtProfile {
  specification: keyof typeof courtSpecifications;
  lighting: keyof typeof courtLighting;
  climate: keyof typeof courtClimate;
  surfaceNote: string;
  description: string;
  playingLengthM: number | null;
  playingWidthM: number | null;
  totalLengthM: number | null;
  totalWidthM: number | null;
}
export const emptyCourtProfile: CourtProfile = {
  specification: "UNSPECIFIED", lighting: "UNSPECIFIED", climate: "UNSPECIFIED", surfaceNote: "", description: "",
  playingLengthM: null, playingWidthM: null, totalLengthM: null, totalWidthM: null,
};
export type CourtPurchaseField = "name" | "hourlyPriceCents" | "environment" | "surface" | "specification";
export interface CourtPurchaseInfo {
  name?: string | null;
  hourlyPriceCents?: number | null;
  environment?: string | null;
  indoor?: boolean | null;
  surface?: string | null;
  profile?: { specification?: string | null } | null;
}
/** Required for purchase and for the complete result of any partial asset/price edit. */
export function missingCourtPurchaseFields(court: CourtPurchaseInfo): CourtPurchaseField[] {
  const missing: CourtPurchaseField[] = [];
  if (!court.name?.trim()) missing.push("name");
  if (court.hourlyPriceCents == null || !Number.isSafeInteger(court.hourlyPriceCents) || court.hourlyPriceCents < 0) missing.push("hourlyPriceCents");
  const hasEnvironment = court.environment == null
    ? typeof court.indoor === "boolean"
    : Object.hasOwn(courtEnvironments, court.environment);
  if (!hasEnvironment) missing.push("environment");
  if (!court.surface || court.surface === "UNSPECIFIED" || !Object.hasOwn(courtSurfaces, court.surface)) missing.push("surface");
  const specification = court.profile?.specification;
  if (!specification || specification === "UNSPECIFIED" || !Object.hasOwn(courtSpecifications, specification)) missing.push("specification");
  return missing;
}
/** This only checks purchase information; active status and time availability are separate. */
export function isCourtReadyForBooking(court: CourtPurchaseInfo): boolean {
  return missingCourtPurchaseFields(court).length === 0;
}
export function validateCourtProfile(profile: CourtProfile): boolean {
  if (Object.keys(profile).some((key) => !Object.hasOwn(emptyCourtProfile, key)) ||
    !Object.hasOwn(courtSpecifications, profile.specification) || !Object.hasOwn(courtLighting, profile.lighting) ||
    !Object.hasOwn(courtClimate, profile.climate) || typeof profile.surfaceNote !== "string" || profile.surfaceNote.length > 200 ||
    typeof profile.description !== "string" || profile.description.length > 2000) return false;
  for (const key of ["playingLengthM", "playingWidthM", "totalLengthM", "totalWidthM"] as const) {
    const value = profile[key];
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 200 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-8)) return false;
  }
  for (const [playing, total] of [[profile.playingLengthM, profile.totalLengthM], [profile.playingWidthM, profile.totalWidthM]]) {
    if (playing != null && total != null && total < playing) return false;
  }
  return true;
}
export function courtDescription(court: { indoor: boolean; environment?: CourtEnvironment; surface: CourtSurface; profile?: CourtProfile }) {
  return [courtEnvironments[court.environment ?? (court.indoor ? "INDOOR" : "OUTDOOR")],
    court.surface !== "UNSPECIFIED" ? courtSurfaces[court.surface] : "",
    court.profile?.specification && court.profile.specification !== "UNSPECIFIED" ? courtSpecifications[court.profile.specification] : "",
  ].filter(Boolean).join(" · ");
}
export function matchesCourtFilter(court: { indoor: boolean; environment?: CourtEnvironment; surface: CourtSurface }, filter: string) {
  const environment = court.environment ?? (court.indoor ? "INDOOR" : "OUTDOOR");
  return filter === "all" || (filter === "clay" ? court.surface === "CLAY" : environment === filter.toUpperCase());
}

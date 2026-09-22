import {
  courtClimate,
  courtLighting,
  courtSpecifications,
  emptyCourtProfile,
  type CourtProfile,
} from "../../../../packages/domain/src/tennis-court-profile";

export interface ScheduleCourtDetail {
  label: string;
  value: string;
}

export function scheduleCourtSpecification(specification: CourtProfile["specification"] | undefined) {
  if (!specification || specification === "UNSPECIFIED") return "";
  return specification === "STANDARD" ? "标准全场" : courtSpecifications[specification];
}

function dimensions(length: number | null, width: number | null) {
  if (length != null && width != null) return `${length} × ${width} 米`;
  if (length != null) return `长 ${length} 米`;
  if (width != null) return `宽 ${width} 米`;
  return "";
}

export function scheduleCourtDetails(value: Partial<CourtProfile> | undefined): ScheduleCourtDetail[] {
  const profile = { ...emptyCourtProfile, ...value };
  const details: ScheduleCourtDetail[] = [];
  const add = (label: string, detail: string) => {
    if (detail) details.push({ label, value: detail });
  };
  if (profile.lighting !== "UNSPECIFIED") add("照明", courtLighting[profile.lighting]);
  if (profile.climate !== "UNSPECIFIED") add("空调 / 通风", courtClimate[profile.climate]);
  add("边线内尺寸", dimensions(profile.playingLengthM, profile.playingWidthM));
  add("含缓冲区尺寸", dimensions(profile.totalLengthM, profile.totalWidthM));
  add("面层说明", profile.surfaceNote.trim());
  add("场地说明", profile.description.trim());
  return details;
}

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScheduleCourt } from "../../apps/web/src/tennis/ScheduleCourt";
import { scheduleCourtDetails, scheduleCourtSpecification } from "../../apps/web/src/tennis/schedule-court-presentation";
import { emptyCourtProfile } from "../../packages/domain/src/tennis-court-profile";
import type { CourtRecord } from "../../apps/web/src/tennis/types";

const court: CourtRecord = {
  id: "court", tenantId: "tenant", venueId: "venue", name: "中央球场",
  active: true, indoor: true, environment: "INDOOR", surface: "CLAY", revision: 1,
  hourlyPriceCents: 0, profile: { ...emptyCourtProfile, specification: "STANDARD" },
};

describe("schedule court presentation", () => {
  it("keeps basic information in a static card when there are no additional details", () => {
    const html = renderToStaticMarkup(createElement(ScheduleCourt, { court }));
    expect(html).toContain('<div class="tennis-grid-court">');
    for (const text of ["中央球场", "¥0.00", "室内", "红土场", "标准全场"]) expect(html).toContain(text);
    expect(html).not.toMatch(/<button|tabindex|role="tooltip"|has-details|球场详情/);
    expect(scheduleCourtDetails(court.profile)).toEqual([]);
  });

  it("offers details only for additional known attributes, including explicit absence", () => {
    const profile = {
      ...court.profile, lighting: "NONE" as const, climate: "NONE" as const,
      playingLengthM: 23.77, totalWidthM: 18, surfaceNote: "  有弹性垫层  ", description: "  独立入口  ",
    };
    const details = scheduleCourtDetails(profile);
    expect(details).toEqual([
      { label: "照明", value: "无照明" },
      { label: "空调 / 通风", value: "无空调 / 通风设备" },
      { label: "边线内尺寸", value: "长 23.77 米" },
      { label: "含缓冲区尺寸", value: "宽 18 米" },
      { label: "面层说明", value: "有弹性垫层" },
      { label: "场地说明", value: "独立入口" },
    ]);
    const html = renderToStaticMarkup(createElement(ScheduleCourt, { court: { ...court, profile } }));
    expect(html).toContain('<button');
    expect(html).toContain('class="tennis-grid-court has-details"');
    expect(html).toContain('aria-label="中央球场 球场详情"');
  });

  it("does not create an empty popup from unknown fields or whitespace notes", () => {
    expect(scheduleCourtDetails({ surfaceNote: " \n ", description: "\t" })).toEqual([]);
    expect(scheduleCourtDetails(undefined)).toEqual([]);
    const html = renderToStaticMarkup(createElement(ScheduleCourt, {
      court: { ...court, hourlyPriceCents: null, surface: "UNSPECIFIED", profile: emptyCourtProfile },
    }));
    expect(html).not.toMatch(/<button|tennis-court-price|未标注|价格未配置|标准全场/);
  });

  it("keeps full measurements and accurate compact specification labels", () => {
    expect(scheduleCourtDetails({ playingLengthM: 23.77, playingWidthM: 10.97 })).toEqual([
      { label: "边线内尺寸", value: "23.77 × 10.97 米" },
    ]);
    expect(scheduleCourtSpecification("SINGLES")).toBe("标准单打场");
    expect(scheduleCourtSpecification("PRACTICE")).toBe("练习场 / 非标准场");
    expect(scheduleCourtSpecification("UNSPECIFIED")).toBe("");
  });
});

import { useId, useRef, useState } from "react";
import { InfoHint } from "./InfoHint";
import { courtSurfaces, courtEnvironments, courtSpecifications, courtLighting, courtClimate, emptyCourtProfile, validateCourtProfile, missingCourtPurchaseFields, type CourtProfile, type CourtEnvironment } from "../../../../packages/domain/src/tennis-court-profile";
import { courtPurchaseFieldNames } from "./court-purchase-fields";
import type { TennisApi } from "./api";
import type { CourtRecord, VenueRecord } from "./types";
import { cents, ErrorNotice, Modal } from "./components";

function Choice({ label, value, options, onChange, hint, required = false }: { label: string; value: string; options: Record<string, string>; onChange: (value: string) => void; hint?: string; required?: boolean }) {
  const id = useId();
  return <div className="tennis-label">
    <div className="tennis-field-heading"><label htmlFor={id}><span>{label}{required && <span className="tennis-required" aria-hidden="true">*</span>}</span></label>{hint && <InfoHint label={`${label}说明`}>{hint}</InfoHint>}</div>
    <select id={id} aria-label={label} required={required} value={value} onChange={(event) => onChange(event.target.value)}>
      {Object.entries(options).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
    </select>
  </div>;
}
export function CourtEditor({ api, venue, court, canAssets, canPrices, onClose, onSaved }: {
  api: TennisApi; venue: VenueRecord; court: CourtRecord | "new"; canAssets: boolean; canPrices: boolean;
  onClose: () => void; onSaved: () => void;
}) {
  const current = court === "new" ? null : court;
  const original = { name: current?.name ?? "", environment: current ? current.environment ?? (current.indoor ? "INDOOR" : "OUTDOOR") : "" as CourtEnvironment | "",
    surface: current?.surface ?? "UNSPECIFIED", active: current?.active ?? true, profile: { ...emptyCourtProfile, ...current?.profile } };
  const [draft, setDraft] = useState(original);
  const [price, setPrice] = useState(current?.hourlyPriceCents == null ? "" : String(current.hourlyPriceCents / 100));
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const saving = useRef(false);
  const assetsChanged = canAssets && (!current || JSON.stringify(draft) !== JSON.stringify(original));
  let priceCents: number | null = null;
  try { priceCents = price.trim() ? cents(price) : null; } catch { priceCents = NaN; }
  const priceChanged = canPrices && (priceCents !== (current?.hourlyPriceCents ?? null));
  const missing = missingCourtPurchaseFields({ ...draft, environment: draft.environment || null, hourlyPriceCents: priceCents });
  const valid = missing.length === 0 && validateCourtProfile(draft.profile)
    && (current !== null || canAssets && canPrices);
  const changeProfile = <K extends keyof CourtProfile>(key: K, value: CourtProfile[K]) => setDraft((valueBefore) => ({ ...valueBefore, profile: { ...valueBefore.profile, [key]: value } }));
  async function save() {
    if (saving.current || !valid || (!assetsChanged && !priceChanged)) return;
    saving.current = true; setBusy(true); setError(undefined);
    try {
      if (current) await api(`/venues/${venue.id}/courts/${current.id}/profile`, "PATCH", {
        expectedRevision: current.revision, ...(assetsChanged ? { assets: draft } : {}), ...(priceChanged ? { hourlyPriceCents: priceCents } : {}),
      });
      else await api(`/venues/${venue.id}/courts`, "POST", { ...draft, ...(priceChanged ? { hourlyPriceCents: priceCents } : {}) });
      onSaved(); onClose();
    } catch (next) { setError(next); }
    finally { saving.current = false; setBusy(false); }
  }
  const specificationHint = {
    STANDARD: "标准双打场边线内为 23.77 × 10.97 米，也可打单打；不含场外缓冲区。",
    SINGLES: "标准单打边线内为 23.77 × 8.23 米，缓冲区另计。",
    PRACTICE: "练习场没有统一尺寸，请在下方填写实测尺寸，并说明是否有球网、练习墙等。",
    MINI_RED: "儿童红球短场，尺寸请按实际填写；红球指教学规格，与红土材质无关。",
    MINI_ORANGE: "儿童橙球中场，尺寸请按实际填写；不是成人标准全场。",
    OTHER: "可在场地说明中补充实际用途与尺寸。", UNSPECIFIED: "请按实际选择标准全场、单打场或非标准场等；实测尺寸可选填。",
  }[draft.profile.specification];
  return <Modal title={current ? "编辑球场" : "添加球场"} onClose={onClose} closeDisabled={busy}
    footer={<button className="button button-primary" type="submit" form="court-profile-form" disabled={busy || !valid || (!assetsChanged && !priceChanged)}>{busy ? "正在保存…" : "保存"}</button>}>
    <form id="court-profile-form" className="tennis-form tennis-court-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <ErrorNotice error={error} />
      <fieldset disabled={!canAssets || busy}>
        <legend>球场资料</legend>
        <label><span>球场名称<span className="tennis-required" aria-hidden="true">*</span></span><input required maxLength={200} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
        <div className="tennis-two">
          <Choice label="场地材质" required value={draft.surface} options={{ ...courtSurfaces, UNSPECIFIED: "请选择材质" }} onChange={(surface) => setDraft({ ...draft, surface: surface as CourtRecord["surface"] })} />
          <Choice label="场地环境" required value={draft.environment} options={{ "": "请选择环境", ...courtEnvironments }} onChange={(environment) => setDraft({ ...draft, environment: environment as CourtEnvironment })} />
        </div>
        <label>面层补充说明<input maxLength={200} value={draft.profile.surfaceNote} placeholder="如红土类型、铺装品牌（选填）" onChange={(e) => changeProfile("surfaceNote", e.target.value)} /></label>
        <Choice label="规格类型" required hint={specificationHint} value={draft.profile.specification} options={{ ...courtSpecifications, UNSPECIFIED: "请选择规格" }} onChange={(value) => changeProfile("specification", value as CourtProfile["specification"])} />
        <div className="tennis-two">
          <Choice label="照明条件" value={draft.profile.lighting} options={courtLighting} onChange={(value) => changeProfile("lighting", value as CourtProfile["lighting"])} />
          <Choice label="空调 / 通风" value={draft.profile.climate} options={courtClimate} onChange={(value) => changeProfile("climate", value as CourtProfile["climate"])} />
        </div>
        <details className="tennis-court-dimensions"><summary>实测尺寸（选填）</summary>
          <p className="tennis-muted">比赛区域只量边线内；整片可用区域还包括场外缓冲区。</p>
          <div className="tennis-two">{([
            ["playingLengthM", "比赛区域长度（米）"], ["playingWidthM", "比赛区域宽度（米）"],
            ["totalLengthM", "整片可用区域长度（米）"], ["totalWidthM", "整片可用区域宽度（米）"],
          ] as const).map(([key, label]) => <label key={key}>{label}<input type="number" min="0.01" max="200" step="0.01" value={draft.profile[key] ?? ""}
            onChange={(e) => changeProfile(key, e.target.value === "" ? null : Number(e.target.value))} /></label>)}</div>
          {!validateCourtProfile(draft.profile) && <p className="tennis-error" role="alert">尺寸须为 0–200 米之间的正数，最多两位小数；整片区域不能小于比赛区域。</p>}
        </details>
        <label>场地说明（客户可见）<textarea rows={3} maxLength={2000} value={draft.profile.description} placeholder="如器材、入场须知、用鞋要求（选填）" onChange={(e) => changeProfile("description", e.target.value)} /></label>
        <label className="tennis-check"><input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />启用球场</label>
        {!draft.active && <p className="tennis-note">停用后将不再接受新预订；已有预约需先处理。</p>}
      </fieldset>
      <fieldset disabled={!canPrices || busy}>
        <legend>标准小时价 <InfoHint label="小时价格说明">按预订时长和适用折扣计算费用。调价不影响已有订单和仍在有效期内的报价。</InfoHint></legend>
        <label><span>标准小时价（元 / 小时）<span className="tennis-required" aria-hidden="true">*</span></span><input required type="number" min="0" max="90071992547409" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="请输入价格，免费填 0" /></label>
        {priceCents !== null && (!Number.isSafeInteger(priceCents) || priceCents < 0) && <p className="tennis-error" role="alert">请输入不小于 0、最多两位小数的价格。</p>}
      </fieldset>
      {missing.length > 0 && <p className="tennis-note" role="status">保存前请补齐：{missing.map((field) => courtPurchaseFieldNames[field]).join("、")}。</p>}
      {(!canAssets || !canPrices) && <p className="tennis-muted">当前账号可修改{canAssets ? "球场资料" : "小时价格"}，其余内容仅可查看。</p>}
    </form>
  </Modal>;
}

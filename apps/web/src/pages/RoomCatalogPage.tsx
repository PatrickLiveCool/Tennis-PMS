import { useEffect, useRef, useState, type FormEvent } from "react";
import { BedDouble, Building2, History, Plus, RefreshCw, Settings2, Tag } from "lucide-react";
import type { ManagedRoom, ManagedRoomType, RoomCatalogInput, RoomCatalogView, RoomRateAnchors } from "@qintopia/contracts";
import { api } from "../api";
import { principalCan, useWorkspace } from "../session";
import type { CommandRequest } from "../types";
import { CommandDialog, CommandRecoveryBar, DamagedCommandRecoveryNotice, EmptyState, InlineError, LoadingBlock, Modal,
  QuoteRecoveryConflictNotice, formatDateTime, formatMinor, isTerminalCommandRecovery, recoveryCommandRequest, usePersistentCommandRecovery } from "../ui";
import { BuildingOrderEditor } from "./BuildingOrderEditor";
import "./room-catalog.css";

const nights = ["1", "7", "14", "30"] as const;
type Editor = { kind: "TYPE"; type?: ManagedRoomType } | { kind: "ROOM"; room?: ManagedRoom; type?: ManagedRoomType }
  | { kind: "RATES"; type: ManagedRoomType };
const money = (value: number) => formatMinor(value, "CNY");

export function parseCatalogMoney(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) throw new Error("价格须为大于 0 的金额，最多两位小数");
  const [whole, decimal = ""] = value.trim().split(".");
  const minor = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor) || minor <= 0 || minor > 20_000_000) throw new Error("价格须大于 0 且不超过 20 万元");
  return minor;
}

function CatalogEditor({ editor, data, draft, onClose, onSubmit }: { editor: Editor; data: RoomCatalogView; draft?: { input: RoomCatalogInput; reason: string }; onClose: () => void;
  onSubmit: (input: RoomCatalogInput, reason: string) => void }) {
  const oldRoom = editor.kind === "ROOM" ? editor.room : undefined;
  const initialType = editor.type ?? data.types.find((type) => type.code === oldRoom?.typeCode) ?? data.types.find((type) => type.active);
  const current = data.prices.find((price) => price.typeCode === initialType?.code);
  const [name, setName] = useState(draft?.input.name ?? (editor.kind === "TYPE" ? editor.type?.name ?? "" : ""));
  const [bathroom, setBathroom] = useState<"PRIVATE" | "SHARED">(draft?.input.bathroom ?? initialType?.bathroom ?? "PRIVATE");
  const [saleMode, setSaleMode] = useState<"ROOM" | "BED">(draft?.input.saleMode ?? initialType?.saleMode ?? "ROOM");
  const [typeCode, setTypeCode] = useState(draft?.input.typeCode ?? initialType?.code ?? "");
  const [beds, setBeds] = useState(String(draft?.input.bedCount ?? oldRoom?.bedCount ?? initialType?.bedCount ?? 1));
  const [capacity, setCapacity] = useState(String(draft?.input.capacity ?? oldRoom?.capacity ?? initialType?.capacity ?? 1));
  const [code, setCode] = useState(draft?.input.code ?? oldRoom?.code ?? "");
  const [building, setBuilding] = useState(draft?.input.buildingCode ?? oldRoom?.buildingCode ?? data.rooms[0]?.buildingCode ?? "");
  const [amounts, setAmounts] = useState<Record<string, string>>(() => Object.fromEntries(nights.map((night) => [night, draft?.input.anchors ? (draft.input.anchors[night] / 100).toFixed(2) : current ? (current.anchors[night] / 100).toFixed(2) : ""])));
  const [effectiveFrom, setEffectiveFrom] = useState(draft?.input.effectiveFrom ?? data.businessDate);
  const [arrival, setArrival] = useState(data.businessDate);
  const [departure, setDeparture] = useState(() => {
    const date = new Date(data.businessDate + "T00:00:00Z"); date.setUTCDate(date.getUTCDate() + 7); return date.toISOString().slice(0, 10);
  });
  const [whole, setWhole] = useState(false);
  const [reason, setReason] = useState(draft?.reason ?? "");
  const [error, setError] = useState<unknown>();
  const [trial, setTrial] = useState<{ nights: number; anchorNights: number; amountMinor: number }>();
  const [trying, setTrying] = useState(false);
  const trialLease = useRef(0);
  const type = data.types.find((item) => item.code === typeCode);
  const mode = editor.kind === "TYPE" ? saleMode : type?.saleMode;
  const title = editor.kind === "TYPE" ? editor.type ? "编辑房型" : "新增房型" : editor.kind === "ROOM" ? oldRoom ? "调整房间与床位" : "新增房间" : `调整价格 · ${editor.type.name}`;
  function readAnchors() { return Object.fromEntries(nights.map((night) => [night, parseCatalogMoney(amounts[night] ?? "")])) as RoomRateAnchors; }
  function invalidateTrial() { trialLease.current += 1; setTrial(undefined); setTrying(false); }
  useEffect(() => () => { trialLease.current += 1; }, []);
  async function runTrial() {
    const lease = ++trialLease.current;
    setError(undefined); setTrying(true); setTrial(undefined);
    try {
      const response = await api.roomRateTrial(data.propertyId, { anchors: readAnchors(), arrivalDate: arrival, departureDate: departure,
        multiplier: whole ? initialType?.bedCount ?? 1 : 1 });
      if (trialLease.current === lease) setTrial(response);
    } catch (nextError) { if (trialLease.current === lease) setError(nextError); }
    finally { if (trialLease.current === lease) setTrying(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault(); setError(undefined);
    try {
      if (!reason.trim()) throw new Error("请填写修改原因");
      const common = { propertyId: data.propertyId, expectedVersion: data.version };
      const input: RoomCatalogInput = editor.kind === "TYPE" ? { ...common, action: "SAVE_TYPE", ...(editor.type ? { typeCode: editor.type.code } : {}),
        name: name.trim(), bathroom, saleMode, bedCount: Number(beds), capacity: Number(mode === "BED" ? beds : capacity) }
        : editor.kind === "ROOM" ? { ...common, action: "SAVE_ROOM", ...(oldRoom ? { roomId: oldRoom.unitId } : {}), typeCode,
          code: code.trim(), buildingCode: building.trim(), bedCount: Number(beds), capacity: Number(mode === "BED" ? beds : capacity) }
        : { ...common, action: "PUBLISH_RATES", typeCode: editor.type.code, effectiveFrom, anchors: readAnchors() };
      onSubmit(input, reason.trim());
    } catch (nextError) { setError(nextError); }
  }
  return <Modal title={title} onClose={onClose} className="catalog-editor" footer={<><button type="button" className="button button-secondary" onClick={onClose}>取消</button>
    <button className="button button-primary" type="submit" form="catalog-editor-form">核对{editor.kind === "RATES" ? "并发布" : "修改"}</button></>}>
    <form id="catalog-editor-form" onSubmit={submit} className="catalog-form">
      {editor.kind === "TYPE" ? <>
        <label className="field"><span>房型名称</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="例如：花园双床房" /></label>
        <div className="catalog-form-pair"><label className="field"><span>卫浴</span><select value={bathroom} onChange={(e) => setBathroom(e.target.value as typeof bathroom)}><option value="PRIVATE">独立卫浴</option><option value="SHARED">公共卫浴</option></select></label>
          <label className="field"><span>销售方式</span><select value={saleMode} onChange={(e) => setSaleMode(e.target.value as typeof saleMode)}><option value="ROOM">按整房销售</option><option value="BED">按床位销售，可整间预订</option></select></label></div>
      </> : editor.kind === "ROOM" ? <>
        <div className="catalog-form-pair"><label className="field"><span>楼栋</span><input value={building} maxLength={40} onChange={(e) => setBuilding(e.target.value)} required /></label>
          <label className="field"><span>房号</span><input value={code} maxLength={40} onChange={(e) => setCode(e.target.value)} required /></label></div>
        <label className="field"><span>房型</span><select value={typeCode} required onChange={(e) => { setTypeCode(e.target.value); const next = data.types.find((item) => item.code === e.target.value); if (next) { setBeds(String(next.bedCount)); setCapacity(String(next.capacity)); } }}>
          <option value="" disabled>请选择房型</option>{data.types.filter((item) => item.active).map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
        {oldRoom ? <p className="catalog-hint">调整前需要处理关联预订、在住与维修占用。历史订单保留原房型和床位记录。</p> : null}
      </> : <>
        <p className="catalog-hint">填写每个档位的基准总价，销售单位为{editor.type.saleMode === "BED" ? "床位" : "整房"}。系统按连续住宿晚数选择档位。</p>
        <div className="catalog-price-inputs">{nights.map((night) => <label className="field" key={night}><span>{night} 晚总价 / 元</span><input value={amounts[night] ?? ""} inputMode="decimal" required
          onChange={(e) => { setAmounts({ ...amounts, [night]: e.target.value }); invalidateTrial(); }} /></label>)}</div>
        <label className="field"><span>生效日期</span><input type="date" min={data.businessDate} value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required /></label>
        <p className="catalog-hint">新订单按入住日使用相应价格。已建订单锁定原价，后续续住和改期也不会自动涨价。</p>
        <section className="catalog-trial" aria-label="发布前试算"><h3>试算住宿金额</h3>
          <div className="catalog-form-pair"><label className="field"><span>入住日期</span><input type="date" value={arrival} onChange={(e) => { setArrival(e.target.value); invalidateTrial(); }} /></label>
            <label className="field"><span>退房日期</span><input type="date" value={departure} onChange={(e) => { setDeparture(e.target.value); invalidateTrial(); }} /></label></div>
          {editor.type.saleMode === "BED" ? <label className="catalog-check"><input type="checkbox" checked={whole} onChange={(e) => { setWhole(e.target.checked); invalidateTrial(); }} />按默认 {editor.type.bedCount} 床整间试算</label> : null}
          <button className="button button-secondary" type="button" disabled={trying} onClick={() => void runTrial()}>{trying ? "正在计算…" : "试算金额"}</button>
          {trial ? <p className="catalog-trial-result" role="status"><span>{trial.nights} 晚 · 按 {trial.anchorNights} 晚档折算</span><strong>{money(trial.amountMinor)}</strong></p> : <p className="catalog-hint">试算使用上方待发布价格，不创建订单或占用房间。</p>}
        </section>
      </>}
      {editor.kind !== "RATES" ? <><div className="catalog-form-pair">
        <label className="field"><span>{editor.kind === "TYPE" ? "默认物理床数" : "物理床数"}</span><input type="number" min="1" max="100" step="1" required value={beds} onChange={(e) => setBeds(e.target.value)} /></label>
        <label className="field"><span>最多可住人数</span><input type="number" min="1" max="100" step="1" required value={mode === "BED" ? beds : capacity} disabled={mode === "BED"} onChange={(e) => setCapacity(e.target.value)} /></label>
      </div><p className="catalog-hint">{mode === "BED" ? "每床住一人。整间销售将占用全部有效床位。" : "物理床仅用于房间配置，不会自动变成可单卖的床位。"}</p></> : null}
      <label className="field"><span>修改原因</span><textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} required placeholder="记录这次调整的原因" /></label>
      <InlineError error={error} title="请检查填写内容" />
    </form>
  </Modal>;
}

export function RoomCatalogPage() {
  const { principal, propertyId, refreshMeta } = useWorkspace();
  const [data, setData] = useState<RoomCatalogView>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"TYPES" | "ROOMS" | "HISTORY">("TYPES");
  const [selected, setSelected] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [buildingDraft, setBuildingDraft] = useState<string[]>();
  const [ordering, setOrdering] = useState(false);
  const [editor, setEditor] = useState<Editor>();
  const [editorDraft, setEditorDraft] = useState<{ input: RoomCatalogInput; reason: string }>();
  useEffect(() => { if (!editor) setEditorDraft(undefined); }, [editor]);
  const [command, setCommand] = useState<CommandRequest>();
  const [recovering, setRecovering] = useState(false);
  const [notice, setNotice] = useState("");
  const loadLease = useRef(0);
  const canManage = principalCan(principal, propertyId, "MANAGE_ROOM_CATALOG");
  const recovery = usePersistentCommandRecovery({ subjectId: principal.subjectId, scopeId: `property:${propertyId}` });
  async function refresh() {
    const lease = ++loadLease.current; setLoading(true); setError(undefined);
    try { const next = await api.roomCatalog(propertyId); if (loadLease.current === lease) setData(next); }
    catch (nextError) { if (loadLease.current === lease) setError(nextError); }
    finally { if (loadLease.current === lease) setLoading(false); }
  }
  useEffect(() => { setData(undefined); setOrdering(false); setSelected(""); setEditor(undefined); setCommand(undefined); void refresh(); return () => { loadLease.current += 1; }; }, [propertyId]);
  const blocked = loading || Boolean(error) || recovery.blocked || !canManage;
  const visibleTypes = data?.types.filter((type) => showInactive || type.active) ?? [];
  const activeType = visibleTypes.find((type) => type.code === selected) ?? visibleTypes[0];
  const typeRooms = data?.rooms.filter((room) => room.typeCode === activeType?.code) ?? [];
  const price = data?.prices.find((item) => item.typeCode === activeType?.code);
  function submit(input: RoomCatalogInput, reason: string) {
    setRecovering(false); setNotice("");
    setCommand({ commandType: "MANAGE_ROOM_CATALOG", input: { ...input }, title: input.action === "SET_BUILDING_ORDER" ? "核对楼栋顺序" : "核对房型与价格修改",
      description: "请核对修改内容，确认后保存并保留操作记录。", initialReason: { code: "ROOM_CATALOG_CHANGE", note: reason } });
  }
  function simple(input: Omit<RoomCatalogInput, "propertyId" | "expectedVersion">, title: string) {
    if (!data || blocked) return;
    setEditor(undefined); setRecovering(false);
    setCommand({ commandType: "MANAGE_ROOM_CATALOG", input: { ...input, propertyId, expectedVersion: data.version }, title,
      description: "请核对影响并填写原因，历史订单和操作记录会保留。", initialReason: { code: "ROOM_CATALOG_CHANGE", note: "" } });
  }
  function roomRows(rooms: ManagedRoom[]) {
    return <div className="table-region catalog-room-table" tabIndex={0} role="region" aria-label="房间与床位"><table className="data-table"><thead><tr><th>房间</th><th>房型</th><th>物理床 / 可住人数</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>{rooms.filter((room) => showInactive || room.active).map((room) => <tr key={room.unitId}><th scope="row">{room.buildingCode}栋 {room.code}</th>
        <td>{data?.types.find((type) => type.code === room.typeCode)?.name ?? room.typeCode}</td><td>{room.bedCount} 床 / {room.capacity} 人{room.beds.length ? <small className="catalog-bed-list">可售床位：{room.beds.filter((bed) => bed.active).map((bed) => bed.code).join("、") || "无"}</small> : null}</td>
        <td><span className={`catalog-status ${room.active ? "" : "is-inactive"}`}>{room.active ? "启用" : "已停用"}</span></td><td><div className="row-actions">
          <button className="button button-compact button-secondary" disabled={blocked} onClick={() => setEditor({ kind: "ROOM", room })}>调整</button>
          <button className="button button-compact button-secondary" disabled={blocked} onClick={() => simple({ action: "SET_ROOM_ACTIVE", roomId: room.unitId, active: !room.active }, `${room.active ? "停用" : "启用"}房间 ${room.code}`)}>{room.active ? "停用" : "启用"}</button>
        </div></td></tr>)}</tbody></table></div>;
  }
  return <div className="room-catalog-page">
    <header className="page-heading page-heading-actions"><div><p className="eyebrow">房源配置</p><h1>房型与价格</h1><p>管理房型、实际房间与床位，统一维护住宿价格</p></div>
      <div className="catalog-page-actions"><button className="button button-secondary" onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} aria-hidden="true" />刷新</button>
        <button className="button button-primary" disabled={blocked} onClick={() => setEditor(tab === "ROOMS" ? { kind: "ROOM" } : { kind: "TYPE" })}><Plus size={17} aria-hidden="true" />{tab === "ROOMS" ? "新增房间" : "新增房型"}</button></div></header>
    {!canManage ? <p className="catalog-hint">当前账号可查看配置，修改由管理员操作。</p> : null}
    {notice ? <p className="catalog-notice" role="status">{notice}</p> : null}
    {recovery.canDiscardCorrupt ? <DamagedCommandRecoveryNotice error={recovery.error} onDiscard={recovery.discardCorruptAfterReview} /> : <InlineError error={recovery.error} />}
    <QuoteRecoveryConflictNotice conflict={recovery.conflict} />
    {recovery.pending ? <CommandRecoveryBar recovery={recovery.pending} businessFacing onOpen={() => { if (recovery.pending) { setRecovering(true); setCommand(recoveryCommandRequest(recovery.pending)); } }} /> : null}
    <InlineError error={error} title="无法载入房型与价格" />
    <div className="catalog-toolbar"><nav className="catalog-tabs" aria-label="房源设置内容">{([
      ["TYPES", "房型与价格", Tag], ["ROOMS", "房间与床位", Building2], ["HISTORY", "修改记录", History]
    ] as const).map(([value, label, Icon]) => <button key={value} className={tab === value ? "is-selected" : ""} aria-pressed={tab === value} onClick={() => setTab(value)}><Icon size={16} aria-hidden="true" />{label}</button>)}</nav>
      {tab !== "HISTORY" ? <label className="catalog-check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />显示停用项</label> : null}</div>
    {loading && !data ? <LoadingBlock label="正在载入房型与价格" /> : data && !error ? <>
      {tab === "TYPES" ? <div className="catalog-workspace"><aside className="catalog-type-list" aria-label="房型列表">
        {visibleTypes.map((type) => <button key={type.code} onClick={() => setSelected(type.code)} aria-pressed={activeType?.code === type.code} className={activeType?.code === type.code ? "is-selected" : ""}>
          <span><strong>{type.name}</strong><small>{type.saleMode === "BED" ? "按床位销售" : "按整房销售"}{type.active ? "" : " · 已停用"}</small></span><span>{data.rooms.filter((room) => room.active && room.typeCode === type.code).length} 间</span></button>)}
      </aside>{activeType ? <section className="catalog-detail"><header className="catalog-detail-heading"><div><h2>{activeType.name}</h2><p>{activeType.bathroom === "PRIVATE" ? "独立卫浴" : "公共卫浴"} · 默认 {activeType.bedCount} 床 / {activeType.capacity} 人 · {typeRooms.filter((room) => room.active).length} 间启用</p></div>
        <button className="button button-secondary button-compact" disabled={blocked} onClick={() => setEditor({ kind: "TYPE", type: activeType })}><Settings2 size={15} aria-hidden="true" />编辑房型</button></header>
        <section className="catalog-prices"><div className="catalog-section-heading"><div><h3>现行价格</h3><p>{data.businessDate} 入住 · 基准总价 / {activeType.saleMode === "BED" ? "床位" : "整房"}</p></div>
          <button className="button button-primary button-compact" disabled={blocked || !activeType.active} onClick={() => setEditor({ kind: "RATES", type: activeType })}>调整价格</button></div>
          <dl className="catalog-price-grid">{nights.map((night) => <div key={night}><dt>{night} 晚</dt><dd>{price ? money(price.anchors[night]) : "未设置"}</dd></div>)}</dl>
          {activeType.saleMode === "BED" ? <p className="catalog-hint">多人间整租按床位基准价 × 该房物理床数计算，最后对住宿总额取整。</p> : null}
          {data.rates.filter((rate) => rate.typeCode === activeType.code).length ? <details className="catalog-rate-history"><summary>查看价格版本与生效安排</summary>
            {[...data.rates].filter((rate) => rate.typeCode === activeType.code).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.version - a.version).map((rate) => {
              const superseded = data.rates.some((other) => other.typeCode === rate.typeCode && other.effectiveFrom === rate.effectiveFrom && other.version > rate.version);
              return <div key={rate.id}><strong>{rate.effectiveFrom} 起</strong><span>{superseded ? "同日版本已被更正" : rate.effectiveFrom > data.businessDate ? "待生效" : "已发布"}</span><p>{nights.map((night) => `${night} 晚 ${money(rate.anchors[night])}`).join(" · ")}</p></div>;
            })}</details> : null}
        </section>
        <section><div className="catalog-section-heading"><div><h3>关联房间</h3><p>查看实际房间，并调整房型和床位结构</p></div><button className="button button-secondary button-compact" disabled={blocked || !activeType.active} onClick={() => { setTab("ROOMS"); setEditor({ kind: "ROOM", type: activeType }); }}><Plus size={15} aria-hidden="true" />新增房间</button></div>
          {typeRooms.some((room) => showInactive || room.active) ? roomRows(typeRooms) : <div className="catalog-empty"><BedDouble size={25} aria-hidden="true" /><p>暂无关联的启用房间</p><button className="button button-secondary" disabled={blocked || !activeType.active} onClick={() => setTab("ROOMS")}>去分配已有房间</button></div>}</section>
        <footer className="catalog-type-footer"><span>停用会同时停止关联房间与床位的销售，历史记录保留。</span><div className="row-actions"><button className="button button-secondary button-compact" disabled={blocked}
          onClick={() => simple({ action: "SET_TYPE_ACTIVE", typeCode: activeType.code, active: !activeType.active }, `${activeType.active ? "停用" : "启用"}房型`)}>{activeType.active ? "停用房型" : "启用房型"}</button>
          <button className="button button-secondary button-compact danger-text-button" disabled={blocked || typeRooms.length > 0 || data.rates.some((rate) => rate.typeCode === activeType.code)}
            title="仅未关联房间、价格或会员的误建房型可删除" onClick={() => simple({ action: "DELETE_TYPE", typeCode: activeType.code }, "删除误建房型")}>删除误建房型</button></div></footer>
      </section> : <EmptyState title="暂无房型" detail="新增房型后可以分配房间并设置价格。" />}</div>
      : tab === "ROOMS" ? <section className="catalog-all-rooms"><div className="catalog-section-heading"><div><h2>实际房间与床位</h2><p>{data.rooms.filter((room) => room.active).length} 间启用 · 物理床与可单卖床位分别管理</p></div><button className="button button-secondary button-compact" disabled={blocked || (data.buildingOrder?.length ?? 0) < 2} onClick={() => { setBuildingDraft(undefined); setOrdering(true); }}><Settings2 size={15} aria-hidden="true" />调整楼栋顺序</button></div>{roomRows(data.rooms)}</section>
      : <section className="catalog-history"><h2>最近修改</h2><p className="muted">保留操作人、时间、原因和前后内容，最多展示最近 100 次操作。</p>{data.history.length ? data.history.map((item) => <article key={item.id}><header><h3>{item.title}</h3><time>{formatDateTime(item.createdAt)}</time></header><p>{item.operator} · {item.reason}</p><ul>{item.description.map((line, index) => <li key={index}>{line}</li>)}</ul></article>) : <EmptyState title="暂无修改记录" detail="首次保存或发布价格后，记录会显示在这里。" />}</section>}
    </> : null}
    {ordering && data && !command ? <BuildingOrderEditor data={data} {...(buildingDraft ? { draft: buildingDraft } : {})} onClose={() => setOrdering(false)} onSubmit={(buildingOrder) => {
      setBuildingDraft(buildingOrder);
      submit({ propertyId, expectedVersion: data.version, action: "SET_BUILDING_ORDER", buildingOrder }, "调整库存日历楼栋显示顺序");
    }} /> : null}
    {editor && data && !command ? <CatalogEditor editor={editor} data={data} {...(editorDraft ? { draft: editorDraft } : {})} onClose={() => setEditor(undefined)} onSubmit={submit} /> : null}
    {command ? <CommandDialog key={recovering ? recovery.pending?.confirmationKey : "catalog-command"} request={command}
      {...(recovering && recovery.pending ? { initialConfirmationKey: recovery.pending.confirmationKey } : {})}
      onProgress={(progress) => recovery.track(command, progress)} onReturnToEdit={(draft) => {
        setCommand(undefined);
        if (draft.input.action === "SET_BUILDING_ORDER") {
          setOrdering(true); setBuildingDraft((draft.input as unknown as RoomCatalogInput).buildingOrder);
        } else { setEditor(editor); setEditorDraft({ input: draft.input as unknown as RoomCatalogInput, reason: draft.initialReason?.note ?? "" }); }
      }}
      onCommitted={async () => { setOrdering(false); await Promise.all([refresh(), refreshMeta()]); setNotice("设置已保存，房态与新订单已使用最新配置。"); }}
      onClose={async (context) => { setCommand(undefined); setEditor(undefined); setOrdering(false); setRecovering(false);
        if (context || (recovery.pending && isTerminalCommandRecovery(recovery.pending.state))) await recovery.clearResolved(); }} /> : null}
  </div>;
}

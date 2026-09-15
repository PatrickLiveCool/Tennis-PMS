import { useState } from "react";
import { ArrowDown, ArrowUp, Building2 } from "lucide-react";
import type { RoomCatalogView } from "@qintopia/contracts";
import { Modal } from "../ui";

export function BuildingOrderEditor({ data, draft, onClose, onSubmit }: {
  data: RoomCatalogView;
  draft?: string[];
  onClose: () => void;
  onSubmit: (order: string[]) => void;
}) {
  const initial = data.buildingOrder ?? [];
  const [order, setOrder] = useState(draft ?? initial);
  const [announcement, setAnnouncement] = useState("");
  const changed = order.some((code, index) => code !== initial[index]);
  const label = (code: string) => code.endsWith("栋") ? code : `${code} 栋`;
  function move(index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setOrder(next);
    setAnnouncement(`${label(order[index]!)}已移至第 ${target + 1} 位`);
  }
  return <Modal title="调整楼栋顺序" onClose={onClose} className="catalog-building-editor" footer={<>
    <button className="button button-secondary" onClick={onClose}>取消</button>
    <button className="button button-primary" disabled={!changed} onClick={() => onSubmit(order)}>核对并保存</button>
  </>}>
    <p className="catalog-hint">从上到下对应首页库存日历的显示顺序，保存后对本店所有同事生效。</p>
    <ol className="catalog-building-order" aria-label="楼栋显示顺序">{order.map((code, index) => {
      const count = data.rooms.filter((room) => room.active && room.buildingCode === code).length;
      return <li key={code}>
        <span className="catalog-building-position" aria-hidden="true">{index + 1}</span>
        <Building2 size={18} aria-hidden="true" />
        <span className="catalog-building-name"><strong>{label(code)}</strong><small>{count ? `${count} 间启用` : "暂无启用房间"}</small></span>
        <div className="catalog-building-moves">
          <button className="button button-secondary button-compact" aria-label={`上移 ${code} 栋`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={16} aria-hidden="true" /><span>上移</span></button>
          <button className="button button-secondary button-compact" aria-label={`下移 ${code} 栋`} disabled={index === order.length - 1} onClick={() => move(index, 1)}><ArrowDown size={16} aria-hidden="true" /><span>下移</span></button>
        </div>
      </li>;
    })}</ol>
    <p className="catalog-hint" role="status">{announcement || "新增楼栋自动排在最后，未分栋房间显示在所有楼栋之后。"}</p>
  </Modal>;
}

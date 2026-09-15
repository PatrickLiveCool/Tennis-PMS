import type { RoomCatalogSnapshot } from "@qintopia/contracts";
import type { DbExecutor } from "./inventory.ts";

type BuildingRoom = { building_code?: string | null; buildingCode?: string | null };
const codeOf = (room: BuildingRoom) => room.building_code ?? room.buildingCode ?? "";

/** Input keeps the legacy room-code order. Unknown buildings append; unassigned rooms stay last. */
export function resolveBuildingOrder(rooms: BuildingRoom[], saved: readonly string[] = []): string[] {
  return [...new Set([...saved, ...rooms.map(codeOf)].filter(Boolean))];
}

export function sortRoomsByBuilding<T extends BuildingRoom>(rooms: T[], order: readonly string[]): T[] {
  const ranks = new Map(order.map((code, index) => [code, index]));
  return [...rooms].sort((left, right) => (ranks.get(codeOf(left)) ?? order.length) - (ranks.get(codeOf(right)) ?? order.length));
}

export async function readBuildingOrder(db: DbExecutor, propertyId: string, rooms: BuildingRoom[]): Promise<string[]> {
  const row = await db.selectFrom("room_catalog_state").select("snapshot").where("property_id", "=", propertyId).executeTakeFirst();
  const snapshot = row?.snapshot as unknown as RoomCatalogSnapshot | undefined;
  return resolveBuildingOrder(rooms, snapshot?.buildingOrder);
}

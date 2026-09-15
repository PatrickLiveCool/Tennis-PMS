import type { DbExecutor } from "./inventory.ts";
import type { RoomCatalogSnapshot } from "@qintopia/contracts";

/** Operational labels can change; historical inventory records stay untouched. */
export async function projectCatalogUnitNames<T extends { property_id: string; room_type_code: string | null; code: string; name: string; active: boolean }>(db: DbExecutor, units: T[]): Promise<T[]> {
  const propertyIds = [...new Set(units.map((unit) => unit.property_id))];
  if (!propertyIds.length) return units;
  const states = await db.selectFrom("room_catalog_state").select(["property_id", "snapshot"]).where("property_id", "in", propertyIds).execute();
  const labels = new Map(states.map((state) => [state.property_id,
    new Map((state.snapshot as unknown as RoomCatalogSnapshot).types.map((type) => [type.code, type.name]))]));
  return units.map((unit) => {
    const name = unit.active && unit.room_type_code ? labels.get(unit.property_id)?.get(unit.room_type_code) : undefined;
    return name ? { ...unit, name: `${unit.code} ${name}` } : unit;
  });
}

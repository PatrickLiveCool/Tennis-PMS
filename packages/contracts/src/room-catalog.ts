export const roomCatalogActions = ["SAVE_TYPE", "DELETE_TYPE", "SET_TYPE_ACTIVE", "SAVE_ROOM", "SET_ROOM_ACTIVE", "PUBLISH_RATES"] as const;
export type RoomCatalogAction = (typeof roomCatalogActions)[number];
export type RoomRateAnchors = Record<"1" | "7" | "14" | "30", number>;
export interface ManagedRoomType {
  code: string;
  name: string;
  bathroom: "PRIVATE" | "SHARED";
  saleMode: "ROOM" | "BED";
  bedCount: number;
  capacity: number;
  active: boolean;
  products: { code: string; kind: "ROOM" | "BED"; multiplier: number }[];
}
export interface ManagedRoom {
  assetId: string;
  unitId: string;
  code: string;
  buildingCode: string;
  typeCode: string;
  bedCount: number;
  capacity: number;
  active: boolean;
  beds: { id: string; code: string; active: boolean }[];
}
export interface RoomRateChange {
  id: string;
  typeCode: string;
  effectiveFrom: string;
  anchors: RoomRateAnchors;
  version: number;
}
export interface RoomCatalogSnapshot {
  version: number;
  types: ManagedRoomType[];
  rates: RoomRateChange[];
}
export interface RoomCatalogView extends RoomCatalogSnapshot {
  propertyId: string;
  businessDate: string;
  rooms: ManagedRoom[];
  prices: { typeCode: string; effectiveFrom: string; anchors: RoomRateAnchors }[];
  history: { id: string; action: RoomCatalogAction; title: string; description: string[]; operator: string; createdAt: string; reason: string }[];
}
export interface RoomCatalogInput {
  propertyId: string;
  expectedVersion: number;
  action: RoomCatalogAction;
  typeCode?: string;
  name?: string;
  bathroom?: "PRIVATE" | "SHARED";
  saleMode?: "ROOM" | "BED";
  bedCount?: number;
  capacity?: number;
  active?: boolean;
  roomId?: string;
  code?: string;
  buildingCode?: string;
  effectiveFrom?: string;
  anchors?: RoomRateAnchors;
}
export interface CatalogInventoryInsert {
  id: string; property_id: string; kind: "ROOM" | "BED"; parent_room_id: string | null;
  code: string; name: string; active: boolean; catalog_version: string; building_code: string;
  room_type_code: string; pricing_product_code: string; inventory_basis: "INDEPENDENT" | "WHOLE_ROOM_COMBINATION";
  code_provenance: "PMS_GENERATED"; physical_bed_count: number | null; occupancy_capacity: number;
}
export interface CatalogPolicyInsert {
  id: string; effectiveFrom: string; anchors: Record<string, RoomRateAnchors>;
}
export interface RoomCatalogEffect {
  operation: "MANAGE_ROOM_CATALOG";
  propertyId: string;
  action: RoomCatalogAction;
  title: string;
  description: string[];
  beforeVersion: number;
  after: RoomCatalogSnapshot;
  retireUnitIds: string[];
  insertUnits: CatalogInventoryInsert[];
  roomLink: { assetId: string; oldUnitId: string | null; newUnitId: string } | null;
  policies: CatalogPolicyInsert[];
}

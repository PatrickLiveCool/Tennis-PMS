import { Type, type TProperties } from "@sinclair/typebox";
import { roomCatalogActions } from "@qintopia/contracts";
const obj = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
const id = Type.String({ minLength: 1, maxLength: 160 });
const name = Type.String({ minLength: 1, maxLength: 100 });
const date = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const nullable = <T extends ReturnType<typeof Type.String>>(schema: T) => Type.Union([schema, Type.Null()]);
const count = Type.Integer({ minimum: 1, maximum: 100 });
const mode = Type.Union([Type.Literal("ROOM"), Type.Literal("BED")]);
const bathroom = Type.Union([Type.Literal("PRIVATE"), Type.Literal("SHARED")]);
export const RoomRateAnchorsSchema = obj(Object.fromEntries(["1","7","14","30"].map((key) => [key, Type.Integer({ minimum: 1, maximum: 2_000_000_000 })])));
const roomType = obj({ code: id, name, bathroom, saleMode: mode, bedCount: count, capacity: count, active: Type.Boolean(),
  products: Type.Array(obj({ code: id, kind: mode, multiplier: count })) });
const rate = obj({ id, typeCode: id, effectiveFrom: date, anchors: RoomRateAnchorsSchema, version: Type.Integer({ minimum: 1 }) });
const snapshot = obj({ version: Type.Integer({ minimum: 0 }), types: Type.Array(roomType), rates: Type.Array(rate) });
const action = Type.Union(roomCatalogActions.map((value) => Type.Literal(value)));
const unit = obj({ id, property_id: id, kind: mode, parent_room_id: nullable(id), code: name, name: Type.String(), active: Type.Boolean(),
  catalog_version: id, building_code: name, room_type_code: id, pricing_product_code: id,
  inventory_basis: Type.Union([Type.Literal("INDEPENDENT"), Type.Literal("WHOLE_ROOM_COMBINATION")]), code_provenance: Type.Literal("PMS_GENERATED"),
  physical_bed_count: Type.Union([count, Type.Null()]), occupancy_capacity: count });
export const RoomCatalogEffectSchema = obj({ operation: Type.Literal("MANAGE_ROOM_CATALOG"), propertyId: id, action, title: name,
  description: Type.Array(Type.String()), beforeVersion: Type.Integer({ minimum: 0 }), after: snapshot,
  retireUnitIds: Type.Array(id), insertUnits: Type.Array(unit),
  roomLink: Type.Union([obj({ assetId: id, oldUnitId: nullable(id), newUnitId: id }), Type.Null()]),
  policies: Type.Array(obj({ id, effectiveFrom: date, anchors: Type.Record(Type.String(), RoomRateAnchorsSchema) })) });
export const RoomCatalogInputSchema = Type.Unsafe({ type: "object", discriminator: { propertyName: "action" }, oneOf: [
  obj({ propertyId: id, expectedVersion: Type.Integer({ minimum: 0 }), action: Type.Literal("SAVE_TYPE"), typeCode: Type.Optional(id),
    name, bathroom, saleMode: mode, bedCount: count, capacity: count }),
  obj({ propertyId: id, expectedVersion: Type.Integer({ minimum: 0 }), action: Type.Literal("DELETE_TYPE"), typeCode: id }),
  obj({ propertyId: id, expectedVersion: Type.Integer({ minimum: 0 }), action: Type.Literal("SET_TYPE_ACTIVE"), typeCode: id, active: Type.Boolean() }),
  obj({ propertyId: id, expectedVersion: Type.Integer({ minimum: 0 }), action: Type.Literal("SAVE_ROOM"), roomId: Type.Optional(id), typeCode: id,
    code: name, buildingCode: name, bedCount: count, capacity: count }),
  obj({ propertyId: id, expectedVersion: Type.Integer({ minimum: 0 }), action: Type.Literal("SET_ROOM_ACTIVE"), roomId: id, active: Type.Boolean() }),
  obj({ propertyId: id, expectedVersion: Type.Integer({ minimum: 0 }), action: Type.Literal("PUBLISH_RATES"), typeCode: id,
    effectiveFrom: date, anchors: RoomRateAnchorsSchema })
] });
export const RoomCatalogResultSchema = obj({ ...RoomCatalogEffectSchema.properties, changeId: id });
export const RoomCatalogViewSchema = obj({ ...snapshot.properties, propertyId: id, businessDate: date,
  rooms: Type.Array(obj({ assetId: id, unitId: id, code: name, buildingCode: Type.String(), typeCode: Type.String(), bedCount: count, capacity: count,
    active: Type.Boolean(), beds: Type.Array(obj({ id, code: name, active: Type.Boolean() })) })),
  prices: Type.Array(obj({ typeCode: id, effectiveFrom: date, anchors: RoomRateAnchorsSchema })),
  history: Type.Array(obj({ id, action, title: name, description: Type.Array(Type.String()), operator: Type.String(), createdAt: Type.String(), reason: Type.String() })) });
export const RoomRateTrialSchema = obj({ anchors: RoomRateAnchorsSchema, arrivalDate: date, departureDate: date, multiplier: Type.Optional(count) });
export const RoomRateTrialResultSchema = obj({ nights: Type.Integer({ minimum: 1 }), anchorNights: Type.Integer({ minimum: 1 }), amountMinor: Type.Integer({ minimum: 0 }) });

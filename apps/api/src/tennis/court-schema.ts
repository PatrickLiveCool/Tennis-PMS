import { Type } from "@sinclair/typebox";
import { courtSurfaces, courtEnvironments, courtSpecifications, courtLighting, courtClimate } from "../../../../packages/domain/src/tennis-court-profile.ts";
const choice = <T extends Record<string, string>>(options: T) => Type.Unsafe<keyof T>({ type: "string", enum: Object.keys(options) });
// Decimal precision is checked by validateCourtProfile with a floating-point
// tolerance; JSON Schema multipleOf: 0.01 rejects valid values such as 18.29.
const dimension = Type.Union([Type.Number({ exclusiveMinimum: 0, maximum: 200 }), Type.Null()]);
export const courtProfileSchema = Type.Partial(Type.Object({
  specification: choice(courtSpecifications), lighting: choice(courtLighting), climate: choice(courtClimate),
  surfaceNote: Type.String({ maxLength: 200 }), description: Type.String({ maxLength: 2000 }),
  playingLengthM: dimension, playingWidthM: dimension, totalLengthM: dimension, totalWidthM: dimension,
}, { additionalProperties: false }));
export const courtAssetProperties = {
  name: Type.String({ minLength: 1, maxLength: 200 }), indoor: Type.Optional(Type.Boolean()),
  environment: Type.Optional(choice(courtEnvironments)), surface: Type.Optional(choice(courtSurfaces)),
  active: Type.Optional(Type.Boolean()), profile: Type.Optional(courtProfileSchema),
};
export const courtPriceSchema = Type.Union([Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]);

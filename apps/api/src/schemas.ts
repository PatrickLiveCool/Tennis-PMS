import { Type, type TObject, type TProperties } from "@sinclair/typebox";
import {
  backfillCollectionMethods,
  bookingChannelCodes,
  commandCapabilities,
  commandTypes,
  createOrderPricingBasisCodes,
  currentReleaseFeatures,
  errorCauseCodes,
  errorCodes,
  freeStayCategoryCodes,
  fulfillmentRecordingModes,
  historicalRecoverableCommandTypes,
  orderArrangementChangeTypes,
  orderActionCodes,
  orderEffectiveArrangementPresentations,
  orderFulfillmentStates,
  ROOM_STATUS_MAX_QUERY_NIGHTS,
  ROOM_STATUS_OPERATIONAL_TASK_LIMIT,
  recoverableCommandTypes,
  roomStatusActionCodes,
  roomStatusAttentionCodes,
  roomStatusBlockingFactKinds,
  roomStatusOperationalAttentionCodes,
  roomStatusOperationalTaskKinds,
  roomStatusSourceCategories,
  roomStatusSourceKinds,
  roomStatusStatuses,
  stayTypes,
  type CommandType
} from "@qintopia/contracts";
import { humanGrantableCommandTypes } from "@qintopia/domain";

const strictObject = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
const nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) => Type.Union([schema, Type.Null()]);
const humanGrantableCommandTypeSet = new Set<string>(humanGrantableCommandTypes);
const publicCommandTypes = commandTypes.filter((commandType) => humanGrantableCommandTypeSet.has(commandType));
const commandEnvelope = <C extends CommandType, T extends TProperties>(commandType: C, input: TObject<T>) => {
  if (!humanGrantableCommandTypeSet.has(commandType)) {
    throw new Error(`Public command envelope cannot expose non-human-grantable command ${commandType}`);
  }
  return strictObject({
    commandType: Type.Literal(commandType),
    input
  });
};

export const Id = Type.String({ minLength: 3, maxLength: 160 });
export const LocalDate = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
export const DateTime = Type.String({ format: "date-time" });
const OpaqueTokenSecret = Type.String({ minLength: 47, maxLength: 47, pattern: "^qtp_[A-Za-z0-9_-]{43}$" });
const ShortText = Type.String({ minLength: 1, maxLength: 200 });
const Note = Type.String({ minLength: 1, maxLength: 1000 });
const OptionalNote = Type.String({ maxLength: 1000 });
const SafeInteger = Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
const PositiveAmount = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const NonNegativeAmount = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const NonNegativeWholeYuanAmount = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 100 });
const PositiveWholeYuanAmount = Type.Integer({ minimum: 100, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 100 });
const MembershipAgreedPriceAmount = Type.Integer({ minimum: 100, maximum: 2_147_483_600, multipleOf: 100 });
const StayChangeTargetAmount = Type.Integer({ minimum: 0, maximum: 2_147_483_600, multipleOf: 100 });
const NonZeroInteger = Type.Union([
  Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: -1 }),
  Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
]);

export const AccessLevelSchema = Type.Union([Type.Literal("READ"), Type.Literal("WRITE")]);
export const InventoryUnitKindSchema = Type.Union([Type.Literal("ROOM"), Type.Literal("BED")]);
export const EntitlementUnitKindSchema = Type.Union([Type.Literal("ROOM_NIGHT"), Type.Literal("BED_NIGHT")]);
export const StayTypeSchema = Type.Union(stayTypes.map((stayType) => Type.Literal(stayType)));
export const BookingChannelCodeSchema = Type.Union(bookingChannelCodes.map((code) => Type.Literal(code)));
export const FreeStayCategoryCodeSchema = Type.Union(freeStayCategoryCodes.map((code) => Type.Literal(code)));
export const BackfillCollectionMethodSchema = Type.Union(backfillCollectionMethods.map((method) => Type.Literal(method)));
export const CommandTypeSchema = Type.Union(commandTypes.map((commandType) => Type.Literal(commandType)));
export const CommandCapabilitySchema = Type.Union(commandCapabilities.map((commandType) => Type.Literal(commandType)));
const HumanGrantableCommandCapabilitySchema = Type.Union(humanGrantableCommandTypes.map((commandType) => Type.Literal(commandType)));
const HistoricalReadCommandGrantSchema = Type.Union([
  Type.Literal("PLACE_INTERNAL_USE"),
  Type.Literal("RELEASE_INTERNAL_USE"),
  Type.Literal("BACKFILL_COMPLETED_STAY")
]);
export const CommandGrantSchema = Type.Union([
  ...humanGrantableCommandTypes.map((commandType) => Type.Literal(commandType)),
  HistoricalReadCommandGrantSchema
]);
const EffectiveCommandCapabilitySchema = Type.Union(humanGrantableCommandTypes
  .filter((commandType) => commandType !== "COMPLETE_CLEANING" || currentReleaseFeatures.cleaningWorkflow)
  .filter((commandType) => commandType !== "CORRECT_HISTORICAL_STAY_ARRANGEMENTS" || currentReleaseFeatures.historicalStayArrangementCorrection)
  .filter((commandType) => commandType !== "CORRECT_MEMBER_PROFILE" || currentReleaseFeatures.memberProfileCorrection)
  .filter((commandType) => commandType !== "CORRECT_MEMBERSHIP_EFFECTIVE_DATE" || currentReleaseFeatures.membershipEffectiveDateCorrection)
  .filter((commandType) => commandType !== "BACKFILL_HISTORICAL_MEMBERSHIP" || currentReleaseFeatures.historicalMembershipBackfill)
  .filter((commandType) => commandType !== "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY" || currentReleaseFeatures.membershipConversionVoidCorrection)
  .map((commandType) => Type.Literal(commandType)));
const CommandCeilingSchema = Type.Array(HumanGrantableCommandCapabilitySchema, { uniqueItems: true });
const EffectiveCommandCeilingSchema = Type.Array(EffectiveCommandCapabilitySchema, { uniqueItems: true });
const PersistedCommandCeilingSchema = Type.Array(CommandGrantSchema, { uniqueItems: true });
const EmptyCommandCeilingSchema = Type.Tuple([]);
export const RecoverableCommandTypeSchema = Type.Union(recoverableCommandTypes.map((commandType) => Type.Literal(commandType)));
export const HistoricalCommandTypeSchema = Type.Union([
  CommandTypeSchema,
  Type.Literal("PLACE_INTERNAL_USE"),
  Type.Literal("RELEASE_INTERNAL_USE"),
  Type.Literal("BACKFILL_COMPLETED_STAY")
]);
export const HistoricalRecoverableCommandTypeSchema = Type.Union(
  historicalRecoverableCommandTypes.map((commandType) => Type.Literal(commandType))
);
export const OrderStatusSchema = Type.Union([
  Type.Literal("RESERVED"), Type.Literal("CHECKED_IN"), Type.Literal("CHECKED_OUT"),
  Type.Literal("CANCELLED"), Type.Literal("NO_SHOW"), Type.Literal("CHECK_IN_REVOKED")
]);

export const Money = strictObject({
  currency: Type.String({ minLength: 3, maxLength: 3, pattern: "^[A-Z]{3}$" }),
  minorUnits: SafeInteger
});
export const NonNegativeMoney = strictObject({
  currency: Type.String({ minLength: 3, maxLength: 3, pattern: "^[A-Z]{3}$" }),
  minorUnits: Type.Integer({ minimum: 0, maximum: 2_147_483_647 })
});
export const CoverageItem = strictObject({
  serviceDate: LocalDate,
  inventoryUnitId: Id,
  unitKind: EntitlementUnitKindSchema,
  entitlementLotId: Id
});
const TemporaryOtherRoomArrangementSchema = strictObject({
  kind: Type.Literal("TEMPORARY_OTHER_ROOM"),
  membershipOrderId: Id,
  memberContractId: Id,
  entitlementLotId: Id,
  originalRoomTypeCode: ShortText,
  originalInventoryKind: Type.Literal("ROOM"),
  entitlementUnitKind: Type.Literal("ROOM_NIGHT"),
  actualInventoryUnitId: Id,
  actualRoomTypeCode: ShortText,
  actualInventoryKind: Type.Literal("ROOM"),
  arrivalDate: LocalDate,
  departureDate: LocalDate
});
const TemporaryOtherRoomLifecycleEvidenceFields = {
  temporaryOtherRoomArrangement: Type.Optional(TemporaryOtherRoomArrangementSchema),
  temporaryOtherRoomCreateAmendmentId: Type.Optional(Id)
};
const NightlyCashLine = strictObject({
  lineKind: Type.Optional(Type.Literal("NIGHT")),
  serviceDate: LocalDate,
  inventoryUnitId: Id,
  description: Type.String({ minLength: 1, maxLength: 500 }),
  amount: Money
});
const StayTotalCashLine = strictObject({
  lineKind: Type.Literal("STAY_TOTAL"),
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  inventoryUnitId: Id,
  description: Type.String({ minLength: 1, maxLength: 500 }),
  pricingBandAnchorNights: Type.Union([Type.Literal(1), Type.Literal(7), Type.Literal(14), Type.Literal(30)]),
  calculationSegments: Type.Array(strictObject({
    inventoryUnitId: Id,
    pricingProductCode: ShortText,
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1 }),
    anchorAmountMinor: PositiveAmount,
    numeratorMinor: PositiveAmount,
    denominator: Type.Union([Type.Literal(1), Type.Literal(7), Type.Literal(14), Type.Literal(30)])
  }), { minItems: 1 }),
  amount: Money
});
export const CashLine = Type.Union([NightlyCashLine, StayTotalCashLine]);
const QuoteStayTotalCashLine = strictObject({
  lineKind: Type.Literal("STAY_TOTAL"),
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  inventoryUnitId: Id,
  description: Type.String({ minLength: 1, maxLength: 500 }),
  pricingBandAnchorNights: Type.Union([Type.Literal(1), Type.Literal(7), Type.Literal(14), Type.Literal(30)]),
  pricingSummary: Type.String({ minLength: 1, maxLength: 1000 }),
  amount: Money
});
const QuoteCashLine = Type.Union([NightlyCashLine, QuoteStayTotalCashLine]);
export const AmountSummarySchema = strictObject({
  currentContractAmount: Money,
  netRecordedCollection: Money,
  collectionDifference: Money,
  refundReferenceAmount: NonNegativeMoney
});
export const CommandReasonSchema = strictObject({
  code: Type.String({ minLength: 1, maxLength: 80 }),
  note: Note
});
const RecordedCommandReasonSchema = strictObject({
  code: Type.String({ minLength: 1, maxLength: 80 }),
  note: OptionalNote
});

const BackfillNonCashCollectionMethodSchema = Type.Union([
  Type.Literal("WECOM"),
  Type.Literal("BANK_TRANSFER")
]);
const BackfillPositiveAmount = Type.Integer({ minimum: 1, maximum: 2_147_483_647 });
const BackfillCollectionInputSchema = Type.Intersect([
  strictObject({
    amountMinor: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
    method: BackfillCollectionMethodSchema,
    transactionReference: Type.Optional(ShortText),
    cashCollector: Type.Optional(ShortText),
    note: Type.Optional(OptionalNote)
  }),
  Type.Union([
    Type.Object({
      amountMinor: Type.Literal(0),
      method: BackfillNonCashCollectionMethodSchema,
      cashCollector: Type.Optional(Type.Never())
    }),
    Type.Object({
      amountMinor: Type.Literal(0),
      method: Type.Literal("CASH"),
      transactionReference: Type.Optional(Type.Never())
    }),
    Type.Object({
      amountMinor: BackfillPositiveAmount,
      method: BackfillNonCashCollectionMethodSchema,
      transactionReference: ShortText,
      cashCollector: Type.Optional(Type.Never())
    }),
    Type.Object({
      amountMinor: BackfillPositiveAmount,
      method: Type.Literal("CASH"),
      transactionReference: Type.Optional(Type.Never()),
      cashCollector: ShortText,
      note: Note
    })
  ])
]);
const BackfillCollectionEffectSchema = Type.Union([
  strictObject({
    amountMinor: BackfillPositiveAmount,
    method: BackfillNonCashCollectionMethodSchema,
    transactionReference: ShortText,
    note: OptionalNote
  }),
  strictObject({
    amountMinor: BackfillPositiveAmount,
    method: Type.Literal("CASH"),
    cashCollector: ShortText,
    note: Note
  })
]);
const BackfillCompletedStayCollectionEffectSchema = Type.Union([
  strictObject({
    amountMinor: BackfillPositiveAmount,
    currency: Type.String({ minLength: 3, maxLength: 3 }),
    method: BackfillNonCashCollectionMethodSchema,
    transactionReference: ShortText,
    note: OptionalNote
  }),
  strictObject({
    amountMinor: BackfillPositiveAmount,
    currency: Type.String({ minLength: 3, maxLength: 3 }),
    method: Type.Literal("CASH"),
    cashCollector: ShortText,
    note: Note
  })
]);

const ErrorDetailsSchema = Type.Union([
  strictObject({ serviceDate: LocalDate, claimId: Id }),
  strictObject({ serviceDate: LocalDate, inventoryUnitId: Id }),
  strictObject({
    inventoryUnitCode: Type.String({ minLength: 1, maxLength: 120 }),
    overlapStartDate: LocalDate,
    overlapEndDate: LocalDate,
    claimIds: Type.Array(Id)
  }),
  strictObject({ causeCode: Type.Union(errorCauseCodes.map((code) => Type.Literal(code))) }),
  strictObject({ expiresOn: LocalDate, asOfDate: LocalDate }),
  strictObject({ businessDate: LocalDate, arrivalDate: LocalDate }),
  strictObject({ businessDate: LocalDate, departureDate: LocalDate }),
  strictObject({ remainingAvailable: SafeInteger }),
  strictObject({ expirationFactId: Id }),
  strictObject({ reversalFactId: Id }),
  strictObject({ activeRefunded: SafeInteger }),
  strictObject({ commandId: Id }),
  strictObject({ activeQuoteCount: Type.String({ pattern: "^\\d+$" }), limit: Type.Integer({ minimum: 1 }) }),
  strictObject({
    availableBalance: Type.String({ pattern: "^-?\\d+$" }),
    minimum: Type.Literal("0"),
    maximum: Type.Literal("2147483647")
  }),
  strictObject({ orderId: Id, serviceDate: LocalDate, coverageId: Id }),
  strictObject({ orderId: Id, serviceDate: LocalDate, activeClaimIds: Type.Array(Id) }),
  strictObject({
    temporaryOtherRoomAvailable: Type.Literal(true),
    originalRoomTypeCode: ShortText,
    actualRoomTypeCode: ShortText,
    originalRoomTypeAvailable: Type.Boolean()
  }),
  strictObject({ cleaningTaskId: Id, status: Type.Union([Type.Literal("PENDING"), Type.Literal("COMPLETED")]) })
]);

export const ErrorResponse = strictObject({
  code: Type.Union(errorCodes.map((code) => Type.Literal(code))),
  message: Type.String({ minLength: 1, maxLength: 2000 }),
  correlationId: Type.String({ minLength: 1, maxLength: 160 }),
  retryable: Type.Boolean(),
  commandId: Type.Optional(Id),
  receiptId: Type.Optional(Id),
  details: Type.Optional(ErrorDetailsSchema)
});

export const WriteHeaders = Type.Object({
  "idempotency-key": Type.String({ minLength: 1, maxLength: 160 }),
  "x-correlation-id": Type.String({ minLength: 1, maxLength: 160 })
}, { additionalProperties: true });

const Nickname = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" });
const PrimaryGuestInputSchema = strictObject({
  fullName: Type.String({ minLength: 1, maxLength: 200 }),
  nickname: Nickname,
  phone: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  documentNumber: Type.Optional(Type.String({ minLength: 1, maxLength: 120 }))
});
const PrimaryGuestSnapshotSchema = strictObject({
  fullName: Type.String({ minLength: 1, maxLength: 200 }),
  nickname: Type.Optional(nullable(Nickname)),
  phone: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  documentNumber: Type.Optional(Type.String({ minLength: 1, maxLength: 120 }))
});
const CommandEffectOrderOccupantSchema = strictObject({
  id: Id,
  ordinal: Type.Integer({ minimum: 1 }),
  role: Type.Union([Type.Literal("PRIMARY"), Type.Literal("ADDITIONAL")]),
  fullName: Type.String({ minLength: 1, maxLength: 200 }),
  nickname: Nickname,
  phone: Type.Optional(nullable(Type.String({ minLength: 1, maxLength: 80 }))),
  documentNumber: Type.Optional(nullable(Type.String({ minLength: 1, maxLength: 120 })))
});
const OrderOccupantSchema = strictObject({
  id: Id,
  orderId: Id,
  ordinal: Type.Integer({ minimum: 1 }),
  role: Type.Union([Type.Literal("PRIMARY"), Type.Literal("ADDITIONAL")]),
  fullName: nullable(Type.String({ minLength: 1, maxLength: 200 })),
  nickname: nullable(Nickname),
  phone: nullable(Type.String({ minLength: 1, maxLength: 80 })),
  documentNumber: nullable(Type.String({ minLength: 1, maxLength: 120 })),
  createdAt: DateTime
});
const OrderOccupantPriorSnapshotSchema = strictObject({
  fullName: nullable(Type.String({ minLength: 1, maxLength: 200 })),
  nickname: nullable(Nickname),
  phone: nullable(Type.String({ minLength: 1, maxLength: 80 })),
  documentNumber: nullable(Type.String({ minLength: 1, maxLength: 120 }))
});
const OrderOccupantCorrectedSnapshotSchema = strictObject({
  fullName: Type.String({ minLength: 1, maxLength: 200 }),
  nickname: Nickname,
  phone: nullable(Type.String({ minLength: 1, maxLength: 80 })),
  documentNumber: nullable(Type.String({ minLength: 1, maxLength: 120 }))
});
const MemberProfileCorrectionSnapshotSchema = strictObject({
  fullName: ShortText,
  nickname: Nickname,
  identityCardNumber: nullable(ShortText),
  phone: ShortText,
  wechat: ShortText
});
const HistoricalStayArrangementCorrectionItemSchema = strictObject({
  orderId: Id,
  expectedVersion: Type.Integer({ minimum: 1 }),
  target: strictObject({
    inventoryUnitId: Id,
    arrivalDate: LocalDate,
    departureDate: LocalDate
  })
});
const HistoricalMembershipPaymentInputSchema = strictObject({
  amountMinor: PositiveAmount,
  businessDate: LocalDate,
  transactionReference: ShortText,
  note: Type.Optional(OptionalNote)
});
const ReplacementDirectPaymentInputSchema = strictObject({
  businessDate: LocalDate,
  transactionReference: ShortText
});
const PropertyInput = { propertyId: Id };
const OrderInput = { ...PropertyInput, orderId: Id };

// Read-only compatibility gate for exact replays persisted before nickname became required.
// This schema is never published as the command input contract.
export const HistoricalCreateOrderReplayEnvelopeSchema = strictObject({
  commandType: Type.Literal("CREATE_ORDER"),
  input: strictObject({
    ...PropertyInput,
    quoteId: Id,
    primaryGuest: strictObject({
      fullName: Type.String({ minLength: 1, maxLength: 200 }),
      phone: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      documentNumber: Type.Optional(Type.String({ minLength: 1, maxLength: 120 }))
    }),
    bookingChannelCode: BookingChannelCodeSchema,
    channelOrderReference: Type.Optional(nullable(ShortText)),
    freeStayReason: Type.Optional(Note)
  })
});

export const CommandEnvelopeSchema = Type.Union([
  Type.Object({ commandType: Type.Literal("MANAGE_ROOM_CATALOG"), input: RoomCatalogInputSchema }, { additionalProperties: false }),
  commandEnvelope("CREATE_MEMBER", strictObject({
    ...PropertyInput,
    fullName: ShortText,
    nickname: Nickname,
    identityCardNumber: Type.Optional(nullable(ShortText)),
    phone: ShortText,
    wechat: ShortText
  })),
  commandEnvelope("CREATE_MEMBERSHIP_ORDER", strictObject({
    ...PropertyInput,
    memberId: Id,
    membershipProductId: Id,
    agreedPriceMinor: NonNegativeWholeYuanAmount,
    priceAdjustmentReason: Type.Optional(Note)
  })),
  commandEnvelope("RECORD_MEMBERSHIP_PAYMENT", strictObject({
    ...PropertyInput,
    membershipOrderId: Id,
    amountMinor: PositiveAmount,
    transactionReference: ShortText,
    note: Type.Optional(OptionalNote)
  })),
  commandEnvelope("CORRECT_MEMBERSHIP_PAYMENT", strictObject({
    ...PropertyInput,
    membershipOrderId: Id,
    originalPaymentFactId: Id,
    correctedAmountMinor: PositiveAmount,
    correctedTransactionReference: ShortText,
    note: Type.Optional(OptionalNote)
  })),
  commandEnvelope("ACTIVATE_MEMBERSHIP_ORDER", strictObject({
    ...PropertyInput,
    membershipOrderId: Id
  })),
  commandEnvelope("CORRECT_HISTORICAL_STAY_ARRANGEMENTS", strictObject({
    ...PropertyInput,
    correctionSet: Type.Array(HistoricalStayArrangementCorrectionItemSchema, { minItems: 1, maxItems: 100 }),
    evidenceNote: Type.Optional(Note)
  })),
  commandEnvelope("CORRECT_MEMBER_PROFILE", strictObject({
    ...PropertyInput,
    memberId: Id,
    expectedPriorProfile: MemberProfileCorrectionSnapshotSchema,
    correctedProfile: MemberProfileCorrectionSnapshotSchema,
    evidenceNote: Note
  })),
  commandEnvelope("CORRECT_MEMBERSHIP_EFFECTIVE_DATE", strictObject({
    ...PropertyInput,
    membershipOrderId: Id,
    actualMembershipDate: LocalDate,
    evidenceNote: Note
  })),
  commandEnvelope("BACKFILL_HISTORICAL_MEMBERSHIP", strictObject({
    ...PropertyInput,
    memberId: Id,
    membershipProductId: Id,
    actualMembershipDate: LocalDate,
    payment: HistoricalMembershipPaymentInputSchema,
    evidenceNote: Note
  })),
  commandEnvelope("VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY", strictObject({
    ...PropertyInput,
    erroneousMembershipOrderId: Id,
    sourceStayOrderId: Id,
    actualMembershipDate: LocalDate,
    replacementDirectPayment: Type.Optional(ReplacementDirectPaymentInputSchema),
    evidenceNote: Note
  })),
  commandEnvelope("CREATE_ORDER", strictObject({
    ...PropertyInput,
    quoteId: Id,
    primaryGuest: PrimaryGuestInputSchema,
    additionalGuests: Type.Optional(Type.Array(PrimaryGuestInputSchema, { maxItems: 999 })),
    bookingChannelCode: Type.Optional(BookingChannelCodeSchema),
    channelOrderReference: Type.Optional(nullable(ShortText)),
    targetCurrentContractAmountMinor: Type.Optional(Type.Integer({
      minimum: 0,
      maximum: 2_147_483_600,
      multipleOf: 100
    })),
    channelPriceDifferenceReason: Type.Optional(Note),
    manualPriceAdjustmentReason: Type.Optional(Note),
    freeStayReason: Type.Optional(Note),
    freeStayCategoryCode: Type.Optional(FreeStayCategoryCodeSchema),
    backfill: Type.Optional(Type.Literal(true)),
    backfillReason: Type.Optional(Note),
    backfillCollection: Type.Optional(BackfillCollectionInputSchema),
    temporaryOtherRoomReason: Type.Optional(ShortText)
  })),
  commandEnvelope("CORRECT_ORDER_OCCUPANT", strictObject({
    ...OrderInput,
    occupantId: Id,
    expectedPriorSnapshot: OrderOccupantPriorSnapshotSchema,
    correctedSnapshot: OrderOccupantCorrectedSnapshotSchema
  })),
  commandEnvelope("MANAGE_ORDER_OCCUPANTS", strictObject({
    ...OrderInput, action: Type.Union([Type.Literal("ADD"), Type.Literal("REMOVE")]),
    guest: Type.Optional(OrderOccupantCorrectedSnapshotSchema), occupantId: Type.Optional(Id)
  })),
  commandEnvelope("RESCHEDULE_STAY", strictObject({
    ...OrderInput,
    newArrivalDate: LocalDate,
    newDepartureDate: LocalDate,
    targetCurrentContractAmountMinor: Type.Optional(StayChangeTargetAmount),
    channelPriceDifferenceReason: Type.Optional(Note),
    manualPriceAdjustmentReason: Type.Optional(Note)
  })),
  commandEnvelope("EXTEND_STAY", strictObject({
    ...OrderInput,
    newDepartureDate: LocalDate,
    targetCurrentContractAmountMinor: Type.Optional(StayChangeTargetAmount),
    channelPriceDifferenceReason: Type.Optional(Note),
    manualPriceAdjustmentReason: Type.Optional(Note)
  })),
  commandEnvelope("SHORTEN_STAY", strictObject({
    ...OrderInput,
    newDepartureDate: LocalDate,
    targetCurrentContractAmountMinor: Type.Optional(StayChangeTargetAmount),
    channelPriceDifferenceReason: Type.Optional(Note),
    manualPriceAdjustmentReason: Type.Optional(Note)
  })),
  commandEnvelope("MOVE_UNIT", strictObject({
    ...OrderInput,
    newInventoryUnitId: Id,
    effectiveDate: LocalDate,
    targetCurrentContractAmountMinor: Type.Optional(StayChangeTargetAmount),
    channelPriceDifferenceReason: Type.Optional(Note),
    manualPriceAdjustmentReason: Type.Optional(Note)
  })),
  commandEnvelope("REPRICE_ORDER", strictObject({ ...OrderInput, targetCurrentContractAmountMinor: NonNegativeWholeYuanAmount })),
  commandEnvelope("CANCEL_ORDER", strictObject(OrderInput)),
  commandEnvelope("MARK_NO_SHOW", strictObject(OrderInput)),
  commandEnvelope("REVOKE_CHECK_IN", strictObject({ ...OrderInput, unusedRoomConfirmed: Type.Literal(true) })),
  commandEnvelope("LOCK_MAINTENANCE", strictObject({ ...PropertyInput, inventoryUnitId: Id, arrivalDate: LocalDate, departureDate: LocalDate, reason: Note })),
  commandEnvelope("RELEASE_MAINTENANCE", strictObject({ ...PropertyInput, maintenanceLockId: Id })),
  commandEnvelope("COMPLETE_CLEANING", strictObject({ ...PropertyInput, cleaningTaskId: Id })),
  commandEnvelope("RECORD_COLLECTION", strictObject({ ...OrderInput, amountMinor: PositiveAmount, method: ShortText, transactionReference: Type.Optional(ShortText), note: Type.Optional(OptionalNote) })),
  commandEnvelope("RECORD_REFUND", strictObject({ ...OrderInput, amountMinor: PositiveAmount, referencesFactId: Id, method: ShortText, transactionReference: Type.Optional(ShortText), refundReference: Type.Optional(ShortText), note: Type.Optional(OptionalNote) })),
  commandEnvelope("REVERSE_FACT", strictObject({ ...OrderInput, reversesFactId: Id, note: Note })),
  commandEnvelope("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP", strictObject({
    ...OrderInput,
    memberId: Id,
    membershipProductId: Id,
    collectionFactIds: Type.Array(Id),
    agreedPriceMinor: MembershipAgreedPriceAmount,
    priceAdjustmentReason: Type.Optional(Note),
    remainingPaymentTransactionReference: Type.Optional(ShortText),
    remainingPaymentNote: Type.Optional(OptionalNote)
  })),
  commandEnvelope("CHECK_IN", strictObject(OrderInput)),
  commandEnvelope("CHECK_OUT", strictObject(OrderInput)),
  commandEnvelope("REVOKE_CHECK_OUT", strictObject(OrderInput)),
  commandEnvelope("COMPLETE_STAY", strictObject({
    ...OrderInput,
    actualStayCompletedConfirmed: Type.Literal(true),
    reasonNote: Note,
    collection: Type.Optional(BackfillCollectionInputSchema)
  })),
  commandEnvelope("CORRECT_MEMBER_ENTITLEMENT_BALANCE", strictObject({
    ...PropertyInput,
    entitlementLotId: Id,
    targetAvailableBalance: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
    expectedAvailableBalance: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
    adjustmentReason: Note
  })),
  commandEnvelope("ISSUE_TOKEN", strictObject({
    ...PropertyInput,
    subjectId: Id,
    label: Type.String({ minLength: 1, maxLength: 200 }),
    accessCeiling: AccessLevelSchema,
    commandCeiling: CommandCeilingSchema,
    expiresAt: DateTime,
    tokenSecret: OpaqueTokenSecret
  })),
  commandEnvelope("ROTATE_TOKEN", strictObject({
    ...PropertyInput,
    tokenId: Id,
    commandCeiling: CommandCeilingSchema,
    expiresAt: Type.Optional(DateTime),
    tokenSecret: OpaqueTokenSecret
  })),
  commandEnvelope("REVOKE_TOKEN", strictObject({ ...PropertyInput, tokenId: Id }))
]);

const ConfirmBaseProperties = {
  propertyId: Id,
  confirmation: Type.Literal(true),
  expectedEffectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" })
};
export const ConfirmSchema = Type.Union([
  strictObject({
    ...ConfirmBaseProperties,
    commandType: Type.Literal("CREATE_ORDER"),
    reason: Type.Union([
      strictObject({ code: Type.Literal("CREATE_STANDARD_ORDER"), note: Type.Literal("") }),
      strictObject({ code: Type.Literal("BACKFILL_STAY"), note: Note }),
      strictObject({ code: Type.Literal("TEMPORARY_OTHER_ROOM"), note: ShortText })
    ])
  }),
  strictObject({
    ...ConfirmBaseProperties,
    commandType: Type.Union(publicCommandTypes
      .filter((commandType) => commandType !== "CREATE_ORDER")
      .map((commandType) => Type.Literal(commandType))),
    reason: CommandReasonSchema
  })
]);

const InventoryUnitRecordSchema = strictObject({
  id: Id,
  propertyId: Id,
  kind: InventoryUnitKindSchema,
  roomId: Id,
  code: Type.String({ minLength: 1, maxLength: 120 }),
  name: Type.String({ minLength: 1, maxLength: 240 }),
  catalogVersion: nullable(ShortText),
  buildingCode: nullable(ShortText),
  roomTypeCode: nullable(ShortText),
  pricingProductCode: nullable(ShortText),
  inventoryBasis: nullable(Type.Union([Type.Literal("INDEPENDENT"), Type.Literal("WHOLE_ROOM_COMBINATION")])),
  codeProvenance: nullable(Type.Union([Type.Literal("SOURCE_EXPLICIT"), Type.Literal("USER_CONFIRMED_RENAMED"), Type.Literal("PMS_GENERATED")])),
  physicalBedCount: nullable(Type.Integer({ minimum: 1, maximum: 4 })),
  occupancyCapacity: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 }))
});
const PricingResultSchema = strictObject({
  coverageSet: Type.Array(CoverageItem),
  cashLines: Type.Array(CashLine),
  cashRemainder: Money,
  currentContractAmount: Money
});
const QuotePricingExplanationSchema = strictObject({
  pricingModel: Type.Union([
    Type.Literal("NIGHTLY"),
    Type.Literal("DURATION_BAND_TOTAL"),
    Type.Literal("FREE"),
    Type.Literal("MEMBER_ENTITLEMENT")
  ]),
  totalNights: Type.Integer({ minimum: 1, maximum: 366 }),
  quoteAmount: Money,
  amountField: Type.Literal("currentContractAmount"),
  summary: Type.String({ minLength: 1, maxLength: 500 }),
  agentInstruction: Type.String({ minLength: 1, maxLength: 1000 }),
  durationBand: Type.Optional(strictObject({
    anchorNights: Type.Union([Type.Literal(1), Type.Literal(7), Type.Literal(14), Type.Literal(30)]),
    finalAmount: Money,
    roundingRule: Type.Literal("FINAL_STAY_TOTAL_WHOLE_YUAN_HALF_UP"),
    auditCalculationFieldsAreAmounts: Type.Literal(false),
    segments: Type.Array(strictObject({
      inventoryUnitId: Id,
      pricingProductCode: ShortText,
      arrivalDate: LocalDate,
      departureDate: LocalDate,
      nights: Type.Integer({ minimum: 1, maximum: 366 }),
      anchorAmount: Money,
      summary: Type.String({ minLength: 1, maxLength: 500 })
    }), { minItems: 1 })
  }))
});
const CreateOrderPricingDecisionSchema = strictObject({
  pricingBasis: Type.Union(createOrderPricingBasisCodes.map((code) => Type.Literal(code))),
  policyBaseAmount: Money,
  targetCurrentContractAmount: Money,
  differenceFromPolicy: Money,
  manualAdjustmentMinor: SafeInteger,
  differenceExceedsThreshold: Type.Boolean(),
  reason: RecordedCommandReasonSchema
});
export const QuoteSchema = strictObject({
  quoteId: Id,
  propertyId: Id,
  inventoryUnitId: Id,
  stayType: StayTypeSchema,
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  pricingPolicyVersionId: Id,
  coverageSet: Type.Array(CoverageItem),
  cashLines: Type.Array(QuoteCashLine),
  cashRemainder: Money,
  currentContractAmount: Money,
  pricingExplanation: Type.Optional(QuotePricingExplanationSchema),
  expiresAt: DateTime,
  memberId: Type.Optional(Id),
  memberContractId: Type.Optional(Id),
  temporaryOtherRoomArrangement: Type.Optional(TemporaryOtherRoomArrangementSchema),
  inputHash: Type.String({ minLength: 64, maxLength: 64 })
});

export const QuoteRequestSchema = strictObject({
  propertyId: Id,
  inventoryUnitId: Id,
  stayType: Type.Optional(StayTypeSchema),
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  pricingPolicyVersionId: Id,
  memberId: Type.Optional(Id),
  temporaryOtherRoom: Type.Optional(Type.Literal(true))
});
const StayTimelineItemSchema = strictObject({ serviceDate: LocalDate, inventoryUnitId: Id });
const StayTimelineSchema = Type.Array(StayTimelineItemSchema, { minItems: 1 });
const StayChangeDateDiffSchema = strictObject({
  preservedDates: Type.Array(LocalDate),
  releasedDates: Type.Array(LocalDate),
  addedDates: Type.Array(LocalDate)
});
const StayChangeEntitlementDiffSchema = strictObject({
  preservedCoverageDates: Type.Array(LocalDate),
  releasedCoverageDates: Type.Array(LocalDate),
  addedCoverageDates: Type.Array(LocalDate),
  consumedCoverageDates: Type.Array(LocalDate)
});
const StayChangeFundsSummarySchema = strictObject({
  netRecordedCollection: Money,
  collectionDifference: Money
});
const ShortenStayFundsSummarySchema = strictObject({
  netRecordedCollection: Money,
  collectionDifference: Money,
  factCount: Type.Integer({ minimum: 0, maximum: 2_147_483_647 })
});
const LegacyShortenStayEntitlementSummarySchema = strictObject({
  currentConsumedCoverageDates: Type.Array(LocalDate),
  retainedHistoricalConsumedCoverageDates: Type.Array(LocalDate),
  ledgerWriteCount: Type.Literal(0)
});
const ShortenStayEntitlementSummarySchema = strictObject({
  currentConsumedCoverageDates: Type.Array(LocalDate),
  retainedHistoricalConsumedCoverageDates: Type.Array(LocalDate),
  restoredFutureCoverageDates: Type.Array(LocalDate),
  ledgerWriteCount: Type.Integer({ minimum: 0, maximum: 366 })
});
const InventoryClaimSummarySchema = strictObject({
  serviceDate: LocalDate,
  inventoryUnitId: Id
});
const MoveUnitInventoryChangeSchema = strictObject({
  preservedClaims: Type.Array(InventoryClaimSummarySchema),
  releasedClaims: Type.Array(InventoryClaimSummarySchema),
  addedClaims: Type.Array(InventoryClaimSummarySchema)
});
const MoveUnitEntitlementSummarySchema = strictObject({
  preservedCoverageDates: Type.Array(LocalDate),
  migratedHeldCoverageDates: Type.Array(LocalDate),
  consumedCoverageDates: Type.Array(LocalDate),
  convertedMembershipCoveragePreserved: Type.Boolean(),
  ledgerWriteCount: Type.Integer({ minimum: 0, maximum: 2_147_483_647 })
});
const PreInHouseMembershipMoveUnitEntitlementSummarySchema = strictObject({
  preservedCoverageDates: Type.Array(LocalDate),
  migratedHeldCoverageDates: Type.Array(LocalDate),
  consumedCoverageDates: Type.Array(LocalDate),
  ledgerWriteCount: Type.Integer({ minimum: 0, maximum: 2_147_483_647 })
});
const MoveUnitFundsSummarySchema = strictObject({
  netRecordedCollection: Money,
  collectionDifference: Money,
  factCount: Type.Integer({ minimum: 0, maximum: 2_147_483_647 })
});
const MoveUnitBeforeSchema = strictObject({
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  nights: Type.Integer({ minimum: 1, maximum: 366 }),
  currentContractAmount: Money,
  stayTimeline: StayTimelineSchema,
  actualCurrentInventoryUnit: nullable(InventoryUnitRecordSchema),
  effectiveDateInventoryUnit: InventoryUnitRecordSchema
});
const MoveUnitAfterSchema = strictObject({
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  nights: Type.Integer({ minimum: 1, maximum: 366 }),
  stayTimeline: StayTimelineSchema,
  pricing: PricingResultSchema
});

const LegacyStayChangeEffectSchema = strictObject({
  operation: Type.Union([Type.Literal("RESCHEDULE_STAY"), Type.Literal("EXTEND_STAY")]),
  orderId: Id,
  stayId: Id,
  inventoryUnitId: Id,
  before: strictObject({
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1, maximum: 366 }),
    currentContractAmount: Money
  }),
  after: strictObject({
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1, maximum: 366 }),
    stayTimeline: StayTimelineSchema,
    pricing: PricingResultSchema
  }),
  pricingDecision: CreateOrderPricingDecisionSchema,
  inventoryChange: StayChangeDateDiffSchema,
  entitlementChange: StayChangeEntitlementDiffSchema,
  fundsSummary: StayChangeFundsSummarySchema
});

const LegacyShortenStayEffectSchema = strictObject({
  operation: Type.Literal("SHORTEN_STAY"),
  orderId: Id,
  stayId: Id,
  inventoryUnitId: Id,
  businessDate: LocalDate,
  completionMode: Type.Union([Type.Literal("SHORTEN_IN_HOUSE"), Type.Literal("EARLY_CHECK_OUT")]),
  before: strictObject({
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1, maximum: 366 }),
    currentContractAmount: Money
  }),
  after: strictObject({
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1, maximum: 366 }),
    stayTimeline: StayTimelineSchema,
    pricing: PricingResultSchema
  }),
  pricingDecision: CreateOrderPricingDecisionSchema,
  inventoryChange: StayChangeDateDiffSchema,
  entitlementSummary: LegacyShortenStayEntitlementSummarySchema,
  fundsSummary: ShortenStayFundsSummarySchema,
  refundReferenceAmount: NonNegativeMoney
});

const LegacyMoveUnitEffectSchema = strictObject({
  orderId: Id,
  fromInventoryUnit: InventoryUnitRecordSchema,
  toInventoryUnit: InventoryUnitRecordSchema,
  effectiveDate: LocalDate,
  occupantCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  occupancyCapacity: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  stayTimeline: StayTimelineSchema,
  pricing: PricingResultSchema
});

const PreInHouseMembershipShortenStayEffectSchema = strictObject({
  operation: Type.Literal("SHORTEN_STAY"),
  orderId: Id,
  stayId: Id,
  inventoryUnitId: Id,
  businessDate: LocalDate,
  completionMode: Type.Union([Type.Literal("SHORTEN_IN_HOUSE"), Type.Literal("EARLY_CHECK_OUT")]),
  before: strictObject({
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1, maximum: 366 }),
    currentContractAmount: Money,
    stayTimeline: StayTimelineSchema
  }),
  after: strictObject({
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1, maximum: 366 }),
    stayTimeline: StayTimelineSchema,
    pricing: PricingResultSchema
  }),
  pricingDecision: CreateOrderPricingDecisionSchema,
  inventoryChange: StayChangeDateDiffSchema,
  entitlementSummary: LegacyShortenStayEntitlementSummarySchema,
  fundsSummary: ShortenStayFundsSummarySchema,
  refundReferenceAmount: NonNegativeMoney
});

const PreInHouseMembershipMoveUnitEffectSchema = strictObject({
  operation: Type.Literal("MOVE_UNIT"),
  orderId: Id,
  stayId: Id,
  businessDate: LocalDate,
  toInventoryUnit: InventoryUnitRecordSchema,
  effectiveDate: LocalDate,
  occupantCount: Type.Integer({ minimum: 1, maximum: 1000 }),
  occupancyCapacity: Type.Integer({ minimum: 1, maximum: 1000 }),
  before: MoveUnitBeforeSchema,
  after: MoveUnitAfterSchema,
  pricingDecision: CreateOrderPricingDecisionSchema,
  inventoryChange: MoveUnitInventoryChangeSchema,
  entitlementSummary: PreInHouseMembershipMoveUnitEntitlementSummarySchema,
  fundsSummary: MoveUnitFundsSummarySchema
});

const StayCollectionTransferItemSchema = strictObject({
  factId: Id,
  amount: Money,
  transactionReference: ShortText,
  recordedAt: DateTime
});

const AdminMembershipProductEffectSchema = strictObject({
  productId: Id,
  code: ShortText,
  version: Type.Integer({ minimum: 1 }),
  name: ShortText,
  listedPrice: Money,
  agreedPrice: Money,
  entitlementUnitKind: EntitlementUnitKindSchema,
  entitlementUnits: Type.Integer({ minimum: 1 }),
  validityPeriod: Type.Literal("P1Y"),
  allowedRoomTypeCode: ShortText,
  allowedInventoryKind: InventoryUnitKindSchema
});

const AdminMemberProfileChangedFieldSchema = Type.Union([
  Type.Literal("fullName"),
  Type.Literal("nickname"),
  Type.Literal("identityCardNumber"),
  Type.Literal("phone"),
  Type.Literal("wechat")
]);
const AdminMembershipDirectCollectionSchema = strictObject({
  factId: Id,
  amount: Money,
  transactionReference: ShortText,
  businessDate: LocalDate
});
const AdminMembershipSourceIdentityEvidenceSchema = strictObject({
  phoneMatched: Type.Boolean(),
  documentMatched: Type.Boolean()
});

const HistoricalStayArrangementSnapshotSchema = strictObject({
  inventoryUnitId: Id,
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  nights: Type.Integer({ minimum: 1, maximum: 366 }),
  stayTimeline: StayTimelineSchema
});

const HistoricalStayArrangementOccupantSchema = strictObject({
  ordinal: Type.Integer({ minimum: 1 }),
  role: Type.Union([Type.Literal("PRIMARY"), Type.Literal("ADDITIONAL")]),
  fullName: nullable(ShortText),
  nickname: nullable(ShortText)
});

const HistoricalStayArrangementUnchangedSchema = strictObject({
  orderStatus: Type.Literal("CHECKED_OUT"),
  stayStatus: Type.Literal("COMPLETED"),
  stayType: StayTypeSchema,
  currentRevisionId: Id,
  currentContractAmountMinor: SafeInteger,
  currency: Type.String({ minLength: 3, maxLength: 3 }),
  occupantCount: Type.Integer({ minimum: 1 }),
  occupants: Type.Array(HistoricalStayArrangementOccupantSchema, { minItems: 1 }),
  collectionFactCount: Type.Integer({ minimum: 0 }),
  netRecordedCollectionMinor: SafeInteger,
  collectionDifferenceMinor: SafeInteger
});

const RevokeCheckOutEffectSchema = strictObject({
  operation: Type.Literal("REVOKE_CHECK_OUT"), orderId: Id,
  fromStatus: Type.Literal("CHECKED_OUT"), toStatus: Type.Literal("CHECKED_IN"),
  checkoutAmendmentId: Id, checkoutSequence: Type.Integer({ minimum: 1 }), sourceRevisionId: Id,
  mode: Type.Union([Type.Literal("UNDO_EARLY_CHECK_OUT"), Type.Literal("UNDO_CHECK_OUT")]),
  businessDate: LocalDate,
  before: strictObject({ arrivalDate: LocalDate, departureDate: LocalDate, currentContractAmount: Money }),
  after: strictObject({ arrivalDate: LocalDate, departureDate: LocalDate, currentContractAmount: Money,
    stayTimeline: Type.Array(strictObject({ serviceDate: LocalDate, inventoryUnitId: Id }), { minItems: 1 }) }),
  entitlementReconsumeDates: Type.Array(LocalDate),
  fundsSummary: strictObject({ netRecordedCollection: Money, collectionDifference: Money, refundReferenceAmount: Money })
});

export const CommandEffectSchema = Type.Union([
  RoomCatalogEffectSchema,
  RevokeCheckOutEffectSchema,
  strictObject({
    operation: Type.Literal("CREATE_MEMBER_PROFILE"),
    memberId: Type.Null(),
    member: strictObject({
      fullName: ShortText,
      nickname: Nickname,
      identityCardNumber: nullable(ShortText),
      phone: ShortText,
      wechat: ShortText
    }),
    propertyLink: strictObject({ operation: Type.Literal("CREATE") })
  }),
  strictObject({
    operation: Type.Literal("CREATE_MEMBERSHIP_ORDER"),
    member: strictObject({ memberId: Id, fullName: ShortText }),
    product: strictObject({
      productId: Id,
      code: ShortText,
      version: Type.Integer({ minimum: 1 }),
      name: ShortText,
      entitlementUnitKind: EntitlementUnitKindSchema,
      entitlementUnits: Type.Integer({ minimum: 1 }),
      allowedRoomTypeCode: ShortText,
      allowedInventoryKind: InventoryUnitKindSchema
    }),
    pricing: strictObject({
      listedPrice: Money,
      agreedPrice: Money,
      adjustment: Money,
      adjustmentReason: nullable(Note)
    }),
    status: Type.Literal("DRAFT")
  }),
  strictObject({
    operation: Type.Literal("RECORD_MEMBERSHIP_PAYMENT"),
    membershipOrderId: Id,
    memberName: ShortText,
    productName: ShortText,
    payment: strictObject({ amount: Money, businessDate: LocalDate, transactionReference: ShortText, note: OptionalNote }),
    totals: strictObject({
      agreedPrice: Money,
      previouslyCollected: Money,
      currentCollection: Money,
      differenceAfter: Money
    }),
    status: Type.Union([Type.Literal("DRAFT"), Type.Literal("ACTIVE")])
  }),
  strictObject({
    operation: Type.Literal("CORRECT_MEMBERSHIP_PAYMENT"),
    membershipOrderId: Id,
    memberName: ShortText,
    productName: ShortText,
    originalPaymentFactId: Id,
    original: strictObject({ amount: Money, businessDate: LocalDate, transactionReference: ShortText }),
    replacement: strictObject({ amount: Money, businessDate: LocalDate, transactionReference: ShortText, note: OptionalNote }),
    totals: strictObject({ before: Money, after: Money, agreedPrice: Money, differenceAfter: Money }),
    status: Type.Literal("DRAFT")
  }),
  strictObject({
    operation: Type.Literal("ACTIVATE_MEMBERSHIP_ORDER"),
    membershipOrderId: Id,
    memberName: ShortText,
    productName: ShortText,
    paymentTotal: Money,
    agreedPrice: Money,
    paymentDifference: Money,
    validFrom: LocalDate,
    validUntil: LocalDate,
    entitlementUnitKind: EntitlementUnitKindSchema,
    entitlementUnits: Type.Integer({ minimum: 1 }),
    fromStatus: Type.Literal("DRAFT"),
    toStatus: Type.Literal("ACTIVE")
  }),
  strictObject({
    operation: Type.Literal("CORRECT_MEMBER_PROFILE"),
    memberId: Id,
    before: MemberProfileCorrectionSnapshotSchema,
    after: MemberProfileCorrectionSnapshotSchema,
    changedFields: Type.Array(AdminMemberProfileChangedFieldSchema, { minItems: 1, maxItems: 5, uniqueItems: true }),
    evidenceNote: Note
  }),
  strictObject({
    operation: Type.Literal("CORRECT_HISTORICAL_STAY_ARRANGEMENTS"),
    corrections: Type.Array(strictObject({
      orderId: Id,
      stayId: Id,
      expectedVersion: Type.Integer({ minimum: 1 }),
      before: HistoricalStayArrangementSnapshotSchema,
      after: HistoricalStayArrangementSnapshotSchema,
      unchanged: HistoricalStayArrangementUnchangedSchema
    }), { minItems: 1, maxItems: 100 })
  }),
  strictObject({
    operation: Type.Literal("CORRECT_MEMBERSHIP_EFFECTIVE_DATE"),
    propertyToday: LocalDate,
    memberId: Id,
    membershipOrderId: Id,
    contractId: Id,
    entitlementLotId: Id,
    evidenceNote: Note,
    before: strictObject({
      validFrom: LocalDate,
      validUntil: LocalDate,
      status: Type.Literal("ACTIVE")
    }),
    after: strictObject({
      validFrom: LocalDate,
      validUntil: LocalDate,
      status: Type.Literal("ACTIVE")
    }),
    unchanged: strictObject({
      memberId: Id,
      productName: ShortText,
      agreedPrice: Money,
      entitlementUnitKind: EntitlementUnitKindSchema,
      entitlementUnits: Type.Integer({ minimum: 1 }),
      usedUnits: Type.Integer({ minimum: 0 }),
      availableBalance: strictObject({
        ROOM_NIGHT: Type.Integer({ minimum: 0 }),
        BED_NIGHT: Type.Integer({ minimum: 0 })
      }),
      paymentFactCount: Type.Integer({ minimum: 0 }),
      lifecycleStatus: Type.Literal("ACTIVE")
    })
  }),
  strictObject({
    operation: Type.Literal("BACKFILL_HISTORICAL_MEMBERSHIP"),
    evidenceNote: Note,
    member: strictObject({ memberId: Id, fullName: ShortText }),
    product: AdminMembershipProductEffectSchema,
    payment: strictObject({
      amount: Money,
      businessDate: LocalDate,
      transactionReference: ShortText,
      note: OptionalNote
    }),
    validFrom: LocalDate,
    validUntil: LocalDate,
    entitlementUnitKind: EntitlementUnitKindSchema,
    entitlementUnits: Type.Integer({ minimum: 1 }),
    status: Type.Literal("ACTIVE")
  }),
  strictObject({
    operation: Type.Literal("VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY"),
    evidenceNote: Note,
    member: strictObject({ memberId: Id, fullName: ShortText }),
    oldMembership: strictObject({
      membershipOrderId: Id,
      contractId: Id,
      entitlementLotId: Id,
      productId: Id,
      status: Type.Literal("ACTIVE"),
      directCollections: Type.Array(AdminMembershipDirectCollectionSchema, { minItems: 1 })
    }),
    sourceStay: strictObject({
      orderId: Id,
      stayId: Id,
      arrivalDate: LocalDate,
      departureDate: LocalDate,
      serviceDates: Type.Array(LocalDate, { minItems: 1 }),
      identityEvidence: AdminMembershipSourceIdentityEvidenceSchema
    }),
    funds: strictObject({
      oldDirectCollectionTotal: Money,
      oldReversalTotal: Money,
      stayTransferTotal: Money,
      replacementDirectPayment: nullable(strictObject({
        amount: Money,
        businessDate: LocalDate,
        transactionReference: ShortText
      })),
      membershipAgreedPrice: Money,
      reclassificationOnly: Type.Literal(true)
    }),
    newMembership: strictObject({
      productId: Id,
      productName: ShortText,
      validFrom: LocalDate,
      validUntil: LocalDate
    }),
    entitlement: strictObject({
      unitKind: EntitlementUnitKindSchema,
      totalUnits: Type.Integer({ minimum: 1 }),
      consumedUnits: Type.Integer({ minimum: 1 }),
      remainingUnits: Type.Integer({ minimum: 0 }),
      serviceDates: Type.Array(LocalDate, { minItems: 1 })
    })
  }),
  strictObject({
    quoteId: Id,
    primaryGuest: PrimaryGuestSnapshotSchema,
    occupants: Type.Optional(Type.Array(CommandEffectOrderOccupantSchema, { minItems: 1, maxItems: 1000 })),
    occupancyCapacity: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    bookingChannelCode: nullable(BookingChannelCodeSchema),
    channelOrderReference: nullable(ShortText),
    freeStayReason: nullable(Note),
    freeStayCategoryCode: nullable(FreeStayCategoryCodeSchema),
    inventoryUnit: InventoryUnitRecordSchema,
    stayType: StayTypeSchema,
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    pricingPolicyVersionId: Id,
    memberId: nullable(Id),
    memberContractId: nullable(Id),
    temporaryOtherRoomArrangement: Type.Optional(TemporaryOtherRoomArrangementSchema),
    temporaryOtherRoomReason: Type.Optional(ShortText),
    backfill: Type.Optional(strictObject({
      reason: Note,
      businessDate: LocalDate,
      resultingOrderStatus: Type.Union([Type.Literal("CHECKED_IN"), Type.Literal("CHECKED_OUT")]),
      resultingStayStatus: Type.Union([Type.Literal("IN_HOUSE"), Type.Literal("COMPLETED")]),
      collection: nullable(BackfillCollectionEffectSchema),
      externalChannel: Type.Boolean(),
      settlementStatus: Type.Union([Type.Literal("SETTLED"), Type.Literal("ARREARS")]),
      collectedAmountMinor: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
      balanceDueMinor: Type.Integer({ minimum: 0, maximum: 2_147_483_647 })
    })),
    pricingDecision: Type.Optional(CreateOrderPricingDecisionSchema),
    pricing: PricingResultSchema
  }),
  strictObject({
    operation: Type.Literal("CORRECT_ORDER_OCCUPANT"),
    orderId: Id,
    occupantId: Id,
    ordinal: Type.Integer({ minimum: 1 }),
    role: Type.Union([Type.Literal("PRIMARY"), Type.Literal("ADDITIONAL")]),
    before: OrderOccupantPriorSnapshotSchema,
    after: OrderOccupantCorrectedSnapshotSchema,
    ...TemporaryOtherRoomLifecycleEvidenceFields
  }),
  strictObject({
    operation: Type.Literal("MANAGE_ORDER_OCCUPANTS"),
    ...TemporaryOtherRoomLifecycleEvidenceFields,
    action: Type.Union([Type.Literal("ADD"), Type.Literal("REMOVE")]),
    orderId: Id,
    occupantId: Id,
    ordinal: Type.Integer({ minimum: 2 }),
    guest: OrderOccupantPriorSnapshotSchema,
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    beforeCount: Type.Integer({ minimum: 1 }),
    afterCount: Type.Integer({ minimum: 1 }),
    occupancyCapacity: Type.Integer({ minimum: 1 })
  }),
  strictObject({ inventoryUnit: InventoryUnitRecordSchema, arrivalDate: LocalDate, departureDate: LocalDate, reason: Note }),
  strictObject({ maintenanceLockId: Id, inventoryUnitId: Id, arrivalDate: LocalDate, departureDate: LocalDate }),
  strictObject({
    internalUseBlockId: Id,
    inventoryUnitId: Id,
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    reason: Note,
    fromStatus: Type.Literal("ACTIVE"),
    toStatus: Type.Literal("RELEASED")
  }),
  strictObject({
    cleaningTaskId: Id,
    orderId: Id,
    stayId: Id,
    inventoryUnitId: Id,
    roomId: Id,
    serviceDate: LocalDate,
    fromStatus: Type.Literal("PENDING"),
    toStatus: Type.Literal("COMPLETED")
  }),
  strictObject({
    entitlementLotId: Id,
    contractId: Id,
    unitKind: EntitlementUnitKindSchema,
    quantityDelta: NonZeroInteger,
    adjustmentReason: Note,
    availableBefore: SafeInteger,
    availableAfter: SafeInteger
  }),
  strictObject({
    contractId: Id,
    unitKind: EntitlementUnitKindSchema,
    units: PositiveAmount,
    expiresOn: LocalDate
  }),
  strictObject({
    entitlementLotId: Id, contractId: Id, unitKind: EntitlementUnitKindSchema, expiresOn: LocalDate,
    asOfDate: LocalDate, remainingAvailable: Type.Integer({ minimum: 0 }), quantityDelta: Type.Integer({ maximum: 0 }), entryType: Type.Literal("EXPIRE")
  }),
  strictObject({
    subjectId: Id,
    subjectDisplayName: ShortText,
    label: ShortText,
    accessCeiling: AccessLevelSchema,
    commandCeiling: CommandCeilingSchema,
    persistedCommandCeiling: PersistedCommandCeilingSchema,
    expiresAt: DateTime
  }),
  strictObject({
    tokenId: Id,
    subjectId: Id,
    subjectDisplayName: ShortText,
    label: ShortText,
    accessCeiling: AccessLevelSchema,
    previousCommandCeiling: CommandCeilingSchema,
    commandCeiling: CommandCeilingSchema,
    previousPersistedCommandCeiling: PersistedCommandCeilingSchema,
    persistedCommandCeiling: PersistedCommandCeilingSchema,
    previousExpiresAt: DateTime,
    expiresAt: DateTime,
    historicalReadCeilingPreserved: Type.Boolean(),
    operation: Type.Literal("ROTATE")
  }),
  strictObject({
    tokenId: Id,
    subjectId: Id,
    subjectDisplayName: ShortText,
    label: ShortText,
    accessCeiling: AccessLevelSchema,
    commandCeiling: CommandCeilingSchema,
    persistedCommandCeiling: PersistedCommandCeilingSchema,
    expiresAt: DateTime,
    historicalReadCeilingPreserved: Type.Literal(false),
    operation: Type.Literal("REVOKE")
  }),
  strictObject({
    operation: Type.Union([Type.Literal("RESCHEDULE_STAY"), Type.Literal("EXTEND_STAY")]),
    orderId: Id,
    stayId: Id,
    inventoryUnitId: Id,
    before: strictObject({
      arrivalDate: LocalDate,
      departureDate: LocalDate,
      nights: Type.Integer({ minimum: 1, maximum: 366 }),
      currentContractAmount: Money,
      stayTimeline: StayTimelineSchema
    }),
    after: strictObject({
      arrivalDate: LocalDate,
      departureDate: LocalDate,
      nights: Type.Integer({ minimum: 1, maximum: 366 }),
      stayTimeline: StayTimelineSchema,
      pricing: PricingResultSchema
    }),
    pricingDecision: CreateOrderPricingDecisionSchema,
    inventoryChange: StayChangeDateDiffSchema,
    entitlementChange: StayChangeEntitlementDiffSchema,
    fundsSummary: StayChangeFundsSummarySchema,
    ...TemporaryOtherRoomLifecycleEvidenceFields
  }),
  strictObject({
    operation: Type.Literal("SHORTEN_STAY"),
    orderId: Id,
    stayId: Id,
    inventoryUnitId: Id,
    businessDate: LocalDate,
    completionMode: Type.Union([Type.Literal("SHORTEN_IN_HOUSE"), Type.Literal("EARLY_CHECK_OUT")]),
    before: strictObject({
      arrivalDate: LocalDate,
      departureDate: LocalDate,
      nights: Type.Integer({ minimum: 1, maximum: 366 }),
      currentContractAmount: Money,
      stayTimeline: StayTimelineSchema
    }),
    after: strictObject({
      arrivalDate: LocalDate,
      departureDate: LocalDate,
      nights: Type.Integer({ minimum: 1, maximum: 366 }),
      stayTimeline: StayTimelineSchema,
      pricing: PricingResultSchema
    }),
    pricingDecision: CreateOrderPricingDecisionSchema,
    inventoryChange: StayChangeDateDiffSchema,
    entitlementSummary: ShortenStayEntitlementSummarySchema,
    fundsSummary: ShortenStayFundsSummarySchema,
    refundReferenceAmount: NonNegativeMoney,
    ...TemporaryOtherRoomLifecycleEvidenceFields
  }),
  strictObject({
    operation: Type.Literal("MOVE_UNIT"),
    orderId: Id,
    stayId: Id,
    businessDate: LocalDate,
    toInventoryUnit: InventoryUnitRecordSchema,
    effectiveDate: LocalDate,
    occupantCount: Type.Integer({ minimum: 1, maximum: 1000 }),
    occupancyCapacity: Type.Integer({ minimum: 1, maximum: 1000 }),
    before: MoveUnitBeforeSchema,
    after: MoveUnitAfterSchema,
    pricingDecision: CreateOrderPricingDecisionSchema,
    inventoryChange: MoveUnitInventoryChangeSchema,
    entitlementSummary: MoveUnitEntitlementSummarySchema,
    fundsSummary: MoveUnitFundsSummarySchema
  }),
  strictObject({
    orderId: Id,
    inventoryUnitId: Id,
    stayTimeline: StayTimelineSchema,
    before: strictObject({ currentContractAmount: Money }),
    policyBaseAmount: Money,
    targetCurrentContractAmount: Money,
    pricing: PricingResultSchema,
    manualAdjustmentMinor: SafeInteger
  }),
  strictObject({
    orderId: Id,
    inventoryUnitId: Id,
    stayTimeline: StayTimelineSchema,
    before: strictObject({ currentContractAmount: Money }),
    pricing: PricingResultSchema
  }),
  strictObject({ orderId: Id, amountMinor: PositiveAmount, currency: Type.String({ minLength: 3, maxLength: 3 }), method: ShortText, transactionReference: nullable(ShortText), note: OptionalNote }),
  strictObject({ orderId: Id, amountMinor: PositiveAmount, currency: Type.String({ minLength: 3, maxLength: 3 }), referencesFactId: Id, method: ShortText, transactionReference: nullable(ShortText), refundReference: Type.Optional(ShortText), note: OptionalNote }),
  strictObject({ orderId: Id, reversesFactId: Id, amountMinor: PositiveAmount, netEffectMinor: SafeInteger, currency: Type.String({ minLength: 3, maxLength: 3 }), note: Note }),
  strictObject({
    operation: Type.Literal("CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"),
    orderId: Id,
    stayId: Id,
    primaryOccupant: strictObject({
      fullName: nullable(ShortText),
      nickname: nullable(ShortText),
      phone: nullable(ShortText)
    }),
    member: strictObject({ memberId: Id, fullName: ShortText, phone: ShortText }),
    product: strictObject({
      productId: Id,
      code: ShortText,
      version: Type.Integer({ minimum: 1 }),
      name: ShortText,
      entitlementUnitKind: EntitlementUnitKindSchema,
      entitlementUnits: Type.Integer({ minimum: 1 }),
      allowedRoomTypeCode: ShortText,
      allowedInventoryKind: InventoryUnitKindSchema
    }),
    transfer: strictObject({
      collections: Type.Array(StayCollectionTransferItemSchema),
      total: Money
    }),
    membershipPricing: strictObject({
      listedPrice: Money,
      agreedPrice: Money,
      adjustment: Money,
      adjustmentReason: nullable(Note)
    }),
    remainingPayment: nullable(strictObject({
      amount: Money,
      transactionReference: ShortText,
      note: OptionalNote
    })),
    entitlement: strictObject({
      entitlementUnitKind: EntitlementUnitKindSchema,
      entitlementUnits: Type.Integer({ minimum: 1 }),
      consumedUnits: Type.Integer({ minimum: 1 }),
      remainingUnits: Type.Integer({ minimum: 0 }),
      serviceDates: Type.Array(LocalDate, { minItems: 1 }),
      validFrom: LocalDate,
      validUntil: LocalDate
    }),
    before: strictObject({
      currentContractAmount: Money,
      netRecordedCollection: Money
    }),
    pricingDecision: CreateOrderPricingDecisionSchema,
    pricing: PricingResultSchema
  }),
  strictObject({
    operation: Type.Literal("BACKFILL_COMPLETED_STAY"),
    orderId: Id,
    stayId: Id,
    inventoryUnitId: Id,
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    businessDate: LocalDate,
    amounts: AmountSummarySchema,
    checkIn: strictObject({
      orderId: Id,
      fromStatus: Type.Literal("RESERVED"),
      toStatus: Type.Literal("CHECKED_IN"),
      inventoryUnitId: Id,
      businessDate: LocalDate,
      effectiveDate: LocalDate,
      recordingMode: Type.Union([Type.Literal("ON_SCHEDULE"), Type.Literal("LATE_RECORDED")]),
      entitlementTransition: strictObject({
        from: Type.Literal("HELD"),
        to: Type.Literal("CONSUMED"),
        coverageCount: Type.Integer({ minimum: 0 })
      })
    }),
    checkOut: strictObject({
      orderId: Id,
      fromStatus: Type.Literal("CHECKED_IN"),
      toStatus: Type.Literal("CHECKED_OUT"),
      inventoryUnitId: Id,
      businessDate: LocalDate,
      effectiveDate: LocalDate,
      recordingMode: Type.Union([Type.Literal("ON_SCHEDULE"), Type.Literal("LATE_RECORDED")])
    }),
    entitlementTransition: strictObject({
      from: Type.Literal("HELD"),
      to: Type.Literal("CONSUMED"),
      coverageCount: Type.Integer({ minimum: 0 })
    }),
    collection: nullable(BackfillCompletedStayCollectionEffectSchema)
  }),
  strictObject({
    operation: Type.Literal("COMPLETE_STAY"),
    orderId: Id,
    stayId: Id,
    inventoryUnitId: Id,
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    businessDate: LocalDate,
    reasonNote: Note,
    stayTimeline: StayTimelineSchema,
    settlementStatus: Type.Union([Type.Literal("SETTLED"), Type.Literal("ARREARS")]),
    amounts: AmountSummarySchema,
    inventoryRelease: strictObject({
      claimIds: Type.Array(Id),
      claimCount: Type.Integer({ minimum: 0 })
    }),
    checkIn: strictObject({
      orderId: Id,
      fromStatus: Type.Literal("RESERVED"),
      toStatus: Type.Literal("CHECKED_IN"),
      inventoryUnitId: Id,
      businessDate: LocalDate,
      effectiveDate: LocalDate,
      recordingMode: Type.Union([Type.Literal("ON_SCHEDULE"), Type.Literal("LATE_RECORDED")]),
      entitlementTransition: strictObject({
        from: Type.Literal("HELD"),
        to: Type.Literal("CONSUMED"),
        coverageCount: Type.Integer({ minimum: 0 })
      })
    }),
    checkOut: strictObject({
      orderId: Id,
      fromStatus: Type.Literal("CHECKED_IN"),
      toStatus: Type.Literal("CHECKED_OUT"),
      inventoryUnitId: Id,
      businessDate: LocalDate,
      effectiveDate: LocalDate,
      recordingMode: Type.Union([Type.Literal("ON_SCHEDULE"), Type.Literal("LATE_RECORDED")])
    }),
    entitlementTransition: strictObject({
      from: Type.Literal("HELD"),
      to: Type.Literal("CONSUMED"),
      coverageCount: Type.Integer({ minimum: 0 }),
      coverageIds: Type.Array(Id)
    }),
    collection: nullable(BackfillCompletedStayCollectionEffectSchema),
    ...TemporaryOtherRoomLifecycleEvidenceFields
  }),
  strictObject({
    orderId: Id,
    fromStatus: OrderStatusSchema,
    toStatus: OrderStatusSchema,
    inventoryUnitId: Id,
    businessDate: Type.Optional(LocalDate),
    effectiveDate: Type.Optional(LocalDate),
    recordingMode: Type.Optional(Type.Union([Type.Literal("ON_SCHEDULE"), Type.Literal("LATE_RECORDED")])),
    freeStayReason: Type.Optional(nullable(Note)),
    freeStayCategoryCode: Type.Optional(nullable(FreeStayCategoryCodeSchema)),
    currentContractAmount: Type.Optional(Money),
    amounts: Type.Optional(AmountSummarySchema),
    cleaningTask: Type.Optional(strictObject({
      inventoryUnitId: Id,
      serviceDate: LocalDate,
      status: Type.Literal("PENDING")
    })),
    entitlementTransition: Type.Optional(strictObject({
      from: Type.Union([Type.Literal("HELD"), Type.Literal("CONSUMED")]),
      to: Type.Union([Type.Literal("CONSUMED"), Type.Literal("RELEASED"), Type.Literal("RESTORED")]),
      coverageCount: Type.Integer({ minimum: 0 })
    })),
    unusedRoomConfirmed: Type.Optional(Type.Literal(true)),
    pricingRevision: Type.Optional(strictObject({
      currentContractAmount: Money,
      pricingBasis: Type.Union(createOrderPricingBasisCodes.map((code) => Type.Literal(code)))
    })),
    ...TemporaryOtherRoomLifecycleEvidenceFields
  })
]);

export const PreviewSchema = strictObject({
  previewId: Id,
  commandType: HistoricalCommandTypeSchema,
  effectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
  effect: CommandEffectSchema,
  expiresAt: DateTime
});

const CreateOrderResultSchema = strictObject({
  orderId: Id,
  stayId: Id,
  segmentId: Id,
  pricingRevisionId: Id,
  pricingPolicyVersionId: Type.Optional(Id),
  primaryGuest: nullable(PrimaryGuestSnapshotSchema),
  occupants: Type.Optional(Type.Array(OrderOccupantSchema, { minItems: 1, maxItems: 1000 })),
  bookingChannelCode: nullable(BookingChannelCodeSchema),
  channelOrderReference: nullable(ShortText),
  freeStayReason: nullable(Note),
  freeStayCategoryCode: nullable(FreeStayCategoryCodeSchema),
  temporaryOtherRoomArrangement: Type.Optional(TemporaryOtherRoomArrangementSchema),
  temporaryOtherRoomCreateAmendmentId: Type.Optional(Id),
  effectHash: Type.Optional(Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" })),
  status: Type.Optional(Type.Union([Type.Literal("RESERVED"), Type.Literal("CHECKED_IN"), Type.Literal("CHECKED_OUT")])),
  backfill: Type.Optional(strictObject({
    businessDate: LocalDate,
    checkInAmendmentId: Id,
    checkOutAmendmentId: nullable(Id),
    settlementStatus: Type.Union([Type.Literal("SETTLED"), Type.Literal("ARREARS")]),
    collectedAmountMinor: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
    balanceDueMinor: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
    collectionFactId: nullable(Id)
  })),
  pricingDecision: Type.Optional(CreateOrderPricingDecisionSchema)
});
const CorrectOrderOccupantResultSchema = strictObject({
  orderId: Id,
  occupantId: Id,
  correctionId: Id,
  amendmentId: Id,
  occupant: OrderOccupantCorrectedSnapshotSchema,
  effectHash: Type.Optional(Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" })),
  ...TemporaryOtherRoomLifecycleEvidenceFields
});
const CreateMemberResultSchema = strictObject({
  memberId: Id,
  memberCreated: Type.Literal(true)
});
const MaintenanceLockResultSchema = strictObject({ maintenanceLockId: Id });
const MaintenanceReleaseResultSchema = strictObject({ maintenanceLockId: Id, status: Type.Literal("RELEASED") });
const InternalUsePlacementResultSchema = strictObject({
  internalUseBlockId: Id,
  inventoryUnitId: Id,
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  status: Type.Literal("ACTIVE")
});
const InternalUseReleaseResultSchema = strictObject({ internalUseBlockId: Id, status: Type.Literal("RELEASED") });
const CleaningCompletionResultSchema = strictObject({ cleaningTaskId: Id, status: Type.Literal("COMPLETED") });
const EntitlementAdjustmentResultSchema = strictObject({
  entitlementLotId: Id,
  adjustmentFactId: Id,
  availableBefore: SafeInteger,
  availableAfter: SafeInteger,
  quantityDelta: NonZeroInteger
});
const EntitlementLotAddedResultSchema = strictObject({ entitlementLotId: Id, contractId: Id, adjustmentFactId: Id, units: PositiveAmount });
const EntitlementExpirationResultSchema = strictObject({
  entitlementLotId: Id,
  contractId: Id,
  factId: Id,
  entryType: Type.Literal("EXPIRE"),
  expiredUnits: Type.Integer({ minimum: 0 }),
  remainingAvailable: Type.Literal(0),
  asOfDate: LocalDate
});
const TokenIssueResultSchema = strictObject({
  tokenId: Id,
  subjectId: Id,
  subjectDisplayName: ShortText,
  label: ShortText,
  accessCeiling: AccessLevelSchema,
  commandCeiling: CommandCeilingSchema,
  persistedCommandCeiling: PersistedCommandCeilingSchema,
  expiresAt: DateTime
});
const TokenRotationResultSchema = strictObject({
  tokenId: Id,
  rotatedFromTokenId: Id,
  subjectId: Id,
  subjectDisplayName: ShortText,
  label: ShortText,
  accessCeiling: AccessLevelSchema,
  previousCommandCeiling: CommandCeilingSchema,
  commandCeiling: CommandCeilingSchema,
  previousPersistedCommandCeiling: PersistedCommandCeilingSchema,
  persistedCommandCeiling: PersistedCommandCeilingSchema,
  previousExpiresAt: DateTime,
  expiresAt: DateTime,
  historicalReadCeilingPreserved: Type.Boolean()
});
const TokenRevocationResultSchema = strictObject({
  tokenId: Id,
  subjectId: Id,
  subjectDisplayName: ShortText,
  label: ShortText,
  accessCeiling: AccessLevelSchema,
  commandCeiling: CommandCeilingSchema,
  persistedCommandCeiling: PersistedCommandCeilingSchema,
  expiresAt: DateTime,
  historicalReadCeilingPreserved: Type.Literal(false),
  revoked: Type.Literal(true)
});
const StayChangeResultSchema = strictObject({
  orderId: Id,
  stayId: Id,
  amendmentId: Id,
  staySegmentId: Id,
  pricingRevisionId: Id,
  effectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  before: strictObject({
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1, maximum: 366 }),
    currentContractAmount: Money,
    stayTimeline: StayTimelineSchema
  }),
  after: strictObject({
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1, maximum: 366 }),
    stayTimeline: StayTimelineSchema,
    pricing: PricingResultSchema
  }),
  pricingDecision: CreateOrderPricingDecisionSchema,
  inventoryChange: StayChangeDateDiffSchema,
  entitlementChange: StayChangeEntitlementDiffSchema,
  fundsSummary: StayChangeFundsSummarySchema,
  ...TemporaryOtherRoomLifecycleEvidenceFields
});
const ShortenStayResultSchema = strictObject({
  orderId: Id,
  stayId: Id,
  arrangementAmendmentId: Id,
  checkoutAmendmentId: nullable(Id),
  staySegmentId: Id,
  pricingRevisionId: Id,
  effectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
  completionMode: Type.Union([Type.Literal("SHORTEN_IN_HOUSE"), Type.Literal("EARLY_CHECK_OUT")]),
  businessDate: LocalDate,
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  before: strictObject({
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1, maximum: 366 }),
    currentContractAmount: Money,
    stayTimeline: StayTimelineSchema
  }),
  after: strictObject({
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1, maximum: 366 }),
    stayTimeline: StayTimelineSchema,
    pricing: PricingResultSchema
  }),
  pricingDecision: CreateOrderPricingDecisionSchema,
  inventoryChange: StayChangeDateDiffSchema,
  entitlementSummary: ShortenStayEntitlementSummarySchema,
  fundsSummary: ShortenStayFundsSummarySchema,
  refundReferenceAmount: NonNegativeMoney,
  fulfillmentTiming: nullable(strictObject({
    effectiveDate: LocalDate,
    recordedBusinessDate: LocalDate,
    recordingMode: Type.Literal("ON_SCHEDULE")
  })),
  ...TemporaryOtherRoomLifecycleEvidenceFields
});
const MoveUnitResultSchema = strictObject({
  orderId: Id,
  stayId: Id,
  amendmentId: Id,
  staySegmentId: Id,
  pricingRevisionId: Id,
  effectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
  businessDate: LocalDate,
  effectiveDate: LocalDate,
  before: MoveUnitBeforeSchema,
  after: MoveUnitAfterSchema,
  pricingDecision: CreateOrderPricingDecisionSchema,
  inventoryChange: MoveUnitInventoryChangeSchema,
  entitlementSummary: MoveUnitEntitlementSummarySchema,
  fundsSummary: MoveUnitFundsSummarySchema
});
const LegacyStayChangeResultSchema = strictObject({
  orderId: Id,
  stayId: Id,
  amendmentId: Id,
  staySegmentId: Id,
  pricingRevisionId: Id,
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  before: strictObject({
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1, maximum: 366 }),
    currentContractAmount: Money
  }),
  after: strictObject({
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1, maximum: 366 }),
    stayTimeline: StayTimelineSchema,
    pricing: PricingResultSchema
  }),
  pricingDecision: CreateOrderPricingDecisionSchema,
  inventoryChange: StayChangeDateDiffSchema,
  entitlementChange: StayChangeEntitlementDiffSchema,
  fundsSummary: StayChangeFundsSummarySchema
});
const LegacyShortenStayResultSchema = strictObject({
  orderId: Id,
  stayId: Id,
  arrangementAmendmentId: Id,
  checkoutAmendmentId: nullable(Id),
  staySegmentId: Id,
  pricingRevisionId: Id,
  completionMode: Type.Union([Type.Literal("SHORTEN_IN_HOUSE"), Type.Literal("EARLY_CHECK_OUT")]),
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  before: strictObject({
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1, maximum: 366 }),
    currentContractAmount: Money
  }),
  after: strictObject({
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1, maximum: 366 }),
    stayTimeline: StayTimelineSchema,
    pricing: PricingResultSchema
  }),
  pricingDecision: CreateOrderPricingDecisionSchema,
  inventoryChange: StayChangeDateDiffSchema,
  entitlementSummary: LegacyShortenStayEntitlementSummarySchema,
  fundsSummary: ShortenStayFundsSummarySchema,
  refundReferenceAmount: NonNegativeMoney,
  fulfillmentTiming: nullable(strictObject({
    effectiveDate: LocalDate,
    recordedBusinessDate: LocalDate,
    recordingMode: Type.Literal("ON_SCHEDULE")
  }))
});
const LegacyMoveUnitResultSchema = strictObject({
  orderId: Id,
  amendmentId: Id,
  staySegmentId: Id,
  pricingRevisionId: Id
});
const PreInHouseMembershipShortenStayResultSchema = strictObject({
  orderId: Id,
  stayId: Id,
  arrangementAmendmentId: Id,
  checkoutAmendmentId: nullable(Id),
  staySegmentId: Id,
  pricingRevisionId: Id,
  effectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
  completionMode: Type.Union([Type.Literal("SHORTEN_IN_HOUSE"), Type.Literal("EARLY_CHECK_OUT")]),
  businessDate: LocalDate,
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  before: strictObject({
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1, maximum: 366 }),
    currentContractAmount: Money,
    stayTimeline: StayTimelineSchema
  }),
  after: strictObject({
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    nights: Type.Integer({ minimum: 1, maximum: 366 }),
    stayTimeline: StayTimelineSchema,
    pricing: PricingResultSchema
  }),
  pricingDecision: CreateOrderPricingDecisionSchema,
  inventoryChange: StayChangeDateDiffSchema,
  entitlementSummary: LegacyShortenStayEntitlementSummarySchema,
  fundsSummary: ShortenStayFundsSummarySchema,
  refundReferenceAmount: NonNegativeMoney,
  fulfillmentTiming: nullable(strictObject({
    effectiveDate: LocalDate,
    recordedBusinessDate: LocalDate,
    recordingMode: Type.Literal("ON_SCHEDULE")
  }))
});
const PreInHouseMembershipMoveUnitResultSchema = strictObject({
  orderId: Id,
  stayId: Id,
  amendmentId: Id,
  staySegmentId: Id,
  pricingRevisionId: Id,
  effectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
  businessDate: LocalDate,
  effectiveDate: LocalDate,
  before: MoveUnitBeforeSchema,
  after: MoveUnitAfterSchema,
  pricingDecision: CreateOrderPricingDecisionSchema,
  inventoryChange: MoveUnitInventoryChangeSchema,
  entitlementSummary: PreInHouseMembershipMoveUnitEntitlementSummarySchema,
  fundsSummary: MoveUnitFundsSummarySchema
});
const RepriceResultSchema = strictObject({
  orderId: Id, amendmentId: Id, pricingRevisionId: Id,
  policyBaseAmount: Money,
  targetCurrentContractAmount: Money,
  manualAdjustmentMinor: SafeInteger
});
const CoverageRefreshResultSchema = strictObject({ orderId: Id, amendmentId: Id, pricingRevisionId: Id });
const CollectionFactResultSchema = strictObject({
  orderId: Id,
  factId: Id,
  factType: Type.Union([Type.Literal("COLLECTION"), Type.Literal("REFUND"), Type.Literal("REVERSAL")]),
  netEffectMinor: SafeInteger,
  transactionReference: nullable(ShortText),
  refundReference: Type.Optional(ShortText)
});
const OrderStatusResultSchema = strictObject({
  orderId: Id,
  amendmentId: Id,
  status: OrderStatusSchema,
  pricingRevisionId: Type.Optional(Id),
  effectHash: Type.Optional(Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" })),
  cleaningTaskId: Type.Optional(Id),
  fulfillmentTiming: Type.Optional(strictObject({
    effectiveDate: LocalDate,
    recordedBusinessDate: LocalDate,
    recordingMode: Type.Union([Type.Literal("ON_SCHEDULE"), Type.Literal("LATE_RECORDED")])
  })),
  entitlementTransition: Type.Optional(strictObject({
    from: Type.Union([Type.Literal("HELD"), Type.Literal("CONSUMED")]),
    to: Type.Union([Type.Literal("CONSUMED"), Type.Literal("RELEASED"), Type.Literal("RESTORED")]),
    coverageCount: Type.Integer({ minimum: 0 })
  })),
  ...TemporaryOtherRoomLifecycleEvidenceFields
});
const PreviewReceiptResultSchema = strictObject({ preview: PreviewSchema });
const QuoteReceiptResultSchema = strictObject({ quote: QuoteSchema });
const BackfillCompletedStayResultSchema = strictObject({
  orderId: Id,
  stayId: Id,
  checkInAmendmentId: Id,
  checkOutAmendmentId: Id,
  collectionFactId: nullable(Id),
  status: Type.Literal("CHECKED_OUT"),
  settlementStatus: Type.Union([Type.Literal("SETTLED"), Type.Literal("ARREARS")]),
  fulfillmentTiming: strictObject({
    effectiveDate: LocalDate,
    recordedBusinessDate: LocalDate,
    recordingMode: Type.Union([Type.Literal("ON_SCHEDULE"), Type.Literal("LATE_RECORDED")])
  })
});
export const CompleteStayResultSchema = strictObject({
  orderId: Id,
  stayId: Id,
  checkInAmendmentId: Id,
  checkOutAmendmentId: Id,
  collectionFactId: nullable(Id),
  releasedClaimIds: Type.Array(Id, { minItems: 1 }),
  consumedCoverageIds: Type.Array(Id),
  status: Type.Literal("CHECKED_OUT"),
  settlementStatus: Type.Union([Type.Literal("SETTLED"), Type.Literal("ARREARS")]),
  fulfillmentTiming: strictObject({
    effectiveDate: LocalDate,
    recordedBusinessDate: LocalDate,
    recordingMode: Type.Union([Type.Literal("ON_SCHEDULE"), Type.Literal("LATE_RECORDED")])
  }),
  effectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
  ...TemporaryOtherRoomLifecycleEvidenceFields
});
const MembershipOrderCreatedResultSchema = strictObject({
  membershipOrderId: Id,
  status: Type.Literal("DRAFT")
});
const MembershipPaymentRecordedResultSchema = strictObject({
  membershipOrderId: Id,
  paymentFactId: Id,
  status: Type.Union([Type.Literal("DRAFT"), Type.Literal("ACTIVE")])
});
const MembershipPaymentCorrectedResultSchema = strictObject({
  membershipOrderId: Id,
  originalPaymentFactId: Id,
  reversalFactId: Id,
  replacementFactId: Id,
  status: Type.Literal("DRAFT")
});
const MembershipOrderActivatedResultSchema = strictObject({
  membershipOrderId: Id,
  status: Type.Literal("ACTIVE"),
  contractId: Id,
  entitlementLotId: Id,
  validFrom: LocalDate,
  validUntil: LocalDate,
  entitlementUnits: Type.Integer({ minimum: 1 })
});
const StayCollectionMembershipConversionResultSchema = strictObject({
  orderId: Id,
  memberId: Id,
  amendmentId: Id,
  pricingRevisionId: Id,
  membershipOrderId: Id,
  status: Type.Literal("ACTIVE"),
  contractId: Id,
  entitlementLotId: Id,
  transferredCollectionFactIds: Type.Array(Id),
  lodgingReversalFactIds: Type.Array(Id),
  membershipPaymentFactIds: Type.Array(Id),
  transferIds: Type.Array(Id),
  conversionMode: Type.Union([Type.Literal("IN_HOUSE"), Type.Literal("COMPLETED")]),
  conversionCoverageIds: Type.Array(Id),
  conversionLedgerFactIds: Type.Array(Id, { minItems: 1 }),
  transferredAmount: Money,
  membershipAgreedPrice: Money,
  remainingPaymentAmount: NonNegativeMoney,
  entitlementUnitKind: Type.Union([Type.Literal("ROOM_NIGHT"), Type.Literal("BED_NIGHT")]),
  convertedUnits: Type.Integer({ minimum: 1 }),
  remainingUnits: Type.Integer({ minimum: 0 }),
  effectHash: Type.Optional(Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }))
});
const AdminCorrectionReceiptActorSchema = strictObject({
  subjectId: Id,
  displayName: ShortText
});
const AdminCorrectionReceiptAuditFields = {
  reason: CommandReasonSchema,
  evidenceNote: Note,
  actor: AdminCorrectionReceiptActorSchema,
  recordedAt: DateTime
};
const HistoricalStayArrangementCorrectionResultSchema = strictObject({
  operation: Type.Literal("CORRECT_HISTORICAL_STAY_ARRANGEMENTS"),
  correctionSetHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  corrections: Type.Array(strictObject({
    orderId: Id,
    stayId: Id,
    correctionId: Id,
    amendmentId: Id,
    staySegmentId: Id,
    pricingRevisionId: Id,
    claimIds: Type.Array(Id),
    before: HistoricalStayArrangementSnapshotSchema,
    after: HistoricalStayArrangementSnapshotSchema,
    unchanged: HistoricalStayArrangementUnchangedSchema
  }), { minItems: 1, maxItems: 100 }),
  reason: CommandReasonSchema,
  evidenceNote: Type.Optional(Note),
  actor: AdminCorrectionReceiptActorSchema,
  recordedAt: DateTime,
  effectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" })
});
const MemberProfileCorrectedResultSchema = strictObject({
  memberId: Id,
  correctionId: Id,
  changedFields: Type.Array(AdminMemberProfileChangedFieldSchema, { minItems: 1, maxItems: 5, uniqueItems: true }),
  before: MemberProfileCorrectionSnapshotSchema,
  after: MemberProfileCorrectionSnapshotSchema,
  ...AdminCorrectionReceiptAuditFields,
  effectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" })
});
const MembershipEffectiveDateCorrectedResultSchema = strictObject({
  memberId: Id,
  membershipOrderId: Id,
  contractId: Id,
  entitlementLotId: Id,
  correctionId: Id,
  validFrom: LocalDate,
  validUntil: LocalDate,
  status: Type.Literal("ACTIVE"),
  before: strictObject({
    validFrom: LocalDate,
    validUntil: LocalDate,
    status: Type.Literal("ACTIVE")
  }),
  after: strictObject({
    validFrom: LocalDate,
    validUntil: LocalDate,
    status: Type.Literal("ACTIVE")
  }),
  unchanged: strictObject({
    memberId: Id,
    productName: ShortText,
    agreedPrice: Money,
    entitlementUnitKind: EntitlementUnitKindSchema,
    entitlementUnits: Type.Integer({ minimum: 1 }),
    usedUnits: Type.Integer({ minimum: 0 }),
    availableBalance: strictObject({
      ROOM_NIGHT: Type.Integer({ minimum: 0 }),
      BED_NIGHT: Type.Integer({ minimum: 0 })
    }),
    paymentFactCount: Type.Integer({ minimum: 0 }),
    lifecycleStatus: Type.Literal("ACTIVE")
  }),
  ...AdminCorrectionReceiptAuditFields,
  effectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" })
});
const HistoricalMembershipBackfilledResultSchema = strictObject({
  memberId: Id,
  membershipOrderId: Id,
  paymentFactId: Id,
  contractId: Id,
  entitlementLotId: Id,
  backfillId: Id,
  status: Type.Literal("ACTIVE"),
  validFrom: LocalDate,
  validUntil: LocalDate,
  entitlementUnitKind: EntitlementUnitKindSchema,
  entitlementUnits: Type.Integer({ minimum: 1 }),
  member: strictObject({ memberId: Id, fullName: ShortText }),
  product: AdminMembershipProductEffectSchema,
  payment: strictObject({
    amount: Money,
    businessDate: LocalDate,
    transactionReference: ShortText,
    note: Type.Optional(OptionalNote)
  }),
  ...AdminCorrectionReceiptAuditFields,
  effectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" })
});
const MembershipVoidReconvertedResultSchema = strictObject({
  memberId: Id,
  voidReconversionId: Id,
  member: strictObject({ memberId: Id, fullName: ShortText }),
  oldMembership: strictObject({
    membershipOrderId: Id,
    contractId: Id,
    entitlementLotId: Id,
    productId: Id,
    status: Type.Literal("ACTIVE"),
    directCollections: Type.Array(AdminMembershipDirectCollectionSchema, { minItems: 1 })
  }),
  oldMembershipOrderId: Id,
  oldContractId: Id,
  oldEntitlementLotId: Id,
  oldStatus: Type.Literal("VOIDED"),
  sourceStayOrderId: Id,
  sourceStayId: Id,
  sourceStay: strictObject({
    orderId: Id,
    stayId: Id,
    arrivalDate: LocalDate,
    departureDate: LocalDate,
    serviceDates: Type.Array(LocalDate, { minItems: 1 }),
    identityEvidence: AdminMembershipSourceIdentityEvidenceSchema
  }),
  amendmentId: Id,
  pricingRevisionId: Id,
  membershipOrderId: Id,
  status: Type.Literal("ACTIVE"),
  contractId: Id,
  entitlementLotId: Id,
  oldDirectCollectionTotal: Money,
  transferredAmount: Money,
  replacementDirectPaymentAmount: NonNegativeMoney,
  membershipAgreedPrice: Money,
  funds: strictObject({
    oldDirectCollectionTotal: Money,
    oldReversalTotal: Money,
    stayTransferTotal: Money,
    replacementDirectPayment: nullable(strictObject({
      amount: Money,
      businessDate: LocalDate,
      transactionReference: ShortText
    })),
    membershipAgreedPrice: Money,
    reclassificationOnly: Type.Literal(true)
  }),
  validFrom: LocalDate,
  validUntil: LocalDate,
  newMembership: strictObject({
    productId: Id,
    productName: ShortText,
    validFrom: LocalDate,
    validUntil: LocalDate,
    membershipOrderId: Id,
    contractId: Id,
    entitlementLotId: Id
  }),
  entitlementUnitKind: EntitlementUnitKindSchema,
  convertedUnits: Type.Integer({ minimum: 1 }),
  remainingUnits: Type.Integer({ minimum: 0 }),
  entitlement: strictObject({
    unitKind: EntitlementUnitKindSchema,
    totalUnits: Type.Integer({ minimum: 1 }),
    consumedUnits: Type.Integer({ minimum: 1 }),
    remainingUnits: Type.Integer({ minimum: 0 }),
    serviceDates: Type.Array(LocalDate, { minItems: 1 })
  }),
  serviceDates: Type.Array(LocalDate, { minItems: 1 }),
  sourceCollectionFactIds: Type.Array(Id, { minItems: 1 }),
  oldPaymentReversalFactIds: Type.Array(Id, { minItems: 1 }),
  paymentReclassificationFactIds: Type.Array(Id, { minItems: 1 }),
  sourceReversalFactIds: Type.Array(Id, { minItems: 1 }),
  transferPaymentFactIds: Type.Array(Id, { minItems: 1 }),
  replacementPaymentFactId: nullable(Id),
  transferIds: Type.Array(Id, { minItems: 1 }),
  voidLedgerFactId: Id,
  conversionLedgerFactIds: Type.Array(Id, { minItems: 1 }),
  ...AdminCorrectionReceiptAuditFields,
  effectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" })
});

export const ExecutedCommandResultSchema = Type.Union([
  RoomCatalogResultSchema,
  strictObject({ operation: Type.Literal("MANAGE_ORDER_OCCUPANTS"),
    ...TemporaryOtherRoomLifecycleEvidenceFields,
    action: Type.Union([Type.Literal("ADD"), Type.Literal("REMOVE")]),
    orderId: Id, occupantId: Id, ordinal: Type.Integer({ minimum: 2 }),
    guest: OrderOccupantPriorSnapshotSchema, arrivalDate: LocalDate, departureDate: LocalDate,
    beforeCount: Type.Integer({ minimum: 1 }), afterCount: Type.Integer({ minimum: 1 }),
    occupancyCapacity: Type.Integer({ minimum: 1 }), amendmentId: Id, removalId: nullable(Id),
    effectHash: Type.String({ pattern: "^[a-f0-9]{64}$" }) }),
  strictObject({ ...RevokeCheckOutEffectSchema.properties, stayId: Id, amendmentId: Id,
    staySegmentId: Id, pricingRevisionId: Id, status: Type.Literal("CHECKED_IN"),
    effectHash: Type.String({ pattern: "^[a-f0-9]{64}$" }) }),
  QuoteReceiptResultSchema,
  CreateMemberResultSchema,
  MembershipOrderCreatedResultSchema,
  MembershipPaymentRecordedResultSchema,
  MembershipPaymentCorrectedResultSchema,
  MembershipOrderActivatedResultSchema,
  StayCollectionMembershipConversionResultSchema,
  HistoricalStayArrangementCorrectionResultSchema,
  MemberProfileCorrectedResultSchema,
  MembershipEffectiveDateCorrectedResultSchema,
  HistoricalMembershipBackfilledResultSchema,
  MembershipVoidReconvertedResultSchema,
  CreateOrderResultSchema,
  CorrectOrderOccupantResultSchema,
  MaintenanceLockResultSchema,
  MaintenanceReleaseResultSchema,
  InternalUsePlacementResultSchema,
  InternalUseReleaseResultSchema,
  CleaningCompletionResultSchema,
  EntitlementAdjustmentResultSchema,
  EntitlementLotAddedResultSchema,
  EntitlementExpirationResultSchema,
  TokenIssueResultSchema,
  TokenRotationResultSchema,
  TokenRevocationResultSchema,
  StayChangeResultSchema,
  ShortenStayResultSchema,
  MoveUnitResultSchema,
  RepriceResultSchema,
  CoverageRefreshResultSchema,
  CollectionFactResultSchema,
  OrderStatusResultSchema,
  BackfillCompletedStayResultSchema,
  CompleteStayResultSchema,
  PreviewReceiptResultSchema
]);

export const ReceiptSchema = strictObject({
  receiptId: Id,
  commandId: Id,
  executionStatus: Type.Union([Type.Literal("EXECUTED"), Type.Literal("NOT_EXECUTED"), Type.Literal("UNKNOWN")]),
  businessCommitted: Type.Boolean(),
  correlationId: Type.String({ minLength: 1, maxLength: 160 }),
  result: Type.Optional(ExecutedCommandResultSchema),
  error: Type.Optional(ErrorResponse),
  resourceRefs: Type.Array(Id),
  factRefs: Type.Array(Id),
  committedAt: Type.Optional(DateTime)
});

const HistoricalReadOnlyMetadata = {
  recoveryMode: Type.Literal("HISTORICAL_READ_ONLY")
} as const;
const LegacyStayChangePreviewSchema = strictObject({
  previewId: Id,
  commandType: Type.Union([Type.Literal("RESCHEDULE_STAY"), Type.Literal("EXTEND_STAY")]),
  effectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
  effect: LegacyStayChangeEffectSchema,
  expiresAt: DateTime
});
const LegacyShortenStayPreviewSchema = strictObject({
  previewId: Id,
  commandType: Type.Literal("SHORTEN_STAY"),
  effectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
  effect: LegacyShortenStayEffectSchema,
  expiresAt: DateTime
});
const LegacyMoveUnitPreviewSchema = strictObject({
  previewId: Id,
  commandType: Type.Literal("MOVE_UNIT"),
  effectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
  effect: LegacyMoveUnitEffectSchema,
  expiresAt: DateTime
});
const PreInHouseMembershipShortenStayPreviewSchema = strictObject({
  previewId: Id,
  commandType: Type.Literal("SHORTEN_STAY"),
  effectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
  effect: PreInHouseMembershipShortenStayEffectSchema,
  expiresAt: DateTime
});
const PreInHouseMembershipMoveUnitPreviewSchema = strictObject({
  previewId: Id,
  commandType: Type.Literal("MOVE_UNIT"),
  effectHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
  effect: PreInHouseMembershipMoveUnitEffectSchema,
  expiresAt: DateTime
});
const LegacyPreviewReceiptStayChangeResultSchema = strictObject({ preview: LegacyStayChangePreviewSchema });
const LegacyPreviewReceiptShortenResultSchema = strictObject({ preview: LegacyShortenStayPreviewSchema });
const LegacyPreviewReceiptMoveResultSchema = strictObject({ preview: LegacyMoveUnitPreviewSchema });
const PreInHouseMembershipPreviewReceiptShortenResultSchema = strictObject({
  preview: PreInHouseMembershipShortenStayPreviewSchema
});
const PreInHouseMembershipPreviewReceiptMoveResultSchema = strictObject({
  preview: PreInHouseMembershipMoveUnitPreviewSchema
});
const HistoricalExecutedReceiptBase = {
  receiptId: Id,
  commandId: Id,
  executionStatus: Type.Literal("EXECUTED"),
  businessCommitted: Type.Literal(true),
  correlationId: Type.String({ minLength: 1, maxLength: 160 }),
  resourceRefs: Type.Array(Id),
  factRefs: Type.Array(Id),
  committedAt: Type.Optional(DateTime),
  ...HistoricalReadOnlyMetadata
} as const;
const HistoricalStayChangeReceiptReadSchema = strictObject({
  ...HistoricalExecutedReceiptBase,
  protocolVersion: Type.Literal("LEGACY_STAGE_9_10"),
  result: Type.Union([LegacyStayChangeResultSchema, LegacyPreviewReceiptStayChangeResultSchema])
});
const HistoricalShortenReceiptReadSchema = strictObject({
  ...HistoricalExecutedReceiptBase,
  protocolVersion: Type.Literal("LEGACY_STAGE_10"),
  result: Type.Union([LegacyShortenStayResultSchema, LegacyPreviewReceiptShortenResultSchema])
});
const HistoricalMoveReceiptReadSchema = strictObject({
  ...HistoricalExecutedReceiptBase,
  protocolVersion: Type.Literal("PRE_STAGE_11"),
  result: Type.Union([LegacyMoveUnitResultSchema, LegacyPreviewReceiptMoveResultSchema])
});
const PreInHouseMembershipShortenReceiptReadSchema = strictObject({
  ...HistoricalExecutedReceiptBase,
  protocolVersion: Type.Literal("PRE_INHOUSE_MEMBERSHIP_FULFILLMENT"),
  result: Type.Union([
    PreInHouseMembershipShortenStayResultSchema,
    PreInHouseMembershipPreviewReceiptShortenResultSchema
  ])
});
const PreInHouseMembershipMoveReceiptReadSchema = strictObject({
  ...HistoricalExecutedReceiptBase,
  protocolVersion: Type.Literal("PRE_INHOUSE_MEMBERSHIP_FULFILLMENT"),
  result: Type.Union([
    PreInHouseMembershipMoveUnitResultSchema,
    PreInHouseMembershipPreviewReceiptMoveResultSchema
  ])
});
const PreInHouseMembershipConversionReceiptReadSchema = strictObject({
  ...HistoricalExecutedReceiptBase,
  protocolVersion: Type.Literal("PRE_INHOUSE_MEMBERSHIP_FULFILLMENT"),
  result: StayCollectionMembershipConversionResultSchema
});
export const HistoricalReceiptReadSchema = Type.Union([
  ReceiptSchema,
  HistoricalStayChangeReceiptReadSchema,
  HistoricalShortenReceiptReadSchema,
  HistoricalMoveReceiptReadSchema,
  PreInHouseMembershipShortenReceiptReadSchema,
  PreInHouseMembershipMoveReceiptReadSchema,
  PreInHouseMembershipConversionReceiptReadSchema
]);

const CurrentCommandPreviewResponseSchema = strictObject({
  preview: PreviewSchema,
  receipt: ReceiptSchema
});
const HistoricalStayChangePreviewReceiptReadSchema = strictObject({
  ...HistoricalExecutedReceiptBase,
  protocolVersion: Type.Literal("LEGACY_STAGE_9_10"),
  result: LegacyPreviewReceiptStayChangeResultSchema
});
const HistoricalShortenPreviewReceiptReadSchema = strictObject({
  ...HistoricalExecutedReceiptBase,
  protocolVersion: Type.Literal("LEGACY_STAGE_10"),
  result: LegacyPreviewReceiptShortenResultSchema
});
const HistoricalMovePreviewReceiptReadSchema = strictObject({
  ...HistoricalExecutedReceiptBase,
  protocolVersion: Type.Literal("PRE_STAGE_11"),
  result: LegacyPreviewReceiptMoveResultSchema
});
const PreInHouseMembershipShortenPreviewReceiptReadSchema = strictObject({
  ...HistoricalExecutedReceiptBase,
  protocolVersion: Type.Literal("PRE_INHOUSE_MEMBERSHIP_FULFILLMENT"),
  result: PreInHouseMembershipPreviewReceiptShortenResultSchema
});
const PreInHouseMembershipMovePreviewReceiptReadSchema = strictObject({
  ...HistoricalExecutedReceiptBase,
  protocolVersion: Type.Literal("PRE_INHOUSE_MEMBERSHIP_FULFILLMENT"),
  result: PreInHouseMembershipPreviewReceiptMoveResultSchema
});
export const HistoricalCommandPreviewResponseSchema = Type.Union([
  CurrentCommandPreviewResponseSchema,
  strictObject({
    preview: LegacyStayChangePreviewSchema,
    receipt: HistoricalStayChangePreviewReceiptReadSchema
  }),
  strictObject({
    preview: LegacyShortenStayPreviewSchema,
    receipt: HistoricalShortenPreviewReceiptReadSchema
  }),
  strictObject({
    preview: LegacyMoveUnitPreviewSchema,
    receipt: HistoricalMovePreviewReceiptReadSchema
  }),
  strictObject({
    preview: PreInHouseMembershipShortenStayPreviewSchema,
    receipt: PreInHouseMembershipShortenPreviewReceiptReadSchema
  }),
  strictObject({
    preview: PreInHouseMembershipMoveUnitPreviewSchema,
    receipt: PreInHouseMembershipMovePreviewReceiptReadSchema
  })
]);

export const QuoteCommandResponseSchema = strictObject({
  quote: QuoteSchema,
  receipt: ReceiptSchema
});

export const CommandResultRecoverySchema = Type.Union([
  ReceiptSchema,
  strictObject({
    executionStatus: Type.Literal("UNKNOWN"),
    businessCommitted: Type.Literal(false),
    commandId: Type.Optional(Id),
    correlationId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 }))
  })
]);

export const HistoricalCommandResultRecoverySchema = Type.Union([
  HistoricalReceiptReadSchema,
  strictObject({
    executionStatus: Type.Literal("UNKNOWN"),
    businessCommitted: Type.Literal(false),
    commandId: Type.Optional(Id),
    correlationId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 }))
  })
]);

export const ResolveCommandResultSchema = strictObject({
  propertyId: Id,
  commandType: HistoricalRecoverableCommandTypeSchema,
  idempotencyKey: Type.String({ minLength: 1, maxLength: 160 })
});

export const AvailabilityUnitSchema = strictObject({
  id: Id,
  propertyId: Id,
  kind: InventoryUnitKindSchema,
  roomId: Id,
  code: Type.String({ minLength: 1, maxLength: 120 }),
  name: Type.String({ minLength: 1, maxLength: 240 }),
  catalogVersion: nullable(ShortText),
  buildingCode: nullable(ShortText),
  roomTypeCode: nullable(ShortText),
  pricingProductCode: nullable(ShortText),
  inventoryBasis: nullable(Type.Union([Type.Literal("INDEPENDENT"), Type.Literal("WHOLE_ROOM_COMBINATION")])),
  codeProvenance: nullable(Type.Union([Type.Literal("SOURCE_EXPLICIT"), Type.Literal("USER_CONFIRMED_RENAMED"), Type.Literal("PMS_GENERATED")])),
  physicalBedCount: nullable(Type.Integer({ minimum: 1, maximum: 4 })),
  occupancyCapacity: Type.Integer({ minimum: 1, maximum: 1000 }),
  nights: Type.Array(strictObject({
    serviceDate: LocalDate,
    available: Type.Boolean(),
    blockingClaimIds: Type.Array(Id)
  })),
  available: Type.Boolean()
});

export const RoomStatusStatusSchema = Type.Union(roomStatusStatuses.map((status) => Type.Literal(status)));
export const RoomStatusAttentionSchema = Type.Union(roomStatusAttentionCodes.map((attention) => Type.Literal(attention)));
export const RoomStatusOperationalAttentionSchema = Type.Union(
  roomStatusOperationalAttentionCodes.map((attention) => Type.Literal(attention))
);
export const RoomStatusSourceKindSchema = Type.Union(roomStatusSourceKinds.map((kind) => Type.Literal(kind)));
export const RoomStatusSourceCategorySchema = Type.Union(roomStatusSourceCategories.map((category) => Type.Literal(category)));
export const RoomStatusActionCodeSchema = Type.Union(roomStatusActionCodes.map((code) => Type.Literal(code)));
export const RoomStatusOperationalTaskKindSchema = Type.Union(roomStatusOperationalTaskKinds.map((kind) => Type.Literal(kind)));
export const RoomStatusSalesModeSchema = Type.Union([
  Type.Literal("WHOLE_ROOM"), Type.Literal("BED_SPLIT"), Type.Literal("UNAVAILABLE")
]);
export const RoomStatusQuerySchema = strictObject({
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  page: Type.Optional(Type.Integer({ minimum: 0 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  search: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  roomType: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  salesMode: Type.Optional(RoomStatusSalesModeSchema),
  status: Type.Optional(RoomStatusStatusSchema),
  minCapacity: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  unitKind: Type.Optional(InventoryUnitKindSchema)
});
const RoomStatusDisplayText = Type.String({ minLength: 1 });
export const RoomStatusReferenceSchema = strictObject({
  type: Type.Union([
    Type.Literal("CLAIM"), Type.Literal("ORDER"), Type.Literal("STAY"), Type.Literal("OPERATIONS"),
    Type.Literal("BLOCK"), Type.Literal("INVENTORY_UNIT"), Type.Literal("RECEIPT")
  ]),
  id: Id,
  label: RoomStatusDisplayText,
  href: nullable(Type.String({ minLength: 1, maxLength: 500 }))
});
export const RoomStatusActionSchema = strictObject({
  code: RoomStatusActionCodeSchema,
  enabled: Type.Boolean(),
  disabledReason: nullable(Type.String({ minLength: 1, maxLength: 1000 })),
  requiresFullInterval: Type.Boolean(),
  targetReference: nullable(RoomStatusReferenceSchema)
});
export const RoomStatusHistorySchema = strictObject({
  action: Type.String({ minLength: 1, maxLength: 200 }),
  actorId: nullable(Id),
  source: Type.Union([Type.Literal("WEB_SESSION"), Type.Literal("API_TOKEN"), Type.Literal("SYSTEM"), Type.Literal("UNKNOWN")]),
  occurredAt: DateTime,
  commandId: nullable(Id),
  receiptId: nullable(Id),
  correlationId: nullable(Type.String({ minLength: 1, maxLength: 160 }))
});
export const RoomStatusConflictSchema = strictObject({
  id: Id,
  blockingFactKind: Type.Union(roomStatusBlockingFactKinds.map((kind) => Type.Literal(kind))),
  claimId: nullable(Id),
  claimIds: Type.Array(Id),
  requestedInventoryUnitId: Id,
  actualInventoryUnitId: Id,
  roomId: Id,
  startDate: LocalDate,
  endDate: LocalDate,
  sourceKind: RoomStatusSourceKindSchema,
  sourceReference: RoomStatusReferenceSchema,
  reason: RoomStatusDisplayText,
  blocking: Type.Literal(true)
});
export const RoomStatusOccupantSchema = strictObject({
  occupantId: Id,
  nickname: nullable(RoomStatusDisplayText)
});
export const RoomStatusIntervalSchema = Type.Object({
  id: Id,
  displayInventoryUnitId: Id,
  actualInventoryUnitId: Id,
  roomId: Id,
  startDate: LocalDate,
  endDate: LocalDate,
  sourceStartDate: LocalDate,
  sourceEndDate: LocalDate,
  orderArrivalDate: Type.Optional(LocalDate),
  orderDepartureDate: Type.Optional(LocalDate),
  status: RoomStatusStatusSchema,
  attention: nullable(RoomStatusAttentionSchema),
  operationalAttention: nullable(RoomStatusOperationalAttentionSchema),
  available: Type.Boolean(),
  blocking: Type.Boolean(),
  sourceKind: RoomStatusSourceKindSchema,
  sourceCategory: nullable(RoomStatusSourceCategorySchema),
  freeStayCategoryCode: nullable(FreeStayCategoryCodeSchema),
  freeStayReason: nullable(RoomStatusDisplayText),
  label: RoomStatusDisplayText,
  primaryOccupantLabel: nullable(ShortText),
  occupantCount: Type.Integer({ minimum: 0, maximum: 1000 }),
  occupants: Type.Array(RoomStatusOccupantSchema, { maxItems: 1000 }),
  reason: nullable(RoomStatusDisplayText),
  claimIds: Type.Array(Id),
  references: Type.Array(RoomStatusReferenceSchema),
  conflicts: Type.Array(RoomStatusConflictSchema),
  history: Type.Array(RoomStatusHistorySchema),
  allowedActions: Type.Array(RoomStatusActionSchema)
}, {
  additionalProperties: false,
  dependentRequired: {
    orderArrivalDate: ["orderDepartureDate"],
    orderDepartureDate: ["orderArrivalDate"]
  }
});
export const RoomStatusOperationalTaskSchema = Type.Object({
  taskKind: RoomStatusOperationalTaskKindSchema,
  businessDate: LocalDate,
  id: Id,
  displayInventoryUnitId: Id,
  actualInventoryUnitId: Id,
  roomId: Id,
  startDate: LocalDate,
  endDate: LocalDate,
  sourceStartDate: LocalDate,
  sourceEndDate: LocalDate,
  orderArrivalDate: Type.Optional(LocalDate),
  orderDepartureDate: Type.Optional(LocalDate),
  status: RoomStatusStatusSchema,
  attention: nullable(RoomStatusAttentionSchema),
  operationalAttention: nullable(RoomStatusOperationalAttentionSchema),
  available: Type.Boolean(),
  blocking: Type.Boolean(),
  sourceKind: RoomStatusSourceKindSchema,
  sourceCategory: nullable(RoomStatusSourceCategorySchema),
  freeStayCategoryCode: nullable(FreeStayCategoryCodeSchema),
  freeStayReason: nullable(RoomStatusDisplayText),
  label: RoomStatusDisplayText,
  primaryOccupantLabel: nullable(ShortText),
  occupantCount: Type.Integer({ minimum: 0, maximum: 1000 }),
  occupants: Type.Array(RoomStatusOccupantSchema, { maxItems: 1000 }),
  reason: nullable(RoomStatusDisplayText),
  claimIds: Type.Array(Id),
  references: Type.Array(RoomStatusReferenceSchema),
  conflicts: Type.Array(RoomStatusConflictSchema),
  history: Type.Array(RoomStatusHistorySchema),
  allowedActions: Type.Array(RoomStatusActionSchema)
}, {
  additionalProperties: false,
  dependentRequired: {
    orderArrivalDate: ["orderDepartureDate"],
    orderDepartureDate: ["orderArrivalDate"]
  }
});
export const RoomStatusDaySchema = strictObject({
  serviceDate: LocalDate,
  status: RoomStatusStatusSchema,
  available: Type.Boolean(),
  intervalIds: Type.Array(Id),
  conflicts: Type.Array(RoomStatusConflictSchema)
});
export const RoomStatusBedOccupantSchema = strictObject({
  occupantId: Id,
  inventoryUnitId: Id,
  inventoryUnitCode: RoomStatusDisplayText,
  primaryOccupantLabel: nullable(ShortText),
  sourceReference: strictObject({
    type: Type.Literal("ORDER"),
    id: Id,
    label: RoomStatusDisplayText,
    href: nullable(Type.String({ minLength: 1, maxLength: 500 }))
  })
});
export const RoomStatusBedOccupancySchema = strictObject({
  serviceDate: LocalDate,
  occupiedBedCount: Type.Integer({ minimum: 1 }),
  totalBedCount: Type.Integer({ minimum: 1 }),
  occupants: Type.Array(RoomStatusBedOccupantSchema, { minItems: 1 })
});
export const RoomStatusBedSlotStateSchema = strictObject({
  serviceDate: LocalDate,
  inventoryUnitId: Id,
  inventoryUnitCode: RoomStatusDisplayText,
  status: RoomStatusStatusSchema
});
export const RoomStatusAvailabilitySummarySchema = strictObject({
  serviceDate: LocalDate,
  availableRooms: Type.Integer({ minimum: 0 }),
  availableBeds: Type.Integer({ minimum: 0 }),
  paidOccupiedUnits: Type.Integer({ minimum: 0 }),
  totalSellableUnits: Type.Integer({ minimum: 0 }),
  occupantCount: Type.Integer({ minimum: 0 })
});
const RoomStatusUnitBase = {
  id: Id,
  propertyId: Id,
  roomId: Id,
  code: RoomStatusDisplayText,
  name: RoomStatusDisplayText,
  active: Type.Boolean(),
  salesMode: RoomStatusSalesModeSchema,
  buildingCode: nullable(ShortText),
  roomTypeCode: nullable(ShortText),
  pricingProductCode: nullable(ShortText),
  physicalBedCount: nullable(Type.Integer({ minimum: 1, maximum: 1000 })),
  capacity: Type.Integer({ minimum: 1 }),
  occupancyCapacity: Type.Integer({ minimum: 1, maximum: 1000 }),
  childUnitIds: Type.Array(Id),
  bedOccupancies: Type.Array(RoomStatusBedOccupancySchema),
  bedSlotStates: Type.Array(RoomStatusBedSlotStateSchema),
  days: Type.Array(RoomStatusDaySchema),
  intervals: Type.Array(RoomStatusIntervalSchema),
  conflicts: Type.Array(RoomStatusConflictSchema),
  allowedActions: Type.Array(RoomStatusActionSchema)
};
const RoomStatusBedUnitSchema = strictObject({
  ...RoomStatusUnitBase,
  parentRoomId: Id,
  kind: Type.Literal("BED"),
  children: Type.Array(Type.Never(), { maxItems: 0 })
});
export const RoomStatusUnitSchema = strictObject({
  ...RoomStatusUnitBase,
  parentRoomId: Type.Null(),
  kind: Type.Literal("ROOM"),
  children: Type.Array(RoomStatusBedUnitSchema)
});
export const RoomStatusBoardSchema = strictObject({
  propertyId: Id,
  businessDate: LocalDate,
  range: strictObject({ arrivalDate: LocalDate, departureDate: LocalDate }),
  dates: Type.Array(LocalDate, { maxItems: ROOM_STATUS_MAX_QUERY_NIGHTS }),
  asOf: DateTime,
  freshUntil: DateTime,
  revision: Type.String({ minLength: 1, maxLength: 80, pattern: "^\\d+$" }),
  accessLevel: AccessLevelSchema,
  projectionState: Type.Union([Type.Literal("READY"), Type.Literal("PARTIAL")]),
  filterOptions: strictObject({
    roomTypeCodes: Type.Array(ShortText),
    salesModes: Type.Array(RoomStatusSalesModeSchema),
    statuses: Type.Array(RoomStatusStatusSchema),
    capacities: Type.Array(Type.Integer({ minimum: 1 })),
    unitKinds: Type.Array(InventoryUnitKindSchema)
  }),
  page: strictObject({
    index: Type.Integer({ minimum: 0 }),
    size: Type.Integer({ minimum: 1, maximum: 200 }),
    totalRooms: Type.Integer({ minimum: 0 }),
    totalPages: Type.Integer({ minimum: 0 })
  }),
  operationalTasks: Type.Array(RoomStatusOperationalTaskSchema, { maxItems: ROOM_STATUS_OPERATIONAL_TASK_LIMIT }),
  availabilitySummary: Type.Array(RoomStatusAvailabilitySummarySchema, { maxItems: ROOM_STATUS_MAX_QUERY_NIGHTS }),
  rooms: Type.Array(RoomStatusUnitSchema)
});

export const LoginSchema = strictObject({
  username: Type.String({ minLength: 1, maxLength: 120 }),
  password: Type.String({ minLength: 1, maxLength: 200 })
});
export const LoginResponseSchema = strictObject({ subjectId: Id, displayName: ShortText, expiresAt: DateTime });
export const MeResponseSchema = strictObject({
  subjectId: Id,
  displayName: ShortText,
  credentialType: Type.Union([Type.Literal("SESSION"), Type.Literal("TOKEN")]),
  propertyAccess: Type.Record(Type.String({ minLength: 3, maxLength: 160 }), AccessLevelSchema),
  propertyCommandGrants: Type.Record(Type.String({ minLength: 3, maxLength: 160 }), Type.Array(CommandGrantSchema, { uniqueItems: true })),
  allowedActions: Type.Record(Type.String({ minLength: 3, maxLength: 160 }), Type.Array(EffectiveCommandCapabilitySchema, { uniqueItems: true }))
});

const PropertyRowSchema = strictObject({
  id: Id, code: ShortText, name: ShortText, timezone: ShortText,
  currency: Type.String({ minLength: 3, maxLength: 3 }), created_at: DateTime
});
const InventoryUnitRowSchema = strictObject({
  id: Id, property_id: Id, kind: InventoryUnitKindSchema, parent_room_id: nullable(Id), code: ShortText,
  name: ShortText, active: Type.Boolean(), catalog_version: nullable(ShortText), building_code: nullable(ShortText),
  room_type_code: nullable(ShortText), pricing_product_code: nullable(ShortText),
  inventory_basis: nullable(Type.Union([Type.Literal("INDEPENDENT"), Type.Literal("WHOLE_ROOM_COMBINATION")])),
  code_provenance: nullable(Type.Union([Type.Literal("SOURCE_EXPLICIT"), Type.Literal("USER_CONFIRMED_RENAMED"), Type.Literal("PMS_GENERATED")])),
  physical_bed_count: nullable(Type.Integer({ minimum: 1, maximum: 4 })),
  occupancy_capacity: Type.Integer({ minimum: 1, maximum: 1000 }),
  created_at: DateTime
});
const PricingPolicyRowSchema = strictObject({
  id: Id, property_id: Id, code: ShortText, version: Type.Integer({ minimum: 1 }), stay_type: nullable(StayTypeSchema),
  calculation_kind: Type.Union([Type.Literal("FLAT_NIGHTLY"), Type.Literal("DURATION_BAND_TOTAL"), Type.Literal("FREE")]),
  nightly_rate_minor: nullable(Type.Integer({ minimum: 0 })),
  product_anchor_rates_minor: nullable(Type.Record(Type.String({ minLength: 1, maxLength: 200 }), strictObject({ "1": PositiveAmount, "7": PositiveAmount, "14": PositiveAmount, "30": PositiveAmount }))),
  effective_from: nullable(LocalDate), effective_until: nullable(LocalDate),
  rounding_rule: nullable(Type.Literal("FINAL_TOTAL_WHOLE_YUAN_HALF_UP")),
  currency: Type.String({ minLength: 3, maxLength: 3 }), status: Type.Literal("PUBLISHED"), created_at: DateTime
});
const MemberContractRowSchema = strictObject({
  id: Id, property_id: Id, member_id: nullable(Id), member_name: ShortText,
  status: Type.Union([Type.Literal("ACTIVE"), Type.Literal("EXPIRED"), Type.Literal("VOIDED")]),
  valid_from: LocalDate, valid_until: LocalDate, version: Type.Integer({ minimum: 1 }), created_at: DateTime
});
const MemberRowSchema = strictObject({
  id: Id,
  identity_card_number: nullable(ShortText),
  nickname: ShortText,
  full_name: ShortText,
  phone: ShortText,
  wechat: ShortText,
  created_at: DateTime
});
const MembershipProductRowSchema = strictObject({
  id: Id,
  code: ShortText,
  version: Type.Integer({ minimum: 1 }),
  name: ShortText,
  list_price_minor: NonNegativeWholeYuanAmount,
  currency: Type.String({ minLength: 3, maxLength: 3 }),
  entitlement_unit_kind: EntitlementUnitKindSchema,
  entitlement_units: Type.Integer({ minimum: 1 }),
  validity_period: Type.Literal("P1Y"),
  allowed_room_type_code: ShortText,
  allowed_inventory_kind: InventoryUnitKindSchema,
  status: Type.Literal("PUBLISHED"),
  created_at: DateTime
});

export const MetaResponseSchema = strictObject({
  properties: Type.Array(PropertyRowSchema),
  inventoryUnits: Type.Array(InventoryUnitRowSchema),
  pricingPolicyVersions: Type.Array(PricingPolicyRowSchema),
  members: Type.Array(MemberRowSchema),
  memberContracts: Type.Array(MemberContractRowSchema),
  membershipProducts: Type.Array(MembershipProductRowSchema)
});

const ReferenceExecutionStateSchema = Type.Literal("REFERENCE_ONLY");
const ReferenceCurrencySchema = Type.String({ minLength: 3, maxLength: 3, pattern: "^[A-Z]{3}$" });
const ReferenceSourceSchema = {
  sourceSheet: ShortText,
  sourceRange: Type.String({ minLength: 1, maxLength: 200 })
};
const ReferenceCatalogBatchSchema = strictObject({
  id: Id,
  propertyId: Id,
  sourceRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  sourceVersionDate: nullable(LocalDate),
  contentHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  executionState: ReferenceExecutionStateSchema,
  createdAt: DateTime
});
const ReferenceInventoryCatalogEntrySchema = strictObject({
  id: Id,
  typeCode: ShortText,
  typeName: ShortText,
  bathroomType: Type.Union([Type.Literal("SHARED"), Type.Literal("ENSUITE")]),
  sellUnitKind: InventoryUnitKindSchema,
  physicalRoomCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  physicalBedCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  unitsPerRoom: nullable(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  sellableUnitCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  separateElectricityCharge: Type.Literal(false),
  executionState: ReferenceExecutionStateSchema,
  ...ReferenceSourceSchema
});
const ReferencePhysicalRoomSchema = strictObject({
  operationalCode: ShortText,
  buildingCode: ShortText,
  roomTypeKey: ShortText,
  sourceCode: nullable(ShortText),
  sourceLabel: ShortText,
  codeProvenance: Type.Union([Type.Literal("SOURCE_EXPLICIT"), Type.Literal("USER_CONFIRMED_RENAMED"), Type.Literal("PMS_GENERATED")]),
  physicalBedCount: Type.Integer({ minimum: 1, maximum: 4 }),
  physicalBedCodes: nullable(Type.Array(Type.String({ minLength: 1, maxLength: 4 }), { minItems: 2, maxItems: 4, uniqueItems: true })),
  saleMode: Type.Union([Type.Literal("INDEPENDENT_ROOM"), Type.Literal("BED_WITH_WHOLE_ROOM_COMBINATION")])
});
const ReferencePricingRuleSchema = strictObject({
  code: ShortText,
  version: Type.Integer({ minimum: 1 }),
  calculationKind: Type.Literal("DURATION_BAND_TOTAL"),
  effectiveFrom: LocalDate,
  effectiveUntil: Type.Null(),
  transientMaximumNightsExclusive: Type.Literal(7),
  bands: Type.Array(strictObject({
    minimumNights: Type.Integer({ minimum: 1 }),
    maximumNightsExclusive: nullable(Type.Integer({ minimum: 2 })),
    anchorNights: Type.Union([Type.Literal(1), Type.Literal(7), Type.Literal(14), Type.Literal(30)])
  }), { minItems: 4, maxItems: 4 }),
  rounding: strictObject({
    stage: Type.Literal("FINAL_STAY_TOTAL"),
    unit: Type.Literal("CNY_YUAN"),
    mode: Type.Literal("HALF_UP_POSITIVE")
  }),
  shorteningBasis: Type.Literal("FULL_STAY_FROM_ORIGINAL_ARRIVAL"),
  extensionBasis: Type.Literal("FULL_STAY_FROM_ORIGINAL_ARRIVAL"),
  crossCalendarMonthTreatment: Type.Literal("NO_SPLIT"),
  antiInversionRule: Type.Literal("NONE"),
  separateElectricityCharge: Type.Literal(false)
});
const ReferencePricingProductSchema = strictObject({
  productCode: ShortText,
  roomTypeKey: ShortText,
  inventoryUnitKind: InventoryUnitKindSchema,
  anchorMultiplier: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(4)]),
  anchorsMinor: strictObject({
    "1": PositiveAmount,
    "7": PositiveAmount,
    "14": PositiveAmount,
    "30": PositiveAmount
  }),
  derivation: Type.Union([Type.Literal("SOURCE_PUBLISHED"), Type.Literal("BED_ANCHORS_TIMES_PHYSICAL_BEDS")])
});
const ReferenceRateSchema = strictObject({
  id: Id,
  inventoryCatalogEntryId: Id,
  packageNights: Type.Union([Type.Literal(1), Type.Literal(7), Type.Literal(14), Type.Literal(30)]),
  packageAmountMinor: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  currency: ReferenceCurrencySchema,
  executionState: ReferenceExecutionStateSchema,
  ...ReferenceSourceSchema
});
const ReferenceMembershipProductSchema = strictObject({
  id: Id,
  inventoryCatalogEntryId: Id,
  code: ShortText,
  name: ShortText,
  priceMinor: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  currency: ReferenceCurrencySchema,
  salesLimit: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  entitlementNights: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  validityPeriod: Type.String({ minLength: 2, maxLength: 80, pattern: "^P" }),
  executionState: ReferenceExecutionStateSchema,
  terms: strictObject({
    entitlementUnit: EntitlementUnitKindSchema,
    quotaMeaning: Type.Literal("MEMBERSHIP_SLOTS_NOT_INVENTORY"),
    validityStartsAt: Type.Literal("PAYMENT_DATE"),
    membershipRules: strictObject({
      bookingRule: Type.String({ minLength: 1, maxLength: 1000 }),
      refundPolicy: Type.Literal("NON_REFUNDABLE_MEMBERSHIP"),
      refundRule: Type.String({ minLength: 1, maxLength: 1000 }),
      overriddenSourceRefundRule: Type.String({ minLength: 1, maxLength: 1000 }),
      refundCalculation: Type.Null(),
      sourceRange: Type.String({ minLength: 1, maxLength: 200 })
    })
  }),
  ...ReferenceSourceSchema
});

export const ReferenceCatalogResponseSchema = strictObject({
  batch: ReferenceCatalogBatchSchema,
  inventoryEntries: Type.Array(ReferenceInventoryCatalogEntrySchema),
  rates: Type.Array(ReferenceRateSchema),
  rooms: Type.Array(ReferencePhysicalRoomSchema),
  pricingRule: ReferencePricingRuleSchema,
  pricingProducts: Type.Array(ReferencePricingProductSchema),
  rejectedSourceFigures: Type.Array(strictObject({ name: ShortText, value: SafeInteger, reason: Note })),
  membershipProducts: Type.Array(ReferenceMembershipProductSchema),
  unresolvedIssues: Type.Array(strictObject({
    code: Type.String({ minLength: 1, maxLength: 160 }),
    description: Type.String({ minLength: 1, maxLength: 1000 })
  }))
});

export const OrderRowSchema = strictObject({
  id: Id,
  property_id: Id,
  status: OrderStatusSchema,
  stay_type: StayTypeSchema,
  arrival_date: LocalDate,
  departure_date: LocalDate,
  primary_guest_snapshot: PrimaryGuestSnapshotSchema,
  current_primary_guest: strictObject({
    fullName: nullable(ShortText),
    nickname: Type.Optional(nullable(Nickname)),
    phone: Type.Optional(nullable(ShortText)),
    documentNumber: Type.Optional(nullable(ShortText))
  }),
  booking_channel_code: nullable(BookingChannelCodeSchema),
  channel_order_reference: nullable(ShortText),
  free_stay_reason: nullable(Note),
  free_stay_category_code: nullable(FreeStayCategoryCodeSchema),
  pricing_policy_version_id: Id,
  member_id: nullable(Id),
  member_contract_id: nullable(Id),
  current_revision_id: nullable(Id),
  current_contract_amount_minor: nullable(Type.Integer()),
  currency: nullable(Type.String({ minLength: 1, maxLength: 16 })),
  current_unit_name: Type.Optional(nullable(ShortText)),
  current_unit_code: Type.Optional(nullable(ShortText)),
  current_unit_room_type_code: Type.Optional(nullable(ShortText)),
  version: Type.Integer({ minimum: 1 }),
  created_at: DateTime,
  updated_at: DateTime
});
const OrderListRowSchema = strictObject({
  ...OrderRowSchema.properties,
  stay_status: Type.Union([
    Type.Literal("PLANNED"), Type.Literal("IN_HOUSE"), Type.Literal("COMPLETED"),
    Type.Literal("CANCELLED"), Type.Literal("NO_SHOW"), Type.Literal("CHECK_IN_REVOKED")
  ])
});
export const OrdersQuerySchema = strictObject({
  propertyId: Id,
  orderIds: Type.Optional(Type.Array(Id, { minItems: 1, maxItems: 100 })),
  status: Type.Optional(OrderStatusSchema),
  query: Type.Optional(Type.String({ maxLength: 200 })),
  workDate: Type.Optional(LocalDate),
  funds: Type.Optional(Type.Union([Type.Literal("BALANCE_DUE"), Type.Literal("OVERPAID")])),
  reconversionMemberId: Type.Optional(Id),
  beforeId: Type.Optional(Id),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))
});
export const OrdersListResponseSchema = strictObject({
  businessDate: LocalDate,
  nextCursor: Type.Optional(nullable(Id)),
  orders: Type.Array(OrderListRowSchema)
});

const StaySegmentRowSchema = strictObject({
  id: Id, stay_id: Id, sequence: Type.Integer({ minimum: 1 }), inventory_unit_id: Id,
  arrival_date: LocalDate, departure_date: LocalDate, segment_type: ShortText,
  supersedes_segment_id: nullable(Id), amendment_id: Id, created_at: DateTime
});
const CreateOrderAmendmentPayloadSchema = strictObject({
  quoteId: Id,
  inventoryUnitId: Id,
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  primaryGuest: Type.Optional(PrimaryGuestSnapshotSchema),
  occupants: Type.Optional(Type.Array(CommandEffectOrderOccupantSchema, { minItems: 1, maxItems: 1000 })),
  bookingChannelCode: Type.Optional(nullable(BookingChannelCodeSchema)),
  channelOrderReference: Type.Optional(nullable(ShortText)),
  freeStayReason: Type.Optional(nullable(Note)),
  freeStayCategoryCode: Type.Optional(nullable(FreeStayCategoryCodeSchema)),
  temporaryOtherRoomArrangement: Type.Optional(TemporaryOtherRoomArrangementSchema),
  pricingDecision: Type.Optional(CreateOrderPricingDecisionSchema)
});
const AmendmentRowBase = {
  id: Id, order_id: Id, sequence: Type.Integer({ minimum: 1 }),
  reason_code: Type.String({ minLength: 1, maxLength: 80 }), reason_note: OptionalNote,
  prior_version: Type.Integer({ minimum: 0 }), new_version: Type.Integer({ minimum: 1 }),
  command_id: nullable(Id),
  actor: nullable(strictObject({ subjectId: Id, displayName: ShortText })),
  created_at: DateTime
} as const;
const CurrentAmendmentRowSchema = strictObject({
  ...AmendmentRowBase,
  amendment_type: CommandTypeSchema,
  payload: Type.Union([CreateOrderAmendmentPayloadSchema, CommandEffectSchema])
});
const HistoricalStayArrangementCorrectionAmendmentRowSchema = strictObject({
  ...AmendmentRowBase,
  amendment_type: Type.Literal("CORRECT_HISTORICAL_STAY_ARRANGEMENT"),
  payload: strictObject({
    operation: Type.Literal("CORRECT_HISTORICAL_STAY_ARRANGEMENT"),
    commandType: Type.Literal("CORRECT_HISTORICAL_STAY_ARRANGEMENTS"),
    orderId: Id,
    stayId: Id,
    expectedVersion: Type.Integer({ minimum: 1 }),
    correctionSetHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    before: HistoricalStayArrangementSnapshotSchema,
    after: strictObject({
      ...HistoricalStayArrangementSnapshotSchema.properties,
      pricing: strictObject({
        coverageSet: Type.Array(CoverageItem),
        cashLines: Type.Array(CashLine),
        currentContractAmount: Money
      })
    }),
    unchanged: HistoricalStayArrangementUnchangedSchema
  })
});
const BackfillCheckInAmendmentRowSchema = strictObject({
  ...AmendmentRowBase,
  amendment_type: Type.Literal("CHECK_IN"),
  reason_code: Type.Literal("BACKFILL_STAY"),
  payload: strictObject({
    fromStatus: Type.Literal("RESERVED"),
    toStatus: Type.Literal("CHECKED_IN"),
    inventoryUnitId: Id,
    businessDate: LocalDate,
    effectiveDate: LocalDate,
    recordingMode: Type.Union([Type.Literal("ON_SCHEDULE"), Type.Literal("LATE_RECORDED")])
  })
});
const BackfillCheckOutAmendmentRowSchema = strictObject({
  ...AmendmentRowBase,
  amendment_type: Type.Literal("CHECK_OUT"),
  reason_code: Type.Literal("BACKFILL_STAY"),
  payload: strictObject({
    fromStatus: Type.Literal("CHECKED_IN"),
    toStatus: Type.Literal("CHECKED_OUT"),
    inventoryUnitId: Id,
    businessDate: LocalDate,
    effectiveDate: LocalDate,
    recordingMode: Type.Union([Type.Literal("ON_SCHEDULE"), Type.Literal("LATE_RECORDED")])
  })
});
const LegacyStayChangeAmendmentRowSchema = strictObject({
  ...AmendmentRowBase,
  amendment_type: Type.Union([Type.Literal("RESCHEDULE_STAY"), Type.Literal("EXTEND_STAY")]),
  payload: LegacyStayChangeEffectSchema,
  protocolVersion: Type.Literal("LEGACY_STAGE_9_10"),
  ...HistoricalReadOnlyMetadata
});
const LegacyShortenAmendmentRowSchema = strictObject({
  ...AmendmentRowBase,
  amendment_type: Type.Literal("SHORTEN_STAY"),
  payload: LegacyShortenStayEffectSchema,
  protocolVersion: Type.Literal("LEGACY_STAGE_10"),
  ...HistoricalReadOnlyMetadata
});
const LegacyMoveAmendmentRowSchema = strictObject({
  ...AmendmentRowBase,
  amendment_type: Type.Literal("MOVE_UNIT"),
  payload: LegacyMoveUnitEffectSchema,
  protocolVersion: Type.Literal("PRE_STAGE_11"),
  ...HistoricalReadOnlyMetadata
});
const PreInHouseMembershipShortenAmendmentRowSchema = strictObject({
  ...AmendmentRowBase,
  amendment_type: Type.Literal("SHORTEN_STAY"),
  payload: PreInHouseMembershipShortenStayEffectSchema,
  protocolVersion: Type.Literal("PRE_INHOUSE_MEMBERSHIP_FULFILLMENT"),
  ...HistoricalReadOnlyMetadata
});
const PreInHouseMembershipMoveAmendmentRowSchema = strictObject({
  ...AmendmentRowBase,
  amendment_type: Type.Literal("MOVE_UNIT"),
  payload: PreInHouseMembershipMoveUnitEffectSchema,
  protocolVersion: Type.Literal("PRE_INHOUSE_MEMBERSHIP_FULFILLMENT"),
  ...HistoricalReadOnlyMetadata
});
const AmendmentRowSchema = Type.Union([
  BackfillCheckInAmendmentRowSchema,
  BackfillCheckOutAmendmentRowSchema,
  CurrentAmendmentRowSchema,
  HistoricalStayArrangementCorrectionAmendmentRowSchema,
  LegacyStayChangeAmendmentRowSchema,
  LegacyShortenAmendmentRowSchema,
  LegacyMoveAmendmentRowSchema,
  PreInHouseMembershipShortenAmendmentRowSchema,
  PreInHouseMembershipMoveAmendmentRowSchema
]);
const PricingRevisionRowSchema = strictObject({
  id: Id, order_id: Id, revision_no: Type.Integer({ minimum: 1 }), amendment_id: Id, policy_version_id: Id,
  arrival_date: LocalDate, departure_date: LocalDate, coverage_set: Type.Array(CoverageItem), cash_lines: Type.Array(CashLine),
  policy_base_amount_minor: SafeInteger,
  pricing_basis: Type.Union(createOrderPricingBasisCodes.map((code) => Type.Literal(code))),
  manual_adjustment_minor: SafeInteger,
  current_contract_amount_minor: SafeInteger,
  difference_from_policy_minor: SafeInteger,
  reason: RecordedCommandReasonSchema,
  currency: Type.String({ minLength: 3, maxLength: 3 }), created_at: DateTime
});
const CoverageRowSchema = strictObject({
  id: Id, order_id: Id, contract_id: Id, lot_id: Id, inventory_unit_id: Id, service_date: LocalDate,
  unit_kind: EntitlementUnitKindSchema,
  status: Type.Union([Type.Literal("HELD"), Type.Literal("CONSUMED"), Type.Literal("RELEASED")]),
  held_by_revision_id: Id, created_at: DateTime, updated_at: DateTime
});
const CleaningTaskSummarySchema = strictObject({
  id: Id,
  inventoryUnitId: Id,
  serviceDate: LocalDate,
  status: Type.Union([Type.Literal("PENDING"), Type.Literal("COMPLETED")]),
  createdAt: DateTime,
  completedAt: nullable(DateTime),
  createdBy: nullable(strictObject({ subjectId: Id, displayName: ShortText })),
  completedBy: nullable(strictObject({ subjectId: Id, displayName: ShortText }))
});
const OrderFulfillmentRecordProperties = {
  plannedBusinessDate: LocalDate,
  recordedBusinessDate: nullable(LocalDate),
  recordingMode: Type.Union(fulfillmentRecordingModes.map((mode) => Type.Literal(mode))),
  recordedAt: DateTime,
  actor: nullable(strictObject({ subjectId: Id, displayName: ShortText })),
  reason: strictObject({ code: ShortText, note: Note })
};
const CheckInFulfillmentRecordSchema = strictObject({
  type: Type.Literal("CHECK_IN"),
  ...OrderFulfillmentRecordProperties
});
const CheckOutFulfillmentRecordSchema = strictObject({
  type: Type.Literal("CHECK_OUT"),
  ...OrderFulfillmentRecordProperties
});
const CheckInRevocationFulfillmentRecordSchema = strictObject({
  type: Type.Literal("REVOKE_CHECK_IN"),
  ...OrderFulfillmentRecordProperties
});
const OrderFulfillmentProjectionSchema = strictObject({
  state: Type.Union(orderFulfillmentStates.map((state) => Type.Literal(state))),
  checkIn: nullable(CheckInFulfillmentRecordSchema),
  checkOut: nullable(CheckOutFulfillmentRecordSchema),
  checkInRevocation: nullable(CheckInRevocationFulfillmentRecordSchema)
});
const OrderArrangementIntervalSchema = strictObject({
  inventoryUnitId: Id,
  arrivalDate: LocalDate,
  departureDate: LocalDate
});
const OrderArrangementSchema = strictObject({
  arrivalDate: LocalDate,
  departureDate: LocalDate,
  intervals: Type.Array(OrderArrangementIntervalSchema, { minItems: 1 })
});
const OrderEffectiveArrangementSchema = strictObject({
  ...OrderArrangementSchema.properties,
  presentation: Type.Union(orderEffectiveArrangementPresentations.map((presentation) => Type.Literal(presentation))),
  businessDate: LocalDate
});
const OrderHistoricalStayCorrectionGroupSchema = strictObject({
  correctionSetHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  corrections: Type.Array(strictObject({
    orderId: Id,
    stayId: Id,
    correctionId: Id,
    amendmentId: Id,
    staySegmentId: Id,
    pricingRevisionId: Id,
    before: HistoricalStayArrangementSnapshotSchema,
    after: HistoricalStayArrangementSnapshotSchema
  }), { minItems: 1, maxItems: 100 }),
  reason: RecordedCommandReasonSchema,
  evidenceNote: Type.Optional(Note),
  actor: strictObject({ subjectId: Id, displayName: ShortText }),
  recordedAt: DateTime
});
const OrderArrangementHistoryItemSchema = strictObject({
  type: Type.Union(orderArrangementChangeTypes.map((type) => Type.Literal(type))),
  before: nullable(OrderArrangementSchema),
  after: OrderArrangementSchema,
  reason: RecordedCommandReasonSchema,
  actor: nullable(strictObject({ subjectId: Id, displayName: ShortText })),
  recordedAt: DateTime,
  pricingSummary: strictObject({
    policyBaseAmount: Money,
    currentContractAmount: Money,
    differenceFromPolicy: Money
  }),
  fundsSummary: strictObject({
    netRecordedCollection: Money,
    collectionDifference: Money,
    refundReferenceAmount: NonNegativeMoney,
    factCount: Type.Integer({ minimum: 0 })
  }),
  correctionGroup: Type.Optional(OrderHistoricalStayCorrectionGroupSchema)
});
export const CollectionFactRowSchema = strictObject({
  fact_id: Id, order_id: Id,
  fact_type: Type.Union([Type.Literal("COLLECTION"), Type.Literal("REFUND"), Type.Literal("REVERSAL")]),
  amount_minor: PositiveAmount, net_effect_minor: SafeInteger,
  currency: Type.String({ minLength: 3, maxLength: 3 }), references_fact_id: nullable(Id), reverses_fact_id: nullable(Id),
  method: ShortText, note: OptionalNote, transaction_reference: nullable(ShortText), refund_reference: Type.Optional(nullable(ShortText)), cash_collector: nullable(ShortText), pricing_revision_id: nullable(Id), command_id: Id, created_at: DateTime,
  transfer: Type.Optional(nullable(strictObject({
    id: Id,
    membershipOrderId: Id,
    memberId: Id,
    membershipPaymentFactId: Id,
    sourceReversalFactId: Id
  })))
});

export const OrderDetailResponseSchema = strictObject({
  accessLevel: AccessLevelSchema,
  allowedActions: Type.Array(strictObject({
    code: Type.Union(orderActionCodes.map((code) => Type.Literal(code))),
    enabled: Type.Boolean(),
    disabledReason: nullable(ShortText)
  })),
  order: OrderRowSchema,
  occupants: Type.Array(OrderOccupantSchema, { minItems: 1, maxItems: 1000 }),
  occupantCorrections: Type.Array(strictObject({
    id: Id,
    orderId: Id,
    occupantId: Id,
    sequence: Type.Integer({ minimum: 1 }),
    priorSnapshot: OrderOccupantPriorSnapshotSchema,
    correctedSnapshot: OrderOccupantCorrectedSnapshotSchema,
    reason: strictObject({ code: ShortText, note: Note }),
    actor: strictObject({ subjectId: Id, displayName: ShortText }),
    amendmentId: Id,
    commandId: Id,
    createdAt: DateTime
  })),
  stay: strictObject({ id: Id, status: Type.Union([
    Type.Literal("PLANNED"), Type.Literal("IN_HOUSE"), Type.Literal("COMPLETED"),
    Type.Literal("CANCELLED"), Type.Literal("NO_SHOW"), Type.Literal("CHECK_IN_REVOKED")
  ]) }),
  currentSegment: strictObject({ id: Id, sequence: Type.Integer({ minimum: 1 }), inventoryUnitId: Id, arrivalDate: LocalDate, departureDate: LocalDate }),
  segments: Type.Array(StaySegmentRowSchema),
  originalArrangement: OrderArrangementSchema,
  effectiveArrangement: OrderEffectiveArrangementSchema,
  fulfillment: OrderFulfillmentProjectionSchema,
  arrangementHistory: Type.Array(OrderArrangementHistoryItemSchema, { minItems: 1 }),
  referencedInventoryUnits: Type.Array(InventoryUnitRowSchema, { minItems: 1 }),
  amendments: Type.Array(AmendmentRowSchema),
  pricingRevisions: Type.Array(PricingRevisionRowSchema),
  membershipConversion: nullable(strictObject({
    membershipOrderId: Id,
    memberId: Id,
    contractId: Id,
    entitlementLotId: Id,
    commandId: Id
  })),
  coverageSet: Type.Array(CoverageRowSchema),
  collectionFacts: Type.Array(CollectionFactRowSchema),
  cleaningTasks: Type.Array(CleaningTaskSummarySchema),
  amounts: AmountSummarySchema
});

const EntitlementLotRowSchema = strictObject({
  id: Id, contract_id: Id, unit_kind: EntitlementUnitKindSchema, total_units: Type.Integer({ minimum: 0 }),
  expires_on: LocalDate, status: Type.Union([Type.Literal("ACTIVE"), Type.Literal("VOIDED")]),
  version: Type.Integer({ minimum: 1 }), created_at: DateTime
});
const MemberExternalReferenceRowSchema = strictObject({
  id: Id,
  member_id: Id,
  property_id: Id,
  provider: Type.Literal("FEISHU_BASE"),
  source_container_id: ShortText,
  source_table_id: ShortText,
  external_record_id: ShortText,
  created_at: DateTime
});
const MemberAvailableBalanceSchema = strictObject({
  ROOM_NIGHT: Type.Integer({ minimum: 0 }),
  BED_NIGHT: Type.Integer({ minimum: 0 })
});
const MemberLotBalanceSchema = strictObject({
  lotId: Id,
  unitKind: EntitlementUnitKindSchema,
  availableUnits: Type.Integer({ minimum: 0 })
});
const MembershipOrderRowSchema = strictObject({
  id: Id,
  property_id: Id,
  member_id: Id,
  product_id: Id,
  product_code: ShortText,
  product_version: Type.Integer({ minimum: 1 }),
  product_name: ShortText,
  listed_price_minor: NonNegativeWholeYuanAmount,
  agreed_price_minor: NonNegativeWholeYuanAmount,
  price_adjustment_minor: SafeInteger,
  price_adjustment_reason: nullable(Note),
  currency: Type.String({ minLength: 3, maxLength: 3 }),
  entitlement_unit_kind: EntitlementUnitKindSchema,
  entitlement_units: Type.Integer({ minimum: 1 }),
  validity_period: Type.Literal("P1Y"),
  allowed_room_type_code: ShortText,
  allowed_inventory_kind: InventoryUnitKindSchema,
  status: Type.Union([Type.Literal("DRAFT"), Type.Literal("ACTIVE"), Type.Literal("VOIDED")]),
  activated_at: nullable(DateTime),
  valid_from: nullable(LocalDate),
  valid_until: nullable(LocalDate),
  contract_id: nullable(Id),
  entitlement_lot_id: nullable(Id),
  version: Type.Integer({ minimum: 1 }),
  created_by_command_id: Id,
  activated_by_command_id: nullable(Id),
  created_at: DateTime,
  updated_at: DateTime
});
const MembershipPaymentFactRowSchema = strictObject({
  fact_id: Id,
  membership_order_id: Id,
  fact_type: Type.Union([Type.Literal("COLLECTION"), Type.Literal("REVERSAL")]),
  amount_minor: PositiveAmount,
  net_effect_minor: SafeInteger,
  currency: Type.String({ minLength: 3, maxLength: 3 }),
  transaction_reference: nullable(ShortText),
  corrects_fact_id: nullable(Id),
  reverses_fact_id: nullable(Id),
  source_type: Type.Union([Type.Literal("DIRECT_WECOM"), Type.Literal("STAY_COLLECTION_TRANSFER")]),
  source_order_id: nullable(Id),
  source_collection_fact_id: nullable(Id),
  note: OptionalNote,
  command_id: Id,
  business_date: LocalDate,
  created_at: DateTime
});
const MembershipOrderSummarySchema = strictObject({
  order: MembershipOrderRowSchema,
  paymentFacts: Type.Array(MembershipPaymentFactRowSchema),
  paymentTotalMinor: SafeInteger,
  paymentDifferenceMinor: SafeInteger
});
const MemberCorrectionActorSchema = AdminCorrectionReceiptActorSchema;
const MaskedMemberProfileHistoryValueSchema = Type.String({ minLength: 3, maxLength: 200, pattern: "\\*{3,}" });
const MemberProfileCorrectionRowSchema = strictObject({
  id: Id,
  property_id: Id,
  member_id: Id,
  sequence: Type.Integer({ minimum: 1 }),
  prior_full_name: ShortText,
  prior_nickname: ShortText,
  prior_identity_card_number: nullable(MaskedMemberProfileHistoryValueSchema),
  prior_phone: MaskedMemberProfileHistoryValueSchema,
  prior_wechat: MaskedMemberProfileHistoryValueSchema,
  corrected_full_name: ShortText,
  corrected_nickname: ShortText,
  corrected_identity_card_number: nullable(MaskedMemberProfileHistoryValueSchema),
  corrected_phone: MaskedMemberProfileHistoryValueSchema,
  corrected_wechat: MaskedMemberProfileHistoryValueSchema,
  changed_fields: Type.Array(AdminMemberProfileChangedFieldSchema, { minItems: 1, maxItems: 5, uniqueItems: true }),
  evidence_note: Note,
  command_id: Id,
  created_at: DateTime,
  actor: MemberCorrectionActorSchema
});
const MembershipEffectiveDateCorrectionRowSchema = strictObject({
  id: Id,
  property_id: Id,
  member_id: Id,
  membership_order_id: Id,
  contract_id: Id,
  entitlement_lot_id: Id,
  sequence: Type.Integer({ minimum: 1 }),
  prior_valid_from: LocalDate,
  prior_valid_until: LocalDate,
  corrected_valid_from: LocalDate,
  corrected_valid_until: LocalDate,
  prior_order_version: Type.Integer({ minimum: 1 }),
  prior_contract_version: Type.Integer({ minimum: 1 }),
  prior_lot_version: Type.Integer({ minimum: 1 }),
  evidence_note: Note,
  command_id: Id,
  created_at: DateTime,
  actor: MemberCorrectionActorSchema
});
const HistoricalMembershipBackfillRowSchema = strictObject({
  id: Id,
  property_id: Id,
  member_id: Id,
  membership_order_id: Id,
  contract_id: Id,
  entitlement_lot_id: Id,
  payment_fact_id: Id,
  product_id: Id,
  product_code: ShortText,
  product_version: Type.Integer({ minimum: 1 }),
  product_name: ShortText,
  listed_price_minor: NonNegativeWholeYuanAmount,
  agreed_price_minor: NonNegativeWholeYuanAmount,
  currency: Type.String({ minLength: 3, maxLength: 3 }),
  entitlement_unit_kind: EntitlementUnitKindSchema,
  entitlement_units: Type.Integer({ minimum: 1 }),
  validity_period: Type.Literal("P1Y"),
  allowed_room_type_code: ShortText,
  allowed_inventory_kind: InventoryUnitKindSchema,
  actual_membership_date: LocalDate,
  valid_until: LocalDate,
  business_date: LocalDate,
  transaction_reference: ShortText,
  evidence_note: Note,
  command_id: Id,
  created_at: DateTime,
  actor: MemberCorrectionActorSchema
});
const MembershipPaymentReclassificationRowSchema = strictObject({
  id: Id,
  property_id: Id,
  member_id: Id,
  old_membership_order_id: Id,
  old_payment_fact_id: Id,
  old_reversal_fact_id: Id,
  new_membership_order_id: Id,
  new_payment_fact_id: nullable(Id),
  amount_minor: PositiveAmount,
  currency: Type.String({ minLength: 3, maxLength: 3 }),
  evidence_note: Note,
  command_id: Id,
  created_at: DateTime,
  actor: MemberCorrectionActorSchema
});
const MembershipVoidReconversionRowSchema = strictObject({
  id: Id,
  property_id: Id,
  member_id: Id,
  old_membership_order_id: Id,
  old_contract_id: Id,
  old_entitlement_lot_id: Id,
  prior_old_order_version: Type.Integer({ minimum: 1 }),
  prior_old_contract_version: Type.Integer({ minimum: 1 }),
  prior_old_lot_version: Type.Integer({ minimum: 1 }),
  source_order_id: Id,
  source_stay_id: Id,
  prior_source_order_version: Type.Integer({ minimum: 1 }),
  new_membership_order_id: Id,
  new_contract_id: Id,
  new_entitlement_lot_id: Id,
  replacement_payment_fact_id: nullable(Id),
  replacement_business_date: nullable(LocalDate),
  replacement_transaction_reference: nullable(ShortText),
  actual_membership_date: LocalDate,
  valid_until: LocalDate,
  old_direct_collection_total_minor: NonNegativeAmount,
  stay_transfer_total_minor: PositiveAmount,
  membership_agreed_price_minor: PositiveAmount,
  currency: Type.String({ minLength: 3, maxLength: 3 }),
  service_dates: Type.Array(LocalDate, { minItems: 1 }),
  evidence_note: Note,
  command_id: Id,
  created_at: DateTime,
  actor: MemberCorrectionActorSchema
});
const MemberSummarySchema = strictObject({
  member: MemberRowSchema
});
export const MembersQuerySchema = strictObject({
  propertyId: Id,
  query: Type.Optional(Type.String({ maxLength: 200 })),
  beforeId: Type.Optional(Id),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  memberId: Type.Optional(Id),
  phone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  hasContract: Type.Optional(Type.Boolean())
});
export const MembersListResponseSchema = strictObject({ members: Type.Array(MemberSummarySchema), nextCursor: nullable(Id) });
export const EntitlementLedgerRowSchema = strictObject({
  fact_id: Id, lot_id: Id,
  entry_type: Type.Union([
    Type.Literal("ADJUST"),
    Type.Literal("HOLD"),
    Type.Literal("RELEASE"),
    Type.Literal("CONSUME"),
    Type.Literal("RESTORE"),
    Type.Literal("EXPIRE"),
    Type.Literal("VOID"),
    Type.Literal("CONVERSION_CONSUME")
  ]),
  quantity_delta: SafeInteger, service_date: nullable(LocalDate), order_id: nullable(Id), coverage_id: nullable(Id),
  reason: Type.String({ minLength: 1, maxLength: 1000 }), command_id: nullable(Id), created_at: DateTime
});
export const MemberResponseSchema = strictObject({
  member: MemberRowSchema,
  contracts: Type.Array(MemberContractRowSchema),
  lots: Type.Array(EntitlementLotRowSchema),
  ledger: Type.Array(EntitlementLedgerRowSchema),
  externalReferences: Type.Array(MemberExternalReferenceRowSchema),
  lotBalances: Type.Array(MemberLotBalanceSchema),
  availableBalance: MemberAvailableBalanceSchema,
  balanceAsOfDate: LocalDate,
  membershipProducts: Type.Array(MembershipProductRowSchema),
  membershipOrders: Type.Array(MembershipOrderSummarySchema),
  profileCorrections: Type.Array(MemberProfileCorrectionRowSchema),
  effectiveDateCorrections: Type.Array(MembershipEffectiveDateCorrectionRowSchema),
  historicalMembershipBackfills: Type.Array(HistoricalMembershipBackfillRowSchema),
  paymentReclassifications: Type.Array(MembershipPaymentReclassificationRowSchema),
  voidReconversions: Type.Array(MembershipVoidReconversionRowSchema)
});

const CollectionFactResponseSchema = strictObject({
  fact_id: Id, order_id: Id,
  fact_type: Type.Union([Type.Literal("COLLECTION"), Type.Literal("REFUND"), Type.Literal("REVERSAL")]),
  amount_minor: PositiveAmount, net_effect_minor: SafeInteger,
  currency: Type.String({ minLength: 3, maxLength: 3 }), references_fact_id: nullable(Id), reverses_fact_id: nullable(Id),
  method: ShortText, note: OptionalNote, transaction_reference: nullable(ShortText), refund_reference: Type.Optional(nullable(ShortText)), cash_collector: nullable(ShortText), pricing_revision_id: nullable(Id), created_at: DateTime, property_id: Id
});
const EntitlementFactResponseSchema = strictObject({ ...EntitlementLedgerRowSchema.properties, property_id: Id });
export const FactResponseSchema = Type.Union([CollectionFactResponseSchema, EntitlementFactResponseSchema]);

const TokenRowCore = {
  subjectId: Id,
  displayName: ShortText,
  id: Id, label: ShortText, property_scope: Id, expires_at: DateTime,
  revoked_at: nullable(DateTime), rotated_from_id: nullable(Id), replaced_by_id: nullable(Id), created_at: DateTime
} as const;
const ReadTokenRowSchema = strictObject({
  ...TokenRowCore,
  access_ceiling: Type.Literal("READ"),
  commandCeiling: EmptyCommandCeilingSchema,
  persistedCommandCeiling: EmptyCommandCeilingSchema,
  historicalReadCeilingPreserved: Type.Literal(false)
});
const WriteTokenRowSchema = strictObject({
  ...TokenRowCore,
  access_ceiling: Type.Literal("WRITE"),
  commandCeiling: EffectiveCommandCeilingSchema,
  persistedCommandCeiling: PersistedCommandCeilingSchema,
  historicalReadCeilingPreserved: Type.Boolean()
});
const TokenRowSchema = Type.Union([ReadTokenRowSchema, WriteTokenRowSchema]);
export const TokensResponseSchema = strictObject({ tokens: Type.Array(TokenRowSchema) });

const TokenTargetSchema = strictObject({
  subjectId: Id,
  displayName: ShortText,
  accessLevel: AccessLevelSchema,
  commandGrants: Type.Array(CommandCapabilitySchema, { uniqueItems: true })
});
export const TokenTargetsResponseSchema = strictObject({ subjects: Type.Array(TokenTargetSchema) });

export const MaintenanceLockStatusSchema = Type.Union([Type.Literal("ACTIVE"), Type.Literal("RELEASED")]);
export const MaintenanceLocksQuerySchema = strictObject({
  propertyId: Id,
  status: Type.Optional(MaintenanceLockStatusSchema)
});
export const MaintenanceLockRowSchema = strictObject({
  id: Id,
  property_id: Id,
  inventory_unit_id: Id,
  arrival_date: LocalDate,
  departure_date: LocalDate,
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
  status: MaintenanceLockStatusSchema,
  version: Type.Integer({ minimum: 1 }),
  created_at: DateTime,
  released_at: nullable(DateTime)
});
export const MaintenanceLocksResponseSchema = strictObject({
  maintenanceLocks: Type.Array(MaintenanceLockRowSchema)
});

const AuditMetadataSchema = Type.Union([
  strictObject({ effectHash: Type.String({ minLength: 64, maxLength: 64 }) }),
  strictObject({ previewId: Id, effectHash: Type.String({ minLength: 64, maxLength: 64 }) }),
  strictObject({ quoteInputHash: Type.String({ minLength: 64, maxLength: 64 }) }),
  strictObject({ errorCode: Type.Union(errorCodes.map((code) => Type.Literal(code))) })
]);
export const AuditResponseSchema = strictObject({
  entries: Type.Array(strictObject({
    id: Id, subject_id: Id, credential_id: Id, action: Type.String({ minLength: 1, maxLength: 200 }),
    decision: Type.Union([Type.Literal("ALLOWED"), Type.Literal("DENIED")]), command_id: nullable(Id),
    correlation_id: Type.String({ minLength: 1, maxLength: 160 }), reason: nullable(RecordedCommandReasonSchema),
    target_refs: Type.Array(Id), metadata: AuditMetadataSchema, created_at: DateTime
  }))
});

export const StoredPreviewResponseSchema = strictObject({
  id: Id,
  property_id: Id,
  command_type: HistoricalCommandTypeSchema,
  input_hash: Type.String({ minLength: 64, maxLength: 64 }),
  effect: CommandEffectSchema,
  effect_hash: Type.String({ minLength: 64, maxLength: 64 }),
  expires_at: DateTime,
  status: Type.Union([Type.Literal("OPEN"), Type.Literal("USED"), Type.Literal("EXPIRED")]),
  created_at: DateTime,
  used_at: nullable(DateTime)
});
const HistoricalStoredPreviewBase = {
  id: Id,
  property_id: Id,
  input_hash: Type.String({ minLength: 64, maxLength: 64 }),
  effect_hash: Type.String({ minLength: 64, maxLength: 64 }),
  expires_at: DateTime,
  status: Type.Union([Type.Literal("OPEN"), Type.Literal("USED"), Type.Literal("EXPIRED")]),
  created_at: DateTime,
  used_at: nullable(DateTime),
  confirmable: Type.Literal(false),
  ...HistoricalReadOnlyMetadata
} as const;
const HistoricalStayChangeStoredPreviewSchema = strictObject({
  ...HistoricalStoredPreviewBase,
  command_type: Type.Union([Type.Literal("RESCHEDULE_STAY"), Type.Literal("EXTEND_STAY")]),
  effect: LegacyStayChangeEffectSchema,
  protocolVersion: Type.Literal("LEGACY_STAGE_9_10")
});
const HistoricalShortenStoredPreviewSchema = strictObject({
  ...HistoricalStoredPreviewBase,
  command_type: Type.Literal("SHORTEN_STAY"),
  effect: LegacyShortenStayEffectSchema,
  protocolVersion: Type.Literal("LEGACY_STAGE_10")
});
const HistoricalMoveStoredPreviewSchema = strictObject({
  ...HistoricalStoredPreviewBase,
  command_type: Type.Literal("MOVE_UNIT"),
  effect: LegacyMoveUnitEffectSchema,
  protocolVersion: Type.Literal("PRE_STAGE_11")
});
const PreInHouseMembershipShortenStoredPreviewSchema = strictObject({
  ...HistoricalStoredPreviewBase,
  command_type: Type.Literal("SHORTEN_STAY"),
  effect: PreInHouseMembershipShortenStayEffectSchema,
  protocolVersion: Type.Literal("PRE_INHOUSE_MEMBERSHIP_FULFILLMENT")
});
const PreInHouseMembershipMoveStoredPreviewSchema = strictObject({
  ...HistoricalStoredPreviewBase,
  command_type: Type.Literal("MOVE_UNIT"),
  effect: PreInHouseMembershipMoveUnitEffectSchema,
  protocolVersion: Type.Literal("PRE_INHOUSE_MEMBERSHIP_FULFILLMENT")
});
export const HistoricalStoredPreviewResponseSchema = Type.Union([
  StoredPreviewResponseSchema,
  HistoricalStayChangeStoredPreviewSchema,
  HistoricalShortenStoredPreviewSchema,
  HistoricalMoveStoredPreviewSchema,
  PreInHouseMembershipShortenStoredPreviewSchema,
  PreInHouseMembershipMoveStoredPreviewSchema
]);

export const IdParams = strictObject({ id: Id });
export const PreviewParams = strictObject({ previewId: Id });
import { RoomCatalogInputSchema, RoomCatalogEffectSchema, RoomCatalogResultSchema } from "./room-catalog-schemas.ts";

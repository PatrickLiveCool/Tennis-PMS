export * from "./account-management.ts";
export * from "./room-catalog.ts";

export const accessLevels = ["READ", "WRITE"] as const;
export type AccessLevel = (typeof accessLevels)[number];

export const inventoryUnitKinds = ["ROOM", "BED"] as const;
export type InventoryUnitKind = (typeof inventoryUnitKinds)[number];
export type EntitlementUnitKind = "ROOM_NIGHT" | "BED_NIGHT";

export const stayTypes = ["TRANSIENT", "WEEKLY", "MONTHLY", "CUSTOM", "FIXED_TERM", "ROLLING", "FREE"] as const;
export type StayType = (typeof stayTypes)[number];

export const bookingChannelCodes = ["YOUMUDAO", "CTRIP", "MEITUAN", "WECOM"] as const;
export type BookingChannelCode = (typeof bookingChannelCodes)[number];

export const createOrderPricingBasisCodes = [
  "POLICY",
  "CHANNEL_CONTRACT",
  "MANUAL_ADJUSTMENT",
  "MEMBER_ENTITLEMENT",
  "FREE"
] as const;
export type CreateOrderPricingBasis = (typeof createOrderPricingBasisCodes)[number];

export const freeStayCategoryCodes = ["VOLUNTEER", "RECEPTION"] as const;
export type FreeStayCategoryCode = (typeof freeStayCategoryCodes)[number];

export const roomStatusSourceCategories = ["DIRECT", "YOUMUDAO", "CTRIP", "MEITUAN", "FREE_STAY", "MEMBER"] as const;
export type RoomStatusSourceCategory = (typeof roomStatusSourceCategories)[number];

export const backfillCollectionMethods = ["WECOM", "BANK_TRANSFER", "CASH"] as const;
export type BackfillCollectionMethod = (typeof backfillCollectionMethods)[number];

export const currentReleaseFeatures = {
  cleaningWorkflow: false,
  stayBackfillSubmission: false,
  completedStayBackfillCreation: true,
  historicalStayArrangementCorrection: true,
  memberProfileCorrection: true,
  membershipEffectiveDateCorrection: true,
  historicalMembershipBackfill: true,
  membershipConversionVoidCorrection: true
} as const;

export const commandTypes = [
  "MANAGE_ROOM_CATALOG",
  "CREATE_MEMBER",
  "CREATE_MEMBERSHIP_ORDER",
  "RECORD_MEMBERSHIP_PAYMENT",
  "CORRECT_MEMBERSHIP_PAYMENT",
  "ACTIVATE_MEMBERSHIP_ORDER",
  "CREATE_ORDER",
  "CORRECT_ORDER_OCCUPANT",
  "MANAGE_ORDER_OCCUPANTS",
  "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
  "CORRECT_MEMBER_PROFILE",
  "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
  "BACKFILL_HISTORICAL_MEMBERSHIP",
  "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",
  "RESCHEDULE_STAY",
  "EXTEND_STAY",
  "SHORTEN_STAY",
  "MOVE_UNIT",
  "REPRICE_ORDER",
  "CANCEL_ORDER",
  "MARK_NO_SHOW",
  "REVOKE_CHECK_IN",
  "LOCK_MAINTENANCE",
  "RELEASE_MAINTENANCE",
  "COMPLETE_CLEANING",
  "RECORD_COLLECTION",
  "RECORD_REFUND",
  "REVERSE_FACT",
  "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
  "CHECK_IN",
  "CHECK_OUT",
  "REVOKE_CHECK_OUT",
  "COMPLETE_STAY",
  "REFRESH_MEMBER_COVERAGE",
  "ADD_MEMBER_ENTITLEMENT_LOT",
  "ADJUST_MEMBER_ENTITLEMENT",
  "CORRECT_MEMBER_ENTITLEMENT_BALANCE",
  "EXPIRE_MEMBER_ENTITLEMENT",
  "ISSUE_TOKEN",
  "ROTATE_TOKEN",
  "REVOKE_TOKEN"
] as const;
export type DeferredCommandType = "PLACE_INTERNAL_USE" | "RELEASE_INTERNAL_USE";
export type ObsoleteCommandType = "BACKFILL_COMPLETED_STAY";
export type CommandType = (typeof commandTypes)[number];
export const futureAdministratorCommandTypes = [] as const;
export type FutureAdministratorCommandType = (typeof futureAdministratorCommandTypes)[number];
export const commandCapabilities = [...commandTypes, ...futureAdministratorCommandTypes] as const;
export type CommandCapability = (typeof commandCapabilities)[number];
export type HistoricalCommandType = CommandType | DeferredCommandType | ObsoleteCommandType;

export const directCommandTypes = ["CREATE_QUOTE"] as const;
export type DirectCommandType = (typeof directCommandTypes)[number];
export const recoverableCommandTypes = [...directCommandTypes, ...commandTypes] as const;
export type RecoverableCommandType = (typeof recoverableCommandTypes)[number];
export const historicalRecoverableCommandTypes = [
  ...recoverableCommandTypes,
  "PLACE_INTERNAL_USE",
  "RELEASE_INTERNAL_USE",
  "BACKFILL_COMPLETED_STAY"
] as const;
export type HistoricalRecoverableCommandType = (typeof historicalRecoverableCommandTypes)[number];
export const commandCatalogTypes = [
  ...directCommandTypes,
  ...commandTypes,
  ...futureAdministratorCommandTypes,
  "PLACE_INTERNAL_USE",
  "RELEASE_INTERNAL_USE",
  "BACKFILL_COMPLETED_STAY"
] as const;
export type CommandCatalogType = (typeof commandCatalogTypes)[number];

export const errorCodes = [
  "CURSOR_EXPIRED",
  "AUTHENTICATION_REQUIRED",
  "INVALID_CREDENTIALS",
  "TOKEN_EXPIRED",
  "TOKEN_REVOKED",
  "SUBJECT_DISABLED",
  "INSUFFICIENT_ACCESS",
  "RESOURCE_SCOPE_DENIED",
  "IDEMPOTENCY_KEY_REQUIRED",
  "CORRELATION_ID_REQUIRED",
  "IDEMPOTENCY_KEY_REUSED",
  "PREVIEW_REQUIRED",
  "PREVIEW_NOT_FOUND",
  "PREVIEW_STALE",
  "PREVIEW_ALREADY_USED",
  "CONFIRMATION_REQUIRED",
  "CONFIRMATION_MISMATCH",
  "REASON_REQUIRED",
  "AGGREGATE_VERSION_CONFLICT",
  "INVENTORY_CONFLICT",
  "ENTITLEMENT_CONFLICT",
  "INVALID_ORDER_STATE",
  "CROSS_ORDER_FACT_REFERENCE",
  "FACT_ALREADY_REVERSED",
  "REFUND_LIMIT_EXCEEDED",
  "PRICING_POLICY_UNCONFIGURED",
  "POLICY_VERSION_NOT_FOUND",
  "QUOTE_EXPIRED",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "COMMAND_STATUS_UNKNOWN",
  "COMMAND_INTERRUPTED",
  "RATE_LIMITED",
  "SERVICE_NOT_READY",
  "INTERNAL_ERROR"
] as const;
export type ErrorCode = (typeof errorCodes)[number];
export const errorCauseCodes = [...errorCodes, "PREVIEW_EXPIRED"] as const;
export type ErrorCauseCode = (typeof errorCauseCodes)[number];

export interface MoneyDto {
  currency: string;
  minorUnits: number;
}

export interface ReferenceCatalogBatchDto {
  id: string;
  propertyId: string;
  sourceRevision: number;
  sourceVersionDate: string | null;
  contentHash: string;
  executionState: "REFERENCE_ONLY";
  createdAt: string;
}

export interface ReferenceInventoryCatalogEntryDto {
  id: string;
  typeCode: string;
  typeName: string;
  bathroomType: "SHARED" | "ENSUITE";
  sellUnitKind: "ROOM" | "BED";
  physicalRoomCount: number;
  physicalBedCount: number;
  unitsPerRoom: number | null;
  sellableUnitCount: number;
  separateElectricityCharge: false;
  executionState: "REFERENCE_ONLY";
  sourceSheet: string;
  sourceRange: string;
}

export interface ReferencePhysicalRoomDto {
  operationalCode: string;
  buildingCode: string;
  roomTypeKey: string;
  sourceCode: string | null;
  sourceLabel: string;
  codeProvenance: "SOURCE_EXPLICIT" | "USER_CONFIRMED_RENAMED" | "PMS_GENERATED";
  physicalBedCount: number;
  physicalBedCodes: string[] | null;
  saleMode: "INDEPENDENT_ROOM" | "BED_WITH_WHOLE_ROOM_COMBINATION";
}

export interface ReferencePricingRuleDto {
  code: string;
  version: number;
  calculationKind: "DURATION_BAND_TOTAL";
  effectiveFrom: string;
  effectiveUntil: null;
  transientMaximumNightsExclusive: 7;
  bands: Array<{ minimumNights: number; maximumNightsExclusive: number | null; anchorNights: 1 | 7 | 14 | 30 }>;
  rounding: { stage: "FINAL_STAY_TOTAL"; unit: "CNY_YUAN"; mode: "HALF_UP_POSITIVE" };
  shorteningBasis: "FULL_STAY_FROM_ORIGINAL_ARRIVAL";
  extensionBasis: "FULL_STAY_FROM_ORIGINAL_ARRIVAL";
  crossCalendarMonthTreatment: "NO_SPLIT";
  antiInversionRule: "NONE";
  separateElectricityCharge: false;
}

export interface ReferencePricingProductDto {
  productCode: string;
  roomTypeKey: string;
  inventoryUnitKind: InventoryUnitKind;
  anchorMultiplier: 1 | 2 | 4;
  anchorsMinor: { "1": number; "7": number; "14": number; "30": number };
  derivation: "SOURCE_PUBLISHED" | "BED_ANCHORS_TIMES_PHYSICAL_BEDS";
}

export interface ReferenceRateDto {
  id: string;
  inventoryCatalogEntryId: string;
  packageNights: 1 | 7 | 14 | 30;
  packageAmountMinor: number;
  currency: string;
  executionState: "REFERENCE_ONLY";
  sourceSheet: string;
  sourceRange: string;
}

export interface ReferenceMembershipProductDto {
  id: string;
  inventoryCatalogEntryId: string;
  code: string;
  name: string;
  priceMinor: number;
  currency: string;
  salesLimit: number;
  entitlementNights: number;
  validityPeriod: string;
  executionState: "REFERENCE_ONLY";
  terms: {
    entitlementUnit: EntitlementUnitKind;
    quotaMeaning: "MEMBERSHIP_SLOTS_NOT_INVENTORY";
    validityStartsAt: "PAYMENT_DATE";
    membershipRules: {
      bookingRule: string;
      refundPolicy: "NON_REFUNDABLE_MEMBERSHIP";
      refundRule: string;
      overriddenSourceRefundRule: string;
      refundCalculation: null;
      sourceRange: string;
    };
  };
  sourceSheet: string;
  sourceRange: string;
}

export interface ReferenceCatalogDto {
  batch: ReferenceCatalogBatchDto;
  inventoryEntries: ReferenceInventoryCatalogEntryDto[];
  rates: ReferenceRateDto[];
  rooms: ReferencePhysicalRoomDto[];
  pricingRule: ReferencePricingRuleDto;
  pricingProducts: ReferencePricingProductDto[];
  rejectedSourceFigures: Array<{ name: string; value: number; reason: string }>;
  membershipProducts: ReferenceMembershipProductDto[];
  unresolvedIssues: Array<{ code: string; description: string }>;
}

export interface CoverageItemDto {
  serviceDate: string;
  inventoryUnitId: string;
  unitKind: EntitlementUnitKind;
  entitlementLotId: string;
}

export interface TemporaryOtherRoomArrangementDto {
  kind: "TEMPORARY_OTHER_ROOM";
  membershipOrderId: string;
  memberContractId: string;
  entitlementLotId: string;
  originalRoomTypeCode: string;
  originalInventoryKind: "ROOM";
  entitlementUnitKind: "ROOM_NIGHT";
  actualInventoryUnitId: string;
  actualRoomTypeCode: string;
  actualInventoryKind: "ROOM";
  arrivalDate: string;
  departureDate: string;
}

export interface NightlyCashLineDto {
  lineKind?: "NIGHT";
  serviceDate: string;
  inventoryUnitId: string;
  description: string;
  amount: MoneyDto;
}

export interface StayTotalCashLineDto {
  lineKind: "STAY_TOTAL";
  arrivalDate: string;
  departureDate: string;
  inventoryUnitId: string;
  description: string;
  pricingBandAnchorNights: 1 | 7 | 14 | 30;
  calculationSegments: Array<{
    inventoryUnitId: string;
    pricingProductCode: string;
    arrivalDate: string;
    departureDate: string;
    nights: number;
    anchorAmountMinor: number;
    numeratorMinor: number;
    denominator: number;
  }>;
  amount: MoneyDto;
}

export type CashLineDto = NightlyCashLineDto | StayTotalCashLineDto;

export interface QuoteStayTotalCashLineDto {
  lineKind: "STAY_TOTAL";
  arrivalDate: string;
  departureDate: string;
  inventoryUnitId: string;
  description: string;
  pricingBandAnchorNights: 1 | 7 | 14 | 30;
  pricingSummary: string;
  amount: MoneyDto;
}

export type QuoteCashLineDto = NightlyCashLineDto | QuoteStayTotalCashLineDto;

export interface QuotePricingExplanationDto {
  pricingModel: "NIGHTLY" | "DURATION_BAND_TOTAL" | "FREE" | "MEMBER_ENTITLEMENT";
  totalNights: number;
  quoteAmount: MoneyDto;
  amountField: "currentContractAmount";
  summary: string;
  agentInstruction: string;
  durationBand?: {
    anchorNights: 1 | 7 | 14 | 30;
    finalAmount: MoneyDto;
    roundingRule: "FINAL_STAY_TOTAL_WHOLE_YUAN_HALF_UP";
    auditCalculationFieldsAreAmounts: false;
    segments: Array<{
      inventoryUnitId: string;
      pricingProductCode: string;
      arrivalDate: string;
      departureDate: string;
      nights: number;
      anchorAmount: MoneyDto;
      summary: string;
    }>;
  };
}

export interface QuoteDto {
  quoteId: string;
  propertyId: string;
  inventoryUnitId: string;
  stayType: StayType;
  arrivalDate: string;
  departureDate: string;
  pricingPolicyVersionId: string;
  coverageSet: CoverageItemDto[];
  cashLines: QuoteCashLineDto[];
  cashRemainder: MoneyDto;
  currentContractAmount: MoneyDto;
  pricingExplanation?: QuotePricingExplanationDto;
  expiresAt: string;
  memberId?: string;
  memberContractId?: string;
  temporaryOtherRoomArrangement?: TemporaryOtherRoomArrangementDto;
}

export interface CreateQuoteCommandInputDto {
  propertyId: string;
  inventoryUnitId: string;
  stayType?: StayType;
  arrivalDate: string;
  departureDate: string;
  pricingPolicyVersionId: string;
  memberId?: string;
  memberContractId?: string;
  temporaryOtherRoom?: true;
}

export interface StoredQuoteDto extends Omit<QuoteDto, "cashLines"> {
  cashLines: CashLineDto[];
  memberContractId?: string;
  inputHash: string;
}

export interface QuoteReadDto extends QuoteDto {
  inputHash: string;
}

export interface AmountSummaryDto {
  currentContractAmount: MoneyDto;
  netRecordedCollection: MoneyDto;
  collectionDifference: MoneyDto;
  refundReferenceAmount: MoneyDto;
}

export const roomStatusStatuses = [
  "AVAILABLE",
  "RESERVED",
  "IN_HOUSE",
  "CLEANING",
  "MAINTENANCE",
  "UNAVAILABLE",
  "SETTLED",
  "ARREARS",
  "STALE",
  "UNKNOWN"
] as const;
export type RoomStatusStatus = (typeof roomStatusStatuses)[number];

export const roomStatusAttentionCodes = ["ARREARS"] as const;
export type RoomStatusAttention = (typeof roomStatusAttentionCodes)[number];

export const roomStatusOperationalAttentionCodes = ["DUE_OUT", "OVERDUE_RESERVED", "OVERDUE_IN_HOUSE"] as const;
export type RoomStatusOperationalAttention = (typeof roomStatusOperationalAttentionCodes)[number];

export const ROOM_STATUS_MAX_QUERY_NIGHTS = 30;
export const ROOM_STATUS_OPERATIONAL_TASK_LIMIT = 500;

export const roomStatusActionCodes = [
  "CREATE_ORDER",
  "CREATE_FREE_STAY",
  "BACKFILL_ORDER",
  "LOCK_MAINTENANCE",
  "OPEN_ORDER",
  "RELEASE_MAINTENANCE",
  "COMPLETE_CLEANING"
] as const;
export type RoomStatusActionCode = (typeof roomStatusActionCodes)[number];

export const roomStatusSourceKinds = [
  "ORDER",
  "FREE_STAY",
  "MAINTENANCE",
  "CLEANING",
  "UNIT_UNSELLABLE"
] as const;
export type RoomStatusSourceKind = (typeof roomStatusSourceKinds)[number];

export const roomStatusOperationalTaskKinds = ["ARRIVAL", "IN_HOUSE", "DEPARTURE", "EXCEPTION"] as const;
export type RoomStatusOperationalTaskKind = (typeof roomStatusOperationalTaskKinds)[number];

export const roomStatusBlockingFactKinds = ["CLAIM", "DUE_OUT", "LODGING_ORDER", "OVERDUE_IN_HOUSE", "UNIT_UNSELLABLE"] as const;
export type RoomStatusBlockingFactKind = (typeof roomStatusBlockingFactKinds)[number];

export interface RoomStatusReferenceDto {
  type: "CLAIM" | "ORDER" | "STAY" | "OPERATIONS" | "BLOCK" | "INVENTORY_UNIT" | "RECEIPT";
  id: string;
  label: string;
  href: string | null;
}

export interface RoomStatusActionDto {
  code: RoomStatusActionCode;
  enabled: boolean;
  disabledReason: string | null;
  requiresFullInterval: boolean;
  targetReference: RoomStatusReferenceDto | null;
}

export interface RoomStatusHistoryDto {
  action: string;
  actorId: string | null;
  source: "WEB_SESSION" | "API_TOKEN" | "SYSTEM" | "UNKNOWN";
  occurredAt: string;
  commandId: string | null;
  receiptId: string | null;
  correlationId: string | null;
}

export interface RoomStatusConflictDto {
  id: string;
  blockingFactKind: RoomStatusBlockingFactKind;
  claimId: string | null;
  claimIds: string[];
  requestedInventoryUnitId: string;
  actualInventoryUnitId: string;
  roomId: string;
  startDate: string;
  endDate: string;
  sourceKind: RoomStatusSourceKind;
  sourceReference: RoomStatusReferenceDto;
  reason: string;
  blocking: true;
}

export interface RoomStatusDayDto {
  serviceDate: string;
  status: RoomStatusStatus;
  available: boolean;
  intervalIds: string[];
  conflicts: RoomStatusConflictDto[];
}

export interface RoomStatusIntervalDto {
  id: string;
  displayInventoryUnitId: string;
  actualInventoryUnitId: string;
  roomId: string;
  startDate: string;
  endDate: string;
  sourceStartDate: string;
  sourceEndDate: string;
  /** Original order arrival date. Omitted for non-lodging and legacy projections. */
  orderArrivalDate?: string;
  /** Original order departure date. Omitted for non-lodging and legacy projections. */
  orderDepartureDate?: string;
  status: RoomStatusStatus;
  attention: RoomStatusAttention | null;
  operationalAttention: RoomStatusOperationalAttention | null;
  available: boolean;
  blocking: boolean;
  sourceKind: RoomStatusSourceKind;
  sourceCategory: RoomStatusSourceCategory | null;
  freeStayCategoryCode: FreeStayCategoryCode | null;
  freeStayReason: string | null;
  label: string;
  primaryOccupantLabel: string | null;
  occupantCount: number;
  occupants: RoomStatusOccupantDto[];
  reason: string | null;
  claimIds: string[];
  references: RoomStatusReferenceDto[];
  conflicts: RoomStatusConflictDto[];
  history: RoomStatusHistoryDto[];
  allowedActions: RoomStatusActionDto[];
}

export interface RoomStatusOccupantDto {
  occupantId: string;
  nickname: string | null;
}

export interface RoomStatusOperationalTaskDto extends RoomStatusIntervalDto {
  taskKind: RoomStatusOperationalTaskKind;
  businessDate: string;
}

export interface RoomStatusBedOccupantDto {
  occupantId: string;
  inventoryUnitId: string;
  inventoryUnitCode: string;
  primaryOccupantLabel: string | null;
  sourceReference: RoomStatusReferenceDto & { type: "ORDER" };
}

export interface RoomStatusBedOccupancyDto {
  serviceDate: string;
  occupiedBedCount: number;
  totalBedCount: number;
  occupants: RoomStatusBedOccupantDto[];
}

export interface RoomStatusBedSlotStateDto {
  serviceDate: string;
  inventoryUnitId: string;
  inventoryUnitCode: string;
  status: RoomStatusStatus;
}

export interface RoomStatusAvailabilitySummaryDto {
  serviceDate: string;
  availableRooms: number;
  availableBeds: number;
  paidOccupiedUnits: number;
  totalSellableUnits: number;
  occupantCount: number;
}

export interface RoomStatusUnitDto {
  id: string;
  propertyId: string;
  roomId: string;
  parentRoomId: string | null;
  kind: InventoryUnitKind;
  code: string;
  name: string;
  active: boolean;
  salesMode: "WHOLE_ROOM" | "BED_SPLIT" | "UNAVAILABLE";
  buildingCode: string | null;
  roomTypeCode: string | null;
  pricingProductCode: string | null;
  physicalBedCount: number | null;
  /** Compatibility capacity. Presentation must use physicalBedCount for physical-bed ratios. */
  capacity: number;
  occupancyCapacity: number;
  childUnitIds: string[];
  children: RoomStatusUnitDto[];
  bedOccupancies: RoomStatusBedOccupancyDto[];
  bedSlotStates: RoomStatusBedSlotStateDto[];
  days: RoomStatusDayDto[];
  intervals: RoomStatusIntervalDto[];
  conflicts: RoomStatusConflictDto[];
  allowedActions: RoomStatusActionDto[];
}

export interface RoomStatusFilterOptionsDto {
  roomTypeCodes: string[];
  salesModes: RoomStatusUnitDto["salesMode"][];
  statuses: RoomStatusStatus[];
  capacities: number[];
  unitKinds: InventoryUnitKind[];
}

export interface RoomStatusBoardQueryDto {
  arrivalDate: string;
  departureDate: string;
  page?: number;
  pageSize?: number;
  search?: string;
  roomType?: string;
  salesMode?: RoomStatusUnitDto["salesMode"];
  status?: RoomStatusStatus;
  minCapacity?: number;
  unitKind?: InventoryUnitKind;
}

export interface RoomStatusBoardDto {
  propertyId: string;
  businessDate: string;
  range: {
    arrivalDate: string;
    departureDate: string;
  };
  dates: string[];
  asOf: string;
  freshUntil: string;
  revision: string;
  accessLevel: AccessLevel;
  projectionState: "READY" | "PARTIAL";
  filterOptions: RoomStatusFilterOptionsDto;
  page: {
    index: number;
    size: number;
    totalRooms: number;
    totalPages: number;
  };
  operationalTasks: RoomStatusOperationalTaskDto[];
  availabilitySummary: RoomStatusAvailabilitySummaryDto[];
  rooms: RoomStatusUnitDto[];
}

export interface CompleteCleaningInput {
  propertyId: string;
  cleaningTaskId: string;
}

export interface CommandReason {
  code: string;
  note: string;
}

export interface PreviewDto {
  previewId: string;
  commandType: CommandType;
  effectHash: string;
  effect: Record<string, unknown>;
  expiresAt: string;
}

export interface ReceiptDto {
  receiptId: string;
  commandId: string;
  executionStatus: "EXECUTED" | "NOT_EXECUTED" | "UNKNOWN";
  businessCommitted: boolean;
  correlationId: string;
  result?: Record<string, unknown>;
  error?: ErrorDto;
  resourceRefs: string[];
  factRefs: string[];
  committedAt?: string;
}

export interface CreateQuoteCommandResponseDto {
  quote: QuoteReadDto;
  receipt: ReceiptDto;
}

export interface ErrorDto {
  code: ErrorCode;
  message: string;
  correlationId: string;
  retryable: boolean;
  commandId?: string;
  receiptId?: string;
  details?: Record<string, unknown>;
}

export interface AuthPrincipal {
  subjectId: string;
  credentialId: string;
  credentialType: "SESSION" | "TOKEN";
  displayName: string;
  propertyAccess: Map<string, AccessLevel>;
  propertyCommandGrants: ReadonlyMap<string, ReadonlySet<CommandCatalogType>>;
  tokenCommandCeiling: ReadonlySet<CommandCatalogType> | null;
}

export interface CommandEnvelope {
  commandType: CommandType;
  input: Record<string, unknown>;
}

export interface PrimaryGuestSnapshotDto {
  fullName: string;
  nickname?: string | null;
  phone?: string;
  documentNumber?: string;
}

export interface CreateOrderPrimaryGuestInputDto extends PrimaryGuestSnapshotDto {
  nickname: string;
}

export type CreateOrderAdditionalGuestInputDto = CreateOrderPrimaryGuestInputDto;

export interface CreateOrderInputDto {
  propertyId: string;
  quoteId: string;
  primaryGuest: CreateOrderPrimaryGuestInputDto;
  additionalGuests?: CreateOrderAdditionalGuestInputDto[];
  bookingChannelCode?: BookingChannelCode;
  channelOrderReference?: string | null;
  targetCurrentContractAmountMinor?: number;
  channelPriceDifferenceReason?: string;
  manualPriceAdjustmentReason?: string;
  freeStayReason?: string;
  freeStayCategoryCode?: FreeStayCategoryCode;
  backfill?: true;
  backfillCollection?: BackfillCompletedStayCollectionInputDto;
  backfillReason?: string;
  temporaryOtherRoomReason?: string;
}

export interface RescheduleStayInputDto {
  propertyId: string;
  orderId: string;
  newArrivalDate: string;
  newDepartureDate: string;
  targetCurrentContractAmountMinor?: number;
  channelPriceDifferenceReason?: string;
  manualPriceAdjustmentReason?: string;
}

export interface ExtendStayInputDto {
  propertyId: string;
  orderId: string;
  newDepartureDate: string;
  targetCurrentContractAmountMinor?: number;
  channelPriceDifferenceReason?: string;
  manualPriceAdjustmentReason?: string;
}

export interface ShortenStayInputDto {
  propertyId: string;
  orderId: string;
  newDepartureDate: string;
  targetCurrentContractAmountMinor?: number;
  channelPriceDifferenceReason?: string;
  manualPriceAdjustmentReason?: string;
}

export interface MoveUnitInputDto {
  propertyId: string;
  orderId: string;
  newInventoryUnitId: string;
  effectiveDate: string;
  targetCurrentContractAmountMinor?: number;
  channelPriceDifferenceReason?: string;
  manualPriceAdjustmentReason?: string;
}

export interface RevokeCheckInInputDto {
  propertyId: string;
  orderId: string;
  unusedRoomConfirmed: true;
}

export type CompleteStayCollectionInputDto =
  | {
      amountMinor: number;
      method: "WECOM" | "BANK_TRANSFER";
      transactionReference?: string;
      note?: string;
      cashCollector?: never;
    }
  | {
      amountMinor: number;
      method: "CASH";
      cashCollector?: string;
      note?: string;
      transactionReference?: never;
    };

export interface CompleteStayInputDto {
  propertyId: string;
  orderId: string;
  actualStayCompletedConfirmed: true;
  reasonNote: string;
  collection?: CompleteStayCollectionInputDto;
}

export type BackfillCompletedStayCollectionInputDto =
  | {
      amountMinor: number;
      method: "WECOM" | "BANK_TRANSFER";
      transactionReference?: string;
      note?: string;
      cashCollector?: never;
    }
  | {
      amountMinor: number;
      method: "CASH";
      cashCollector?: string;
      note?: string;
      transactionReference?: never;
    };

export interface BackfillCompletedStayInputDto {
  propertyId: string;
  orderId: string;
  collection?: BackfillCompletedStayCollectionInputDto;
}

export interface CreateOrderPricingDecisionDto {
  pricingBasis: CreateOrderPricingBasis;
  policyBaseAmountMinor: number;
  currentContractAmountMinor: number;
  differenceFromPolicyMinor: number;
  manualAdjustmentMinor: number;
  differenceExceedsThreshold: boolean;
  reason: CommandReason;
}

export interface OrderOccupantDto {
  id: string;
  orderId: string;
  ordinal: number;
  role: "PRIMARY" | "ADDITIONAL";
  fullName: string | null;
  nickname: string | null;
  phone: string | null;
  documentNumber: string | null;
  createdAt: string;
}

export interface OrderOccupantSnapshotDto {
  fullName: string | null;
  nickname: string | null;
  phone: string | null;
  documentNumber: string | null;
}

export const orderActionCodes = [
  "CORRECT_ORDER_OCCUPANT",
  "MANAGE_ORDER_OCCUPANTS",
  "CHECK_IN",
  "CHECK_OUT",
  "REVOKE_CHECK_OUT",
  "COMPLETE_STAY",
  "RESCHEDULE_STAY",
  "SHORTEN_STAY",
  "EXTEND_STAY",
  "MOVE_UNIT",
  "REPRICE_ORDER",
  "CANCEL_ORDER",
  "MARK_NO_SHOW",
  "REVOKE_CHECK_IN",
  "RECORD_COLLECTION",
  "RECORD_REFUND",
  "REVERSE_FACT",
  "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP"
] as const;
export type OrderActionCode = (typeof orderActionCodes)[number];

export interface OrderAllowedActionDto {
  code: OrderActionCode;
  enabled: boolean;
  disabledReason: string | null;
}

export const fulfillmentRecordingModes = ["ON_SCHEDULE", "LATE_RECORDED", "LEGACY_UNCLASSIFIED"] as const;
export type FulfillmentRecordingMode = (typeof fulfillmentRecordingModes)[number];

export const orderFulfillmentStates = ["NOT_CHECKED_IN", "IN_HOUSE", "CHECKED_OUT", "CANCELLED", "NO_SHOW", "CHECK_IN_REVOKED"] as const;
export type OrderFulfillmentState = (typeof orderFulfillmentStates)[number];

export const orderEffectiveArrangementPresentations = ["CURRENT", "LAST", "BEFORE_CANCELLATION", "NO_SHOW_ORDER", "BEFORE_CHECK_IN_REVOCATION"] as const;
export type OrderEffectiveArrangementPresentation = (typeof orderEffectiveArrangementPresentations)[number];

export const orderArrangementChangeTypes = [
  "INITIAL_BOOKING",
  "RESCHEDULE",
  "EXTENSION",
  "SHORTENING",
  "MOVE",
  "EARLY_CHECK_OUT",
  "CHECK_OUT_REVOCATION",
  "HISTORICAL_STAY_CORRECTION"
] as const;
export type OrderArrangementChangeType = (typeof orderArrangementChangeTypes)[number];

export interface OrderArrangementIntervalDto {
  inventoryUnitId: string;
  arrivalDate: string;
  departureDate: string;
}

export interface OrderArrangementDto {
  arrivalDate: string;
  departureDate: string;
  intervals: OrderArrangementIntervalDto[];
}

export interface OrderEffectiveArrangementDto extends OrderArrangementDto {
  presentation: OrderEffectiveArrangementPresentation;
  businessDate: string;
}

export interface OrderArrangementPricingSummaryDto {
  policyBaseAmount: MoneyDto;
  currentContractAmount: MoneyDto;
  differenceFromPolicy: MoneyDto;
}

export interface OrderArrangementFundsSummaryDto {
  netRecordedCollection: MoneyDto;
  collectionDifference: MoneyDto;
  refundReferenceAmount: MoneyDto;
  factCount: number;
}

export interface OrderHistoricalStayCorrectionSnapshotDto {
  inventoryUnitId: string;
  arrivalDate: string;
  departureDate: string;
  nights: number;
  stayTimeline: Array<{
    serviceDate: string;
    inventoryUnitId: string;
  }>;
}

export interface OrderHistoricalStayCorrectionGroupDto {
  correctionSetHash: string;
  corrections: Array<{
    orderId: string;
    stayId: string;
    correctionId: string;
    amendmentId: string;
    staySegmentId: string;
    pricingRevisionId: string;
    before: OrderHistoricalStayCorrectionSnapshotDto;
    after: OrderHistoricalStayCorrectionSnapshotDto;
  }>;
  reason: { code: string; note: string };
  evidenceNote?: string;
  actor: { subjectId: string; displayName: string };
  recordedAt: string;
}

export interface OrderArrangementHistoryItemDto {
  type: OrderArrangementChangeType;
  before: OrderArrangementDto | null;
  after: OrderArrangementDto;
  reason: { code: string; note: string };
  actor: { subjectId: string; displayName: string } | null;
  recordedAt: string;
  pricingSummary: OrderArrangementPricingSummaryDto;
  fundsSummary: OrderArrangementFundsSummaryDto;
  correctionGroup?: OrderHistoricalStayCorrectionGroupDto;
}

export interface OrderFulfillmentRecordDto {
  type: "CHECK_IN" | "CHECK_OUT" | "REVOKE_CHECK_IN";
  plannedBusinessDate: string;
  recordedBusinessDate: string | null;
  recordingMode: FulfillmentRecordingMode;
  recordedAt: string;
  actor: { subjectId: string; displayName: string } | null;
  reason: { code: string; note: string };
}

export interface OrderFulfillmentProjectionDto {
  state: OrderFulfillmentState;
  checkIn: OrderFulfillmentRecordDto | null;
  checkOut: OrderFulfillmentRecordDto | null;
  checkInRevocation: OrderFulfillmentRecordDto | null;
}

export interface CorrectOrderOccupantInputDto {
  propertyId: string;
  orderId: string;
  occupantId: string;
  expectedPriorSnapshot: OrderOccupantSnapshotDto;
  correctedSnapshot: {
    fullName: string;
    nickname: string;
    phone: string | null;
    documentNumber: string | null;
  };
}

export interface CorrectOrderOccupantResultDto {
  orderId: string;
  occupantId: string;
  correctionId: string;
  amendmentId: string;
  occupant: CorrectOrderOccupantInputDto["correctedSnapshot"];
}

export interface CreateOrderResultDto {
  orderId: string;
  stayId: string;
  segmentId: string;
  pricingRevisionId: string;
  pricingPolicyVersionId: string;
  primaryGuest: PrimaryGuestSnapshotDto | null;
  occupants?: OrderOccupantDto[];
  bookingChannelCode: BookingChannelCode | null;
  channelOrderReference: string | null;
  freeStayReason: string | null;
  freeStayCategoryCode: FreeStayCategoryCode | null;
  temporaryOtherRoomArrangement?: TemporaryOtherRoomArrangementDto;
  temporaryOtherRoomCreateAmendmentId?: string;
  pricingDecision?: {
    pricingBasis: CreateOrderPricingBasis;
    policyBaseAmount: MoneyDto;
    targetCurrentContractAmount: MoneyDto;
    differenceFromPolicy: MoneyDto;
    manualAdjustmentMinor: number;
    differenceExceedsThreshold: boolean;
    reason: CommandReason;
  };
}

export interface CreateMemberInput {
  propertyId: string;
  fullName: string;
  nickname: string;
  identityCardNumber?: string | null;
  phone: string;
  wechat: string;
}

export interface CreateMemberResultDto {
  memberId: string;
  memberCreated: true;
}

export interface ExpireMemberEntitlementInput {
  propertyId: string;
  entitlementLotId: string;
  asOfDate: string;
}

export interface ExpireMemberEntitlementResultDto {
  entitlementLotId: string;
  contractId: string;
  factId: string;
  entryType: "EXPIRE";
  expiredUnits: number;
  remainingAvailable: 0;
  asOfDate: string;
}

export interface TokenIssueResultDto {
  tokenId: string;
  subjectId: string;
  accessCeiling: AccessLevel;
  commandCeiling: CommandCapability[];
  expiresAt: string;
}

export interface TokenRotationResultDto extends TokenIssueResultDto {
  rotatedFromTokenId: string;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, statusCode = 400, retryable = false, details?: Record<string, unknown>) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    if (details !== undefined) this.details = details;
  }
}

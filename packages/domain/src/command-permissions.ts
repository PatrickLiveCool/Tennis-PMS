import {
  currentReleaseFeatures,
  type AccessLevel,
  type CommandCapability,
  type CommandType
} from "@qintopia/contracts";

export const ordinaryStaffCommandGrants = [
  "CREATE_MEMBER",
  "CREATE_MEMBERSHIP_ORDER",
  "RECORD_MEMBERSHIP_PAYMENT",
  "CORRECT_MEMBERSHIP_PAYMENT",
  "ACTIVATE_MEMBERSHIP_ORDER",
  "CREATE_ORDER",
  "MANAGE_ORDER_OCCUPANTS",
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
  "RECORD_COLLECTION",
  "RECORD_REFUND",
  "REVERSE_FACT",
  "CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP",
  "CHECK_IN",
  "CHECK_OUT",
  "COMPLETE_STAY",
  "CORRECT_MEMBER_ENTITLEMENT_BALANCE"
] as const satisfies readonly CommandType[];

export const administratorCommandGrants = [
  ...ordinaryStaffCommandGrants,
  "MANAGE_ROOM_CATALOG",
  "REVOKE_CHECK_OUT",
  "CORRECT_ORDER_OCCUPANT",
  "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
  "CORRECT_MEMBER_PROFILE",
  "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
  "BACKFILL_HISTORICAL_MEMBERSHIP",
  "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY",
  "COMPLETE_CLEANING",
  "ISSUE_TOKEN",
  "ROTATE_TOKEN",
  "REVOKE_TOKEN"
] as const satisfies readonly CommandCapability[];

export const systemDerivedCommandTypes = [
  "REFRESH_MEMBER_COVERAGE",
  "ADD_MEMBER_ENTITLEMENT_LOT",
  "ADJUST_MEMBER_ENTITLEMENT",
  "EXPIRE_MEMBER_ENTITLEMENT"
] as const satisfies readonly CommandType[];

export const humanGrantableCommandTypes = [
  ...administratorCommandGrants
] as const satisfies readonly CommandCapability[];

const humanGrantableCommandSet = new Set<string>(humanGrantableCommandTypes);

export type CommandAuthorizationDenialReason =
  | "SUBJECT_DISABLED"
  | "PROPERTY_WRITE_REQUIRED"
  | "SUBJECT_COMMAND_GRANT_MISSING"
  | "TOKEN_COMMAND_CEILING_MISSING"
  | "FEATURE_DISABLED";

export interface CommandAuthorizationEvaluation {
  allowed: boolean;
  reason: CommandAuthorizationDenialReason | null;
}

export function commandFeatureEnabled(commandType: CommandCapability | string): boolean {
  if (commandType === "COMPLETE_CLEANING") return currentReleaseFeatures.cleaningWorkflow;
  if (commandType === "CORRECT_HISTORICAL_STAY_ARRANGEMENTS") {
    return currentReleaseFeatures.historicalStayArrangementCorrection;
  }
  if (commandType === "CORRECT_MEMBER_PROFILE") return currentReleaseFeatures.memberProfileCorrection;
  if (commandType === "CORRECT_MEMBERSHIP_EFFECTIVE_DATE") return currentReleaseFeatures.membershipEffectiveDateCorrection;
  if (commandType === "BACKFILL_HISTORICAL_MEMBERSHIP") return currentReleaseFeatures.historicalMembershipBackfill;
  if (commandType === "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY") {
    return currentReleaseFeatures.membershipConversionVoidCorrection;
  }
  return true;
}

export const enabledAdministratorCommandGrants = administratorCommandGrants
  .filter((commandType) => commandFeatureEnabled(commandType));

export const enabledAdministratorTokenCommandGrants = enabledAdministratorCommandGrants
  .filter((commandType) => commandType !== "MANAGE_ROOM_CATALOG");

function asSet(values: ReadonlySet<string> | readonly string[] | null | undefined): ReadonlySet<string> {
  if (!values) return new Set();
  return new Set(Array.isArray(values) ? values : [...values]);
}

export function isHumanGrantableCommandCapability(commandType: string): commandType is CommandCapability {
  return humanGrantableCommandSet.has(commandType);
}

export function evaluateCommandAuthorization(options: {
  commandType: CommandCapability | string;
  subjectStatus: "ACTIVE" | "DISABLED";
  propertyAccess: AccessLevel | undefined;
  subjectCommandGrants: ReadonlySet<string> | readonly string[];
  credentialType: "SESSION" | "TOKEN";
  tokenCommandCeiling: ReadonlySet<string> | readonly string[] | null;
  featureEnabled?: boolean;
}): CommandAuthorizationEvaluation {
  if (options.subjectStatus !== "ACTIVE") return { allowed: false, reason: "SUBJECT_DISABLED" };
  if (options.propertyAccess !== "WRITE") return { allowed: false, reason: "PROPERTY_WRITE_REQUIRED" };

  const subjectCommandGrants = asSet(options.subjectCommandGrants);
  if (!isHumanGrantableCommandCapability(options.commandType) || !subjectCommandGrants.has(options.commandType)) {
    return { allowed: false, reason: "SUBJECT_COMMAND_GRANT_MISSING" };
  }

  if (options.credentialType === "TOKEN") {
    const tokenCommandCeiling = asSet(options.tokenCommandCeiling);
    if (options.commandType === "MANAGE_ROOM_CATALOG" || !tokenCommandCeiling.has(options.commandType)) {
      return { allowed: false, reason: "TOKEN_COMMAND_CEILING_MISSING" };
    }
  }

  if (!(options.featureEnabled ?? commandFeatureEnabled(options.commandType))) {
    return { allowed: false, reason: "FEATURE_DISABLED" };
  }
  return { allowed: true, reason: null };
}

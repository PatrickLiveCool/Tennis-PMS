import { describe, expect, it } from "vitest";
import { commandTypes, currentReleaseFeatures, type CommandType } from "@qintopia/contracts";
import {
  administratorCommandGrants,
  evaluateCommandAuthorization,
  ordinaryStaffCommandGrants,
  systemDerivedCommandTypes
} from "./command-permissions.ts";

type ExpectedAuthority = {
  ordinaryStaff: boolean;
  administrator: boolean;
  systemDerived: boolean;
};

const expectedMatrix: Record<CommandType, ExpectedAuthority> = {
  MANAGE_ROOM_CATALOG: { ordinaryStaff: false, administrator: true, systemDerived: false },
  MANAGE_ORDER_OCCUPANTS: { ordinaryStaff: true, administrator: true, systemDerived: false },
  CREATE_MEMBER: { ordinaryStaff: true, administrator: true, systemDerived: false },
  CREATE_MEMBERSHIP_ORDER: { ordinaryStaff: true, administrator: true, systemDerived: false },
  RECORD_MEMBERSHIP_PAYMENT: { ordinaryStaff: true, administrator: true, systemDerived: false },
  CORRECT_MEMBERSHIP_PAYMENT: { ordinaryStaff: true, administrator: true, systemDerived: false },
  ACTIVATE_MEMBERSHIP_ORDER: { ordinaryStaff: true, administrator: true, systemDerived: false },
  CREATE_ORDER: { ordinaryStaff: true, administrator: true, systemDerived: false },
  CORRECT_ORDER_OCCUPANT: { ordinaryStaff: false, administrator: true, systemDerived: false },
  CORRECT_HISTORICAL_STAY_ARRANGEMENTS: { ordinaryStaff: false, administrator: true, systemDerived: false },
  CORRECT_MEMBER_PROFILE: { ordinaryStaff: false, administrator: true, systemDerived: false },
  CORRECT_MEMBERSHIP_EFFECTIVE_DATE: { ordinaryStaff: false, administrator: true, systemDerived: false },
  BACKFILL_HISTORICAL_MEMBERSHIP: { ordinaryStaff: false, administrator: true, systemDerived: false },
  VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY: { ordinaryStaff: false, administrator: true, systemDerived: false },
  RESCHEDULE_STAY: { ordinaryStaff: true, administrator: true, systemDerived: false },
  EXTEND_STAY: { ordinaryStaff: true, administrator: true, systemDerived: false },
  SHORTEN_STAY: { ordinaryStaff: true, administrator: true, systemDerived: false },
  MOVE_UNIT: { ordinaryStaff: true, administrator: true, systemDerived: false },
  REPRICE_ORDER: { ordinaryStaff: true, administrator: true, systemDerived: false },
  CANCEL_ORDER: { ordinaryStaff: true, administrator: true, systemDerived: false },
  MARK_NO_SHOW: { ordinaryStaff: true, administrator: true, systemDerived: false },
  REVOKE_CHECK_IN: { ordinaryStaff: true, administrator: true, systemDerived: false },
  LOCK_MAINTENANCE: { ordinaryStaff: true, administrator: true, systemDerived: false },
  RELEASE_MAINTENANCE: { ordinaryStaff: true, administrator: true, systemDerived: false },
  COMPLETE_CLEANING: { ordinaryStaff: false, administrator: true, systemDerived: false },
  RECORD_COLLECTION: { ordinaryStaff: true, administrator: true, systemDerived: false },
  RECORD_REFUND: { ordinaryStaff: true, administrator: true, systemDerived: false },
  REVERSE_FACT: { ordinaryStaff: true, administrator: true, systemDerived: false },
  CONVERT_STAY_COLLECTIONS_TO_MEMBERSHIP: { ordinaryStaff: true, administrator: true, systemDerived: false },
  CHECK_IN: { ordinaryStaff: true, administrator: true, systemDerived: false },
  CHECK_OUT: { ordinaryStaff: true, administrator: true, systemDerived: false },
  REVOKE_CHECK_OUT: { ordinaryStaff: false, administrator: true, systemDerived: false },
  COMPLETE_STAY: { ordinaryStaff: true, administrator: true, systemDerived: false },
  REFRESH_MEMBER_COVERAGE: { ordinaryStaff: false, administrator: false, systemDerived: true },
  ADD_MEMBER_ENTITLEMENT_LOT: { ordinaryStaff: false, administrator: false, systemDerived: true },
  ADJUST_MEMBER_ENTITLEMENT: { ordinaryStaff: false, administrator: false, systemDerived: true },
  CORRECT_MEMBER_ENTITLEMENT_BALANCE: { ordinaryStaff: true, administrator: true, systemDerived: false },
  EXPIRE_MEMBER_ENTITLEMENT: { ordinaryStaff: false, administrator: false, systemDerived: true },
  ISSUE_TOKEN: { ordinaryStaff: false, administrator: true, systemDerived: false },
  ROTATE_TOKEN: { ordinaryStaff: false, administrator: true, systemDerived: false },
  REVOKE_TOKEN: { ordinaryStaff: false, administrator: true, systemDerived: false }
};

function authorized(overrides: Partial<Parameters<typeof evaluateCommandAuthorization>[0]> = {}) {
  return evaluateCommandAuthorization({
    commandType: "REPRICE_ORDER",
    subjectStatus: "ACTIVE",
    propertyAccess: "WRITE",
    subjectCommandGrants: new Set(["REPRICE_ORDER"]),
    credentialType: "SESSION",
    tokenCommandCeiling: null,
    featureEnabled: true,
    ...overrides
  });
}

describe("exact command permission profiles", () => {
  it("freezes the complete 41-command ordinary staff, administrator, and system-derived matrix", () => {
    expect(commandTypes).toHaveLength(41);
    expect(Object.keys(expectedMatrix).sort()).toEqual([...commandTypes].sort());

    const ordinary = new Set<string>(ordinaryStaffCommandGrants);
    const administrator = new Set<string>(administratorCommandGrants);
    const systemDerived = new Set<string>(systemDerivedCommandTypes);

    for (const commandType of commandTypes) {
      expect({
        ordinaryStaff: ordinary.has(commandType),
        administrator: administrator.has(commandType),
        systemDerived: systemDerived.has(commandType)
      }, commandType).toEqual(expectedMatrix[commandType]);
    }
  });

  it("keeps CREATE_QUOTE under the separate READ protocol instead of a write-command profile", () => {
    expect(ordinaryStaffCommandGrants).not.toContain("CREATE_QUOTE");
    expect(administratorCommandGrants).not.toContain("CREATE_QUOTE");
    expect(systemDerivedCommandTypes).not.toContain("CREATE_QUOTE");
  });

  it("publishes the five administrator corrections as exact enabled capabilities", () => {
    expect(administratorCommandGrants).toEqual(expect.arrayContaining([
      "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
      "CORRECT_MEMBER_PROFILE",
      "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      "BACKFILL_HISTORICAL_MEMBERSHIP",
      "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY"
    ]));
    for (const commandType of [
      "CORRECT_HISTORICAL_STAY_ARRANGEMENTS",
      "CORRECT_MEMBER_PROFILE",
      "CORRECT_MEMBERSHIP_EFFECTIVE_DATE",
      "BACKFILL_HISTORICAL_MEMBERSHIP",
      "VOID_ERRONEOUS_MEMBERSHIP_AND_RECONVERT_STAY"
    ] as const) {
      expect(evaluateCommandAuthorization({
        commandType,
        subjectStatus: "ACTIVE",
        propertyAccess: "WRITE",
        subjectCommandGrants: new Set(administratorCommandGrants),
        credentialType: "SESSION",
        tokenCommandCeiling: null,
        featureEnabled: true
      })).toEqual({ allowed: true, reason: null });
    }
  });

  it("uses exact normalized command matches without wildcard, prefix, case, or role-name inference", () => {
    for (const nonExactGrant of ["REPRICE_*", "REPRICE", "reprice_order", "ADMIN", "*"]) {
      expect(authorized({ subjectCommandGrants: new Set([nonExactGrant]) })).toMatchObject({
        allowed: false,
        reason: "SUBJECT_COMMAND_GRANT_MISSING"
      });
    }
    expect(authorized()).toEqual({ allowed: true, reason: null });
  });

  it("requires every member of the subject, property, grant, Token ceiling, and feature intersection", () => {
    expect(authorized({ subjectStatus: "DISABLED" })).toMatchObject({ allowed: false, reason: "SUBJECT_DISABLED" });
    expect(authorized({ propertyAccess: undefined })).toMatchObject({ allowed: false, reason: "PROPERTY_WRITE_REQUIRED" });
    expect(authorized({ propertyAccess: "READ" })).toMatchObject({ allowed: false, reason: "PROPERTY_WRITE_REQUIRED" });
    expect(authorized({ subjectCommandGrants: new Set() })).toMatchObject({ allowed: false, reason: "SUBJECT_COMMAND_GRANT_MISSING" });
    expect(authorized({
      credentialType: "TOKEN",
      tokenCommandCeiling: new Set(["RECORD_COLLECTION"])
    })).toMatchObject({ allowed: false, reason: "TOKEN_COMMAND_CEILING_MISSING" });
    expect(authorized({
      credentialType: "TOKEN",
      tokenCommandCeiling: new Set(["REPRICE_ORDER"])
    })).toEqual({ allowed: true, reason: null });
    expect(authorized({ featureEnabled: false })).toMatchObject({ allowed: false, reason: "FEATURE_DISABLED" });
  });

  it("does not activate COMPLETE_CLEANING merely because an administrator has its exact grant", () => {
    expect(administratorCommandGrants).toContain("COMPLETE_CLEANING");
    expect(currentReleaseFeatures.cleaningWorkflow).toBe(false);
    expect(authorized({
      commandType: "COMPLETE_CLEANING",
      subjectCommandGrants: new Set(administratorCommandGrants),
      featureEnabled: currentReleaseFeatures.cleaningWorkflow
    })).toMatchObject({ allowed: false, reason: "FEATURE_DISABLED" });
  });

  it("never turns a system-derived command into an artificial human-subject grant", () => {
    for (const commandType of systemDerivedCommandTypes) {
      expect(authorized({
        commandType,
        subjectCommandGrants: new Set(administratorCommandGrants),
        featureEnabled: true
      })).toMatchObject({ allowed: false, reason: "SUBJECT_COMMAND_GRANT_MISSING" });
    }
  });
});

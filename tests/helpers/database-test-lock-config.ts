const defaultServerUrl = "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia";

export const resetDatabaseTargets = [
  ["ROOM_CATALOG_TEST_DATABASE_URL", "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_room_catalog_test"],
  ["TEST_DATABASE_URL", "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_test"],
  ["E2E_DATABASE_URL", "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_e2e"],
  ["COMMAND_PROTOCOL_DATABASE_URL", "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_command_protocol"],
  ["QUOTE_COMMAND_INTEGRATION_DATABASE_URL", "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_quote_command"],
  ["INVARIANTS_INTEGRATION_DATABASE_URL", "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_database_invariants"],
  ["PRICING_POLICY_GUARD_INTEGRATION_DATABASE_URL", "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_pricing_policy_guard"],
  ["SECURITY_INTEGRATION_DATABASE_URL", "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_security_integration"],
  ["RECEIPT_REFERENCES_INTEGRATION_DATABASE_URL", "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_receipt_references"],
  ["SECURITY_CONTRACT_DATABASE_URL", "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_security_contract"],
  ["AGENT_JOURNEY_CONTRACT_DATABASE_URL", "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_agent_journey_contract"],
  ["EFFECT_CONTRACT_DATABASE_URL", "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_effect_contract"],
  ["REFERENCE_CATALOG_INTEGRATION_DATABASE_URL", "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_reference_catalog"],
  ["OPERATIONAL_REFERENCES_INTEGRATION_DATABASE_URL", "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_operational_references"],
  ["OPERATIONAL_REFERENCES_HISTORY_DATABASE_URL", "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_operational_references_history"],
  ["MEMBER_PROFILE_LIFECYCLE_DATABASE_URL", "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_member_profile_lifecycle"],
  ["MEMBER_ENTITLEMENT_EXPIRY_DATABASE_URL", "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_member_entitlement_expiry"],
  ["STAY_COLLECTION_MEMBERSHIP_CONVERSION_DATABASE_URL", "postgres://qintopia:qintopia@127.0.0.1:55432/qintopia_stay_collection_membership_conversion"]
] as const;

function databaseName(urlValue: string): string {
  const url = new URL(urlValue);
  return decodeURIComponent(url.pathname.replace(/^\/+/, ""));
}

export function assertDatabaseTestRunnerPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    throw new Error("The database test suite lock runner requires a POSIX platform for verified process-group cleanup");
  }
}

export function resolveLockDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = environment.TEST_SUITE_LOCK_DATABASE_URL;
  if (explicit) return new URL(explicit).toString();

  const source = resetDatabaseTargets
    .map(([name]) => environment[name])
    .find((value): value is string => Boolean(value))
    ?? environment.DATABASE_URL
    ?? defaultServerUrl;
  const url = new URL(source);
  url.pathname = "/postgres";
  url.hash = "";
  return url.toString();
}

export function assertLockDatabaseIsNotResetTarget(
  lockDatabaseUrl: string,
  environment: NodeJS.ProcessEnv = process.env
): void {
  const lockDatabase = databaseName(lockDatabaseUrl);
  for (const [name, fallback] of resetDatabaseTargets) {
    const resetUrl = environment[name] ?? fallback;
    if (databaseName(resetUrl) === lockDatabase) {
      throw new Error(
        `Test suite lock database ${lockDatabase} is also a database reset target (${name}); choose a stable administrative database with a distinct database name`
      );
    }
  }
}

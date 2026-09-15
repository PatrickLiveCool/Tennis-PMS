import type { AccessLevel, AuthPrincipal, CommandCapability, CommandCatalogType } from "@qintopia/contracts";
import { administratorCommandGrants, enabledAdministratorTokenCommandGrants, ordinaryStaffCommandGrants } from "@qintopia/domain";

const defaultTestPropertyId = "prop_qintopia_demo";

type CredentialType = AuthPrincipal["credentialType"];
type CommandProfile = "ordinary" | "administrator";

export function commandGrantsForProfile(profile: CommandProfile): CommandCapability[] {
  return profile === "administrator"
    ? [...administratorCommandGrants]
    : [...ordinaryStaffCommandGrants];
}

export function tokenCeilingForProfile(profile: CommandProfile): CommandCapability[] {
  return profile === "administrator"
    ? [...enabledAdministratorTokenCommandGrants]
    : [...ordinaryStaffCommandGrants];
}

export function commandGrantSetForProfile(profile: CommandProfile): ReadonlySet<CommandCapability> {
  return new Set(commandGrantsForProfile(profile));
}

export function authScope(options: {
  propertyId?: string;
  accessLevel?: AccessLevel;
  credentialType?: CredentialType;
  profile?: CommandProfile;
} = {}): Pick<AuthPrincipal, "propertyAccess" | "propertyCommandGrants" | "tokenCommandCeiling"> {
  const propertyId = options.propertyId ?? defaultTestPropertyId;
  const accessLevel = options.accessLevel ?? "WRITE";
  const credentialType = options.credentialType ?? "TOKEN";
  const profile = options.profile ?? "ordinary";
  const grants = new Set<CommandCatalogType>(commandGrantsForProfile(profile));
  const tokenCeiling = new Set<CommandCatalogType>(tokenCeilingForProfile(profile));
  return {
    propertyAccess: new Map([[propertyId, accessLevel]]),
    propertyCommandGrants: new Map([[propertyId, grants]]),
    tokenCommandCeiling: credentialType === "TOKEN"
      ? (accessLevel === "WRITE" ? tokenCeiling : new Set<CommandCatalogType>())
      : null
  };
}

export function emptyAuthScope(options: {
  credentialType?: CredentialType;
} = {}): Pick<AuthPrincipal, "propertyAccess" | "propertyCommandGrants" | "tokenCommandCeiling"> {
  return {
    propertyAccess: new Map(),
    propertyCommandGrants: new Map(),
    tokenCommandCeiling: options.credentialType === "SESSION" ? null : new Set<CommandCatalogType>()
  };
}

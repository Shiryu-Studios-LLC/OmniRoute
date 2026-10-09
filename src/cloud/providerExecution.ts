/** Who controls the credentials or upstream account for a provider integration. */
export const PROVIDER_OWNERSHIP_MODES = [
  "customer_managed",
  "shiryu_hosted",
  "third_party",
] as const;

export type ProviderOwnershipMode = (typeof PROVIDER_OWNERSHIP_MODES)[number];

/** Where inference is executed. Customer Local Agents are customer_environment. */
export const PROVIDER_EXECUTION_LOCATIONS = [
  "customer_environment",
  "shiryu_hosted",
  "third_party",
] as const;

export type ProviderExecutionLocation = (typeof PROVIDER_EXECUTION_LOCATIONS)[number];

export interface ProviderExecutionContract {
  credentialOwnership: ProviderOwnershipMode;
  executionLocation: ProviderExecutionLocation;
}

export const LEGACY_PROVIDER_EXECUTION_CONTRACT: ProviderExecutionContract = {
  credentialOwnership: "customer_managed",
  executionLocation: "third_party",
};

export function isProviderOwnershipMode(value: unknown): value is ProviderOwnershipMode {
  return PROVIDER_OWNERSHIP_MODES.some((candidate) => candidate === value);
}

export function isProviderExecutionLocation(value: unknown): value is ProviderExecutionLocation {
  return PROVIDER_EXECUTION_LOCATIONS.some((candidate) => candidate === value);
}

export function validateProviderExecutionContract(value: {
  credentialOwnership?: unknown;
  executionLocation?: unknown;
}): ProviderExecutionContract {
  const credentialOwnership =
    value.credentialOwnership ?? LEGACY_PROVIDER_EXECUTION_CONTRACT.credentialOwnership;
  const executionLocation =
    value.executionLocation ?? LEGACY_PROVIDER_EXECUTION_CONTRACT.executionLocation;

  if (!isProviderOwnershipMode(credentialOwnership)) {
    throw new Error("Invalid provider ownership mode");
  }
  if (!isProviderExecutionLocation(executionLocation)) {
    throw new Error("Invalid provider execution location");
  }

  return { credentialOwnership, executionLocation };
}

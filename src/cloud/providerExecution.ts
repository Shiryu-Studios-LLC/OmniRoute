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

/**
 * Models accepted by the customer OpenAI Responses bridge. Keep this deliberately
 * explicit: that bridge only supports plain-text input and the Responses API
 * count/generation contract, and tenant D1 entitlements must still enable each
 * model before it can be called.
 */
export const CLOUD_OPENAI_RESPONSES_MODELS = [
  "gpt-4o-mini-2024-07-18",
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4o-2024-08-06",
  "gpt-4o-2024-11-20",
  "gpt-4.1-mini",
  "gpt-4.1-mini-2025-04-14",
  "gpt-4.1-nano",
  "gpt-4.1-nano-2025-04-14",
  "gpt-4.1",
  "gpt-4.1-2025-04-14",
] as const;

export type CloudOpenAiResponsesModel = (typeof CLOUD_OPENAI_RESPONSES_MODELS)[number];

/** Exact Anthropic model IDs supported by the narrow cloud Messages adapter. */
export const CLOUD_ANTHROPIC_MESSAGES_MODELS = ["claude-sonnet-4-6"] as const;

export type CloudAnthropicMessagesModel = (typeof CLOUD_ANTHROPIC_MESSAGES_MODELS)[number];

export function isCloudAnthropicMessagesModel(
  value: unknown
): value is CloudAnthropicMessagesModel {
  return (
    typeof value === "string" && CLOUD_ANTHROPIC_MESSAGES_MODELS.some((model) => model === value)
  );
}

export function isCloudOpenAiResponsesModel(value: unknown): value is CloudOpenAiResponsesModel {
  return (
    typeof value === "string" && CLOUD_OPENAI_RESPONSES_MODELS.some((model) => model === value)
  );
}

const CLOUD_OPENAI_RESPONSES_MODEL_OUTPUTS: Record<string, readonly string[]> = {
  "gpt-4o-mini-2024-07-18": ["gpt-4o-mini-2024-07-18"],
  "gpt-4o-mini": ["gpt-4o-mini", "gpt-4o-mini-2024-07-18"],
  "gpt-4o": ["gpt-4o", "gpt-4o-2024-08-06", "gpt-4o-2024-11-20"],
  "gpt-4o-2024-08-06": ["gpt-4o-2024-08-06"],
  "gpt-4o-2024-11-20": ["gpt-4o-2024-11-20"],
  "gpt-4.1-mini": ["gpt-4.1-mini", "gpt-4.1-mini-2025-04-14"],
  "gpt-4.1-mini-2025-04-14": ["gpt-4.1-mini-2025-04-14"],
  "gpt-4.1-nano": ["gpt-4.1-nano", "gpt-4.1-nano-2025-04-14"],
  "gpt-4.1-nano-2025-04-14": ["gpt-4.1-nano-2025-04-14"],
  "gpt-4.1": ["gpt-4.1", "gpt-4.1-2025-04-14"],
  "gpt-4.1-2025-04-14": ["gpt-4.1-2025-04-14"],
};

/** Accept only the requested alias or its documented dated snapshot in upstream results. */
export function isCloudOpenAiResponsesModelResult(
  requestedModel: string,
  responseModel: unknown
): responseModel is CloudOpenAiResponsesModel {
  return (
    typeof responseModel === "string" &&
    CLOUD_OPENAI_RESPONSES_MODEL_OUTPUTS[requestedModel]?.includes(responseModel) === true
  );
}

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

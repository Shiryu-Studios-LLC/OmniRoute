import { validateApiKey } from "@/lib/db/apiKeys";

/** Validate an OmniRoute API key, including configured passthrough keys. */
export async function isValidApiKey(apiKey: string): Promise<boolean> {
  if (!apiKey) return false;

  const envKey = process.env.OMNIROUTE_API_KEY || process.env.ROUTER_API_KEY;
  if (envKey && apiKey === envKey) return true;

  return validateApiKey(apiKey);
}

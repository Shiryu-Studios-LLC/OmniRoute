import type { RegistryEntry } from "../../shared.ts";

export const civitaiProvider: RegistryEntry = {
  id: "civitai",
  alias: "civit",
  // Civitai is a model/image catalog, not an LLM inference API. Keep it as a
  // custom, non-chat provider so it cannot accidentally enter Claude Code
  // routing or an LLM combo.
  format: "custom",
  executor: "default",
  baseUrl: "https://civitai.red/api/v1",
  modelsUrl: "https://civitai.red/api/v1/models?limit=100",
  authType: "apikey",
  authHeader: "Authorization",
  authPrefix: "Bearer",
  models: [],
  passthroughModels: false,
  liveCatalogAuthoritative: false,
};

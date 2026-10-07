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
  // Civitai is cursor-paginated; the discovery route supplies the page size
  // and supports query/cursor/exact-id on demand instead of baking a 100-row cap
  // into the registry configuration.
  modelsUrl: "https://civitai.red/api/v1/models",
  authType: "apikey",
  authHeader: "Authorization",
  authPrefix: "Bearer",
  models: [],
  passthroughModels: false,
  liveCatalogAuthoritative: false,
};

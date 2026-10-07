import type { RegistryEntry } from "../../shared.ts";

export const opencodeProvider: RegistryEntry = {
  id: "opencode",
  alias: "oc",
  format: "openai",
  executor: "opencode",
  baseUrl: "https://opencode.ai/zen/v1",
  modelsUrl: "https://opencode.ai/zen/v1/models",
  authType: "apikey",
  authHeader: "Authorization",
  authPrefix: "Bearer",
  passthroughModels: true,
  defaultContextLength: 200000,
  models: [
    // #2900: big-pickle's upstream runs DeepSeek thinking mode — declare the
    // interleaved reasoning_content contract so follow-up/tool-use turns replay
    // it (otherwise DeepSeek returns 400 "reasoning_content ... must be passed back").
    {
      id: "big-pickle",
      name: "Big Pickle",
      supportsReasoning: true,
      interleavedField: "reasoning_content",
    },
    // #MUSE_SPARK: Muse Spark is served by OpenCode Zen ONLY on the OpenAI
    // Responses API (https://opencode.ai/zen/v1/responses), not /chat/completions
    // (confirmed in the official OpenCode Zen docs: https://opencode.ai/docs/zen/).
    // Without targetFormat:"openai-responses" these models fall through to the
    // default chat/completions pass-through and the upstream returns null/empty
    // content (see issue #10867). The opencode provider is passthrough, so
    // declaring them here only sets the wire format / capability flags — the
    // live upstream model list already advertises both ids.
    // #12681: real window confirmed against the opencode-go registry's own
    // muse-spark-1.2-contributor entries (contextLength: 1048576, maxOutputTokens:
    // 131072) — without an explicit value here resolution fell back to the
    // provider-wide defaultContextLength (200000), understating the real window.
    {
      id: "muse-spark-1.2",
      name: "Muse Spark 1.2",
      supportsReasoning: true,
      targetFormat: "openai-responses",
      contextLength: 1048576,
      maxOutputTokens: 131072,
    },
    // Muse Spark 1.3 is served only on the Responses API, same as 1.2 above.
    // Its window matches the published OpenCode catalog instead of the
    // 200000 provider default.
    {
      id: "muse-spark-1.3",
      name: "Muse Spark 1.3",
      supportsReasoning: true,
      targetFormat: "openai-responses",
      contextLength: 1048576,
      maxOutputTokens: 131072,
    },
    {
      id: "muse-spark-1.3-contributor-free",
      name: "Muse Spark 1.3 Contributor Free",
      supportsReasoning: true,
      targetFormat: "openai-responses",
      contextLength: 1048576,
      maxOutputTokens: 131072,
    },
    // OpenCode's current Zen catalog (updated 2026-10-06) lists these as free.
    // Keep the no-auth registry aligned with the live /zen/v1/models catalog so the
    // dashboard exposes the current free pool instead of the July 2026 rotation.
    { id: "jev-1.13-free", name: "Jev 1.13 Free", contextLength: 200000 },
    { id: "exo-free", name: "Exo Free", contextLength: 200000 },
    {
      id: "muse-spark-1.2-contributor-free",
      name: "Muse Spark 1.2 Contributor Free",
      contextLength: 1048576,
      maxOutputTokens: 131072,
      targetFormat: "openai-responses",
      supportsReasoning: true,
    },
    { id: "space-bunny-free", name: "Space Bunny Free", contextLength: 200000 },
    { id: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview Free", contextLength: 200000 },
    { id: "fledge-alpha-free", name: "Fledge Alpha Free", contextLength: 200000 },
    { id: "mimo-v2.6-flash-free", name: "MiMo V2.6 Flash Free", contextLength: 200000 },
    { id: "mimo-v2.5-free", name: "MiMo V2.5 Free", contextLength: 131000 },
    { id: "hy3-free", name: "HY3 Free", contextLength: 131000 },
    { id: "north-mini-code-free", name: "North Mini Code Free", contextLength: 131000 },
    { id: "ling-3.1-flash-free", name: "Ling 3.1 Flash Free", contextLength: 200000 },
    { id: "ling-3.0-flash-fin-free", name: "Ling 3.0 Flash Fin Free", contextLength: 200000 },
    { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free", contextLength: 1000000 },
    {
      id: "nemotron-3.5-lightning-free",
      name: "Nemotron 3.5 Lightning Free",
      contextLength: 200000,
    },
  ],
};

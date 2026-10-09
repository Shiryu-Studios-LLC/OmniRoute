export const CLOUD_IMAGE_CAPABILITY = "comfyui:image";
export const CLOUD_IMAGE_MAX_PROMPT_CHARS = 2_000;
export const CLOUD_IMAGE_MAX_DIMENSION = 1_024;
export const CLOUD_IMAGE_MAX_PIXELS = 1_048_576;
export const CLOUD_IMAGE_MAX_STEPS = 30;
export const CLOUD_IMAGE_MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

export interface CloudImageJobParameters {
  prompt: string;
  negativePrompt?: string;
  checkpoint?: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  seed: number;
}

const ALLOWED_KEYS = new Set([
  "prompt",
  "negativePrompt",
  "checkpoint",
  "width",
  "height",
  "steps",
  "cfg",
  "seed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validText(value: unknown, maxChars: number, allowEmpty: boolean): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxChars &&
    (allowEmpty || value.trim().length > 0) &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  );
}

function validDimension(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 64 &&
    Number(value) <= CLOUD_IMAGE_MAX_DIMENSION &&
    Number(value) % 8 === 0
  );
}

/** Parse the deliberately small image-generation contract shared by the Worker and Local Agent. */
export function parseCloudImageJobParameters(value: unknown): CloudImageJobParameters | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !ALLOWED_KEYS.has(key))) return null;
  if (!validText(value.prompt, CLOUD_IMAGE_MAX_PROMPT_CHARS, false)) return null;
  if (
    value.negativePrompt !== undefined &&
    !validText(value.negativePrompt, CLOUD_IMAGE_MAX_PROMPT_CHARS, true)
  ) {
    return null;
  }
  if (
    value.checkpoint !== undefined &&
    (!validText(value.checkpoint, 255, false) ||
      value.checkpoint.includes("\\") ||
      value.checkpoint.split("/").some((part) => !part || part === "." || part === ".."))
  ) {
    return null;
  }

  const width = value.width ?? 512;
  const height = value.height ?? 512;
  const steps = value.steps ?? 20;
  const cfg = value.cfg ?? 7;
  const seed = value.seed ?? 0;
  if (
    !validDimension(width) ||
    !validDimension(height) ||
    width * height > CLOUD_IMAGE_MAX_PIXELS
  ) {
    return null;
  }
  if (!Number.isSafeInteger(steps) || Number(steps) < 1 || Number(steps) > CLOUD_IMAGE_MAX_STEPS) {
    return null;
  }
  if (typeof cfg !== "number" || !Number.isFinite(cfg) || cfg < 0 || cfg > 20) return null;
  if (!Number.isSafeInteger(seed) || Number(seed) < 0 || Number(seed) > Number.MAX_SAFE_INTEGER) {
    return null;
  }

  return {
    prompt: value.prompt,
    ...(value.negativePrompt === undefined ? {} : { negativePrompt: value.negativePrompt }),
    ...(value.checkpoint === undefined ? {} : { checkpoint: value.checkpoint }),
    width,
    height,
    steps,
    cfg,
    seed,
  };
}

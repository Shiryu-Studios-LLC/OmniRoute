import type { SyncedAvailableModelInput } from "@/lib/db/models";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringsFromNodeInput(node: unknown, key: string): string[] {
  const required = asRecord(asRecord(node).input).required;
  const value = asRecord(required)[key];
  if (!Array.isArray(value) || !Array.isArray(value[0])) return [];
  return value[0].filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function classifyCheckpoint(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes("pony"))
    return { family: "pony", workflow: "checkpoint", label: "Pony" } as const;
  if (
    lower.includes("anime") ||
    lower.includes("anima") ||
    lower.includes("counterfeit") ||
    lower.includes("meinamix") ||
    lower.includes("pasteldream") ||
    lower.includes("revanimated") ||
    lower.includes("furry") ||
    lower.includes("mature") ||
    lower.includes("pkm") ||
    lower.includes("unreal")
  ) {
    return {
      family: "anime",
      workflow: "checkpoint",
      label: "Anime / specialized checkpoint",
    } as const;
  }
  if (lower.includes("xl"))
    return { family: "sdxl", workflow: "checkpoint", label: "SDXL" } as const;
  return { family: "sd", workflow: "checkpoint", label: "Stable Diffusion checkpoint" } as const;
}

function classifyDiffusionModel(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes("flux-2") || lower.includes("flux2")) {
    return { family: "flux2", workflow: "flux2", label: "FLUX.2" } as const;
  }
  if (lower.includes("wan") && lower.includes("i2v")) {
    return { family: "wan-i2v", workflow: "wan-i2v", label: "WAN video — image-to-video" } as const;
  }
  if (lower.includes("wan") && lower.includes("t2v")) {
    return { family: "wan-t2v", workflow: "wan-t2v", label: "WAN video — text-to-video" } as const;
  }
  return { family: "diffusion", workflow: "diffusion", label: "ComfyUI diffusion model" } as const;
}

function imageModel(
  id: string,
  classification: ReturnType<typeof classifyCheckpoint>
): SyncedAvailableModelInput {
  return {
    id,
    name: id,
    apiFormat: "comfyui",
    targetFormat: "comfyui",
    upstreamProtocol: "comfyui",
    supportedEndpoints: ["images"],
    modelType: "image",
    description: `${classification.label} • ComfyUI workflow: ${classification.workflow}`,
    mediaCapabilities: {
      provider: "comfyui",
      family: classification.family,
      workflow: classification.workflow,
      source: "CheckpointLoaderSimple",
    },
  };
}

function diffusionModel(
  id: string,
  classification: ReturnType<typeof classifyDiffusionModel>
): SyncedAvailableModelInput {
  const isVideo = classification.workflow === "wan-t2v" || classification.workflow === "wan-i2v";
  return {
    id,
    name: id,
    apiFormat: "comfyui",
    targetFormat: "comfyui",
    upstreamProtocol: "comfyui",
    supportedEndpoints: [isVideo ? "videos" : "images"],
    modelType: isVideo ? "video" : "image",
    supportsVideo: isVideo,
    description: `${classification.label} • ComfyUI workflow: ${classification.workflow}`,
    mediaCapabilities: {
      provider: "comfyui",
      family: classification.family,
      workflow: classification.workflow,
      source: "UNETLoader",
    },
  };
}

/**
 * Convert ComfyUI's live /object_info catalog into OmniRoute model records.
 * This deliberately discovers the installed files from node input enums instead
 * of guessing a filesystem path: ComfyUI can aggregate model directories through
 * extra_model_paths.yaml and other runtime configuration.
 */
export function parseComfyUIObjectInfo(data: unknown): SyncedAvailableModelInput[] {
  const root = asRecord(data);
  const deduped = new Map<string, SyncedAvailableModelInput>();

  for (const checkpoint of stringsFromNodeInput(root.CheckpointLoaderSimple, "ckpt_name")) {
    deduped.set(checkpoint, imageModel(checkpoint, classifyCheckpoint(checkpoint)));
  }

  for (const diffusion of stringsFromNodeInput(root.UNETLoader, "unet_name")) {
    deduped.set(diffusion, diffusionModel(diffusion, classifyDiffusionModel(diffusion)));
  }

  return Array.from(deduped.values());
}

export function getComfyUIBaseUrl(connection: unknown): string {
  const record = asRecord(connection);
  const psd = asRecord(record.providerSpecificData);
  const configured = typeof psd.baseUrl === "string" ? psd.baseUrl.trim() : "";
  return (configured || "http://127.0.0.1:8188").replace(/\/$/, "");
}

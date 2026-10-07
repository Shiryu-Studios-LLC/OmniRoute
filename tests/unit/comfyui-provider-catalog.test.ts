import { test } from "node:test";
import assert from "node:assert/strict";

import { getComfyUIBaseUrl, parseComfyUIObjectInfo } from "@/lib/providers/comfyuiCatalog";

test("ComfyUI catalog parser discovers checkpoints and diffusion models with capabilities", () => {
  const models = parseComfyUIObjectInfo({
    CheckpointLoaderSimple: {
      input: {
        required: {
          ckpt_name: [
            [
              "RealVisXL_V5.0_fp16.safetensors",
              "ponyDiffusionV6XL_v6StartWithThisOne.safetensors",
              "animePastelDream_softBakedVae_full_fp16.safetensors",
            ],
          ],
        },
      },
    },
    UNETLoader: {
      input: {
        required: {
          unet_name: [
            [
              "flux-2-klein-base-4b-fp8.safetensors",
              "wan2.1_t2v_1.3B_fp16.safetensors",
              "Wan2_1-I2V-14B-720P_fp8_e4m3fn.safetensors",
            ],
          ],
        },
      },
    },
  });

  assert.equal(models.length, 6);

  const byId = new Map(models.map((model) => [model.id, model]));

  assert.equal(byId.get("RealVisXL_V5.0_fp16.safetensors")?.mediaCapabilities?.family, "sdxl");
  assert.equal(
    byId.get("ponyDiffusionV6XL_v6StartWithThisOne.safetensors")?.mediaCapabilities?.family,
    "pony"
  );
  assert.equal(
    byId.get("animePastelDream_softBakedVae_full_fp16.safetensors")?.mediaCapabilities?.family,
    "anime"
  );

  const flux = byId.get("flux-2-klein-base-4b-fp8.safetensors");
  assert.equal(flux?.modelType, "image");
  assert.deepEqual(flux?.supportedEndpoints, ["images"]);
  assert.equal(flux?.mediaCapabilities?.workflow, "flux2");

  const t2v = byId.get("wan2.1_t2v_1.3B_fp16.safetensors");
  assert.equal(t2v?.modelType, "video");
  assert.equal(t2v?.supportsVideo, true);
  assert.deepEqual(t2v?.supportedEndpoints, ["videos"]);
  assert.equal(t2v?.mediaCapabilities?.workflow, "wan-t2v");

  const i2v = byId.get("Wan2_1-I2V-14B-720P_fp8_e4m3fn.safetensors");
  assert.equal(i2v?.modelType, "video");
  assert.equal(i2v?.mediaCapabilities?.workflow, "wan-i2v");
});

test("ComfyUI base URL honors the connection override without credentials", () => {
  assert.equal(
    getComfyUIBaseUrl({
      providerSpecificData: { baseUrl: "http://127.0.0.1:8188/" },
    }),
    "http://127.0.0.1:8188"
  );
  assert.equal(getComfyUIBaseUrl({ providerSpecificData: {} }), "http://127.0.0.1:8188");
});

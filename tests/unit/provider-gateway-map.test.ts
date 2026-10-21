import assert from "node:assert/strict";
import test from "node:test";
import { parseProviderGatewayMap } from "@/lib/services/providerGateway";

test("provider gateway is disabled when no mapping is configured", () => {
  assert.deepEqual(parseProviderGatewayMap(undefined), {});
  assert.deepEqual(parseProviderGatewayMap("  "), {});
  assert.deepEqual(parseProviderGatewayMap("{}"), {});
});

test("provider gateway maps one provider to normalized host aliases", () => {
  assert.deepEqual(
    parseProviderGatewayMap(
      '{"comfyui":["comfyui.shiryu.org","127.0.0.1"],"other":"other.example"}'
    ),
    {
      "comfyui.shiryu.org": "comfyui",
      "127.0.0.1": "comfyui",
      "other.example": "other",
    }
  );
});

test("provider gateway ignores malformed entries and rejects invalid JSON", () => {
  assert.deepEqual(
    parseProviderGatewayMap(
      '{"comfyui":[" COMFYUI.SHIRYU.ORG ","https://bad.example","bad:8188",12],"":"ignored.example"}'
    ),
    { "comfyui.shiryu.org": "comfyui" }
  );
  assert.deepEqual(parseProviderGatewayMap("not-json"), {});
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  createNodePinnedMcpTransport,
  createPinnedMcpLookup,
  type McpPinnedAddress,
} from "../../src/lib/mcp/nodePinnedMcpTransport.ts";
import { McpOutboundEgressError } from "../../src/lib/mcp/mcpOutboundTransport.ts";

const PUBLIC_V4 = { address: "93.184.216.34", family: 4 } satisfies McpPinnedAddress;

test("pinned lookup serves only its validated addresses without consulting DNS again", async () => {
  const lookup = createPinnedMcpLookup([PUBLIC_V4]);
  const selected = await new Promise<{ address: string; family: number }>((resolve, reject) => {
    lookup("mcp.example.com", {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address: String(address), family: Number(family) });
    });
  });
  assert.deepEqual(selected, PUBLIC_V4);
});

test("pinned lookup rejects empty, private, and invalid address sets", () => {
  for (const records of [
    [],
    [{ address: "93.184.216.34", family: 6 }],
    [{ address: "10.0.0.4", family: 4 }],
    [PUBLIC_V4, { address: "169.254.169.254", family: 4 }],
    [{ address: "::ffff:7f00:1", family: 6 }],
  ]) {
    assert.throws(() => createPinnedMcpLookup(records), McpOutboundEgressError);
  }
});

test("outbound transport rejects unsafe endpoints and mixed DNS answers before connecting", async () => {
  let resolverCalls = 0;
  const transport = createNodePinnedMcpTransport({
    lookupAll: async () => {
      resolverCalls += 1;
      return [PUBLIC_V4, { address: "127.0.0.1", family: 4 }];
    },
  });

  await assert.rejects(
    transport.fetch("https://mcp.example.com/mcp", { method: "POST" }),
    McpOutboundEgressError
  );
  await assert.rejects(
    transport.fetch("https://127.0.0.1/mcp", { method: "POST" }),
    McpOutboundEgressError
  );
  assert.equal(resolverCalls, 1, "literal private targets must reject before DNS resolution");
});

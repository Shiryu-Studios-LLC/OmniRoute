/**
 * Home Provider Topology — per-model sub-nodes.
 *
 * The topology used to stop at the provider tier even though `activeRequests` already
 * carried `{ provider, model }`. These pure helpers decide which models hang off a
 * provider node (ON / AUTO / OFF) and lay them out radially beyond the provider ring.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_TOPOLOGY_MODEL_SUBNODES,
  appendTopologyModels,
  buildModelSubNodes,
  selectTopologyModels,
  selectTopologyRoutes,
} from "../../src/app/(dashboard)/home/topologyUtils.ts";

const OPENAI = {
  nodeId: "provider-openai",
  providerId: "openai",
  angle: -Math.PI / 2,
  color: "#10a37f",
};
const ORBIT = { rx: 210, ry: 132 };

test("AUTO mode keeps only the models with a request in flight", () => {
  const models = selectTopologyModels(
    "openai",
    "auto",
    [{ provider: "openai", model: "gpt-4o" }],
    [{ provider: "openai", model: "gpt-4.1" }]
  );
  assert.deepEqual(models, [{ model: "gpt-4o", active: true }]);
});

test("AUTO mode with no in-flight request yields no model", () => {
  assert.deepEqual(
    selectTopologyModels("openai", "auto", [], [{ provider: "openai", model: "gpt-4o" }]),
    []
  );
});

test("recent topology routes preserve the real worker, combo alias, and outcome", () => {
  const routes = selectTopologyRoutes([
    { provider: "huggingface", model: "connection-test", status: 200 },
    { provider: "openai", model: "gpt-4o", status: 0, stale: true },
    {
      provider: "groq",
      providerDisplay: "Groq",
      model: "llama-3.3-70b-versatile",
      requestedModel: "Claude-Free",
      comboName: "Claude-Free",
      status: 200,
      timestamp: "2026-11-19T03:04:00Z",
    },
    { provider: "groq", model: "llama-3.3-70b-versatile", status: 200 },
    { provider: "openai", model: "gpt-4o", status: 502, error: "Upstream error" },
  ]);
  assert.deepEqual(
    routes.map((r) => [r.provider, r.model, r.active, r.error]),
    [
      ["groq", "llama-3.3-70b-versatile", false, false],
      ["openai", "gpt-4o", false, true],
    ]
  );
  assert.equal(routes[0].comboName, "Claude-Free");
  assert.equal(routes[0].requestedModel, "Claude-Free");
});

test("OFF mode never yields a model, even while one is active", () => {
  assert.deepEqual(
    selectTopologyModels("openai", "off", [{ provider: "openai", model: "gpt-4o" }], []),
    []
  );
});

test("ON mode adds recently used models, active first, deduped and provider-scoped", () => {
  const models = selectTopologyModels(
    "OpenAI",
    "on",
    [{ provider: "openai", model: "gpt-4o" }],
    [
      { provider: "openai", model: "gpt-4.1" },
      { provider: "openai", model: "GPT-4o" },
      { provider: "anthropic", model: "claude-sonnet-4" },
      { provider: "openai", model: "" },
    ]
  );
  assert.deepEqual(models, [
    { model: "gpt-4o", active: true },
    { model: "gpt-4.1", active: false },
  ]);
});

test("ON's model inventory accumulates each additional model without losing old branches", () => {
  const first = appendTopologyModels([], [{ provider: "groq", model: "llama-3.3" }]);
  const second = appendTopologyModels(first, [
    { provider: "groq", model: "LLAMA-3.3" },
    { provider: "groq", model: "qwen-coder" },
    { provider: "openai", model: "gpt-4o" },
  ]);
  assert.deepEqual(second, [
    { provider: "groq", model: "llama-3.3" },
    { provider: "groq", model: "qwen-coder" },
    { provider: "openai", model: "gpt-4o" },
  ]);
  assert.equal(appendTopologyModels(second, [{ provider: "groq", model: "llama-3.3" }]), second);
  assert.deepEqual(selectTopologyModels("groq", "on", [], second), [
    { model: "llama-3.3", active: false },
    { model: "qwen-coder", active: false },
  ]);
});

test("buildModelSubNodes links one active model node to its provider", () => {
  const { nodes, edges } = buildModelSubNodes(
    OPENAI,
    [{ model: "gpt-4o", active: true }],
    ORBIT,
    Math.PI / 2
  );
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, "model");
  assert.equal(nodes[0].id, "model-openai-gpt-4o");
  assert.equal((nodes[0].data as { active: boolean }).active, true);
  assert.equal((nodes[0].data as { label: string }).label, "gpt-4o");
  assert.equal(edges.length, 1);
  assert.equal(edges[0].source, "provider-openai");
  assert.equal(edges[0].target, "model-openai-gpt-4o");
  assert.equal(edges[0].animated, true);
  assert.equal(edges[0].style?.strokeWidth, 1.3);
  assert.equal(edges[0].style?.strokeDasharray, "3 5");
  // The provider sits at the top of the ring, so its model branches further up.
  assert.ok(
    nodes[0].position.y < -ORBIT.ry,
    `expected y < ${-ORBIT.ry}, got ${nodes[0].position.y}`
  );
});

test("buildModelSubNodes with no models adds nothing", () => {
  const { nodes, edges } = buildModelSubNodes(OPENAI, [], ORBIT, Math.PI / 2);
  assert.equal(nodes.length, 0);
  assert.equal(edges.length, 0);
});

test("AUTO request completion removes model and its thin animated edge", () => {
  const active = selectTopologyModels("openai", "auto", [{ provider: "openai", model: "gpt-4o" }]);
  const whileRunning = buildModelSubNodes(OPENAI, active, ORBIT, Math.PI / 2);
  assert.equal(whileRunning.nodes.length, 1);
  assert.equal(whileRunning.edges.length, 1);
  assert.equal(whileRunning.edges[0].animated, true);

  // A completed request belongs in recent history, not the live AUTO model tier.
  const done = selectTopologyModels(
    "openai",
    "auto",
    [],
    [{ provider: "openai", model: "gpt-4o" }]
  );
  const afterCompletion = buildModelSubNodes(OPENAI, done, ORBIT, Math.PI / 2);
  assert.deepEqual(afterCompletion.nodes, []);
  assert.deepEqual(afterCompletion.edges, []);
});

test("ON retains previously used model branches and reveals every newly used model", () => {
  const old = Array.from({ length: MAX_TOPOLOGY_MODEL_SUBNODES }, (_, i) => ({
    provider: "openai",
    model: `model-${i}`,
  }));
  const newModel = { provider: "openai", model: "new-model" };
  const selected = selectTopologyModels("openai", "on", [], [...old, newModel]);
  const { nodes, edges } = buildModelSubNodes(OPENAI, selected, ORBIT, Math.PI / 2, true);
  assert.equal(nodes.length, MAX_TOPOLOGY_MODEL_SUBNODES + 1);
  assert.equal(edges.length, nodes.length);
  assert.equal(
    nodes.some((node) => node.id === "model-openai-new-model"),
    true
  );
  assert.equal(
    nodes.some((node) => node.id === "model-openai-__more"),
    false
  );
  assert.ok(edges.every((edge) => edge.animated === false));
  assert.ok(edges.every((edge) => edge.style?.strokeWidth === 1));
  // Each ON model is placed beyond the previous one along the provider's ray.
  assert.equal(new Set(nodes.map((node) => node.position.y)).size, nodes.length);
});

test("buildModelSubNodes caps the visible models and folds the rest into a +N node", () => {
  const many = Array.from({ length: MAX_TOPOLOGY_MODEL_SUBNODES + 3 }, (_, i) => ({
    model: `m-${i}`,
    active: i === 0,
  }));
  const { nodes, edges } = buildModelSubNodes(OPENAI, many, ORBIT, Math.PI / 2);
  assert.equal(nodes.length, MAX_TOPOLOGY_MODEL_SUBNODES + 1);
  assert.equal(edges.length, MAX_TOPOLOGY_MODEL_SUBNODES + 1);
  const overflow = nodes[nodes.length - 1];
  assert.equal(overflow.id, "model-openai-__more");
  assert.equal((overflow.data as { label: string }).label, "+3");
  assert.equal((overflow.data as { active: boolean }).active, false);
  // Every sub-node id is unique, so ReactFlow never collapses two models into one.
  assert.equal(new Set(nodes.map((n) => n.id)).size, nodes.length);
});

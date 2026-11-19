/**
 * Pure helpers for the home-page Provider Topology panel.
 */
import type { Edge, Node } from "@xyflow/react";
import { edgeStyle } from "@/shared/components/flow/edgeStyles";

import { isNoAuthProviderBlocked, isNoAuthProviderKey } from "@/shared/utils/noAuthProviders";

/** Minimal shape expected by <ProviderTopology activeRequests={...}> */
export interface TopologyActiveRequest {
  provider: string;
  model: string;
}

/** One real attempt from the authenticated call-logs endpoint (not a model catalog entry). */
export interface TopologyCallLog {
  id?: string;
  timestamp?: string;
  provider?: string;
  providerDisplay?: string | null;
  model?: string;
  requestedModel?: string | null;
  comboName?: string | null;
  status?: number;
  error?: string | null;
  active?: boolean;
  stale?: boolean;
  path?: string;
  sourceFormat?: string | null;
  targetFormat?: string | null;
}

export interface TopologyRoute {
  provider: string;
  providerDisplay: string;
  model: string;
  requestedModel: string | null;
  comboName: string | null;
  timestamp: string | null;
  active: boolean;
  error: boolean;
}

/** Preserve the distinct models observed in this dashboard visit when ON is selected. */
export function appendTopologyModels<T extends { provider: string; model: string }>(
  previous: TopologyActiveRequest[],
  observations: T[]
): TopologyActiveRequest[] {
  const keys = new Set(
    previous.map(({ provider, model }) => `${provider.toLowerCase()}\u0000${model.toLowerCase()}`)
  );
  const next = [...previous];
  for (const { provider, model } of observations) {
    if (
      typeof provider !== "string" ||
      !provider.trim() ||
      typeof model !== "string" ||
      !model.trim()
    )
      continue;
    const key = `${provider.toLowerCase()}\u0000${model.toLowerCase()}`;
    if (keys.has(key)) continue;
    keys.add(key);
    next.push({ provider, model });
  }
  return next.length === previous.length ? previous : next;
}

/**
 * Keep actual downstream attempts (provider+model) in the topology after they complete.
 * Combo aliases such as Claude-Free are labels on the request, NOT the serving model.
 * Probes, invalid rows and stale abandoned in-flight entries must never light up a path.
 */
export function selectTopologyRoutes(logs: TopologyCallLog[], limit = 24): TopologyRoute[] {
  if (!Array.isArray(logs)) return [];
  const routes: TopologyRoute[] = [];
  const seen = new Set<string>();
  for (const log of logs) {
    if (
      !log ||
      log.stale ||
      log.model === "connection-test" ||
      log.path === "/api/providers/test" ||
      log.sourceFormat === "test" ||
      log.targetFormat === "test"
    )
      continue;
    const provider = typeof log.provider === "string" ? log.provider.trim() : "";
    const model = typeof log.model === "string" ? log.model.trim() : "";
    if (!provider || !model || provider.toLowerCase() === "unknown") continue;
    const active = log.active === true || log.status === 0;
    const status = typeof log.status === "number" ? log.status : null;
    const error = !active && (Boolean(log.error) || (status !== null && status >= 400));
    const key = `${provider.toLowerCase()}\u0000${model.toLowerCase()}\u0000${active}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({
      provider,
      providerDisplay: log.providerDisplay?.trim() || provider,
      model,
      requestedModel: log.requestedModel?.trim() || null,
      comboName: log.comboName?.trim() || null,
      timestamp: log.timestamp || null,
      active,
      error,
    });
    if (routes.length >= limit) break;
  }
  return routes;
}

/** Minimal in-flight request shape (subset of LiveRequest from useLiveRequests) */
interface InFlightRequest {
  provider: string;
  model: string;
}

/**
 * Maps an array of in-flight LiveRequest entries to the flat
 * { provider, model }[] shape consumed by <ProviderTopology>.
 *
 * The input is expected to contain only pending/running entries — the
 * useLiveRequests hook already filters out completed and failed requests
 * before exposing them via `activeRequests`.
 */
export function selectActiveRequests(requests: InFlightRequest[]): TopologyActiveRequest[] {
  return requests.map(({ provider, model }) => ({ provider, model }));
}

/**
 * A no-auth provider has no connection rows: it is available unless the operator blocked
 * it (by id or alias) in `blockedProviders`. The topology uses this where other providers
 * need an active connection, so a no-auth provider that serves traffic gets its node.
 */
export function isEnabledNoAuthProvider(providerId: string, blockedProviders: unknown): boolean {
  return isNoAuthProviderKey(providerId) && !isNoAuthProviderBlocked(blockedProviders, providerId);
}

/** Which model sub-nodes the topology draws: all recent ones, only in-flight ones, or none. */
export type TopologyModelMode = "on" | "auto" | "off";

/** Per-provider cap on drawn model sub-nodes; the remainder folds into one "+N" node. */
export const MAX_TOPOLOGY_MODEL_SUBNODES = 6;

export interface TopologyModelEntry {
  model: string;
  active: boolean;
}

type ProviderModelRef = { provider?: string; model?: string };

/**
 * Models to hang off one provider node. AUTO (the default) draws only the models that
 * have a request in flight, so an idle dashboard looks exactly as before. ON adds the
 * models seen in recent traffic — never the full registry, which would flood the canvas.
 * Active models come first; matching on provider and model is case-insensitive.
 */
export function selectTopologyModels(
  providerId: string,
  mode: TopologyModelMode,
  activeRequests: ProviderModelRef[],
  recentRequests: ProviderModelRef[] = []
): TopologyModelEntry[] {
  if (mode === "off") return [];
  const pid = providerId.toLowerCase();
  const seen = new Map<string, TopologyModelEntry>();
  const collect = (refs: ProviderModelRef[], active: boolean) => {
    for (const ref of refs) {
      if (!ref.model || ref.provider?.toLowerCase() !== pid) continue;
      const key = ref.model.toLowerCase();
      if (!seen.has(key)) seen.set(key, { model: ref.model, active });
    }
  };
  collect(activeRequests, true);
  if (mode === "on") collect(recentRequests, false);
  return [...seen.values()];
}

/** Handle pair for an edge leaving a node placed at `angle` on the radial layout. */
export function getHandles(
  angle: number,
  cx: number
): { sourceHandle: string; targetHandle: string } {
  const rel = (((angle + Math.PI / 2) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (rel < Math.PI / 4 || rel > (7 * Math.PI) / 4)
    return { sourceHandle: "top", targetHandle: "bottom" };
  if (rel > (3 * Math.PI) / 4 && rel < (5 * Math.PI) / 4)
    return { sourceHandle: "bottom", targetHandle: "top" };
  return cx > 0
    ? { sourceHandle: "right", targetHandle: "left" }
    : { sourceHandle: "left", targetHandle: "right" };
}

export type ModelNodeData = {
  label: string;
  active: boolean;
  color: string;
  providerId: string;
  /** True for the "+N" node that stands in for the models over the cap. */
  overflow?: boolean;
};

const MODEL_NODE_W = 136;
const MODEL_NODE_H = 22;
const MODEL_ORBIT_GAP_X = 120;
const MODEL_ORBIT_GAP_Y = 76;
const MODEL_ROW_STEP_X = 64;
const MODEL_ROW_STEP_Y = 40;
const MAX_MODEL_FAN_STEP = 0.14;

/**
 * Lays model sub-nodes out radially beyond the provider ring (`orbit` is that ring's
 * radii). The fan stays inside the provider's own angular sector so neighbouring
 * providers do not cross, and alternate models step one row further out so their
 * labels do not overlap.
 */
export function buildModelSubNodes(
  provider: { nodeId: string; providerId: string; angle: number; color: string },
  models: TopologyModelEntry[],
  orbit: { rx: number; ry: number },
  sectorAngle: number,
  showAll = false
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  if (models.length === 0) return { nodes, edges };

  // ON mode is explicitly an inventory of every observed model. Keep the
  // compact +N cap for other callers, but never silently hide observed models
  // while the operator has requested ON.
  const visible: ModelNodeData[] = (
    showAll ? models : models.slice(0, MAX_TOPOLOGY_MODEL_SUBNODES)
  ).map((m) => ({
    label: m.model,
    active: m.active,
    color: provider.color,
    providerId: provider.providerId,
  }));
  const hidden = showAll ? 0 : models.length - visible.length;
  if (hidden > 0) {
    visible.push({
      label: `+${hidden}`,
      active: false,
      color: provider.color,
      providerId: provider.providerId,
      overflow: true,
    });
  }

  const count = visible.length;
  const fanStep = count > 1 ? Math.min(MAX_MODEL_FAN_STEP, (sectorAngle * 0.7) / (count - 1)) : 0;

  visible.forEach((data, j) => {
    // For ON, fan models outward along the provider's ray with enough spacing
    // for the pill labels to stay separate as new models are discovered. AUTO
    // keeps its old, compact positioning because active requests are transient.
    const angle = showAll ? provider.angle : provider.angle + (j - (count - 1) / 2) * fanStep;
    const row = j % 2;
    const cx =
      (orbit.rx + MODEL_ORBIT_GAP_X + (showAll ? j * 156 : row * MODEL_ROW_STEP_X)) *
      Math.cos(angle);
    const cy =
      (orbit.ry + MODEL_ORBIT_GAP_Y + (showAll ? j * 48 : row * MODEL_ROW_STEP_Y)) *
      Math.sin(angle);
    const { sourceHandle, targetHandle } = getHandles(angle, cx);
    const id = data.overflow
      ? `model-${provider.providerId}-__more`
      : `model-${provider.providerId}-${data.label}`;

    nodes.push({
      id,
      type: "model",
      position: { x: cx - MODEL_NODE_W / 2, y: cy - MODEL_NODE_H / 2 },
      data: data satisfies ModelNodeData,
      draggable: false,
    });
    edges.push({
      id: `e-${id}`,
      source: provider.nodeId,
      sourceHandle: `s-${sourceHandle}`,
      target: id,
      targetHandle,
      animated: data.active,
      // The provider -> model branch is intentionally thinner than the main
      // OmniRoute -> provider beam. While active React Flow animates its dashes;
      // in AUTO mode the model and this edge disappear on request completion.
      style: {
        ...edgeStyle(data.active, false, false),
        strokeWidth: data.active ? 1.3 : 1,
        ...(data.active ? { strokeDasharray: "3 5" } : {}),
      },
    });
  });

  return { nodes, edges };
}

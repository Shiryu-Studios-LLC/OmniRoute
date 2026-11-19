"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";

import { Card } from "@/shared/components";
import { useLiveRequests } from "@/hooks/useLiveDashboard";
import {
  appendTopologyModels,
  selectActiveRequests,
  selectTopologyRoutes,
  type TopologyCallLog,
  type TopologyActiveRequest,
  type TopologyRoute,
} from "../home/topologyUtils";

const ProviderTopology = dynamic(() => import("../home/ProviderTopology"), { ssr: false });

type TopologyProvider = {
  id: string;
  provider: string;
  name?: string;
  /** Connection-health base state, so the topology can colour a node at rest. */
  status?: "active" | "error" | "idle";
};

const ROUTE_POLL_MS = 3000;

/** Persistent call logs are the authoritative recent route, even after a reload/WS outage. */
function useLoggedTopologyRoutes(enabled: boolean) {
  const [routes, setRoutes] = useState<TopologyRoute[]>([]);
  const [seenModels, setSeenModels] = useState<TopologyActiveRequest[]>([]);
  const [historyAvailable, setHistoryAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const poll = async () => {
      if (document.visibilityState === "visible") {
        controller = new AbortController();
        try {
          const response = await fetch("/api/usage/call-logs?limit=40&excludeTests=1", {
            cache: "no-store",
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Call logs unavailable (${response.status})`);
          const records: unknown = await response.json();
          if (!Array.isArray(records)) throw new Error("Invalid call logs response");
          if (!disposed) {
            const currentRoutes = selectTopologyRoutes(records as TopologyCallLog[]);
            setRoutes(currentRoutes);
            setSeenModels((previous) => appendTopologyModels(previous, currentRoutes));
            setHistoryAvailable(true);
          }
        } catch (error) {
          if (!disposed && !(error instanceof DOMException && error.name === "AbortError")) {
            setHistoryAvailable(false);
          }
        }
      }
      if (!disposed) timeout = setTimeout(poll, ROUTE_POLL_MS);
    };

    void poll();
    return () => {
      disposed = true;
      if (timeout) clearTimeout(timeout);
      controller?.abort();
    };
  }, [enabled]);

  return { routes, seenModels, historyAvailable };
}

export function HomeProviderTopologySection({
  providers,
  lastProvider,
  errorProvider,
  enabled = true,
}: {
  providers: TopologyProvider[];
  lastProvider: string;
  errorProvider: string;
  enabled?: boolean;
}) {
  const t = useTranslations("home");
  // #4596: gate the live-WS connection so it only opens while the topology
  // section is actually shown on the home page.
  const {
    activeRequests: liveActiveRequests,
    completedRequests,
    comboEvents,
    isConnected,
    reconnect,
  } = useLiveRequests({ enabled });
  const { routes, seenModels, historyAvailable } = useLoggedTopologyRoutes(enabled);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(() => setNowMs(Date.now()), ROUTE_POLL_MS);
    return () => clearInterval(interval);
  }, [enabled]);

  // A combo event identifies the actual downstream provider/model. Unlike the alias
  // selected by Claude Code, it describes the attempted worker of the route.
  const freshComboEvent = comboEvents.find(
    (event) => event.provider && event.model && nowMs - event.timestamp < 120_000
  );
  const activeComboAttempt = comboEvents.find(
    (event, index) =>
      event.type === "attempt" &&
      nowMs - event.timestamp < 60_000 &&
      !comboEvents
        .slice(0, index)
        .some(
          (newer) =>
            newer.comboName === event.comboName &&
            newer.targetIndex === event.targetIndex &&
            newer.type !== "attempt"
        )
  );

  // The authenticated call-logs API includes in-flight attempts. Use it as a fallback
  // when Cloudflare or the browser blocks the separate live WebSocket connection.
  const activeRequests = useMemo(() => {
    const refs = [
      ...(isConnected ? selectActiveRequests(liveActiveRequests) : []),
      ...routes.filter((route) => route.active).map(({ provider, model }) => ({ provider, model })),
      ...(isConnected && activeComboAttempt
        ? [{ provider: activeComboAttempt.provider, model: activeComboAttempt.model }]
        : []),
    ];
    const seen = new Set<string>();
    return refs.filter(({ provider, model }) => {
      const key = `${provider.toLowerCase()}\u0000${model.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [liveActiveRequests, routes, activeComboAttempt, isConnected]);

  const recentRequests = useMemo(
    () => [
      ...seenModels,
      ...comboEvents.map(({ provider, model }) => ({ provider, model })),
      ...completedRequests.map(({ provider, model }) => ({ provider, model })),
    ],
    [seenModels, comboEvents, completedRequests]
  );

  const lastRoute = routes.find((route) => !route.active) ?? null;
  const activeProviderCount = new Set(activeRequests.map(({ provider }) => provider)).size;
  // Combo target events can name a provider that has not yet appeared in the
  // connections/metrics summary. Draw that actual target immediately instead
  // of silently dropping its animated beam until the next stats refresh.
  const visibleProviders = useMemo(() => {
    const known = new Set(providers.map(({ provider }) => provider.toLowerCase()));
    const additional: TopologyProvider[] = [];
    for (const { provider } of [...activeRequests, ...recentRequests]) {
      const id = provider.trim();
      if (!id || id.toLowerCase() === "unknown" || known.has(id.toLowerCase())) continue;
      known.add(id.toLowerCase());
      additional.push({ id, provider: id, status: "idle" });
    }
    return additional.length ? [...providers, ...additional] : providers;
  }, [providers, activeRequests, recentRequests]);

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold">{t("providerTopology")}</h2>
          <p className="text-xs text-text-muted">
            {t("activeError", { active: activeProviderCount, errors: errorProvider ? 1 : 0 })}
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-text-muted">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-success" />
            {t("topologyLegendActive")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-warning" />
            {t("topologyLegendRecent")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-error" />
            {t("topologyLegendError")}
          </span>
        </div>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-text-muted">
        <span
          className="flex items-center gap-1.5"
          title={
            isConnected
              ? "Live routing events connected"
              : "Showing persisted logs while live events are disconnected"
          }
        >
          <span className={`size-2 rounded-full ${isConnected ? "bg-success" : "bg-warning"}`} />
          {isConnected ? "Live connected" : "Live events disconnected"}
        </span>
        {lastRoute ? (
          <span
            className="min-w-0"
            title={`${lastRoute.provider} / ${lastRoute.model}${lastRoute.timestamp ? ` · ${lastRoute.timestamp}` : ""}`}
          >
            <span className="font-semibold">Last route:</span>{" "}
            {(lastRoute.comboName || lastRoute.requestedModel) && (
              <span>{lastRoute.comboName || lastRoute.requestedModel} → </span>
            )}
            <span className="font-semibold text-text-main">{lastRoute.providerDisplay}</span>
            <span> / </span>
            <code className="break-all text-text-main">{lastRoute.model}</code>
            <span className={lastRoute.error ? "text-error" : "text-success"}>
              {lastRoute.error ? " · Failed" : " · Completed"}
            </span>
          </span>
        ) : historyAvailable === true ? (
          <span>No routed requests recorded yet</span>
        ) : historyAvailable === false ? (
          <span>Request history unavailable</span>
        ) : null}
        {isConnected && freshComboEvent && (
          <span title={`${freshComboEvent.comboName} target #${freshComboEvent.targetIndex + 1}`}>
            <span className="font-semibold">Combo {freshComboEvent.type}:</span>{" "}
            {freshComboEvent.provider} / <code>{freshComboEvent.model}</code>
          </span>
        )}
        {!isConnected && (
          <button
            type="button"
            onClick={reconnect}
            className="underline decoration-dotted hover:text-text-main"
          >
            Retry live connection
          </button>
        )}
      </div>
      <ProviderTopology
        providers={visibleProviders}
        activeRequests={activeRequests}
        recentRequests={recentRequests}
        lastProvider={freshComboEvent?.provider || routes[0]?.provider || lastProvider}
        errorProvider={errorProvider}
      />
    </Card>
  );
}

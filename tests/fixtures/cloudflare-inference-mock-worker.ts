import { GatewaySessionObject } from "../../cloudflare/worker";
import {
  CLOUD_ANTHROPIC_COUNT_URL,
  CLOUD_ANTHROPIC_RESPONSE_URL,
  CLOUD_INFERENCE_COUNT_URL,
  CLOUD_INFERENCE_RESPONSE_URL,
} from "../../src/cloud/inferenceCustomerHttpApi";
import type { CloudDb } from "../../src/cloud/db";
import { createCloudRuntime } from "../../src/cloud/runtime";

export { GatewaySessionObject };

type WorkerEnv = {
  DB: CloudDb;
  OMNIROUTE_ENV?: string;
  OMNIROUTE_BUILD_SHA?: string;
  OMNIROUTE_CLOUD_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_IDENTITY_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_INFERENCE_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_LIFECYCLE_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_PROVISIONING_TOKEN?: string;
  OMNIROUTE_CLOUD_TENANT_HOSTS_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_FRONT_DESK_ADMIN_TOKEN?: string;
  OMNIROUTE_CLOUD_MAINTENANCE_TOKEN?: string;
  OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY?: string;
  OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEYS_JSON?: string;
  OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID?: string;
  OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY?: string;
  GATEWAY_SESSIONS?: Env["GATEWAY_SESSIONS"];
};

const MOCK_PROVIDER_KEY = "sk-cloudflare-local-inference-fixture";
const MOCK_PROVIDER_KEY_B = "sk-cloudflare-local-inference-tenant-b-fixture";
const MOCK_ANTHROPIC_KEY_A = "sk-ant-cloud-combo-tenant-a-fixture";
const MOCK_ANTHROPIC_KEY_B = "sk-ant-cloud-combo-tenant-b-fixture";
const ANTHROPIC_MODEL = "claude-sonnet-4-6";
const MOCK_RESPONSE = {
  id: "resp_local_fixture",
  model: "gpt-4.1-mini-2025-04-14",
  status: "completed",
  created_at: 1_791_459_200,
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Hello from the local mock provider." }],
    },
  ],
  usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 },
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function mockProviderFetch(
  env: WorkerEnv,
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (request.method !== "POST" || request.redirect !== "manual") {
    throw new Error("Mock provider rejected an unsupported request");
  }
  const isAnthropic = url.origin === "https://api.anthropic.com";
  const authorization = request.headers.get("authorization");
  const apiKey = request.headers.get("x-api-key");
  const credentialId = isAnthropic
    ? apiKey === MOCK_ANTHROPIC_KEY_A
      ? "tenant-a-anthropic"
      : apiKey === MOCK_ANTHROPIC_KEY_B
        ? "tenant-b-anthropic"
        : null
    : authorization === `Bearer ${MOCK_PROVIDER_KEY}`
      ? "tenant-a"
      : authorization === `Bearer ${MOCK_PROVIDER_KEY_B}`
        ? "tenant-b"
        : null;
  if (!credentialId) {
    throw new Error("Mock provider rejected an unexpected credential");
  }
  await env.DB.prepare(
    "INSERT INTO cloud_test_mock_provider_credential_calls (credential_id) VALUES (?)"
  )
    .bind(credentialId)
    .run();

  const body = (await request.json()) as Record<string, unknown>;
  const recordModelCall = async (input: {
    provider: string;
    model: string;
    operation: string;
    path: string;
    authHeader: string;
    versionHeader: string | null;
    maxTokens: number | null;
    stream: boolean | null;
    responseStatus: number;
  }) => {
    await env.DB.prepare(
      `INSERT INTO cloud_test_mock_provider_model_calls
        (credential_id, provider, model, operation, path, auth_header, version_header, max_tokens, stream, response_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        credentialId,
        input.provider,
        input.model,
        input.operation,
        input.path,
        input.authHeader,
        input.versionHeader,
        input.maxTokens,
        input.stream === null ? null : Number(input.stream),
        input.responseStatus
      )
      .run();
  };

  if (isAnthropic) {
    if (
      request.headers.get("content-type") !== "application/json" ||
      request.headers.get("accept") !== "application/json" ||
      request.headers.get("anthropic-version") !== "2023-06-01" ||
      authorization !== null ||
      body.model !== ANTHROPIC_MODEL ||
      !Array.isArray(body.messages) ||
      body.messages.length !== 1 ||
      body.messages[0]?.role !== "user" ||
      typeof body.messages[0]?.content !== "string" ||
      body.messages[0].content.length === 0
    ) {
      throw new Error("Mock provider rejected an invalid Anthropic request contract");
    }
    const operation =
      url.href === CLOUD_ANTHROPIC_COUNT_URL
        ? "count"
        : url.href === CLOUD_ANTHROPIC_RESPONSE_URL
          ? "generation"
          : null;
    if (!operation) throw new Error("Mock provider blocked an unrecognized Anthropic URL");
    if (
      (operation === "count" && ("max_tokens" in body || "stream" in body)) ||
      (operation === "generation" && (body.max_tokens !== 40 || "stream" in body))
    ) {
      throw new Error("Mock provider rejected an invalid Anthropic request shape");
    }
    await recordModelCall({
      provider: "anthropic",
      model: ANTHROPIC_MODEL,
      operation,
      path: url.pathname,
      authHeader: "x-api-key",
      versionHeader: request.headers.get("anthropic-version"),
      maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : null,
      stream: typeof body.stream === "boolean" ? body.stream : null,
      responseStatus: 200,
    });
    if (operation === "count") return Response.json({ input_tokens: 5 });
    await env.DB.prepare("UPDATE cloud_test_mock_provider_calls SET last_error = NULL WHERE id = ?")
      .bind("inference")
      .run();
    return Response.json({
      id: `msg_${credentialId}`,
      type: "message",
      role: "assistant",
      model: ANTHROPIC_MODEL,
      content: [{ type: "text", text: `Anthropic result for ${credentialId}.` }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 3 },
    });
  }

  if (
    request.headers.get("content-type") !== "application/json" ||
    apiKey !== null ||
    authorization !==
      `Bearer ${credentialId === "tenant-a" ? MOCK_PROVIDER_KEY : MOCK_PROVIDER_KEY_B}`
  ) {
    throw new Error("Mock provider rejected invalid OpenAI authentication or content headers");
  }

  if (url.href === CLOUD_INFERENCE_COUNT_URL) {
    if (
      !["gpt-4.1-mini", "gpt-4o-mini-2024-07-18"].includes(String(body.model)) ||
      body.input === undefined ||
      request.headers.get("accept") !== "application/json"
    ) {
      throw new Error("Mock provider rejected an invalid OpenAI token-count request");
    }
    await recordModelCall({
      provider: "openai",
      model: String(body.model),
      operation: "count",
      path: url.pathname,
      authHeader: "authorization",
      versionHeader: null,
      maxTokens: null,
      stream: null,
      responseStatus: 200,
    });
    return Response.json({ object: "response.input_tokens", input_tokens: 5 });
  }

  if (url.href === CLOUD_INFERENCE_RESPONSE_URL) {
    if (
      !["gpt-4.1-mini", "gpt-4o-mini-2024-07-18"].includes(String(body.model)) ||
      (body.stream !== true && body.stream !== undefined) ||
      body.store !== false ||
      body.max_output_tokens !== 40 ||
      request.headers.get("accept") !==
        (body.stream === true ? "text/event-stream" : "application/json")
    ) {
      throw new Error("Mock provider rejected an invalid OpenAI generation request");
    }
    const generationCall = {
      provider: "openai",
      model: String(body.model),
      operation: "generation",
      path: url.pathname,
      authHeader: "authorization",
      versionHeader: null,
      maxTokens: typeof body.max_output_tokens === "number" ? body.max_output_tokens : null,
      stream: typeof body.stream === "boolean" ? body.stream : null,
    };
    const failure = await env.DB.prepare<{ fail_generation_count: number }>(
      "SELECT fail_generation_count FROM cloud_test_mock_provider_calls WHERE id = ?"
    )
      .bind("inference")
      .first();
    if (failure && failure.fail_generation_count > 0) {
      const consumed = await env.DB.prepare(
        `UPDATE cloud_test_mock_provider_calls
            SET fail_generation_count = fail_generation_count - 1,
                last_error = 'simulated upstream generation failure'
          WHERE id = ? AND fail_generation_count > 0`
      )
        .bind("inference")
        .run();
      if (Number(consumed.meta?.changes ?? 0) === 1) {
        await recordModelCall({ ...generationCall, responseStatus: 503 });
        return Response.json({ error: { message: "simulated upstream failure" } }, { status: 503 });
      }
    }
    if (body.model === "gpt-4o-mini-2024-07-18") {
      await recordModelCall({ ...generationCall, responseStatus: 403 });
      return Response.json(
        { error: { message: "model rejected before generation" } },
        { status: 403 }
      );
    }
    await recordModelCall({ ...generationCall, responseStatus: 200 });
    await env.DB.prepare("UPDATE cloud_test_mock_provider_calls SET last_error = NULL WHERE id = ?")
      .bind("inference")
      .run();
    const encoder = new TextEncoder();
    const outputText =
      body.model === "gpt-4o-mini-2024-07-18"
        ? "Mock result for gpt-4o-mini-2024-07-18."
        : "Hello from the local mock provider.";
    const textDeltas =
      body.model === "gpt-4.1-mini"
        ? ["Hello from the ", "local mock provider."]
        : [
            outputText.slice(0, Math.ceil(outputText.length / 2)),
            outputText.slice(Math.ceil(outputText.length / 2)),
          ];
    const chunks = [
      ...textDeltas.map(
        (delta) =>
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`
      ),
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: {
          ...MOCK_RESPONSE,
          model:
            body.model === "gpt-4o-mini-2024-07-18"
              ? "gpt-4o-mini-2024-07-18"
              : MOCK_RESPONSE.model,
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: outputText }],
            },
          ],
        },
      })}\n\n`,
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  // This fixture never forwards unknown destinations to global fetch or the network.
  throw new Error("Mock provider blocked an unrecognized upstream URL");
}

async function incrementMockCallCount(env: WorkerEnv): Promise<void> {
  const result = await env.DB.prepare(
    "UPDATE cloud_test_mock_provider_calls SET call_count = call_count + 1 WHERE id = ?"
  )
    .bind("inference")
    .run();
  if (!result.success || Number(result.meta?.changes ?? 0) !== 1) {
    throw new Error("Mock provider call counter is unavailable");
  }
}

const worker = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__test/mock-provider/stats" && request.method === "GET") {
      if (
        !env.OMNIROUTE_CLOUD_ADMIN_TOKEN ||
        request.headers.get("authorization") !== `Bearer ${env.OMNIROUTE_CLOUD_ADMIN_TOKEN}`
      ) {
        return json({ error: "Unauthorized" }, 401);
      }
      const [row, credentialCalls, modelCalls] = await Promise.all([
        env.DB.prepare<{ call_count: number; last_error: string | null }>(
          "SELECT call_count, last_error FROM cloud_test_mock_provider_calls WHERE id = ?"
        )
          .bind("inference")
          .first(),
        env.DB.prepare<{ credential_id: string }>(
          "SELECT credential_id FROM cloud_test_mock_provider_credential_calls ORDER BY id"
        ).all(),
        env.DB.prepare<{
          credential_id: string;
          provider: string;
          model: string;
          operation: string;
          path: string;
          auth_header: string;
          version_header: string | null;
          max_tokens: number | null;
          stream: number | null;
          response_status: number;
        }>(
          "SELECT credential_id, provider, model, operation, path, auth_header, version_header, max_tokens, stream, response_status FROM cloud_test_mock_provider_model_calls ORDER BY id"
        ).all(),
      ]);
      return row
        ? json({
            callCount: row.call_count,
            lastError: row.last_error,
            credentialIds: credentialCalls.results.map((entry) => entry.credential_id),
            modelCalls: modelCalls.results,
          })
        : json({ error: "Not found" }, 404);
    }
    if (url.pathname === "/__test/inference/state" && request.method === "GET") {
      if (
        !env.OMNIROUTE_CLOUD_ADMIN_TOKEN ||
        request.headers.get("authorization") !== `Bearer ${env.OMNIROUTE_CLOUD_ADMIN_TOKEN}`
      ) {
        return json({ error: "Unauthorized" }, 401);
      }
      const tenantId = url.searchParams.get("tenantId");
      if (!tenantId || !/^[A-Za-z0-9_-]{1,128}$/.test(tenantId)) {
        return json({ error: "Invalid tenantId" }, 400);
      }
      const [usage, reservations, audits] = await Promise.all([
        env.DB.prepare<{
          id: string;
          provider: string;
          model: string;
          connection_id: string;
          tokens_input: number;
          tokens_output: number;
          status: string;
          success: number;
          endpoint: string;
        }>(
          `SELECT id, provider, model, connection_id, tokens_input, tokens_output, status, success, endpoint
             FROM cloud_usage_history WHERE tenant_id = ? ORDER BY rowid`
        )
          .bind(tenantId)
          .all(),
        env.DB.prepare<{
          reservation_id: string;
          provider: string;
          model: string;
          input_tokens: number;
          output_tokens_reserved: number;
          actual_input_tokens: number | null;
          actual_output_tokens: number | null;
          status: string;
        }>(
          `SELECT reservation_id, provider, model, input_tokens, output_tokens_reserved,
                  actual_input_tokens, actual_output_tokens, status
             FROM cloud_inference_reservations WHERE tenant_id = ? ORDER BY rowid`
        )
          .bind(tenantId)
          .all(),
        env.DB.prepare<{ action: string; status: string; metadata_json: string }>(
          `SELECT action, status, metadata_json FROM cloud_compliance_audit
             WHERE tenant_id = ? AND action = 'cloud.inference.chat.completions'
             ORDER BY timestamp, rowid`
        )
          .bind(tenantId)
          .all(),
      ]);
      return json({
        usage: usage.results,
        reservations: reservations.results,
        audits: audits.results,
      });
    }

    const runtime = createCloudRuntime({
      env: {
        OMNIROUTE_ENV: env.OMNIROUTE_ENV,
        OMNIROUTE_BUILD_SHA: env.OMNIROUTE_BUILD_SHA,
        OMNIROUTE_CLOUD_ADMIN_TOKEN: env.OMNIROUTE_CLOUD_ADMIN_TOKEN,
        OMNIROUTE_CLOUD_IDENTITY_ADMIN_TOKEN: env.OMNIROUTE_CLOUD_IDENTITY_ADMIN_TOKEN,
        OMNIROUTE_CLOUD_INFERENCE_ADMIN_TOKEN: env.OMNIROUTE_CLOUD_INFERENCE_ADMIN_TOKEN,
        OMNIROUTE_CLOUD_LIFECYCLE_ADMIN_TOKEN: env.OMNIROUTE_CLOUD_LIFECYCLE_ADMIN_TOKEN,
        OMNIROUTE_CLOUD_PROVISIONING_TOKEN: env.OMNIROUTE_CLOUD_PROVISIONING_TOKEN,
        OMNIROUTE_CLOUD_TENANT_HOSTS_ADMIN_TOKEN: env.OMNIROUTE_CLOUD_TENANT_HOSTS_ADMIN_TOKEN,
        OMNIROUTE_CLOUD_FRONT_DESK_ADMIN_TOKEN: env.OMNIROUTE_CLOUD_FRONT_DESK_ADMIN_TOKEN,
        OMNIROUTE_CLOUD_MAINTENANCE_TOKEN: env.OMNIROUTE_CLOUD_MAINTENANCE_TOKEN,
        OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY: env.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEY,
        OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEYS_JSON:
          env.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_KEYS_JSON,
        OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID:
          env.OMNIROUTE_CLOUD_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID,
        OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY: env.OMNIROUTE_CLOUD_IDEMPOTENCY_HMAC_KEY,
        DB: env.DB,
        GATEWAY_SESSIONS: env.GATEWAY_SESSIONS,
      },
      fetcher: async (input, init) => {
        await incrementMockCallCount(env);
        try {
          return await mockProviderFetch(env, input, init);
        } catch (error) {
          await env.DB.prepare(
            "UPDATE cloud_test_mock_provider_calls SET last_error = ? WHERE id = ?"
          )
            .bind(
              error instanceof Error ? error.message : "unknown mock provider failure",
              "inference"
            )
            .run();
          throw error;
        }
      },
    });
    return runtime.fetch(request);
  },
};

export default worker;

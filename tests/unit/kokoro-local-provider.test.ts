import test from "node:test";
import assert from "node:assert/strict";

import { getSpeechProvider, parseSpeechModel } from "../../open-sse/config/audioRegistry.ts";
import { handleAudioSpeech } from "../../open-sse/handlers/audioSpeech.ts";

function buildBatchExecuteFixture(base64Audio: string): string {
  const inner = JSON.stringify([base64Audio, null, null, null, null, null, []]);
  const outer = JSON.stringify([["wrb.fr", "jQ1olc", inner, null, null, null, "generic"]]);
  return `)]}'\n\n${outer.length}\n${outer}\n`;
}

test("qwen3-local is registered as the natural no-auth speech provider", () => {
  const provider = getSpeechProvider("qwen3-local");
  assert.ok(provider);
  assert.equal(provider?.authType, "none");
  assert.equal(provider?.format, "qwen3-local");
  assert.equal(provider?.baseUrl, "http://127.0.0.1:37832/synthesize");

  const parsed = parseSpeechModel("qwen3-local/qwen3-tts");
  assert.equal(parsed.provider, "qwen3-local");
  assert.equal(parsed.model, "qwen3-tts");
});

test("handleAudioSpeech sends natural voice requests to shared Qwen3-TTS", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "http://127.0.0.1:37832/synthesize");
    const body = JSON.parse(String(init?.body ?? "{}"));
    assert.deepEqual(body, { text: "Hello", voice: "Aiden" });
    return new Response(new Uint8Array([82, 73, 70, 70]), {
      status: 200,
      headers: {
        "content-type": "audio/wav",
        "x-shiryu-tts-voice": "Aiden",
      },
    });
  }) as typeof fetch;

  try {
    const response = await handleAudioSpeech({
      body: {
        model: "qwen3-local/qwen3-tts",
        input: "Hello",
        voice: "Aiden",
      },
      credentials: null,
      resolvedProvider: getSpeechProvider("qwen3-local"),
      resolvedModel: "qwen3-tts",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/wav");
    assert.equal(response.headers.get("x-shiryu-tts-backend"), "qwen3-local");
    assert.equal(response.headers.get("x-shiryu-tts-voice"), "Aiden");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Qwen3-TTS falls back to shared Kokoro if the natural service is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    call += 1;
    if (call === 1) {
      assert.equal(String(url), "http://127.0.0.1:37832/synthesize");
      throw new TypeError("connection refused");
    }
    assert.equal(String(url), "http://127.0.0.1:37831/synthesize");
    const body = JSON.parse(String(init?.body ?? "{}"));
    assert.equal(body.text, "Hello");
    return new Response(new Uint8Array([82, 73, 70, 70]), {
      status: 200,
      headers: { "content-type": "audio/wav" },
    });
  }) as typeof fetch;

  try {
    const response = await handleAudioSpeech({
      body: {
        model: "qwen3-local/qwen3-tts",
        input: "Hello",
        voice: "Aiden",
      },
      credentials: null,
      resolvedProvider: getSpeechProvider("qwen3-local"),
      resolvedModel: "qwen3-tts",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/wav");
    assert.equal(call, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("kokoro-local is registered as a no-auth speech provider", () => {
  const provider = getSpeechProvider("kokoro-local");
  assert.ok(provider);
  assert.equal(provider?.authType, "none");
  assert.equal(provider?.format, "kokoro-local");
  assert.equal(provider?.baseUrl, "http://127.0.0.1:37831/synthesize");

  const parsed = parseSpeechModel("kokoro-local/kokoro");
  assert.equal(parsed.provider, "kokoro-local");
  assert.equal(parsed.model, "kokoro");
});

test("handleAudioSpeech forwards voice and rate to shared Kokoro", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "http://127.0.0.1:37831/synthesize");
    const body = JSON.parse(String(init?.body ?? "{}"));
    assert.deepEqual(body, { text: "Hello", voice: "af_sarah", rate: 1.25 });
    return new Response(new Uint8Array([82, 73, 70, 70]), {
      status: 200,
      headers: { "content-type": "audio/wav" },
    });
  }) as typeof fetch;

  try {
    const response = await handleAudioSpeech({
      body: {
        model: "kokoro-local/kokoro",
        input: "Hello",
        voice: "af_sarah",
        speed: 1.25,
      },
      credentials: null,
      resolvedProvider: getSpeechProvider("kokoro-local"),
      resolvedModel: "kokoro",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/wav");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("shared Kokoro falls back to free English gTTS when local service is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    call += 1;
    if (call === 1) throw new TypeError("connection refused");
    assert.match(String(init?.body), /^f\.req=/);
    return new Response(
      buildBatchExecuteFixture(Buffer.from("fallback-audio").toString("base64")),
      {
        status: 200,
        headers: { "content-type": "text/plain" },
      }
    );
  }) as typeof fetch;

  try {
    const response = await handleAudioSpeech({
      body: {
        model: "kokoro-local/kokoro",
        input: "Hello",
        voice: "bm_george",
      },
      credentials: null,
      resolvedProvider: getSpeechProvider("kokoro-local"),
      resolvedModel: "kokoro",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/mpeg");
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "fallback-audio");
    assert.equal(call, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

test("migration 183 assigns legacy reasoning cache rows to the platform tenant", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE reasoning_cache (
        tool_call_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        char_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at INTEGER NOT NULL
      );
      INSERT INTO reasoning_cache
        (tool_call_id, provider, model, reasoning, char_count, created_at, expires_at)
      VALUES
        ('legacy-call-a', 'deepseek', 'deepseek-reasoner', 'legacy A', 8, '2025-01-01', 2000000000),
        ('legacy-call-b', 'kimi', 'kimi-k2', 'legacy B', 8, '2025-01-02', 2000000001);
    `);

    const migration = fs.readFileSync(
      path.resolve("src/lib/db/migrations/183_tenant_reasoning_cache.sql"),
      "utf8"
    );
    db.exec(migration);

    assert.deepEqual(
      db
        .prepare(
          "SELECT tenant_id, tool_call_id, provider, model, reasoning FROM reasoning_cache ORDER BY tool_call_id"
        )
        .all(),
      [
        {
          tenant_id: "tenant_shiryu_admin",
          tool_call_id: "legacy-call-a",
          provider: "deepseek",
          model: "deepseek-reasoner",
          reasoning: "legacy A",
        },
        {
          tenant_id: "tenant_shiryu_admin",
          tool_call_id: "legacy-call-b",
          provider: "kimi",
          model: "kimi-k2",
          reasoning: "legacy B",
        },
      ]
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM reasoning_cache WHERE tenant_id <> ?")
        .get("tenant_shiryu_admin")?.count,
      0
    );
  } finally {
    db.close();
  }
});

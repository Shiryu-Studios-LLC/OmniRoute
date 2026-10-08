import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createD1Database,
  createD1Statement,
  type CloudDb,
  type CloudDbStatement,
} from "@/cloud/db";

class MockStatement<T> implements CloudDbStatement<T> {
  constructor(
    private readonly sql: string,
    private readonly values: unknown[] = []
  ) {}

  bind(...values: unknown[]) {
    return new MockStatement<T>(this.sql, values);
  }

  async first<U = T>() {
    return { sql: this.sql, values: this.values } as U;
  }

  async all<U = T>() {
    return { results: [{ sql: this.sql, values: this.values }] as U[], success: true };
  }

  async run() {
    return { success: true };
  }
}

function createMockDb(): CloudDb {
  return {
    prepare: <T>(sql: string) => new MockStatement<T>(sql),
    batch: async (statements) => Promise.all(statements.map((statement) => statement.run())),
    exec: async (sql) => ({ sql }),
  };
}

test("D1 boundary preserves prepared statements and async results", async () => {
  const db = createD1Database(createMockDb());
  const statement = createD1Statement(db, "SELECT * FROM tenants WHERE id = ?").bind("tenant-1");

  const row = await statement.first<{ sql: string; values: unknown[] }>();
  assert.deepEqual(row, {
    sql: "SELECT * FROM tenants WHERE id = ?",
    values: ["tenant-1"],
  });

  const result = await db.prepare("SELECT id FROM tenants").all<{ id: string }>();
  assert.equal(result.success, true);
});

test("D1 batch stays asynchronous", async () => {
  const db = createD1Database(createMockDb());
  const results = await db.batch([
    db.prepare("INSERT INTO tenants (id) VALUES (?)").bind("tenant-1"),
    db.prepare("INSERT INTO tenants (id) VALUES (?)").bind("tenant-2"),
  ]);

  assert.equal(results.length, 2);
});

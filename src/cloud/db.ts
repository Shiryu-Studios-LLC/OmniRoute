export interface CloudDbStatement<T = unknown> {
  bind(...values: unknown[]): CloudDbStatement<T>;
  first<U = T>(column?: string): Promise<U | null>;
  all<U = T>(): Promise<{ results: U[]; success: boolean; meta?: Record<string, unknown> }>;
  run(): Promise<{ success: boolean; meta?: Record<string, unknown> }>;
}

export interface CloudDb {
  prepare<T = unknown>(sql: string): CloudDbStatement<T>;
  batch(statements: CloudDbStatement[]): Promise<unknown[]>;
  exec(sql: string): Promise<unknown>;
}

/**
 * Small structural adapter around Cloudflare D1. Keeping this boundary free of
 * Cloudflare imports lets unit tests use a mock and keeps domain code portable.
 */
export function createD1Database(database: CloudDb): CloudDb {
  return database;
}

export function createD1Statement<T = unknown>(database: CloudDb, sql: string) {
  return database.prepare<T>(sql);
}

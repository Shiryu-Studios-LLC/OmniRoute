import { AsyncLocalStorage } from "async_hooks";

export interface TenantRequestContext {
  tenantId: string;
  principalId?: string;
  role?: "owner" | "admin" | "member" | "maintenance";
}

const tenantStorage = new AsyncLocalStorage<TenantRequestContext>();

export function runWithTenantContext<T>(context: TenantRequestContext, callback: () => T): T {
  return tenantStorage.run(context, callback);
}

export function enterTenantContext(context: TenantRequestContext): void {
  tenantStorage.enterWith(context);
}

export function getTenantContext(): TenantRequestContext | null {
  return tenantStorage.getStore() ?? null;
}

export function getCurrentTenantId(): string | null {
  return getTenantContext()?.tenantId ?? null;
}

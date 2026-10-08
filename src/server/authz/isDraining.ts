/** Read the shared shutdown flag without importing process cleanup modules. */
declare global {
  var __omnirouteShutdown:
    { init: boolean; shuttingDown: boolean; activeRequests: number } | undefined;
}

export function isDraining(): boolean {
  if (!globalThis.__omnirouteShutdown) {
    globalThis.__omnirouteShutdown = { init: false, shuttingDown: false, activeRequests: 0 };
  }
  return globalThis.__omnirouteShutdown.shuttingDown;
}

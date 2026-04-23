// apps/kernel entry point.
//
// Production starts here: build the kernel, listen on KERNEL_PORT
// (default 3100), install graceful-shutdown handlers, log the listen
// address. Tests import buildKernel directly and don't run this file.

import { buildKernel, type KernelHandle } from "./server.js";

export { buildKernel, type BuildKernelInput, type KernelHandle } from "./server.js";
export { KernelCache, type CacheStatus, type KernelCacheOptions } from "./cache.js";
export { CacheInvalidator, type CacheInvalidatorOptions } from "./cache-invalidator.js";
export {
  ResolveService,
  type ResolveError,
  type ResolveInput,
  type ResolveOutput,
} from "./resolve-service.js";
export type { RequestContext } from "./context.js";

const PORT = Number.parseInt(process.env.KERNEL_PORT ?? "3100", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

async function main(): Promise<void> {
  const handle: KernelHandle = await buildKernel({
    // REDIS_URL is optional — if unset, L2 caching is skipped and
    // every miss resolves through Postgres. That's the expected dev
    // behavior on machines without Redis running.
    ...(process.env.REDIS_URL !== undefined && process.env.REDIS_URL !== ""
      ? { redisUrl: process.env.REDIS_URL }
      : {}),
  });

  try {
    const address = await handle.app.listen({ port: PORT, host: HOST });
    handle.logger.info({ address, port: PORT, host: HOST }, "erp-kernel: listening");
  } catch (err) {
    handle.logger.error({ err }, "erp-kernel: failed to listen");
    await handle.close();
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    handle.logger.info({ signal }, "erp-kernel: shutting down");
    try {
      await handle.close();
      process.exit(0);
    } catch (err) {
      handle.logger.error({ err }, "erp-kernel: error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const invokedAsScript = Boolean(
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/")),
);
if (invokedAsScript) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("erp-kernel: fatal", err);
    process.exit(1);
  });
}

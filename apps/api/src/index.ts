// apps/api entry point.
//
// Production starts here: build the server, listen on PORT (default 3000),
// install graceful-shutdown handlers, log the listen address.
//
// Tests import buildServer directly and don't run this file.

import { buildServer, type ServerHandle } from "./server.js";

export { buildServer, type BuildServerInput, type ServerHandle } from "./server.js";
export type { RequestContext } from "./context.js";

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

async function main(): Promise<void> {
  const handle: ServerHandle = await buildServer({
    authRequired: process.env.NODE_ENV === "production",
  });

  try {
    const address = await handle.app.listen({ port: PORT, host: HOST });
    handle.logger.info({ address, port: PORT, host: HOST }, "erp-api: listening");
  } catch (err) {
    handle.logger.error({ err }, "erp-api: failed to listen");
    await handle.close();
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    handle.logger.info({ signal }, "erp-api: shutting down");
    try {
      await handle.close();
      process.exit(0);
    } catch (err) {
      handle.logger.error({ err }, "erp-api: error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Only run main() when invoked as the entry point (not when imported
// by tests or by the apps/console dev server that mounts buildServer
// in-process).
const invokedAsScript = Boolean(
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/")),
);
if (invokedAsScript) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("erp-api: fatal", err);
    process.exit(1);
  });
}

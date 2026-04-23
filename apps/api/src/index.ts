// apps/api entry point.
//
// Production starts here: build the server, listen on PORT (default 3000),
// install graceful-shutdown handlers, log the listen address.
//
// Tests import buildServer directly and don't run this file.

export { buildServer, type BuildServerInput, type ServerHandle } from "./server.js";
export type { RequestContext } from "./context.js";

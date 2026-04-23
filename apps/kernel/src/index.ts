// apps/kernel entry point.
//
// Production: build the kernel, listen on KERNEL_PORT (default 3100),
// install graceful-shutdown handlers, log the listen address.
//
// Tests import buildKernel directly and don't run this file.

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

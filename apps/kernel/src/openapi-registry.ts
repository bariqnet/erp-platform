// OpenAPI registry for the kernel. Single registry per server
// instance; `/docs/openapi.json` reads from it.
//
// extendZodWithOpenApi(z) MUST run before any route calls
// registry.registerPath() with nested Zod schemas — see
// apps/api/src/openapi-registry.ts for the same comment.

import {
  OpenApiGeneratorV31,
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

export function createOpenApiRegistry(): OpenAPIRegistry {
  return new OpenAPIRegistry();
}

export function generateOpenApiDocument(
  registry: OpenAPIRegistry,
  options: { readonly title: string; readonly version: string; readonly description?: string },
): ReturnType<OpenApiGeneratorV31["generateDocument"]> {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: options.title,
      version: options.version,
      ...(options.description !== undefined ? { description: options.description } : {}),
    },
  });
}

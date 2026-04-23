// Single OpenAPI registry every route registers its Zod schemas with.
// `/docs/openapi.json` reads from this registry to produce the spec.
//
// One registry per server instance; constructed by buildServer() and
// passed to plugins via the ServerWiring object. Plugins call
// `registry.registerPath(...)` for each route they ship.

import { OpenApiGeneratorV31, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

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

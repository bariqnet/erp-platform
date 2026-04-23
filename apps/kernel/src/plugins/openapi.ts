// openapi plugin — exposes /docs/openapi.json built from the registry.
// Routes register their Zod schemas via the registry; this plugin
// generates the spec on demand.

import { type OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import fp from "fastify-plugin";

import { generateOpenApiDocument } from "../openapi-registry.js";

import type { FastifyPluginAsync } from "fastify";

export interface OpenApiPluginOptions {
  readonly registry: OpenAPIRegistry;
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  /** Path to serve the spec at. Defaults to /docs/openapi.json. */
  readonly route?: string;
}

const openapiPlugin: FastifyPluginAsync<OpenApiPluginOptions> = async (app, opts) => {
  const route = opts.route ?? "/docs/openapi.json";

  app.get(route, async () => {
    return generateOpenApiDocument(opts.registry, {
      title: opts.title,
      version: opts.version,
      ...(opts.description !== undefined ? { description: opts.description } : {}),
    });
  });
};

export default fp(openapiPlugin, { name: "erp-kernel-openapi" });

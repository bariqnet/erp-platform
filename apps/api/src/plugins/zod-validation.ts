// zod-validation — small helpers for parsing request inputs through
// a Zod schema with `.parse()`. The errors plugin catches the
// resulting ZodError and converts it to RFC 7807.
//
// We don't use a Fastify validator-compiler integration (the
// fastify-type-provider-zod package requires Fastify 5; CLAUDE.md
// pins 4.x). Instead handlers call these helpers explicitly:
//
//   const body = parseBody(request, MyBodySchema);
//
// Pattern is documented in docs/patterns/writing-a-route.md.

import type { FastifyRequest } from "fastify";
import type { z, ZodTypeAny } from "zod";

export function parseBody<S extends ZodTypeAny>(request: FastifyRequest, schema: S): z.infer<S> {
  return schema.parse(request.body);
}

export function parseQuery<S extends ZodTypeAny>(request: FastifyRequest, schema: S): z.infer<S> {
  return schema.parse(request.query);
}

export function parseParams<S extends ZodTypeAny>(request: FastifyRequest, schema: S): z.infer<S> {
  return schema.parse(request.params);
}

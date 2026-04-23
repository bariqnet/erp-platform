// zod-validation — small helpers for parsing request inputs through a
// Zod schema. The errors plugin catches the resulting ZodError and
// converts it to RFC 7807. Same convention as apps/api.

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

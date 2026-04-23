// requireRole — preHandler factory that gates a route on the calling
// user's roles. Used by every Admin API endpoint that mutates state
// (the read endpoints don't need role gating beyond auth).
//
// CLAUDE.md §13 · TASK-10: writes require `metadata.write`; approve
// routes require `metadata.approve`; deploy/rollback require
// `metadata.deploy`.
//
// Returns a Fastify preHandler that throws 403 problem+json when the
// role is missing. Combine via Fastify's per-route preHandler array:
//
//   app.post("/x", { preHandler: [requireRole("metadata.write")] }, ...)

import { buildProblem } from "../schemas/error.js";

import type { FastifyReply, FastifyRequest } from "fastify";

export function requireRole(
  role: string,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const roles = request.appContext.userRoles;
    if (!roles.includes(role)) {
      const problem = buildProblem({
        status: 403,
        kind: "forbidden",
        detail: `Role '${role}' is required for this operation.`,
      });
      void reply.code(403).header("content-type", "application/problem+json").send(problem);
    }
  };
}

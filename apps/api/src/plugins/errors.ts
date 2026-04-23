// errors plugin — turns every thrown error into an RFC 7807 problem+json
// document (CLAUDE.md §5: "Errors follow RFC 7807. One error format,
// everywhere.").
//
// Validation errors (Fastify's FST_ERR_VALIDATION + ZodError) become
// 400 with a structured `errors` array; unknown throws become 500
// with the original message hidden in non-prod and surfaced in dev.

import fp from "fastify-plugin";
import { ZodError } from "zod";

import { buildProblem, type Problem } from "../schemas/error.js";

import type { FastifyPluginAsync } from "fastify";

const errorsPlugin: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((err, request, reply) => {
    request.appContext.logger.error(
      {
        err: { name: err.name, message: err.message, stack: err.stack },
        statusCode: err.statusCode,
      },
      "error handler invoked",
    );

    let problem: Problem;

    if (err instanceof ZodError) {
      problem = buildProblem({
        status: 400,
        kind: "validation_error",
        title: "Validation Error",
        detail: "One or more inputs failed validation.",
        errors: err.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    } else if (err.validation !== undefined || err.code === "FST_ERR_VALIDATION") {
      problem = buildProblem({
        status: 400,
        kind: "validation_error",
        title: "Validation Error",
        detail: err.message,
        errors: (err.validation ?? []).map((v) => ({
          path: typeof v.instancePath === "string" ? v.instancePath : "",
          message: v.message ?? "invalid",
        })),
      });
    } else if (
      typeof err.statusCode === "number" &&
      err.statusCode >= 400 &&
      err.statusCode < 600
    ) {
      problem = buildProblem({
        status: err.statusCode,
        ...(typeof err.code === "string" ? { kind: err.code } : {}),
        detail: err.message,
      });
    } else {
      const isProd = process.env.NODE_ENV === "production";
      problem = buildProblem({
        status: 500,
        kind: "internal_error",
        ...(isProd ? {} : { detail: err.message }),
      });
    }

    void reply
      .code(problem.status)
      .header("content-type", "application/problem+json")
      .send(problem);
  });

  // Default 404 handler — RFC 7807 too.
  app.setNotFoundHandler((request, reply) => {
    const problem = buildProblem({
      status: 404,
      kind: "not_found",
      detail: `No route for ${request.method} ${request.url}`,
    });
    void reply.code(404).header("content-type", "application/problem+json").send(problem);
  });
};

export default fp(errorsPlugin, { name: "erp-errors", dependencies: ["erp-telemetry"] });

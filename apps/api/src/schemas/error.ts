// RFC 7807 problem+json — the single error envelope every Admin and
// Runtime API endpoint returns on failure (CLAUDE.md §5).

import { z } from "zod";

export const ProblemSchema = z
  .object({
    /** A URI reference identifying the problem type. */
    type: z.string().url().or(z.literal("about:blank")),
    /** Short, human-readable summary. Same for every instance of this type. */
    title: z.string(),
    /** HTTP status code. */
    status: z.number().int().min(400).max(599),
    /** Per-instance human-readable explanation. */
    detail: z.string().optional(),
    /** A URI reference that identifies this specific occurrence. */
    instance: z.string().optional(),
    /** Per-machine error kind ("not_found", "forbidden", …). */
    kind: z.string().optional(),
    /** Free-form structured details for clients to surface to users. */
    errors: z
      .array(
        z.object({
          path: z.string().optional(),
          message: z.string(),
        }),
      )
      .optional(),
  })
  .strict();

export type Problem = z.infer<typeof ProblemSchema>;

/**
 * Build a Problem document from common error kinds. Defaults set
 * `type` to `about:blank` (per RFC 7807) and `title` to the standard
 * HTTP reason phrase.
 */
export function buildProblem(input: {
  status: number;
  kind?: string;
  title?: string;
  detail?: string;
  instance?: string;
  errors?: Problem["errors"];
}): Problem {
  return {
    type: "about:blank",
    title: input.title ?? defaultTitle(input.status),
    status: input.status,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    ...(input.instance !== undefined ? { instance: input.instance } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.errors !== undefined ? { errors: input.errors } : {}),
  };
}

function defaultTitle(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 409:
      return "Conflict";
    case 422:
      return "Unprocessable Entity";
    case 429:
      return "Too Many Requests";
    case 500:
      return "Internal Server Error";
    case 503:
      return "Service Unavailable";
    default:
      return `HTTP ${status}`;
  }
}

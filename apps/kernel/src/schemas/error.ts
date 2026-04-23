// RFC 7807 problem+json — the single error envelope every kernel
// endpoint returns on failure (CLAUDE.md §5). Shape matches apps/api
// so a client handling problems from one service handles both.

import { z } from "zod";

export const ProblemSchema = z
  .object({
    type: z.string().url().or(z.literal("about:blank")),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    detail: z.string().optional(),
    instance: z.string().optional(),
    kind: z.string().optional(),
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
    case 404:
      return "Not Found";
    case 409:
      return "Conflict";
    case 500:
      return "Internal Server Error";
    case 503:
      return "Service Unavailable";
    default:
      return `HTTP ${status}`;
  }
}

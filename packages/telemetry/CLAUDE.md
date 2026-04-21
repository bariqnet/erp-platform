# @erp/telemetry — Observability

## Purpose

The single place every service imports the **pino** logger and the
**OpenTelemetry** SDK from. Provides a consistent log shape (request
id, tenant id, trace id) and a consistent set of metric helpers
(latency histograms, counter factories) across `apps/api`,
`apps/kernel`, and `apps/worker`.

## Boundaries

**Imports:** `@erp/core`, plus `pino` and the OTel SDK packages
(added in TASK-09).

**Exports:** `createLogger(name)`, `withRequestContext(logger, ctx)`,
metric factories, and the OTel boot helper.

## Patterns

- **Structured JSON logs** via pino. Never `console.log` — the lint
  rule `no-console` blocks it (CLAUDE.md §15). `console.warn` and
  `console.error` are allowed but should be a last resort.
- **Trace context** propagates via W3C Trace Context headers (RFC §14.2).
- **Tenant id** is in every log line that runs under a tenant context
  (RFC §10.2, §14).

## Invariants

1. No service instantiates pino or the OTel SDK directly. Always go
   through this package.
2. Log lines under tenant context carry `tenant_id` as a structured
   field — enforced by the `RequestContext` plumbing in `apps/api`.

## Known gotchas

- This package populates in **TASK-09** (Fastify plugin wiring) and
  expands as services are added. TASK-01 ships only the scaffold.

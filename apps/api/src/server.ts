// The single place every Fastify dependency is wired up — plugins, routes,
// repositories, services. CLAUDE.md §7 non-negotiable #11 forbids
// instantiating Fastify, Kysely, or Redis anywhere else.
//
// TASK-09 replaces this stub with the real Fastify factory.

export interface ServerHandle {
  readonly name: string;
}

export function buildServer(): ServerHandle {
  return { name: "erp-api" };
}

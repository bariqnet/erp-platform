import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

describe("apps/api smoke", () => {
  it("buildServer constructs a Fastify app + closes cleanly without a real DB", async () => {
    // Pass a connectionString that points nowhere — the Pool is lazy,
    // so construction and shutdown work even when nothing answers.
    const handle = await buildServer({
      databaseUrl: "postgresql://nobody@localhost:1/none",
    });
    try {
      expect(handle.app).toBeDefined();
      expect(typeof handle.app.inject).toBe("function");
      expect(handle.registry).toBeDefined();
    } finally {
      await handle.close();
    }
  });
});

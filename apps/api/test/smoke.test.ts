import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

describe("apps/api smoke", () => {
  it("buildServer returns the named server placeholder", () => {
    const server = buildServer();
    expect(server.name).toBe("erp-api");
  });
});

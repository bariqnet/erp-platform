import { describe, expect, it } from "vitest";

import { createLogger, REDACT_PATHS } from "./logger.js";

describe("createLogger", () => {
  it("returns a logger with the requested level + service tag", () => {
    const logger = createLogger({ service: "api", level: "warn", pretty: false });
    expect(logger.level).toBe("warn");
    // pino exposes its bindings (the `base` we passed in).
    expect(logger.bindings()).toMatchObject({ service: "api", env: expect.any(String) });
  });

  it("child loggers inherit the bindings and add new ones", () => {
    const root = createLogger({ service: "api", level: "info", pretty: false });
    const child = root.child({ request_id: "r_1", tenant_id: "t_a" });
    expect(child.bindings()).toMatchObject({
      service: "api",
      request_id: "r_1",
      tenant_id: "t_a",
    });
  });

  it("respects an explicit `base` override", () => {
    const logger = createLogger({
      service: "kernel",
      level: "info",
      pretty: false,
      base: { region: "frankfurt" },
    });
    expect(logger.bindings()).toMatchObject({ service: "kernel", region: "frankfurt" });
  });
});

describe("REDACT_PATHS", () => {
  it("includes the common authentication-bearing fields", () => {
    expect(REDACT_PATHS).toContain("headers.authorization");
    expect(REDACT_PATHS).toContain("headers.cookie");
    expect(REDACT_PATHS).toContain("*.password");
    expect(REDACT_PATHS).toContain("*.token");
  });
});

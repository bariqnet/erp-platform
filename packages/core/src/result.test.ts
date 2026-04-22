import { describe, expect, it } from "vitest";

import { Result, type Err, type Ok } from "./result.js";

describe("Result.ok / Result.err factories", () => {
  it("ok() produces the success discriminator with the value", () => {
    const r = Result.ok(42);
    expect(r.ok).toBe(true);
    expect((r as Ok<number>).value).toBe(42);
  });

  it("err() produces the failure discriminator with the error", () => {
    const r = Result.err("not_found");
    expect(r.ok).toBe(false);
    expect((r as Err<string>).error).toBe("not_found");
  });

  it("each Result is plain-data JSON-serializable", () => {
    const ok = Result.ok({ id: "u_1" });
    const err = Result.err({ kind: "not_found", id: "u_1" });
    expect(JSON.parse(JSON.stringify(ok))).toEqual({ ok: true, value: { id: "u_1" } });
    expect(JSON.parse(JSON.stringify(err))).toEqual({
      ok: false,
      error: { kind: "not_found", id: "u_1" },
    });
  });
});

describe("Result.isOk / Result.isErr narrowing", () => {
  it("isOk is true for ok and false for err", () => {
    expect(Result.isOk(Result.ok(1))).toBe(true);
    expect(Result.isOk(Result.err("e"))).toBe(false);
  });

  it("isErr is the inverse of isOk", () => {
    expect(Result.isErr(Result.ok(1))).toBe(false);
    expect(Result.isErr(Result.err("e"))).toBe(true);
  });

  it("narrows the type in a branch", () => {
    const r = Result.ok("hello") as Result<string, number>;
    if (Result.isOk(r)) {
      // In this branch, r is typed Ok<string>, so r.value is string.
      expect(r.value.length).toBe(5);
    }
  });
});

describe("Result.map", () => {
  it("applies f when ok", () => {
    const r = Result.map(Result.ok(3), (n) => n * 2);
    expect(r).toEqual({ ok: true, value: 6 });
  });

  it("propagates err unchanged", () => {
    const r: Result<number, string> = Result.err("boom");
    const mapped = Result.map(r, (n) => n * 2);
    expect(mapped).toEqual({ ok: false, error: "boom" });
  });

  it("does not call f on err", () => {
    let called = 0;
    Result.map(Result.err("e") as Result<number, string>, (n) => {
      called += 1;
      return n;
    });
    expect(called).toBe(0);
  });
});

describe("Result.mapErr", () => {
  it("transforms the error when err", () => {
    const r = Result.mapErr(Result.err("raw") as Result<number, string>, (e) => ({
      kind: e,
    }));
    expect(r).toEqual({ ok: false, error: { kind: "raw" } });
  });

  it("passes through ok unchanged", () => {
    const r = Result.mapErr(Result.ok(5) as Result<number, string>, (e) => `${e}!`);
    expect(r).toEqual({ ok: true, value: 5 });
  });
});

describe("Result.flatMap", () => {
  it("threads into f on ok", () => {
    const parseInt = (s: string): Result<number, "not_a_number"> => {
      const n = Number(s);
      return Number.isFinite(n) ? Result.ok(n) : Result.err("not_a_number");
    };
    const r = Result.flatMap(Result.ok("42") as Result<string, "missing">, parseInt);
    expect(r).toEqual({ ok: true, value: 42 });
  });

  it("propagates err and widens the error type", () => {
    const parseInt = (_: string): Result<number, "not_a_number"> =>
      Result.err("not_a_number");
    const r = Result.flatMap(
      Result.err("missing") as Result<string, "missing">,
      parseInt,
    );
    expect(r).toEqual({ ok: false, error: "missing" });
  });

  it("returns the inner err when the first step succeeds and the next fails", () => {
    const parseInt = (_: string): Result<number, "not_a_number"> =>
      Result.err("not_a_number");
    const r = Result.flatMap(Result.ok("abc") as Result<string, never>, parseInt);
    expect(r).toEqual({ ok: false, error: "not_a_number" });
  });
});

describe("Result.match", () => {
  it("calls ok handler with the value on ok", () => {
    const out = Result.match(Result.ok(5), {
      ok: (v) => `ok:${v}`,
      err: (e) => `err:${String(e)}`,
    });
    expect(out).toBe("ok:5");
  });

  it("calls err handler with the error on err", () => {
    const out = Result.match(Result.err("boom") as Result<number, string>, {
      ok: (v) => `ok:${v}`,
      err: (e) => `err:${e}`,
    });
    expect(out).toBe("err:boom");
  });
});

describe("Result.unwrap / unwrapOr / unwrapOrElse", () => {
  it("unwrap returns the value on ok", () => {
    expect(Result.unwrap(Result.ok(7))).toBe(7);
  });

  it("unwrap throws on err with the serialized error in the message", () => {
    expect(() => Result.unwrap(Result.err({ kind: "boom" }))).toThrow(/Err/);
    expect(() => Result.unwrap(Result.err({ kind: "boom" }))).toThrow(/boom/);
  });

  it("unwrapOr returns the value on ok, the fallback on err", () => {
    expect(Result.unwrapOr(Result.ok(7) as Result<number, string>, 99)).toBe(7);
    expect(Result.unwrapOr(Result.err("e") as Result<number, string>, 99)).toBe(99);
  });

  it("unwrapOrElse computes the fallback from the error on err", () => {
    const out = Result.unwrapOrElse(
      Result.err("boom") as Result<number, string>,
      (e) => e.length,
    );
    expect(out).toBe(4);
  });
});

describe("Result composition", () => {
  it("chains map and flatMap together", () => {
    type E = "not_a_number" | "negative";
    const parse = (s: string): Result<number, E> => {
      const n = Number(s);
      return Number.isFinite(n) ? Result.ok(n) : Result.err("not_a_number");
    };
    const positive = (n: number): Result<number, E> =>
      n >= 0 ? Result.ok(n) : Result.err("negative");

    const r = Result.map(
      Result.flatMap(Result.flatMap(Result.ok("42"), parse), positive),
      (n) => n * 2,
    );
    expect(r).toEqual({ ok: true, value: 84 });

    const bad = Result.map(
      Result.flatMap(Result.flatMap(Result.ok("-1"), parse), positive),
      (n) => n * 2,
    );
    expect(bad).toEqual({ ok: false, error: "negative" });

    const worse = Result.map(
      Result.flatMap(Result.flatMap(Result.ok("abc"), parse), positive),
      (n) => n * 2,
    );
    expect(worse).toEqual({ ok: false, error: "not_a_number" });
  });
});

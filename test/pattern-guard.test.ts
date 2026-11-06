/**
 * Pattern ReDoS guard: schemas that use `pattern` are validated in a worker that
 * is terminated at a deadline, and fail closed. Direct tests of compileSchema and
 * validateArgumentsGuarded, plus one adapter-level check.
 *
 * The kill path is exercised with hostile input: one run of `^(a+)+$` on 30 a's
 * costs roughly 0.7-1 s in CI, so several such fields exceed a 500 ms deadline
 * on any machine. Deadline and stop behaviour are also covered with a 1 ms
 * deadline (a worker cannot boot and answer in 1 ms) and with a worker terminated
 * before it can reply.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  MAX_ARG_NODES,
  MAX_PATTERN_WORKERS,
  compileSchema,
  livePatternWorkerCount,
  probePatternWorker,
  terminatePatternWorkers,
  validateArgumentsGuarded,
} from "../src/schema.js";
import { UtcpAdapter } from "../src/plugin.js";
import { makeFakeHost } from "./helpers/host.js";
import { startUtcpFixture, type UtcpFixtureServer } from "./fixtures/utcp-http-server.js";

const LOWERCASE = "^[a-z]+$";
const TIME_LIMIT_MESSAGE = "validation of the arguments exceeded the time limit.";
const STOPPED_MESSAGE = "validation of the arguments was stopped before it finished.";
const MISS = {
  ok: false,
  path: "arguments.s",
  expected: "pattern",
  received: "string",
  message: "arguments.s violates 'pattern' in the tool's schema.",
};

function patternSchema(pattern: string) {
  return {
    type: "object",
    properties: { s: { type: "string", pattern } },
    required: ["s"],
  };
}

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  terminatePatternWorkers();
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    if (fn !== undefined) await fn();
  }
});

describe("pattern schemas (ReDoS guard)", () => {
  test("a pattern that matches passes, and a pattern miss is a normal failure from the worker", async () => {
    const compiled = compileSchema(patternSchema(LOWERCASE));
    expect(compiled.usesPattern).toBe(true);

    expect(await validateArgumentsGuarded(compiled, { s: "abc" })).toEqual({ ok: true });
    expect(await validateArgumentsGuarded(compiled, { s: "ABC" })).toEqual(MISS);
    expect(livePatternWorkerCount()).toBe(0);
  });

  test("a validation that misses its deadline is stopped, fails closed, and leaves the event loop alive", async () => {
    const compiled = compileSchema(patternSchema(LOWERCASE));
    // A 1 ms deadline is shorter than a worker boot, so the deadline always wins.
    const pending = validateArgumentsGuarded(compiled, { s: "abc" }, { deadlineMs: 1 });
    expect(livePatternWorkerCount()).toBe(1);

    // A timer started while the worker runs must still fire on time.
    const sleepStartedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(Date.now() - sleepStartedAt).toBeLessThan(400);

    expect(await pending).toEqual({
      ok: false,
      path: "arguments",
      expected: "validation within the time limit",
      received: "validation timed out",
      message: TIME_LIMIT_MESSAGE,
    });
    expect(livePatternWorkerCount()).toBe(0);
  });

  test("a schema without pattern takes the synchronous path and starts no worker", async () => {
    const schema = {
      type: "object",
      properties: { n: { type: "integer" }, tags: { type: "array", items: { type: "string" } } },
      required: ["n"],
      additionalProperties: false,
    };
    const compiled = compileSchema(schema);
    expect(compiled.usesPattern).toBe(false);
    expect(compiled.check.usesPattern).toBe(false);

    const pending = validateArgumentsGuarded(compiled, { n: 1, tags: ["x"] });
    expect(livePatternWorkerCount()).toBe(0);
    expect(await pending).toEqual({ ok: true });
    expect(await validateArgumentsGuarded(compiled, { n: "one" })).toMatchObject({ ok: false, path: "arguments.n" });
    expect(livePatternWorkerCount()).toBe(0);
  });

  test("terminatePatternWorkers stops an in-flight validation, which settles failing closed at once", async () => {
    const compiled = compileSchema(patternSchema(LOWERCASE));
    const startedAt = Date.now();
    const pending = validateArgumentsGuarded(compiled, { s: "abc" }, { deadlineMs: 5_000 });
    expect(livePatternWorkerCount()).toBe(1);

    // Called before the worker can answer, so the stop is what settles the call.
    terminatePatternWorkers();
    expect(livePatternWorkerCount()).toBe(0);
    expect(await pending).toEqual({
      ok: false,
      path: "arguments",
      expected: "validation to finish",
      received: "validation stopped",
      message: STOPPED_MESSAGE,
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("the ninth concurrent pattern validation is refused, and the first eight still run", async () => {
    const compiled = compileSchema(patternSchema(LOWERCASE));
    const first = Array.from({ length: MAX_PATTERN_WORKERS }, () =>
      validateArgumentsGuarded(compiled, { s: "ABC" }, { deadlineMs: 5_000 }),
    );
    expect(livePatternWorkerCount()).toBe(MAX_PATTERN_WORKERS);

    const ninth = validateArgumentsGuarded(compiled, { s: "ABC" }, { deadlineMs: 5_000 });
    expect(livePatternWorkerCount()).toBe(MAX_PATTERN_WORKERS);
    expect(await ninth).toEqual({
      ok: false,
      path: "arguments",
      expected: "a free validation slot",
      received: "too many validations in flight",
      message: "too many concurrent validations.",
    });

    for (const result of await Promise.all(first)) expect(result).toEqual(MISS);
    expect(livePatternWorkerCount()).toBe(0);
  });

  test("the pre-checks run before any worker: an over-large argument is refused without one", async () => {
    const compiled = compileSchema({
      type: "object",
      properties: { s: { type: "string", pattern: LOWERCASE }, xs: { type: "array", items: { type: "number" } } },
    });
    const args = { s: "abc", xs: Array.from({ length: MAX_ARG_NODES + 1 }, () => 0) };

    const pending = validateArgumentsGuarded(compiled, args, { deadlineMs: 5_000 });
    expect(livePatternWorkerCount()).toBe(0);
    expect(await pending).toEqual({
      ok: false,
      path: "arguments",
      expected: `arguments with at most ${MAX_ARG_NODES} values`,
      received: "too many values",
      message: "arguments contain too many values.",
    });
  });

  test("an adapter call whose pattern fails is refused with VALIDATION_FAILED and never reaches the fixture", async () => {
    const server: UtcpFixtureServer = startUtcpFixture({
      tools: [{ name: "pat", inputs: patternSchema(LOWERCASE) }],
    });
    cleanup.push(() => server.stop());
    const host = makeFakeHost({
      manuals: [
        {
          name: "demo",
          call_template_type: "http",
          http_method: "GET",
          url: `${server.url}/manual`,
          content_type: "application/json",
        },
      ],
    });
    const adapter = new UtcpAdapter(host.ctx, { log: () => {}, policyBaseline: () => "rule", disposeDeadlineMs: 500 });
    await adapter.start();
    cleanup.push(() => adapter.dispose());

    const refused = await host.runJson("call", { name: "demo.pat", arguments: { s: "ABC" } });
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe("VALIDATION_FAILED");
    expect(refused.error.message).toBe("arguments.s violates 'pattern' in the tool's schema.");
    expect(server.hits("pat")).toBe(0);

    const accepted = await host.runJson("call", { name: "demo.pat", arguments: { s: "abc" } });
    expect(accepted.ok).toBe(true);
    expect(server.hits("pat")).toBe(1);
  }, 20_000);
});

describe("hostile patterns (kill path)", () => {
  // One `^(a+)+$` run on 30 a's plus '!' costs roughly 0.7-1 s in Bun's regex
  // engine (measured in CI), so several of them in one argument object exceed a
  // 500 ms deadline on any machine. The worker must be terminated at the
  // deadline: the call returns inside the bound, fails closed with the
  // time-limit message, and leaves no worker behind.
  test("several hostile pattern fields together exceed the deadline and are stopped", async () => {
    const properties: Record<string, unknown> = {};
    const args: Record<string, string> = {};
    for (const key of ["a", "b", "c", "d", "e", "f"]) {
      properties[key] = { type: "string", pattern: "^(a+)+$" };
      args[key] = `${"a".repeat(30)}!`;
    }
    const compiled = compileSchema({ type: "object", properties });
    expect(compiled.check.supported).toBe(true);
    const started = Date.now();
    const result = await validateArgumentsGuarded(compiled, args, { deadlineMs: 500 });
    const elapsed = Date.now() - started;
    console.log(`hostile-patterns: ${elapsed} ms, ${result.ok ? "ok" : result.message}`);
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toBe(TIME_LIMIT_MESSAGE);
    expect(elapsed).toBeLessThan(3000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(livePatternWorkerCount()).toBe(0);

    // A worker that was not terminated would keep burning CPU while the host
    // waits. terminate() lets the regex run that is in progress finish (about
    // 0.35 s was observed), so skip a 1 s warm-up, then measure a further idle
    // second: a thread that was never stopped would burn about 1000 ms here.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const cpuBefore = process.cpuUsage();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const cpu = process.cpuUsage(cpuBefore);
    const cpuMs = (cpu.user + cpu.system) / 1_000;
    console.log(`hostile-patterns idle cpu: ${cpuMs.toFixed(1)} ms over 1000 ms`);
    expect(cpuMs).toBeLessThan(250);
  }, 20_000);
});

describe("hostile patterns through the adapter", () => {
  test("a call with six hostile pattern fields is VALIDATION_FAILED at the deadline, never dispatched, and never reaches the permission hook", async () => {
    const properties: Record<string, unknown> = {};
    const args: Record<string, string> = {};
    for (const key of ["a", "b", "c", "d", "e", "f"]) {
      properties[key] = { type: "string", pattern: "^(a+)+$" };
      args[key] = `${"a".repeat(30)}!`;
    }
    const server: UtcpFixtureServer = startUtcpFixture({
      tools: [{ name: "hostile", inputs: { type: "object", properties } }],
    });
    cleanup.push(() => server.stop());
    const host = makeFakeHost({
      manuals: [
        {
          name: "demo",
          call_template_type: "http",
          http_method: "GET",
          url: `${server.url}/manual`,
          content_type: "application/json",
        },
      ],
    });
    const adapter = new UtcpAdapter(host.ctx, { log: () => {}, policyBaseline: () => "rule", disposeDeadlineMs: 500 });
    await adapter.start();
    cleanup.push(() => adapter.dispose());

    const result = await host.runJson("call", { name: "demo.hostile", arguments: args });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(result.error.message).toBe(TIME_LIMIT_MESSAGE);
    expect(server.hits("hostile")).toBe(0);
    // Validation runs before assertPermission, so the permission hook never sees the call.
    expect(host.asserts).toHaveLength(0);
  }, 20_000);
});

describe("startup probe of the pattern worker", () => {
  test("the probe schema accepts 'a' and refuses 'b' as a pattern miss, through the guarded path", async () => {
    const compiled = compileSchema({
      type: "object",
      properties: { s: { type: "string", pattern: "^a$" } },
    });
    expect(await validateArgumentsGuarded(compiled, { s: "a" })).toEqual({ ok: true });
    expect(await validateArgumentsGuarded(compiled, { s: "b" })).toMatchObject({ ok: false, path: "arguments.s" });
    expect(livePatternWorkerCount()).toBe(0);
  });

  test("probePatternWorker resolves true locally and leaves no worker alive", async () => {
    expect(await probePatternWorker()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(livePatternWorkerCount()).toBe(0);
  }, 20_000);

  test("a probe whose deadline is missed resolves false, and still leaves no worker alive", async () => {
    // A worker cannot boot and answer within 1 ms, so the deadline path runs.
    expect(await probePatternWorker(1)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(livePatternWorkerCount()).toBe(0);
  }, 20_000);
});

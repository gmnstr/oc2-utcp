import { afterEach, describe, expect, test } from "bun:test";
import { UtcpAdapter, MAX_INFLIGHT_GLOBAL, MAX_INFLIGHT_PER_MANUAL } from "../src/plugin.js";
import { MAX_ARG_BYTES, refuseArgumentShape } from "../src/schema.js";
import { boundedJsonStringify, MAX_MODEL_OUTPUT_BYTES } from "../src/output.js";
import { makeFakeHost, type FakeHost } from "./helpers/host.js";
import { startUtcpFixture, httpManual, type FixtureTool, type UtcpFixtureServer } from "./fixtures/utcp-http-server.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

function fixture(tools: FixtureTool[]): UtcpFixtureServer {
  const server = startUtcpFixture({ tools });
  cleanup.push(() => server.stop());
  return server;
}

async function start(manuals: unknown[]): Promise<FakeHost> {
  const host = makeFakeHost({ manuals });
  const adapter = new UtcpAdapter(host.ctx, {
    log: () => undefined,
    policyBaseline: () => "rule",
    disposeDeadlineMs: 200,
  });
  await adapter.start();
  expect(adapter.status().state).toBe("ready");
  cleanup.push(() => adapter.dispose());
  return host;
}

async function waitFor(test: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!test()) {
    if (Date.now() >= deadline) throw new Error("requests did not reach fixture before deadline");
    await Bun.sleep(10);
  }
}

describe("pre-dispatch argument budget", () => {
  test("rejects an oversized string before permission, cloning or dispatch", async () => {
    const server = fixture([{
      name: "echo",
      inputs: { type: "object", properties: { payload: { type: "string" } }, required: ["payload"] },
    }]);
    const host = await start([httpManual("demo", server)]);
    const payload = "x".repeat(MAX_ARG_BYTES + 1);
    expect(refuseArgumentShape({ payload })?.received).toBe("too many bytes");
    const result = await host.runJson("call", { name: "demo.echo", arguments: { payload } });
    expect(result.error.code).toBe("VALIDATION_FAILED");
    expect(result.error.received).toBe("too many bytes");
    expect(host.asserts).toHaveLength(0);
    expect(server.hits("echo")).toBe(0);
  });
  test("counts large object keys as bytes", () => {
    const hugeKey = "k".repeat(MAX_ARG_BYTES + 1);
    expect(refuseArgumentShape({ [hugeKey]: 1 })?.received).toBe("too many bytes");
  });
});

describe("bounded tool presentation", () => {
  test("does not serialize an oversized response", async () => {
    const server = fixture([{ name: "large", respond: { payload: "x".repeat(MAX_MODEL_OUTPUT_BYTES + 100) } }]);
    const host = await start([httpManual("demo", server)]);
    const result = await host.runJson("call", { name: "demo.large", arguments: {} });
    expect(result).toMatchObject({ ok: false, error: { code: "RESULT_TOO_LARGE", outcome: "unknown" } });
    expect(JSON.stringify(result).length).toBeLessThan(1024);
    expect(server.hits("large")).toBe(1);
  });
  test("returns complete small results and refuses oversized trees", () => {
    expect(boundedJsonStringify({ ok: true, result: { a: 1 } })).toBe('{"ok":true,"result":{"a":1}}');
    expect(boundedJsonStringify(Array.from({ length: 30_000 }, () => 1))).toBeNull();
  });
});

describe("hard unsettled-call admission on every transport", () => {
  test("an http manual without waitMs cannot dispatch beyond the per-manual cap", async () => {
    const server = fixture([{ name: "hold", hold: true }]);
    const host = await start([httpManual("demo", server)]);
    const calls = Array.from({ length: MAX_INFLIGHT_PER_MANUAL }, () =>
      host.runJson("call", { name: "demo.hold", arguments: {} }),
    );
    await waitFor(() => server.hits("hold") === MAX_INFLIGHT_PER_MANUAL);
    const refused = await host.runJson("call", { name: "demo.hold", arguments: {} });
    expect(refused).toMatchObject({ ok: false, error: { code: "TOOL_UNAVAILABLE" } });
    expect(refused.error.outcome).toBeUndefined();
    expect(server.hits("hold")).toBe(MAX_INFLIGHT_PER_MANUAL);
    expect(server.releaseOne()).toBe(true);
    expect((await calls[0]).ok).toBe(true);
    const next = host.runJson("call", { name: "demo.hold", arguments: {} });
    await waitFor(() => server.hits("hold") === MAX_INFLIGHT_PER_MANUAL + 1);
    while (server.releaseOne()) { /* drain held calls */ }
    await Promise.all([...calls, next]);
  }, 30_000);

  test("mixed manuals share a hard global cap", async () => {
    expect(MAX_INFLIGHT_GLOBAL).toBe(2 * MAX_INFLIGHT_PER_MANUAL);
    const first = fixture([{ name: "hold", hold: true }]);
    const second = fixture([{ name: "hold", hold: true }]);
    const third = fixture([{ name: "hold", hold: true }]);
    const host = await start([httpManual("first", first), httpManual("second", second), httpManual("third", third)]);
    const a = Array.from({ length: MAX_INFLIGHT_PER_MANUAL }, () =>
      host.runJson("call", { name: "first.hold", arguments: {} }),
    );
    const b = Array.from({ length: MAX_INFLIGHT_PER_MANUAL }, () =>
      host.runJson("call", { name: "second.hold", arguments: {} }),
    );
    await waitFor(() => first.hits("hold") === MAX_INFLIGHT_PER_MANUAL && second.hits("hold") === MAX_INFLIGHT_PER_MANUAL);
    const refused = await host.runJson("call", { name: "third.hold", arguments: {} });
    expect(refused.error.code).toBe("TOOL_UNAVAILABLE");
    expect(third.hits("hold")).toBe(0);
    expect(first.releaseOne()).toBe(true);
    expect((await a[0]).ok).toBe(true);
    const nowAllowed = host.runJson("call", { name: "third.hold", arguments: {} });
    await waitFor(() => third.hits("hold") === 1);
    while (first.releaseOne()) {}
    while (second.releaseOne()) {}
    while (third.releaseOne()) {}
    await Promise.all([...a, ...b, nowAllowed]);
  }, 30_000);
});

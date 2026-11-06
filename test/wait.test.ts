/**
 * Bounded wait (`waitMs`, D2): a plain http or sse manual may opt into an
 * adapter-side deadline. At expiry the caller gets TIMEOUT with outcome
 * "unknown"; the SDK call is not cancelled, so it stays tracked until it
 * settles, a late result is discarded, expired calls are capped per manual,
 * and dispose still bounds its wait.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { MAX_ABANDONED_PER_MANUAL, MAX_OUTSTANDING_PER_MANUAL, UtcpAdapter } from "../src/plugin.js";
import type { LogEvent } from "../src/log.js";
import { makeFakeHost, type FakeHost } from "./helpers/host.js";
import { startUtcpFixture, type FixtureTool, type UtcpFixtureServer } from "./fixtures/utcp-http-server.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    if (fn !== undefined) await fn();
  }
});

function fixture(tools: FixtureTool[] = [{ name: "echo" }]): UtcpFixtureServer {
  const server = startUtcpFixture({ tools });
  cleanup.push(() => server.stop());
  return server;
}

function httpManual(name: string, server: UtcpFixtureServer, extra: Record<string, unknown> = {}) {
  return {
    name,
    call_template_type: "http",
    http_method: "GET",
    url: `${server.url}/manual`,
    content_type: "application/json",
    ...extra,
  };
}

interface Harness {
  host: FakeHost;
  adapter: UtcpAdapter;
  events: LogEvent[];
}

async function start(
  options: Record<string, unknown>,
  disposeDeadlineMs = 500,
  extraHooks: { abandonHoldMs?: number } = {},
): Promise<Harness> {
  const host = makeFakeHost(options);
  const events: LogEvent[] = [];
  const adapter = new UtcpAdapter(host.ctx, {
    log: (event) => events.push(event),
    policyBaseline: () => "rule",
    disposeDeadlineMs,
    ...extraHooks,
  });
  await adapter.start();
  cleanup.push(() => adapter.dispose());
  return { host, adapter, events };
}

/** The adapter's own bookkeeping, read for assertions only. */
function internals(adapter: UtcpAdapter): {
  inflight: Set<Promise<unknown>>;
  outstandingByManual: Map<string, number>;
  abandonedByManual: Map<string, number>;
  abandonHoldTimers: Set<unknown>;
} {
  return adapter as unknown as {
    inflight: Set<Promise<unknown>>;
    outstandingByManual: Map<string, number>;
    abandonedByManual: Map<string, number>;
    abandonHoldTimers: Set<unknown>;
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await Bun.sleep(5);
  }
}

describe("bounded wait expiry (D2 1)", () => {
  test("an http call that never answers is TIMEOUT with outcome unknown at waitMs, and is not retried", async () => {
    const server = fixture([{ name: "hang", hold: true }]);
    const { host } = await start({ manuals: [httpManual("demo", server, { waitMs: 1000 })] });

    const startedAt = Date.now();
    const result = await host.runJson("call", { name: "demo.hang", arguments: {} });
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("TIMEOUT");
    expect(result.error.outcome).toBe("unknown");
    expect(result.error.tool).toBe("demo.hang");
    expect(result.error.message).toContain("stopped waiting");
    expect(result.error.message).toContain("1000 ms");
    expect(result.error.message).toContain("not cancelled");
    expect(result.error.message).toContain("may still complete");
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2_500);

    // The request reached the fixture exactly once, and nothing re-sent it.
    await Bun.sleep(200);
    expect(server.hits("hang")).toBe(1);
  }, 20_000);
});

describe("late result after expiry (D2 2)", () => {
  test("a late success is discarded, and a later call to a healthy tool is unaffected", async () => {
    const server = fixture([{ name: "late", delayMs: 2_500 }, { name: "echo" }]);
    const { host, adapter } = await start({ manuals: [httpManual("demo", server, { waitMs: 1000 })] });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const expired = await host.runJson("call", { name: "demo.late", arguments: {} });
      expect(expired.error.code).toBe("TIMEOUT");

      const healthy = await host.runJson("call", { name: "demo.echo", arguments: {} });
      expect(healthy.ok).toBe(true);

      // The late response arrives about 1.5 s after expiry. Wait past it.
      await Bun.sleep(2_000);
      expect(server.hits("late")).toBe(1);
      expect(internals(adapter).inflight.size).toBe(0);
      expect(internals(adapter).abandonedByManual.get("demo")).toBeUndefined();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    const after = await host.runJson("call", { name: "demo.echo", arguments: {} });
    expect(after.ok).toBe(true);
  }, 20_000);

  test("a late failure (non-2xx) after expiry does not become an unhandled rejection", async () => {
    const server = fixture([{ name: "late", delayMs: 2_500, status: 500 }]);
    const { host, adapter } = await start({ manuals: [httpManual("demo", server, { waitMs: 1000 })] });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const expired = await host.runJson("call", { name: "demo.late", arguments: {} });
      expect(expired.error.code).toBe("TIMEOUT");

      await Bun.sleep(2_000);
      expect(server.hits("late")).toBe(1);
      expect(internals(adapter).inflight.size).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 20_000);
});

describe("no waitMs (D2 3)", () => {
  test("a manual without waitMs has no adapter deadline and a slow answer succeeds", async () => {
    const server = fixture([{ name: "slowish", delayMs: 1_500 }]);
    const { host, events } = await start({ manuals: [httpManual("demo", server)] });

    const startedAt = Date.now();
    const result = await host.runJson("call", { name: "demo.slowish", arguments: {} });

    expect(result.ok).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_400);
    const callEvent = events.find((entry) => entry.event === "call");
    expect(callEvent).toBeDefined();
    expect(callEvent).not.toHaveProperty("timedOut");
    expect(callEvent).not.toHaveProperty("waitMs");
  }, 20_000);
});

describe("abort before expiry (D2 5)", () => {
  test("an abort before the deadline returns the abort result once, and the timer never fires afterwards", async () => {
    const server = fixture([{ name: "hang", hold: true }]);
    const { host, events } = await start({ manuals: [httpManual("demo", server, { waitMs: 1000 })] });

    const controller = new AbortController();
    const pending = host.runJson("call", { name: "demo.hang", arguments: {} }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INTERNAL_ERROR");
    expect(result.error.outcome).toBe("unknown");
    expect(result.error.message).toContain("Outcome unknown");

    // Past the 1000 ms deadline: no second result, no timeout log line.
    await Bun.sleep(1_200);
    const callEvents = events.filter((entry) => entry.event === "call");
    expect(callEvents).toHaveLength(1);
    expect(callEvents[0]).toMatchObject({ ok: false, code: "INTERNAL_ERROR" });
    expect(callEvents[0]).not.toHaveProperty("timedOut");
  }, 20_000);
});

describe("abandoned-call cap (D2 6)", () => {
  test("at the cap the next call is refused before dispatch, and one settled call frees a slot", async () => {
    const server = fixture([{ name: "hang", hold: true }]);
    const { host, adapter } = await start({ manuals: [httpManual("demo", server, { waitMs: 1000 })] });

    const startedAt = Date.now();
    const expired = await Promise.all(
      Array.from({ length: MAX_ABANDONED_PER_MANUAL }, () =>
        host.runJson("call", { name: "demo.hang", arguments: {} }),
      ),
    );
    // Concurrent calls: the whole batch expires together, about one deadline.
    expect(Date.now() - startedAt).toBeLessThan(2_500);
    for (const result of expired) {
      expect(result.error.code).toBe("TIMEOUT");
    }
    expect(server.hits("hang")).toBe(MAX_ABANDONED_PER_MANUAL);
    expect(internals(adapter).abandonedByManual.get("demo")).toBe(MAX_ABANDONED_PER_MANUAL);

    // The ninth call is refused without reaching the fixture.
    const refused = await host.runJson("call", { name: "demo.hang", arguments: {} });
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe("TOOL_UNAVAILABLE");
    expect(refused.error.retryable).toBe(true);
    expect(refused.error.outcome).toBeUndefined();
    expect(server.total()).toBe(MAX_ABANDONED_PER_MANUAL);

    // One abandoned call settles, which frees exactly one slot.
    expect(server.releaseOne()).toBe(true);
    await waitFor(() => internals(adapter).abandonedByManual.get("demo") === MAX_ABANDONED_PER_MANUAL - 1, 5_000);

    // Calls dispatch again. This one is held too, so it expires as TIMEOUT.
    const again = await host.runJson("call", { name: "demo.hang", arguments: {} });
    expect(again.error.code).toBe("TIMEOUT");
    expect(server.hits("hang")).toBe(MAX_ABANDONED_PER_MANUAL + 1);
  }, 30_000);
});

describe("abandoned slot hold (D2 1)", () => {
  test("a slot is released at the hold deadline while the remote call never settles, and a later settle does not release it again", async () => {
    const server = fixture([{ name: "hang", hold: true }]);
    const { host, adapter } = await start(
      { manuals: [httpManual("demo", server, { waitMs: 1000 })] },
      500,
      { abandonHoldMs: 300 },
    );

    const fill = () => Array.from({ length: MAX_ABANDONED_PER_MANUAL }, () => host.runJson("call", { name: "demo.hang", arguments: {} }));
    for (const result of await Promise.all(fill())) expect(result.error.code).toBe("TIMEOUT");
    expect(internals(adapter).abandonedByManual.get("demo")).toBe(MAX_ABANDONED_PER_MANUAL);

    // Inside the hold window the cap still applies: the ninth call is refused.
    const refused = await host.runJson("call", { name: "demo.hang", arguments: {} });
    expect(refused.error.code).toBe("TOOL_UNAVAILABLE");
    expect(server.total()).toBe(MAX_ABANDONED_PER_MANUAL);

    // Past the hold the slots are free, but the remote calls are still pending
    // and stay tracked in inflight until they settle.
    await Bun.sleep(350);
    expect(internals(adapter).abandonedByManual.get("demo")).toBeUndefined();
    expect(internals(adapter).inflight.size).toBe(MAX_ABANDONED_PER_MANUAL);

    const again = await host.runJson("call", { name: "demo.hang", arguments: {} });
    expect(again.error.code).toBe("TIMEOUT");
    expect(server.hits("hang")).toBe(MAX_ABANDONED_PER_MANUAL + 1);
    expect(internals(adapter).abandonedByManual.get("demo")).toBe(1);

    // Settling the eight old calls must not release the new call's slot a second time.
    for (let index = 0; index < MAX_ABANDONED_PER_MANUAL; index += 1) expect(server.releaseOne()).toBe(true);
    await Bun.sleep(200);
    expect(internals(adapter).inflight.size).toBe(1);
    expect(internals(adapter).abandonedByManual.get("demo")).toBe(1);

    // Settling the last call drains the count to exactly zero.
    expect(server.releaseOne()).toBe(true);
    await waitFor(() => internals(adapter).inflight.size === 0, 5_000);
    expect(internals(adapter).abandonedByManual.get("demo")).toBeUndefined();

    // A full batch is admitted again, so the count is exactly zero and not negative.
    for (const result of await Promise.all(fill())) expect(result.error.code).toBe("TIMEOUT");
    const ninth = await host.runJson("call", { name: "demo.hang", arguments: {} });
    expect(ninth.error.code).toBe("TOOL_UNAVAILABLE");
    expect(server.hits("hang")).toBe(2 * MAX_ABANDONED_PER_MANUAL + 1);
  }, 30_000);
});

describe("abort-abandoned calls count toward the cap (D2 6b)", () => {
  test("calls the caller aborts fill the cap, and the ninth is refused TOOL_UNAVAILABLE without reaching the fixture", async () => {
    const server = fixture([{ name: "hang", hold: true }]);
    const { host, adapter } = await start({ manuals: [httpManual("demo", server, { waitMs: 1000 })] });

    const controllers = Array.from({ length: MAX_ABANDONED_PER_MANUAL }, () => new AbortController());
    const aborted = controllers.map((controller) =>
      host.runJson("call", { name: "demo.hang", arguments: {} }, { signal: controller.signal }),
    );
    await waitFor(() => server.hits("hang") === MAX_ABANDONED_PER_MANUAL, 5_000);
    for (const controller of controllers) controller.abort();

    for (const result of await Promise.all(aborted)) {
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("INTERNAL_ERROR");
      expect(result.error.outcome).toBe("unknown");
    }
    expect(internals(adapter).abandonedByManual.get("demo")).toBe(MAX_ABANDONED_PER_MANUAL);

    // The ninth call is refused before dispatch, so the fixture sees no new request.
    const refused = await host.runJson("call", { name: "demo.hang", arguments: {} });
    expect(refused.ok).toBe(false);
    expect(refused.error.code).toBe("TOOL_UNAVAILABLE");
    expect(refused.error.retryable).toBe(true);
    expect(server.total()).toBe(MAX_ABANDONED_PER_MANUAL);

    // Releasing the held requests settles them, and the count drains to zero.
    while (server.releaseOne()) {
      // Each release settles one held request.
    }
    await waitFor(() => internals(adapter).abandonedByManual.get("demo") === undefined, 5_000);
  }, 30_000);
});

describe("dispose with an expired call still pending (D2 7)", () => {
  test("dispose reports inflightAbandoned and returns within the stage deadline", async () => {
    const server = fixture([{ name: "hang", hold: true }]);
    const { host, adapter, events } = await start(
      { manuals: [httpManual("demo", server, { waitMs: 1000 })] },
      200,
    );

    const expired = await host.runJson("call", { name: "demo.hang", arguments: {} });
    expect(expired.error.code).toBe("TIMEOUT");
    expect(internals(adapter).inflight.size).toBe(1);

    const startedAt = Date.now();
    await adapter.dispose();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2_000);
    expect(adapter.status().state).toBe("closed");
    expect(
      events.some(
        (event) => event.event === "lifecycle" && event.phase === "closing" && event.detail === "inflightAbandoned:1",
      ),
    ).toBe(true);
  }, 20_000);
});

describe("expiry log line (D2 8)", () => {
  test("the expired call logs timedOut and waitMs, with no URL, header or argument text", async () => {
    const server = fixture([
      {
        name: "hang",
        hold: true,
        inputs: { type: "object", properties: { token: { type: "string" } }, additionalProperties: false },
      },
    ]);
    const { host, events } = await start({
      manuals: [
        {
          ...httpManual("demo", server, { waitMs: 1000 }),
          url: `${server.url}/manual?key=SECRET-QUERY`,
          headers: { Authorization: "SECRET-HEADER" },
        },
      ],
    });

    const result = await host.runJson("call", { name: "demo.hang", arguments: { token: "SECRET-ARGUMENT" } });
    expect(result.error.code).toBe("TIMEOUT");

    const callEvents = events.filter((entry) => entry.event === "call");
    expect(callEvents).toEqual([
      {
        event: "call",
        tool: "demo.hang",
        manual: "demo",
        transport: "http",
        durationMs: expect.any(Number),
        ok: false,
        code: "TIMEOUT",
        timedOut: true,
        waitMs: 1000,
        sessionID: "ses_test",
        invocationID: expect.any(String),
      },
    ]);

    const rendered = JSON.stringify(events);
    expect(rendered).not.toContain("SECRET-QUERY");
    expect(rendered).not.toContain("SECRET-HEADER");
    expect(rendered).not.toContain("SECRET-ARGUMENT");
    expect(rendered).not.toContain(server.url);
  }, 20_000);
});

describe("outstanding bound per manual (D2 1, hard)", () => {
  test("40 concurrent calls: 32 reach the fixture, 8 are refused at once, and the abandoned cap applies after the 32 expire", async () => {
    const server = fixture([{ name: "hang", hold: true }]);
    const { host, adapter } = await start({ manuals: [httpManual("demo", server, { waitMs: 1000 })] });

    const startedAt = Date.now();
    const outcomes = await Promise.all(
      Array.from({ length: MAX_OUTSTANDING_PER_MANUAL + 8 }, () =>
        host.runJson("call", { name: "demo.hang", arguments: {} }).then((result) => ({
          result,
          at: Date.now() - startedAt,
        })),
      ),
    );

    // The first 32 dispatch and expire at the deadline; the other 8 are refused
    // during dispatch, long before any deadline.
    const refused = outcomes.filter((outcome) => outcome.result.error?.code === "TOOL_UNAVAILABLE");
    const expired = outcomes.filter((outcome) => outcome.result.error?.code === "TIMEOUT");
    expect(refused).toHaveLength(8);
    expect(expired).toHaveLength(MAX_OUTSTANDING_PER_MANUAL);
    for (const { result, at } of refused) {
      expect(result.error.retryable).toBe(true);
      expect(result.error.outcome).toBeUndefined();
      expect(at).toBeLessThan(900);
    }
    expect(server.hits("hang")).toBe(MAX_OUTSTANDING_PER_MANUAL);

    const counts = internals(adapter);
    expect(counts.outstandingByManual.get("demo")).toBe(MAX_OUTSTANDING_PER_MANUAL);
    expect(counts.abandonedByManual.get("demo")).toBe(MAX_OUTSTANDING_PER_MANUAL);

    // The 32 are now abandoned, so the abandoned cap (8) refuses the next call.
    const after = await host.runJson("call", { name: "demo.hang", arguments: {} });
    expect(after.error.code).toBe("TOOL_UNAVAILABLE");
    expect(after.error.retryable).toBe(true);
    expect(server.hits("hang")).toBe(MAX_OUTSTANDING_PER_MANUAL);

    // Settling every held request releases both counts exactly to zero: they are
    // deleted at zero, never left negative, so a full batch is admitted again.
    while (server.releaseOne()) {
      // Each release settles one held request.
    }
    await waitFor(
      () => counts.outstandingByManual.get("demo") === undefined && counts.abandonedByManual.get("demo") === undefined,
      5_000,
    );
    expect(counts.inflight.size).toBe(0);
    const again = await host.runJson("call", { name: "demo.hang", arguments: {} });
    expect(again.error.code).toBe("TIMEOUT");
    expect(server.hits("hang")).toBe(MAX_OUTSTANDING_PER_MANUAL + 1);
  }, 30_000);
});

describe("dispose creates no abandon-hold timer (D2 2)", () => {
  test("a call that expires while dispose is still waiting for it leaves no hold timer behind", async () => {
    const server = fixture([{ name: "hang", hold: true }]);
    // dispose waits up to 1.5 s for the held call; the call expires at 1 s inside that wait.
    const { host, adapter } = await start({ manuals: [httpManual("demo", server, { waitMs: 1000 })] }, 1_500);

    const pending = host.runJson("call", { name: "demo.hang", arguments: {} });
    await Bun.sleep(200);
    await adapter.dispose();

    const result = await pending;
    expect(result.error.code).toBe("TIMEOUT");
    expect(adapter.status().state).toBe("closed");
    expect(internals(adapter).abandonedByManual.get("demo")).toBe(1);
    expect(internals(adapter).abandonHoldTimers.size).toBe(0);
  }, 20_000);
});

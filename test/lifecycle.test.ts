/**
 * Lifecycle, dispatch and configuration-diagnostic regressions: a failed start
 * must release the singleton, a pre-aborted call must not reach the transport,
 * dispose must be bounded, the per-session policy memo must be capped, the
 * policy scan must read real JSON, and an ignored `timeout` must be reported.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UtcpAdapter, UtcpAlreadyActiveError, createUtcpPlugin, defaultPolicyBaseline } from "../src/plugin.js";
import type { LogEvent } from "../src/log.js";
import { makeFakeHost } from "./helpers/host.js";
import { startUtcpFixture, type UtcpFixtureServer } from "./fixtures/utcp-http-server.js";
import { uninstallNoRetryMcpProtocol, resetNoRetryInstallationForTest } from "../src/mcp-no-retry.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    if (fn !== undefined) await fn();
  }
  uninstallNoRetryMcpProtocol();
  resetNoRetryInstallationForTest();
});

function fixture(tools: Array<{ name: string; delayMs?: number }> = [{ name: "echo" }]): UtcpFixtureServer {
  const server = startUtcpFixture({
    tools: tools.map((tool) => ({ name: tool.name, inputs: { type: "object", properties: {} }, delayMs: tool.delayMs })),
  });
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

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await Bun.sleep(5);
  }
}

describe("failed startup releases the singleton (A-06)", () => {
  test("an invalid config does not block a later plugin, and a running one still does", async () => {
    const server = fixture();

    const failing = createUtcpPlugin({ log: () => undefined, policyBaseline: () => "rule" });
    const failedHost = makeFakeHost({ manuals: "not-an-array" });
    const failedTeardown = await failing.setup(failedHost.ctx);
    expect(typeof failedTeardown).toBe("function");

    // Before the fix the claim survived the failed start and this factory threw.
    let laterPlugin: ReturnType<typeof createUtcpPlugin> | undefined;
    expect(() => {
      laterPlugin = createUtcpPlugin({ log: () => undefined, policyBaseline: () => "rule" });
    }).not.toThrow();

    const runningHost = makeFakeHost({ manuals: [httpManual("demo", server)] });
    const runningTeardown = await laterPlugin!.setup(runningHost.ctx);
    cleanup.push(async () => {
      if (typeof runningTeardown === "function") await runningTeardown();
    });
    expect(await runningHost.listNames()).toEqual(["search", "describe", "call"]);

    // The earlier plugin's teardown must not clear the claim of the adapter
    // that is now running: a third plugin is still refused.
    if (typeof failedTeardown === "function") await failedTeardown();
    expect(() => createUtcpPlugin({ log: () => undefined })).toThrow(UtcpAlreadyActiveError);
  }, 20_000);
});

describe("pre-aborted dispatch (A-03 part 1)", () => {
  test("a call whose signal is already aborted never reaches the transport", async () => {
    const server = fixture();
    const host = makeFakeHost({ manuals: [httpManual("demo", server)] });
    const adapter = new UtcpAdapter(host.ctx, { log: () => undefined, policyBaseline: () => "rule" });
    await adapter.start();
    cleanup.push(() => adapter.dispose());

    const controller = new AbortController();
    controller.abort();
    const result = await host.runJson(
      "call",
      { name: "demo.echo", arguments: {} },
      { signal: controller.signal },
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INTERNAL_ERROR");
    expect(result.error.message).toContain("before dispatch");
    expect(result.error.message).toContain("not sent");
    // It did not run, so the outcome is not "unknown".
    expect(result.error.outcome).toBeUndefined();
    expect(server.hits("echo")).toBe(0);
  }, 20_000);
});

describe("bounded dispose (A-03 part 2)", () => {
  test("dispose does not wait forever for an in-flight call that never answers", async () => {
    const server = fixture([{ name: "hang", delayMs: 5_000 }]);
    const host = makeFakeHost({ manuals: [httpManual("demo", server)] });
    const events: LogEvent[] = [];
    const adapter = new UtcpAdapter(host.ctx, {
      log: (event) => events.push(event),
      policyBaseline: () => "rule",
      disposeDeadlineMs: 200,
    });
    await adapter.start();

    const pending = host.runJson("call", { name: "demo.hang", arguments: {} });
    pending.catch(() => undefined);
    await waitFor(() => server.hits("hang") === 1, 5_000);

    const startedAt = Date.now();
    await adapter.dispose();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(3_000);
    expect(adapter.status().state).toBe("closed");
    expect(
      events.some(
        (event) => event.event === "lifecycle" && event.phase === "closing" && event.detail === "inflightAbandoned:1",
      ),
    ).toBe(true);
  }, 20_000);

  test("dispose does not wait forever for a client close that never resolves", async () => {
    const server = fixture();
    const host = makeFakeHost({ manuals: [httpManual("demo", server)] });
    const events: LogEvent[] = [];
    const adapter = new UtcpAdapter(host.ctx, {
      log: (event) => events.push(event),
      policyBaseline: () => "rule",
      disposeDeadlineMs: 200,
    });
    await adapter.start();

    // Simulates an MCP session whose cleanup never finishes.
    const client = (adapter as unknown as { client: { close: () => Promise<void> } }).client;
    client.close = () => new Promise<void>(() => {});

    const startedAt = Date.now();
    await adapter.dispose();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(3_000);
    expect(adapter.status().state).toBe("closed");
    expect(
      events.some((event) => event.event === "lifecycle" && event.phase === "closing" && event.detail === "closeTimedOut"),
    ).toBe(true);
  }, 20_000);
});

describe("policy session memo cap (A-05)", () => {
  test("more distinct sessions than the cap evict the oldest memo entry", async () => {
    const server = fixture();
    let probes = 0;
    const host = makeFakeHost({ manuals: [httpManual("demo", server)] });
    const adapter = new UtcpAdapter(host.ctx, {
      log: () => undefined,
      policyBaseline: () => {
        probes += 1;
        return "rule";
      },
    });
    await adapter.start();
    cleanup.push(() => adapter.dispose());

    const sessions = 1_030; // above MAX_POLICY_SESSIONS (1024)
    for (let index = 0; index < sessions; index += 1) {
      await host.runJson("call", { name: "demo.echo", arguments: {} }, { sessionID: `ses_${index}` });
    }
    expect(probes).toBe(sessions);

    // The newest session is still remembered: no second probe.
    await host.runJson("call", { name: "demo.echo", arguments: {} }, { sessionID: `ses_${sessions - 1}` });
    expect(probes).toBe(sessions);

    // The oldest session was evicted, so it is probed again. Without the cap
    // the memo would hold it forever and this would stay at `sessions`.
    await host.runJson("call", { name: "demo.echo", arguments: {} }, { sessionID: "ses_0" });
    expect(probes).toBe(sessions + 1);
  }, 120_000);
});

describe("policy baseline scan (A-policy)", () => {
  function configDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "oc2-utcp-policy-"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  }

  test("a utcp rule that only appears inside a comment is not a rule", () => {
    const dir = configDir({
      "opencode.jsonc": `{
  // "action": "utcp"
  /* {"action": "utcp"} */
  "permissions": []
}`,
    });
    expect(defaultPolicyBaseline(dir)).toBe("no-rule");
  });

  test("a utcp rule under the plural permissions array is a rule", () => {
    const dir = configDir({
      "opencode.json": `{ "permissions": [{ "action": "utcp", "resource": "*" }] }`,
    });
    expect(defaultPolicyBaseline(dir)).toBe("rule");
  });

  test("comment markers inside a string do not hide the rule that follows", () => {
    const dir = configDir({
      "opencode.json": `{ "note": "see /* here", "permissions": [{ "action": "utcp" }] }`,
    });
    expect(defaultPolicyBaseline(dir)).toBe("rule");
  });

  test("a utcp rule under the singular permission key is not counted", () => {
    const dir = configDir({
      "opencode.json": `{ "permission": [{ "action": "utcp" }] }`,
    });
    expect(defaultPolicyBaseline(dir)).toBe("no-rule");
  });

  test("an unparsable config is unknown, not no-rule", () => {
    const dir = configDir({ "opencode.json": `{ "permissions": [ ` });
    expect(defaultPolicyBaseline(dir)).toBe("unknown");
  });

  test("a trailing comma is treated as unparsable, so the verdict is unknown", () => {
    // Trailing commas are JSONC-legal but JSON.parse rejects them; the scan
    // does not extend the grammar, so the file reads as unparsable.
    const dir = configDir({
      "opencode.json": `{ "permissions": [{ "action": "utcp" },] }`,
    });
    expect(defaultPolicyBaseline(dir)).toBe("unknown");
  });

  test("no readable config file is unknown", () => {
    expect(defaultPolicyBaseline(configDir({}))).toBe("unknown");
    expect(defaultPolicyBaseline(undefined)).toBe("unknown");
  });
});

describe("ignored timeout notice (A-timeout)", () => {
  function configEvents(events: LogEvent[]): LogEvent[] {
    return events.filter((event) => event.event === "config" && event.notice === "timeoutIgnored");
  }

  test("an http manual with a timeout emits one timeoutIgnored notice without the value", async () => {
    const server = fixture();
    const host = makeFakeHost({ manuals: [httpManual("demo", server, { timeout: 4321 })] });
    const events: LogEvent[] = [];
    const adapter = new UtcpAdapter(host.ctx, { log: (event) => events.push(event), policyBaseline: () => "rule" });
    await adapter.start();
    cleanup.push(() => adapter.dispose());

    expect(configEvents(events)).toEqual([
      { event: "config", notice: "timeoutIgnored", manual: "demo", template: "http" },
    ]);
    expect(JSON.stringify(events)).not.toContain("4321");
  }, 20_000);

  test("an http manual with both timeout and waitMs still emits the notice, since timeout is ignored either way", async () => {
    const server = fixture();
    const host = makeFakeHost({ manuals: [httpManual("demo", server, { timeout: 4321, waitMs: 1000 })] });
    const events: LogEvent[] = [];
    const adapter = new UtcpAdapter(host.ctx, { log: (event) => events.push(event), policyBaseline: () => "rule" });
    await adapter.start();
    cleanup.push(() => adapter.dispose());

    expect(configEvents(events)).toEqual([
      { event: "config", notice: "timeoutIgnored", manual: "demo", template: "http" },
    ]);
    expect(JSON.stringify(events)).not.toContain("4321");
  }, 20_000);

  test("an sse manual with a timeout is reported with template sse", async () => {
    const server = fixture();
    const host = makeFakeHost({ manuals: [httpManual("feed", server, { call_template_type: "sse", timeout: 900 })] });
    const events: LogEvent[] = [];
    const adapter = new UtcpAdapter(host.ctx, { log: (event) => events.push(event), policyBaseline: () => "rule" });
    await adapter.start();
    cleanup.push(() => adapter.dispose());

    expect(configEvents(events)).toEqual([
      { event: "config", notice: "timeoutIgnored", manual: "feed", template: "sse" },
    ]);
  }, 20_000);

  test("a streamable_http manual with a timeout honours it and emits no notice", async () => {
    const server = fixture();
    const host = makeFakeHost({
      manuals: [httpManual("demo", server, { call_template_type: "streamable_http", timeout: 5000 })],
    });
    const events: LogEvent[] = [];
    const adapter = new UtcpAdapter(host.ctx, { log: (event) => events.push(event), policyBaseline: () => "rule" });
    await adapter.start();
    cleanup.push(() => adapter.dispose());

    // Positive control: the manual was registered, so the absence of a notice
    // is not just a manual that never got past classification.
    expect(adapter.status().manuals.find((entry) => entry.name === "demo")?.registered).toBe(true);
    expect(configEvents(events)).toEqual([]);
  }, 20_000);
});

describe("unnamed manuals (investigation)", () => {
  test("two unnamed http manuals both register and both tools are callable", async () => {
    const serverA = fixture([{ name: "alpha" }]);
    const serverB = fixture([{ name: "beta" }]);
    const host = makeFakeHost({
      manuals: [
        { ...httpManual("", serverA), name: undefined },
        { ...httpManual("", serverB), name: undefined },
      ],
    });
    const adapter = new UtcpAdapter(host.ctx, { log: () => undefined, policyBaseline: () => "rule" });
    await adapter.start();
    cleanup.push(() => adapter.dispose());

    const status = adapter.status();
    expect(status.manuals.filter((entry) => entry.registered)).toHaveLength(2);
    expect(status.tools).toHaveLength(2);

    for (const tool of status.tools) {
      const called = await host.runJson("call", { name: tool, arguments: {} });
      expect(called.ok).toBe(true);
    }
    expect(serverA.hits("alpha")).toBe(1);
    expect(serverB.hits("beta")).toBe(1);
  }, 20_000);
});

describe("dispose during a pending permission prompt (W7-1)", () => {
  test("a call still awaiting permission when dispose starts is refused and never dispatched", async () => {
    const server = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = makeFakeHost({ manuals: [httpManual("demo", server)] }, { onAssert: () => gate });
    const adapter = new UtcpAdapter(host.ctx, { log: () => undefined, policyBaseline: () => "rule" });
    await adapter.start();

    const pending = host.runJson("call", { name: "demo.echo", arguments: {} });
    await waitFor(() => host.asserts.length === 1, 5_000);

    const disposing = adapter.dispose();
    release();
    const result = await pending;
    await disposing;

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("TOOL_UNAVAILABLE");
    expect(result.error.retryable).toBe(false);
    expect(server.hits("echo")).toBe(0);
  }, 20_000);
});

describe("bounded deregistration (W7-2)", () => {
  test("dispose does not wait forever for a manual deregistration that never settles", async () => {
    const server = fixture();
    const host = makeFakeHost({ manuals: [httpManual("demo", server)] });
    const events: LogEvent[] = [];
    const adapter = new UtcpAdapter(host.ctx, {
      log: (event) => events.push(event),
      policyBaseline: () => "rule",
      disposeDeadlineMs: 200,
    });
    await adapter.start();

    const client = (adapter as unknown as { client: { deregisterManual: (n: string) => Promise<unknown> } }).client;
    client.deregisterManual = () => new Promise<void>(() => {});

    const startedAt = Date.now();
    await adapter.dispose();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(3_000);
    expect(adapter.status().state).toBe("closed");
    expect(
      events.some((event) => event.event === "lifecycle" && event.phase === "closing" && event.detail === "deregisterTimedOut"),
    ).toBe(true);
  }, 20_000);

  test("dispose does not wait forever for a registration disposal that never settles", async () => {
    const server = fixture();
    const host = makeFakeHost({ manuals: [httpManual("demo", server)] });
    const events: LogEvent[] = [];
    const adapter = new UtcpAdapter(host.ctx, {
      log: (event) => events.push(event),
      policyBaseline: () => "rule",
      disposeDeadlineMs: 200,
    });
    await adapter.start();

    (adapter as unknown as { registration: { dispose: () => Promise<void> } }).registration = {
      dispose: () => new Promise<void>(() => {}),
    };

    const startedAt = Date.now();
    await adapter.dispose();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(3_000);
    expect(adapter.status().state).toBe("closed");
    expect(
      events.some(
        (event) =>
          event.event === "lifecycle" && event.phase === "closing" && event.detail === "registrationDisposeTimedOut",
      ),
    ).toBe(true);
  }, 20_000);
});

describe("unterminated block comment in the policy file (W7-4)", () => {
  test("an unterminated block comment leaves the file unparsable, so the verdict is unknown", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc2-utcp-policy-"));
    writeFileSync(join(dir, "opencode.json"), `{"permissions":[]} /* unterminated`);
    expect(defaultPolicyBaseline(dir)).toBe("unknown");
  });
});

describe("advisory progress hook (W7-5)", () => {
  test("a progress hook that never settles does not block the call", async () => {
    const server = fixture();
    const host = makeFakeHost({ manuals: [httpManual("demo", server)] });
    const adapter = new UtcpAdapter(host.ctx, { log: () => undefined, policyBaseline: () => "rule" });
    await adapter.start();
    cleanup.push(() => adapter.dispose());

    let progressCalled = false;
    const call = host.runJson(
      "call",
      { name: "demo.echo", arguments: {} },
      {
        progress: () => {
          progressCalled = true;
          return new Promise<void>(() => {});
        },
      },
    );
    const outcome = await Promise.race([call, Bun.sleep(5_000).then(() => "hung" as const)]);

    expect(progressCalled).toBe(true);
    expect(outcome).not.toBe("hung");
    expect((outcome as { ok: boolean }).ok).toBe(true);
    expect(server.hits("echo")).toBe(1);
  }, 20_000);

  test("a progress hook that rejects does not fail the call", async () => {
    const server = fixture();
    const host = makeFakeHost({ manuals: [httpManual("demo", server)] });
    const adapter = new UtcpAdapter(host.ctx, { log: () => undefined, policyBaseline: () => "rule" });
    await adapter.start();
    cleanup.push(() => adapter.dispose());

    const result = await host.runJson(
      "call",
      { name: "demo.echo", arguments: {} },
      { progress: () => Promise.reject(new Error("progress sink failed")) },
    );

    expect(result.ok).toBe(true);
    expect(server.hits("echo")).toBe(1);
  }, 20_000);
});

describe("pattern guard startup notice", () => {
  test("one patternGuard notice with available true is logged before the adapter is ready", async () => {
    const server = fixture();
    const host = makeFakeHost({ manuals: [httpManual("demo", server)] });
    const events: LogEvent[] = [];
    const adapter = new UtcpAdapter(host.ctx, { log: (event) => events.push(event), policyBaseline: () => "rule" });
    await adapter.start();
    cleanup.push(() => adapter.dispose());

    const notices = events.filter((event) => event.event === "config" && event.notice === "patternGuard");
    expect(notices).toEqual([{ event: "config", notice: "patternGuard", available: true }]);

    const noticeAt = events.indexOf(notices[0]!);
    const readyAt = events.findIndex((event) => event.event === "lifecycle" && event.phase === "ready");
    expect(readyAt).toBeGreaterThan(noticeAt);
  }, 20_000);
});

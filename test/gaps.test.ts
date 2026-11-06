/**
 * Acceptance criteria that need a discriminating fixture rather than a unit
 * assertion: sampling what the adapter *did not* do (spawn, read, retry) and
 * what it reports when it cannot enforce a safety property.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UtcpClient } from "@utcp/sdk";

import { UtcpAdapter, createUtcpPlugin, UtcpAlreadyActiveError } from "../src/plugin.js";
import type { LogEvent } from "../src/log.js";
import { makeFakeHost, type FakeHost } from "./helpers/host.js";
import { startUtcpFixture, type UtcpFixtureServer } from "./fixtures/utcp-http-server.js";
import { resetNoRetryInstallationForTest, uninstallNoRetryMcpProtocol } from "../src/mcp-no-retry.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    if (fn !== undefined) await fn();
  }
  uninstallNoRetryMcpProtocol();
  resetNoRetryInstallationForTest();
});

interface Harness {
  host: FakeHost;
  adapter: UtcpAdapter;
  events: LogEvent[];
}

async function start(
  options: Record<string, unknown>,
  hooks: {
    policyBaseline?: () => "rule" | "no-rule" | "unknown";
    installMcpProtocol?: () => "installed" | "unsupported";
  } = {},
): Promise<Harness> {
  const host = makeFakeHost(options);
  const events: LogEvent[] = [];
  const adapter = new UtcpAdapter(host.ctx, {
    log: (event) => events.push(event),
    policyBaseline: hooks.policyBaseline ?? (() => "rule"),
    ...(hooks.installMcpProtocol ? { installMcpProtocol: hooks.installMcpProtocol } : {}),
  });
  await adapter.start();
  cleanup.push(() => adapter.dispose());
  return { host, adapter, events };
}

function fixture(): UtcpFixtureServer {
  const server = startUtcpFixture({
    tools: [{ name: "echo", inputs: { type: "object", properties: {} } }],
  });
  cleanup.push(() => server.stop());
  return server;
}

function httpManual(name: string, server: UtcpFixtureServer) {
  return {
    name,
    call_template_type: "http",
    http_method: "GET",
    url: `${server.url}/manual`,
    content_type: "application/json",
    timeout: 10_000,
  };
}

function mcpHttpManual(name: string, url: string) {
  return {
    name,
    call_template_type: "mcp",
    config: {
      mcpServers: {
        server: {
          transport: "http" as const,
          url,
          timeout: 5,
          sse_read_timeout: 5,
          terminate_on_close: true,
          notification_stream_max_retries: 0,
        },
      },
    },
  };
}

describe("MCP fail-closed registration", () => {
  test("an MCP manual is refused when the no-retry protocol cannot be installed", async () => {
    const server = fixture();
    const { adapter, events, host } = await start(
      { manuals: [mcpHttpManual("mcp_demo", "http://127.0.0.1:1/mcp"), httpManual("demo", server)] },
      { installMcpProtocol: () => "unsupported" },
    );

    const status = adapter.status();
    expect(status.state).toBe("ready");
    const refused = status.manuals.find((entry) => entry.name === "mcp_demo");
    expect(refused?.registered).toBe(false);
    expect(refused?.reason).toContain("retries a failed MCP call once");
    expect(refused?.reason).toContain("was not registered");

    expect(
      events.some(
        (event) => event.event === "lifecycle" && event.detail === "mcpRetrySuppressionUnavailable",
      ),
    ).toBe(true);

    // The refusal is per-manual: the unrelated HTTP manual still works.
    const called = await host.runJson("call", { name: "demo.echo", arguments: {} });
    expect(called.ok).toBe(true);
    expect(server.hits("echo")).toBe(1);
  }, 20_000);
});

describe("local-file refusal", () => {
  test("a local-file manual never opens its path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc2-utcp-stdio-"));
    const manualPath = join(dir, "manual.json");
    writeFileSync(manualPath, JSON.stringify({ tools: [] }));
    // Age the atime with mtime strictly later. macOS APFS and Linux relatime
    // only advance atime when atime < mtime, so atime == mtime (the epoch
    // fixture) would make the positive control below a no-op.
    utimesSync(manualPath, new Date(0), new Date(1000));
    const before = statSync(manualPath).atimeMs;

    const { adapter, host } = await start({
      manuals: [{ name: "files", call_template_type: "file", file_path: manualPath }],
    });

    const manual = adapter.status().manuals.find((entry) => entry.name === "files");
    expect(manual?.registered).toBe(false);
    expect(manual?.transport).toBe("local-file");

    await host.runJson("search", { query: "anything" });
    await host.runJson("call", { name: "files.anything", arguments: {} });

    expect(statSync(manualPath).atimeMs).toBe(before);
    // Positive control: reading the same path does move the counter, so the
    // assertion above is not vacuous.
    expect(readFileSync(manualPath, "utf8")).toContain("tools");
    expect(statSync(manualPath).atimeMs).toBeGreaterThan(before);
  }, 20_000);
});

describe("mcp-stdio spawn accounting", () => {
  const serverPath = join(import.meta.dir, "fixtures", "mcp-stdio-server.ts");

  function stdioManual(counter: string) {
    return {
      name: "stdio_demo",
      call_template_type: "mcp",
      config: {
        mcpServers: {
          server: {
            transport: "stdio" as const,
            command: process.execPath,
            args: [serverPath],
            env: { OC2_UTCP_COUNTER: counter },
          },
        },
      },
    };
  }

  function counterEvents(path: string): Array<{ event: string; pid?: number }> {
    try {
      return readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { event: string; pid?: number });
    } catch {
      return [];
    }
  }

  test("a disabled mcp-stdio manual spawns no child process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc2-utcp-stdio-off-"));
    const counter = join(dir, "counter.jsonl");

    const { adapter } = await start({ manuals: [stdioManual(counter)] });

    const manual = adapter.status().manuals.find((entry) => entry.name === "stdio_demo");
    expect(manual?.transport).toBe("mcp-stdio");
    expect(manual?.registered).toBe(false);
    expect(counterEvents(counter).filter((entry) => entry.event === "spawn")).toHaveLength(0);
  }, 20_000);

  test("terminate_on_close:false cannot keep a stdio child alive", async () => {
    // `terminate_on_close` exists only on the MCP *HTTP* server schema
    // (`node_modules/@utcp/mcp/dist/index.js:4068`); the stdio schema has no
    // such field and zod drops it. The child dies when the transport closes,
    // so no configuration value can leave a spawned process behind — spec §9.
    const dir = mkdtempSync(join(tmpdir(), "oc2-utcp-stdio-keep-"));
    const counter = join(dir, "counter.jsonl");
    const manual = stdioManual(counter) as Record<string, unknown> & {
      config: { mcpServers: { server: Record<string, unknown> } };
    };
    manual.config.mcpServers.server.terminate_on_close = false;

    const host = makeFakeHost({ manuals: [manual], transports: { "mcp-stdio": true } });
    const adapter = new UtcpAdapter(host.ctx, { log: () => undefined });
    await adapter.start();

    const spawns = counterEvents(counter).filter((entry) => entry.event === "spawn");
    expect(spawns).toHaveLength(1);
    const pid = spawns[0]!.pid as number;

    await adapter.dispose();
    await Bun.sleep(100);

    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);

  test("an enabled mcp-stdio manual spawns one child and terminates it on dispose", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc2-utcp-stdio-on-"));
    const counter = join(dir, "counter.jsonl");

    const host = makeFakeHost({
      manuals: [stdioManual(counter)],
      transports: { "mcp-stdio": true },
    });
    const adapter = new UtcpAdapter(host.ctx, { log: () => undefined });
    await adapter.start();

    const spawns = counterEvents(counter).filter((entry) => entry.event === "spawn");
    expect(spawns).toHaveLength(1);
    const pid = spawns[0]!.pid as number;
    expect(typeof pid).toBe("number");

    await adapter.dispose();
    // The transport may close stdin or signal the child; either way the child
    // must record its own teardown and must not survive the adapter.
    await Bun.sleep(100);

    const events = counterEvents(counter);
    const terminated = events.some(
      (entry) =>
        (entry.event === "stop" || entry.event === "stdin-end") && (entry.pid ?? pid) === pid,
    );
    expect(terminated).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);
});

describe("transport timeout", () => {
  test("a slow tool reports TIMEOUT and warns that the call may still have completed", async () => {
    const server = startUtcpFixture({
      tools: [
        {
          name: "slow",
          inputs: { type: "object", properties: {} },
          delayMs: 800,
          // Only the streamable-http call template carries a timeout that the
          // transport honours; the plain `http` template has no such field.
          template: { call_template_type: "streamable_http", timeout: 150 },
        },
      ],
    });
    cleanup.push(() => server.stop());

    const { host } = await start({
      manuals: [{ ...httpManual("demo", server), call_template_type: "streamable_http", timeout: 5000 }],
    });

    const called = await host.runJson("call", { name: "demo.slow", arguments: {} });
    expect(called.ok).toBe(false);
    expect(called.error.code).toBe("TIMEOUT");
    expect(called.error.message).toContain("timed out in the UTCP transport");
    expect(called.error.message).toContain("may still have completed");
  }, 30_000);
});

describe("adapter log hygiene", () => {
  test("adapter events carry no credentials, URLs or argument payloads", async () => {
    const server = startUtcpFixture({
      tools: [{ name: "echo", inputs: { type: "object", properties: { token: { type: "string" } } } }],
    });
    cleanup.push(() => server.stop());

    const { host, events } = await start({
      manuals: [
        {
          ...httpManual("demo", server),
          url: `${server.url}/manual?key=SECRET-QUERY`,
          headers: { Authorization: "SECRET-HEADER" },
        },
      ],
    });

    const ok = await host.runJson("call", {
      name: "demo.echo",
      arguments: { token: "SECRET-ARGUMENT" },
    });
    expect(ok.ok).toBe(true);
    await host.runJson("call", { name: "demo.nope", arguments: { token: "SECRET-ARGUMENT" } });

    const rendered = JSON.stringify(events);
    expect(rendered).not.toContain("SECRET-QUERY");
    expect(rendered).not.toContain("SECRET-HEADER");
    expect(rendered).not.toContain("SECRET-ARGUMENT");
    expect(rendered).not.toContain(server.url);
    // Positive control: the events are not empty and name the tool.
    expect(rendered).toContain("demo.echo");
  }, 20_000);
});

describe("single instance", () => {
  test("a second setup fails with CONFIG_INVALID and a clear message", async () => {
    const server = fixture();
    const plugin = createUtcpPlugin({ log: () => undefined, policyBaseline: () => "rule" });
    const host = makeFakeHost({ manuals: [httpManual("demo", server)] });
    const teardown = await plugin.setup(host.ctx);
    cleanup.push(async () => {
      if (typeof teardown === "function") await teardown();
    });

    let thrown: unknown;
    try {
      createUtcpPlugin({ log: () => undefined });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UtcpAlreadyActiveError);
    expect((thrown as UtcpAlreadyActiveError).code).toBe("CONFIG_INVALID");
    expect((thrown as Error).message).toContain("already active");
  }, 20_000);

  test("the same plugin object cannot be set up twice", async () => {
    const server = fixture();
    const plugin = createUtcpPlugin({ log: () => undefined, policyBaseline: () => "rule" });
    const first = makeFakeHost({ manuals: [httpManual("demo", server)] });
    const teardown = await plugin.setup(first.ctx);
    cleanup.push(async () => {
      if (typeof teardown === "function") await teardown();
    });

    const second = makeFakeHost({ manuals: [httpManual("demo", server)] });
    let thrown: unknown;
    try {
      await plugin.setup(second.ctx);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UtcpAlreadyActiveError);
    expect((thrown as UtcpAlreadyActiveError).code).toBe("CONFIG_INVALID");

    // The refusal is whole: the first host keeps exactly one registration and
    // the second host receives nothing.
    expect(await first.listNames()).toEqual(["search", "describe", "call"]);
    expect(await second.listNames()).toEqual([]);
  }, 20_000);
});

describe("configuration location", () => {
  test("an unresolvable plugin directory fails closed instead of using the process cwd", async () => {
    // Spec §4: the host process cwd is not the session's project. When neither
    // `rootDir` nor a configured location exists, guessing would hand the SDK
    // an unrelated tree to resolve relative manual paths against.
    const host = makeFakeHost({ manuals: [] });
    (host.ctx as { location?: unknown }).location = undefined;
    const adapter = new UtcpAdapter(host.ctx, { log: () => undefined, policyBaseline: () => "rule" });
    await adapter.start();

    expect(adapter.status().state).toBe("closed");
    expect(adapter.status().error?.code).toBe("CONFIG_INVALID");
    expect(adapter.status().error?.message).toContain("Cannot resolve the plugin location");
    expect(await host.listNames()).toEqual([]);
    await adapter.dispose();
  });

  test("an explicit rootDir wins over the configured location", async () => {
    const host = makeFakeHost({ rootDir: "/tmp/work", manuals: [] });
    const adapter = new UtcpAdapter(host.ctx, { log: () => undefined, policyBaseline: () => "rule" });
    await adapter.start();

    expect(adapter.status().state).toBe("ready");
    await adapter.dispose();
  });
});

describe("waitMs configuration (D2 4)", () => {
  async function startWithTemplate(template: Record<string, unknown>) {
    const host = makeFakeHost({ manuals: [template] });
    const adapter = new UtcpAdapter(host.ctx, { log: () => undefined, policyBaseline: () => "rule" });
    await adapter.start();
    cleanup.push(() => adapter.dispose());
    return { host, adapter };
  }

  const mcpServers = { s: { transport: "http", url: "http://127.0.0.1:1/mcp" } };

  test.each([
    ["streamable_http", { name: "demo", call_template_type: "streamable_http", url: "http://127.0.0.1:1/m" }, "'demo'"],
    ["mcp", { name: "demo", call_template_type: "mcp", config: { mcpServers } }, "'demo'"],
    ["file", { name: "demo", call_template_type: "file", file_path: "/tmp/work/manual.md" }, "'demo'"],
    ["http below range", { name: "demo", call_template_type: "http", url: "http://127.0.0.1:1/m", waitMs: 999 }, "'demo'"],
    ["http above range", { name: "demo", call_template_type: "http", url: "http://127.0.0.1:1/m", waitMs: 600_001 }, "'demo'"],
    ["http fractional", { name: "demo", call_template_type: "http", url: "http://127.0.0.1:1/m", waitMs: 1500.5 }, "'demo'"],
    ["http string", { name: "demo", call_template_type: "http", url: "http://127.0.0.1:1/m", waitMs: "1500" }, "'demo'"],
    ["http null", { name: "demo", call_template_type: "http", url: "http://127.0.0.1:1/m", waitMs: null }, "'demo'"],
    ["unnamed http", { call_template_type: "http", url: "http://127.0.0.1:1/m", waitMs: 999 }, "manuals[0]"],
  ])("waitMs on %s is CONFIG_INVALID naming the manual and key", async (_label, template, label) => {
    const waitMs = (template as { waitMs?: unknown }).waitMs;
    const withWait = waitMs === undefined ? { ...template, waitMs: 1000 } : template;
    const { host, adapter } = await startWithTemplate(withWait);

    expect(adapter.status().state).toBe("closed");
    expect(adapter.status().error?.code).toBe("CONFIG_INVALID");
    expect(adapter.status().error?.message).toContain(label);
    expect(adapter.status().error?.message).toContain("waitMs");
    expect(await host.listNames()).toEqual([]);
  });

  test("waitMs on an unnamed http manual is CONFIG_INVALID even with a valid value, and the message says a name is required", async () => {
    const { host, adapter } = await startWithTemplate({
      call_template_type: "http",
      url: "http://127.0.0.1:1/m",
      waitMs: 1000,
    });

    expect(adapter.status().state).toBe("closed");
    expect(adapter.status().error?.code).toBe("CONFIG_INVALID");
    expect(adapter.status().error?.message).toContain("manuals[0]");
    expect(adapter.status().error?.message).toContain("`waitMs`");
    expect(adapter.status().error?.message).toContain("requires the manual to have a `name`");
    expect(await host.listNames()).toEqual([]);
  });

  test("waitMs on a manual whose name is longer than 120 characters is CONFIG_INVALID naming the name", async () => {
    const { host, adapter } = await startWithTemplate({
      name: "n".repeat(121),
      call_template_type: "http",
      url: "http://127.0.0.1:1/m",
      waitMs: 1000,
    });

    expect(adapter.status().state).toBe("closed");
    expect(adapter.status().error?.code).toBe("CONFIG_INVALID");
    expect(adapter.status().error?.message).toContain("`name`");
    expect(adapter.status().error?.message).toContain("120 characters");
    expect(adapter.status().error?.message).toContain("`waitMs`");
    expect(await host.listNames()).toEqual([]);
  });

  test("waitMs on a manual whose name is exactly 120 characters is accepted", async () => {
    const server = fixture();
    const host = makeFakeHost({ manuals: [{ ...httpManual("n".repeat(120), server), waitMs: 1000 }] });
    const adapter = new UtcpAdapter(host.ctx, { log: () => undefined, policyBaseline: () => "rule" });
    await adapter.start();
    cleanup.push(() => adapter.dispose());

    expect(adapter.status().error).toBeNull();
    expect(adapter.status().state).toBe("ready");
  }, 20_000);

  test("waitMs at the bounds is accepted on http and sse, and is never forwarded to the SDK", async () => {
    const server = fixture();
    type Register = (templates: Array<Record<string, unknown>>) => Promise<unknown>;
    const proto = UtcpClient.prototype as unknown as { registerManuals: Register };
    const original: Register = proto.registerManuals;
    const forwarded: Array<Record<string, unknown>> = [];
    proto.registerManuals = function (this: unknown, templates: Array<Record<string, unknown>>) {
      forwarded.push(...templates);
      return original.call(this, templates);
    };
    try {
      const host = makeFakeHost({
        manuals: [
          { ...httpManual("low", server), waitMs: 1000 },
          { ...httpManual("high", server), waitMs: 600_000 },
          { ...httpManual("feed", server), call_template_type: "sse", waitMs: 1000 },
        ],
      });
      const adapter = new UtcpAdapter(host.ctx, { log: () => undefined, policyBaseline: () => "rule" });
      await adapter.start();
      cleanup.push(() => adapter.dispose());

      expect(adapter.status().error).toBeNull();
      expect(adapter.status().state).toBe("ready");
      expect(adapter.status().manuals.find((entry) => entry.name === "low")?.registered).toBe(true);
      expect(adapter.status().manuals.find((entry) => entry.name === "high")?.registered).toBe(true);
      expect(forwarded).toHaveLength(3);
      expect(forwarded.some((template) => "waitMs" in template)).toBe(false);
    } finally {
      proto.registerManuals = original;
    }
  }, 20_000);
});

describe("argument snapshot (D2 8)", () => {
  const echoInputs = {
    type: "object",
    properties: { message: { type: "string" } },
    additionalProperties: false,
  };

  test("arguments changed during the permission await are not what the transport receives", async () => {
    const server = startUtcpFixture({ tools: [{ name: "echo", inputs: echoInputs }] });
    cleanup.push(() => server.stop());
    const args: Record<string, unknown> = { message: "original" };
    const host = makeFakeHost(
      { manuals: [{ name: "demo", call_template_type: "http", http_method: "GET", url: `${server.url}/manual`, content_type: "application/json" }] },
      // The caller mutates the object it passed in, after validation and before dispatch.
      { onAssert: () => void (args.message = "changed-during-permission") },
    );
    const adapter = new UtcpAdapter(host.ctx, { log: () => undefined, policyBaseline: () => "rule" });
    await adapter.start();
    cleanup.push(() => adapter.dispose());

    const result = await host.runJson("call", { name: "demo.echo", arguments: args });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.result)).toContain("original");
    expect(JSON.stringify(result.result)).not.toContain("changed-during-permission");
  }, 20_000);

  test("arguments that cannot be copied are INVALID_ARGUMENTS, and nothing is asked or sent", async () => {
    const server = startUtcpFixture({ tools: [{ name: "echo", inputs: echoInputs }] });
    cleanup.push(() => server.stop());
    const host = makeFakeHost({
      manuals: [{ name: "demo", call_template_type: "http", http_method: "GET", url: `${server.url}/manual`, content_type: "application/json" }],
    });
    const adapter = new UtcpAdapter(host.ctx, { log: () => undefined, policyBaseline: () => "rule" });
    await adapter.start();
    cleanup.push(() => adapter.dispose());

    const result = await host.runJson("call", { name: "demo.echo", arguments: { message: "x", extra: () => 1 } });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INVALID_ARGUMENTS");
    expect(result.error.message).toBe("`arguments` could not be copied for validation, so the call was not sent.");
    expect(host.asserts).toHaveLength(0);
    expect(server.total()).toBe(0);
  }, 20_000);
});

describe("permission ask shape", () => {
  test("the assert carries the session, the agent and the tool call source", async () => {
    const server = fixture();
    const { host } = await start({ manuals: [httpManual("demo", server)], tools: ["demo.*"] });

    await host.runJson("call", { name: "demo.echo", arguments: {} });

    // Spec §6.2: the whole request, not just the action. `source` identifies
    // the tool call that caused the ask; `save` is the durable-approval rule
    // and is present only for a name that is safe as a rule.
    expect(host.asserts).toEqual([
      {
        sessionID: "ses_test",
        agent: "build",
        source: { type: "tool", messageID: "msg_test", id: "call_test" },
        action: "utcp",
        resources: ["demo.echo"],
        save: ["demo.echo"],
      },
    ]);
  }, 20_000);
});

describe("logging channels", () => {
  test("the SDK keeps writing to stdout while adapter events stay on stderr", async () => {
    // Spec §11 #18: the two channels are tested separately. The probe runs in
    // its own process so stdout and stderr are captured by the OS, not by a
    // patched global stream: nothing in `src/` diverts the SDK's output.
    const child = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "fixtures", "channel-probe.ts")],
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);

    // The SDK channel: unfiltered, and it carries the tool name and the fully
    // substituted URL. This is the behaviour the README discloses.
    expect(stdout).toContain("Successfully registered manual 'demo'");
    expect(stdout).toContain("Calling tool 'demo.echo'");
    expect(stdout).toContain("[HttpCommunicationProtocol] Executing HTTP tool 'demo.echo' with URL: http://127.0.0.1:");

    // The adapter channel is stderr, and the two never mix.
    expect(stdout).not.toContain("[oc2-utcp]");
    expect(stderr).toContain('[oc2-utcp] {"event":"call","tool":"demo.echo"');
    expect(stderr).not.toContain("Executing HTTP tool");
    expect(stderr).not.toContain("127.0.0.1");
  }, 60_000);
});

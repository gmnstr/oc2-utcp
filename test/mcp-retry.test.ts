import { afterEach, describe, expect, test } from "bun:test";

import { CommunicationProtocol, UtcpClient } from "@utcp/sdk";
import { McpCommunicationProtocol } from "@utcp/mcp";

import { startFlakyMcpServer, type FlakyMcpServer } from "./fixtures/mcp-flaky-server.js";
import {
  checkProtocolSurface,
  installNoRetryMcpProtocol,
  resetNoRetryInstallationForTest,
  uninstallNoRetryMcpProtocol,
} from "../src/mcp-no-retry.js";

/** Every helper the no-retry override reads from the base prototype. */
const REQUIRED_HELPERS = [
  "_dereferenceSchema",
  "_sessionKey",
  "_getTimeoutMs",
  "_getOrCreateSession",
  "_withSession",
  "_runWithTimeout",
  "_classifySessionError",
  "_cleanupSession",
  "_invalidateOAuthToken",
];

function fakePrototype(
  options: { omit?: string; callTool?: (...args: never[]) => unknown } = {},
): Record<string, unknown> {
  const proto: Record<string, unknown> = {};
  for (const name of REQUIRED_HELPERS) {
    if (name !== options.omit) proto[name] = () => undefined;
  }
  // Default: a callTool that routes through `_withSession`, like the base.
  proto["callTool"] =
    options.callTool ??
    (async function callTool(this: { _withSession(): unknown }) {
      return this._withSession();
    });
  return proto;
}

/**
 * Behavioural proof for spec §8 ("never automatically retry a potentially
 * mutating operation").
 *
 * `@utcp/mcp@1.2.0` retries a transient session failure once, re-running the
 * same operation — including `tools/call`. These tests discriminate the stock
 * behaviour from the adapter's no-retry protocol by counting executions on the
 * server side, not by reading the SDK source.
 */

const servers: FlakyMcpServer[] = [];
const clients: UtcpClient[] = [];

function mcpManual(name: string, url: string) {
  return {
    name,
    call_template_type: "mcp",
    config: {
      mcpServers: {
        flaky: {
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

function newServer(): FlakyMcpServer {
  const server = startFlakyMcpServer();
  servers.push(server);
  return server;
}

async function clientFor(url: string, manualName = "flaky"): Promise<string> {
  const client = await UtcpClient.create();
  clients.push(client);
  const result = await client.registerManual(mcpManual(manualName, url));
  expect(result.success).toBe(true);
  const tools = await client.getTools();
  expect(tools.length).toBe(1);
  return tools[0]!.name;
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close().catch(() => undefined);
  }
  for (const server of servers.splice(0)) {
    server.stop();
  }
  uninstallNoRetryMcpProtocol();
  resetNoRetryInstallationForTest();
});

describe("MCP mutating-call replay", () => {
  test("stock @utcp/mcp re-executes a failed call (documents the defect)", async () => {
    const server = newServer();
    const toolName = await clientFor(server.url);
    const client = clients[0]!;

    const result = await client.callTool(toolName, {});
    // The retry makes the caller see success even though the call ran twice.
    expect(JSON.stringify(result)).toContain("executions=2");
    expect(server.calls()).toBe(2);
    expect(server.executions()).toBe(2);
  });

  test("the no-retry protocol executes exactly once and surfaces the failure", async () => {
    expect(installNoRetryMcpProtocol()).toBe("installed");

    const server = newServer();
    const toolName = await clientFor(server.url);
    const client = clients[0]!;

    let error: unknown;
    try {
      await client.callTool(toolName, {});
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(server.executions()).toBe(1);
    expect(server.calls()).toBe(1);

    // A later call reconnects and succeeds; only the failure was not replayed.
    const second = await client.callTool(toolName, {});
    expect(JSON.stringify(second)).toContain("executions=2");
    expect(server.executions()).toBe(2);
  });

  test("the installed protocol reports a supported surface", () => {
    expect(checkProtocolSurface(McpCommunicationProtocol.prototype)).toBe("supported");
  });

  test("uninstalling restores the factory that was present before install", () => {
    const before = CommunicationProtocol.communicationProtocolFactories["mcp"];
    expect(typeof before).toBe("function");

    expect(installNoRetryMcpProtocol()).toBe("installed");
    const during = CommunicationProtocol.communicationProtocolFactories["mcp"];
    expect(during).not.toBe(before);

    uninstallNoRetryMcpProtocol();
    expect(CommunicationProtocol.communicationProtocolFactories["mcp"]).toBe(before);
  });
});

describe("session cleanup is scoped to the session that failed (W7-3)", () => {
  /** Structural view of the installed protocol's session helpers. */
  interface SessionHelpers {
    _getOrCreateSession: (...args: unknown[]) => Promise<unknown>;
    _cleanupSession: (...args: unknown[]) => Promise<void>;
    _withSession: (...args: unknown[]) => Promise<unknown>;
  }

  function installedProtocol(): SessionHelpers {
    expect(installNoRetryMcpProtocol()).toBe("installed");
    const factory = CommunicationProtocol.communicationProtocolFactories["mcp"];
    expect(typeof factory).toBe("function");
    return factory!() as unknown as SessionHelpers;
  }

  test("a failed session creation does not evict the cached session", async () => {
    const protocol = installedProtocol();
    const cleanups: unknown[][] = [];
    protocol._getOrCreateSession = async () => {
      throw new Error("connection closed before the session was created");
    };
    protocol._cleanupSession = async (...args: unknown[]) => {
      cleanups.push(args);
    };

    let error: unknown;
    try {
      await protocol._withSession("flaky", { url: "http://127.0.0.1:1" }, undefined, async () => "unused");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    // With no client, `_cleanupSession` would fall back to the cached session
    // for this key, which may be a healthy concurrent one. It must not run.
    expect(cleanups).toEqual([]);
    uninstallNoRetryMcpProtocol();
  });

  test("a failed operation evicts exactly the session it used", async () => {
    const protocol = installedProtocol();
    const fakeClient = { id: "client-under-test" };
    const cleanups: unknown[][] = [];
    protocol._getOrCreateSession = async () => fakeClient;
    protocol._cleanupSession = async (...args: unknown[]) => {
      cleanups.push(args);
    };

    let error: unknown;
    try {
      await protocol._withSession("flaky", { url: "http://127.0.0.1:1" }, undefined, async () => {
        throw new Error("connection closed mid-call");
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(cleanups).toHaveLength(1);
    expect(cleanups[0]![1]).toBe(fakeClient);
    uninstallNoRetryMcpProtocol();
  });
});

describe("protocol surface check", () => {
  test("a complete surface whose callTool routes through _withSession is supported", () => {
    expect(checkProtocolSurface(fakePrototype())).toBe("supported");
  });

  test("a prototype missing _withSession is unsupported", () => {
    expect(checkProtocolSurface(fakePrototype({ omit: "_withSession" }))).toBe("unsupported");
  });

  test("a callTool that does not mention _withSession is unsupported", () => {
    const proto = fakePrototype({
      callTool: async function callTool(this: { _send(): unknown }) {
        return this._send();
      },
    });
    expect(checkProtocolSurface(proto)).toBe("unsupported");
  });

  test("a prototype without callTool is unsupported", () => {
    const proto = fakePrototype();
    delete proto["callTool"];
    expect(checkProtocolSurface(proto)).toBe("unsupported");
  });
});

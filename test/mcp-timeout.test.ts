import { afterEach, describe, expect, test } from "bun:test";

import { CommunicationProtocol } from "@utcp/sdk";
import "@utcp/mcp";

import { classifyThrown } from "../src/errors.js";
import { UtcpAdapter } from "../src/plugin.js";
import { makeFakeHost } from "./helpers/host.js";
import { startSlowMcpServer, type SlowMcpServer } from "./fixtures/mcp-slow-server.js";
import {
  installNoRetryMcpProtocol,
  resetNoRetryInstallationForTest,
  uninstallNoRetryMcpProtocol,
} from "../src/mcp-no-retry.js";

/**
 * Spec §8: a transport or MCP server timeout is reported as TIMEOUT, and the
 * adapter never re-runs a call that may have executed. The stock @utcp/mcp
 * timeout rejects with a plain Error whose name is "Error", which the error
 * classifier does not recognise, so the failure surfaced as INTERNAL_ERROR.
 */

const servers: SlowMcpServer[] = [];
const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    if (fn !== undefined) await fn();
  }
  for (const server of servers.splice(0)) {
    server.stop();
  }
  uninstallNoRetryMcpProtocol();
  resetNoRetryInstallationForTest();
});

function slowManual(url: string) {
  return {
    name: "slow",
    call_template_type: "mcp",
    config: {
      mcpServers: {
        server: {
          transport: "http" as const,
          url,
          // Seconds. The tool sleeps for 3s, so the client gives up first.
          timeout: 1,
          sse_read_timeout: 5,
          terminate_on_close: true,
          notification_stream_max_retries: 0,
        },
      },
    },
  };
}

describe("MCP adapter-side timeout", () => {
  test("a timed-out MCP call is TIMEOUT with outcome unknown and is not replayed", async () => {
    const server = startSlowMcpServer(3_000);
    servers.push(server);

    const host = makeFakeHost({ manuals: [slowManual(server.url)] });
    const adapter = new UtcpAdapter(host.ctx, { log: () => undefined });
    await adapter.start();
    cleanup.push(() => adapter.dispose());
    expect(adapter.status().state).toBe("ready");

    const called = await host.runJson("call", {
      name: "slow.server.sleep",
      arguments: {},
    });

    expect(called.ok).toBe(false);
    expect(called.error.code).toBe("TIMEOUT");
    expect(called.error.outcome).toBe("unknown");
    // Exactly one execution: the timeout must not trigger a second attempt.
    expect(server.executions()).toBe(1);
  }, 20_000);

  test("the protocol's timeout rejects with a TimeoutError that still evicts the session", async () => {
    expect(installNoRetryMcpProtocol()).toBe("installed");

    const protocol = CommunicationProtocol.communicationProtocolFactories["mcp"]!() as unknown as {
      _runWithTimeout(
        sessionKey: string,
        timeoutMs: number,
        client: unknown,
        operation: (client: never) => Promise<unknown>,
      ): Promise<unknown>;
      _classifySessionError(error: unknown): string | null;
    };

    let error: unknown;
    try {
      await protocol._runWithTimeout("key", 20, null, () => new Promise(() => {}));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("TimeoutError");
    expect((error as Error).message).toContain("timed out");
    // The base class evicts on "timed out"; the override must keep that path.
    expect(protocol._classifySessionError(error)).toBe("timeout");
  });

  test("classifyThrown maps a TimeoutError-named failure to TIMEOUT with outcome unknown", () => {
    const thrown = Object.assign(new Error("MCP operation on 'x' timed out after 1s."), {
      name: "TimeoutError",
    });

    const body = classifyThrown(thrown, "tool-a");

    expect(body.code).toBe("TIMEOUT");
    expect(body.outcome).toBe("unknown");
    expect(body.tool).toBe("tool-a");
  });
});

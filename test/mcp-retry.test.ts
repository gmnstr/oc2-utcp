import { afterEach, describe, expect, test } from "bun:test";

import { CommunicationProtocol, UtcpClient } from "@utcp/sdk";
import "@utcp/mcp";

import { startFlakyMcpServer, type FlakyMcpServer } from "./fixtures/mcp-flaky-server.js";
import {
  installNoRetryMcpProtocol,
  resetNoRetryInstallationForTest,
  uninstallNoRetryMcpProtocol,
} from "../src/mcp-no-retry.js";

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

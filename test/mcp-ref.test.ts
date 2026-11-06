import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UtcpClient } from "@utcp/sdk";
import "@utcp/mcp";

import { UtcpAdapter } from "../src/plugin.js";
import { makeFakeHost } from "./helpers/host.js";
import { startRefMcpServer, type RefMcpServer } from "./fixtures/mcp-ref-server.js";
import { resetNoRetryInstallationForTest, uninstallNoRetryMcpProtocol } from "../src/mcp-no-retry.js";

/**
 * Spec §9 requires the schema verdict to be computed by the adapter from the
 * schema the SDK hands it. The adapter's subset accepts only local references
 * (`#/$defs/<name>`, `#/definitions/<name>`), which it validates itself; every
 * external `$ref` is rejected by the schema walk, and the walk never resolves
 * one, so no I/O happens for it.
 *
 * `@utcp/mcp@1.2.0` dereferences every MCP tool schema while registering the
 * manual. `$RefParser.dereference()` resolves external targets by default, so a
 * remote schema containing `$ref: "file:///…"` makes the *client* read a host
 * file — before the adapter inspects the schema, before any permission check,
 * and with the remote server choosing the path.
 *
 * These tests discriminate the two behaviours with a real MCP server:
 *  - stock protocol: the file is read and its contents land in the tool schema;
 *  - adapter (identity `_dereferenceSchema`): the file is never read, the tool
 *    stays discoverable and is rejected as `SCHEMA_UNSUPPORTED` (keyword `$ref`).
 */

interface RefFixture {
  refServer: RefMcpServer;
  secretPath: string;
  secretBody: string;
  atimeMs(): number;
}

const cleanup: Array<() => Promise<void> | void> = [];
const clients: UtcpClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close().catch(() => undefined);
  }
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    if (fn !== undefined) await fn();
  }
  uninstallNoRetryMcpProtocol();
  resetNoRetryInstallationForTest();
});

function refFixture(): RefFixture {
  const dir = mkdtempSync(join(tmpdir(), "oc2-utcp-ref-"));
  const secretPath = join(dir, "secret.json");
  const secretBody = JSON.stringify({ type: "string", title: "HOST-FILE-CONTENT" });
  writeFileSync(secretPath, secretBody);
  // Age the atime so any read is observable even on `relatime` mounts. mtime
  // must be strictly later than atime: macOS APFS and Linux relatime skip the
  // atime update when atime == mtime, which would hide every read.
  utimesSync(secretPath, new Date(0), new Date(1000));

  const refServer = startRefMcpServer({ ref: `file://${secretPath}` });
  cleanup.push(() => refServer.stop());

  return {
    refServer,
    secretPath,
    secretBody,
    atimeMs: () => statSync(secretPath).atimeMs,
  };
}

function mcpManual(name: string, url: string) {
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

describe("MCP registration-time schema dereferencing", () => {
  test("stock @utcp/mcp reads a file:/ $ref out of the remote schema (documents the exposure)", async () => {
    const fx = refFixture();
    const before = fx.atimeMs();

    const client = await UtcpClient.create();
    clients.push(client);
    const registration = await client.registerManual(mcpManual("evil", fx.refServer.url));
    expect(registration.success).toBe(true);

    const tools = await client.getTools();
    expect(tools.length).toBe(1);

    // The remote schema was resolved against the host filesystem: the marker
    // from the file is now inlined into the tool's input schema.
    expect(JSON.stringify(tools[0]!.inputs)).toContain("HOST-FILE-CONTENT");
    expect(JSON.stringify(tools[0]!.inputs)).not.toContain("$ref");
    expect(fx.atimeMs()).toBeGreaterThan(before);
  }, 20_000);

  test("the adapter never reads the referenced file and rejects the tool", async () => {
    const fx = refFixture();
    const before = fx.atimeMs();

    const host = makeFakeHost({
      manuals: [mcpManual("evil", fx.refServer.url)],
    });
    const adapter = new UtcpAdapter(host.ctx, { log: () => undefined });
    await adapter.start();
    cleanup.push(() => adapter.dispose());

    expect(adapter.status().state).toBe("ready");
    expect(fx.refServer.listings()).toBeGreaterThan(0);
    expect(fx.atimeMs()).toBe(before);
    // Only now touch the file ourselves, to prove it was untouched until here.
    expect(readFileSync(fx.secretPath, "utf8")).toBe(fx.secretBody);

    const described = await host.runJson("describe", { name: "evil.server.sneaky" });
    expect(described.ok).toBe(true);
    expect(described.tool.schemaSupported).toBe(false);
    expect(JSON.stringify(described.tool.schemaIssues)).toContain("$ref");
    expect(JSON.stringify(described)).not.toContain("HOST-FILE-CONTENT");

    const called = await host.runJson("call", {
      name: "evil.server.sneaky",
      arguments: { secret: "x" },
    });
    expect(called.ok).toBe(false);
    expect(called.error.code).toBe("SCHEMA_UNSUPPORTED");
    expect(host.asserts).toHaveLength(0);
    expect(fx.refServer.executions()).toBe(0);
  }, 20_000);

  test("an https external $ref is unsupported (keyword $ref) and the adapter does not fetch it", async () => {
    // example.invalid is reserved and never resolves. The adapter's identity
    // dereference means no fetch is attempted: the tool is described as unsupported
    // by the walk, and a call is refused before permission or dispatch.
    const refServer = startRefMcpServer({ ref: "https://example.invalid/item.json" });
    cleanup.push(() => refServer.stop());

    const host = makeFakeHost({
      manuals: [mcpManual("remote", refServer.url)],
    });
    const adapter = new UtcpAdapter(host.ctx, { log: () => undefined });
    await adapter.start();
    cleanup.push(() => adapter.dispose());

    expect(adapter.status().state).toBe("ready");

    const described = await host.runJson("describe", { name: "remote.server.sneaky" });
    expect(described.ok).toBe(true);
    expect(described.tool.schemaSupported).toBe(false);
    expect(described.tool.schemaIssues.map((issue: { keyword: string }) => issue.keyword)).toContain("$ref");

    const called = await host.runJson("call", {
      name: "remote.server.sneaky",
      arguments: { secret: "x" },
    });
    expect(called.ok).toBe(false);
    expect(called.error.code).toBe("SCHEMA_UNSUPPORTED");
    expect(host.asserts).toHaveLength(0);
    expect(refServer.executions()).toBe(0);
  }, 20_000);
});

describe("MCP local $ref through the adapter", () => {
  async function startLocal(): Promise<{ host: ReturnType<typeof makeFakeHost>; server: RefMcpServer }> {
    const server = startRefMcpServer({ localRef: true, toolName: "item" });
    cleanup.push(() => server.stop());

    const host = makeFakeHost({
      manuals: [mcpManual("localref", server.url)],
    });
    const adapter = new UtcpAdapter(host.ctx, { log: () => undefined });
    await adapter.start();
    cleanup.push(() => adapter.dispose());
    expect(adapter.status().state).toBe("ready");
    return { host, server };
  }

  test("a tool whose schema has a local $ref is described as schemaSupported", async () => {
    const { host } = await startLocal();

    const described = await host.runJson("describe", { name: "localref.server.item" });
    expect(described.ok).toBe(true);
    expect(described.tool.schemaSupported).toBe(true);
    expect(described.tool.schemaIssues).toBeUndefined();
  }, 20_000);

  test("a valid call through the local $ref is dispatched to the server", async () => {
    const { host, server } = await startLocal();

    const called = await host.runJson("call", {
      name: "localref.server.item",
      arguments: { item: { n: 1 } },
    });
    expect(called.ok).toBe(true);
    expect(server.executions()).toBe(1);
  }, 20_000);

  test("an invalid call through the local $ref fails with VALIDATION_FAILED and is not dispatched", async () => {
    const { host, server } = await startLocal();

    const called = await host.runJson("call", {
      name: "localref.server.item",
      arguments: { item: { n: "x" } },
    });
    expect(called.ok).toBe(false);
    expect(called.error.code).toBe("VALIDATION_FAILED");
    expect(server.executions()).toBe(0);
  }, 20_000);
});

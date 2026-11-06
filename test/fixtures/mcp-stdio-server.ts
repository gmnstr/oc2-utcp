/**
 * Stdio MCP server fixture whose lifecycle is observable from the filesystem.
 *
 * Purpose: prove two things about the adapter's handling of `mcp-stdio`:
 *  - a disabled class never spawns a child (no `spawn` line is written);
 *  - an enabled class does spawn one, and `dispose()` leaves no live child
 *    behind (a `stop` line appears and the pid is gone).
 *
 * Records are appended to `$OC2_UTCP_COUNTER`, one JSON object per line:
 *   {"event":"spawn","pid":123}
 *   {"event":"stop","pid":123,"signal":"SIGTERM"}
 *
 * Speaks newline-delimited JSON-RPC over stdin/stdout, enough for
 * `initialize`, `notifications/initialized`, `tools/list` and `tools/call`.
 */

import { appendFileSync } from "node:fs";

const counter = process.env.OC2_UTCP_COUNTER;
const pid = process.pid;

function record(event: string, extra: Record<string, unknown> = {}): void {
  if (counter === undefined) return;
  try {
    appendFileSync(counter, `${JSON.stringify({ event, pid, ...extra })}\n`);
  } catch {
    // The counter is a test instrument; a failure here must not break the server.
  }
}

record("spawn");

function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id: unknown, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (line.length === 0) continue;

    let message: { id?: unknown; method?: string };
    try {
      message = JSON.parse(line) as { id?: unknown; method?: string };
    } catch {
      continue;
    }

    const id = message.id ?? null;
    switch (message.method) {
      case "initialize":
        record("initialize");
        reply(id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "oc2-utcp-stdio", version: "1.0.0" },
        });
        break;
      case "notifications/initialized":
        break;
      case "tools/list":
        record("list");
        reply(id, {
          tools: [
            {
              name: "slowpoke",
              description: "Returns a fixed string.",
              inputSchema: {
                type: "object",
                properties: { note: { type: "string" } },
                additionalProperties: false,
              },
            },
          ],
        });
        break;
      case "tools/call":
        record("call");
        reply(id, { content: [{ type: "text", text: "stdio-ok" }] });
        break;
      case "ping":
        reply(id, {});
        break;
      default:
        fail(id, -32601, `Method not found: ${String(message.method)}`);
    }
  }
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => {
    record("stop", { signal });
    process.exit(0);
  });
}

process.stdin.on("end", () => {
  record("stdin-end");
  process.exit(0);
});

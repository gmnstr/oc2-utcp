/**
 * Flaky MCP server fixture.
 *
 * Purpose: discriminate "the SDK re-executed my call" from "the SDK executed my
 * call exactly once". The server counts every `tools/call` it *executes*. Its
 * first `tools/call` executes and then answers with a JSON-RPC error whose
 * message classifies as a session-transient failure inside `@utcp/mcp`
 * (`_classifySessionError` → `"transient"`), which is exactly the branch that
 * re-runs the operation once. Every later `tools/call` succeeds.
 *
 * Consequences, both observable from the fixture:
 *  - with the stock MCP protocol: the client retries, so the server records
 *    TWO executions and the caller still receives a successful result;
 *  - with the adapter's no-retry protocol installed: the server records ONE
 *    execution and the caller receives an error.
 *
 * The server speaks just enough Streamable HTTP MCP to complete `initialize`,
 * `notifications/initialized`, `tools/list` and `tools/call`.
 */

export interface FlakyMcpServer {
  readonly url: string;
  /** Number of `tools/call` messages that reached the tool body. */
  executions(): number;
  /** Number of `tools/call` responses sent, including the injected failure. */
  calls(): number;
  stop(): void;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2025-06-18";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function startFlakyMcpServer(): FlakyMcpServer {
  let executions = 0;
  let calls = 0;
  let sessions = 0;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });

      // Server-initiated stream: not used by this fixture.
      if (request.method === "GET") return new Response(null, { status: 405 });
      if (request.method !== "POST") return new Response(null, { status: 405 });

      let body: JsonRpcRequest;
      try {
        body = (await request.json()) as JsonRpcRequest;
      } catch {
        return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
      }

      const method = body.method ?? "";
      const id = body.id ?? null;

      if (method === "initialize") {
        sessions += 1;
        return json(
          {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "oc2-utcp-flaky", version: "1.0.0" },
            },
          },
          200,
          { "mcp-session-id": `session-${sessions}` },
        );
      }

      if (method.startsWith("notifications/")) {
        return new Response(null, { status: 202 });
      }

      if (method === "tools/list") {
        return json({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "bump",
                description: "Increments a server-side counter and returns it.",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
              },
            ],
          },
        });
      }

      if (method === "tools/call") {
        calls += 1;
        executions += 1;
        if (executions === 1) {
          // Executed, then the response is lost to a session-class failure.
          return json({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: "Connection closed" },
          });
        }
        return json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `executions=${executions}` }] },
        });
      }

      if (method === "ping") return json({ jsonrpc: "2.0", id, result: {} });

      return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    executions: () => executions,
    calls: () => calls,
    stop: () => {
      server.stop(true);
    },
  };
}

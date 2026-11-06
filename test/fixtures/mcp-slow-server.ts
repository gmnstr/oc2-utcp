/**
 * Slow MCP server fixture.
 *
 * Purpose: prove that an adapter-side timeout is reported as TIMEOUT and is
 * never replayed. The one tool counts every `tools/call` it starts executing,
 * then sleeps longer than the manual's `timeout`, so the client gives up while
 * the server is still "working". The server never answers in time, so the
 * caller must see a timeout and the tool body must have run exactly once.
 *
 * The server speaks just enough Streamable HTTP MCP to complete `initialize`,
 * `notifications/initialized`, `tools/list` and `tools/call`.
 */

export interface SlowMcpServer {
  readonly url: string;
  /** Number of `tools/call` messages that reached the tool body. */
  executions(): number;
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

export function startSlowMcpServer(sleepMs: number): SlowMcpServer {
  let executions = 0;
  let sessions = 0;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });

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
              serverInfo: { name: "oc2-utcp-slow", version: "1.0.0" },
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
                name: "sleep",
                description: "Runs longer than the caller's timeout and then returns.",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
              },
            ],
          },
        });
      }

      if (method === "tools/call") {
        executions += 1;
        await Bun.sleep(sleepMs);
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
    stop: () => {
      server.stop(true);
    },
  };
}

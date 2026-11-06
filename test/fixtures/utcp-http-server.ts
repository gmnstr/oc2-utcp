export interface FixtureTool {
  name: string;
  description?: string;
  inputs?: unknown;
  outputs?: unknown;
  /** Extra tool-level fields, e.g. a crafted description. */
  extra?: Record<string, unknown>;
  /** Extra fields merged into the tool's call template. */
  template?: Record<string, unknown>;
  /** If set, `/call/<name>` returns this body instead of the echo payload. */
  respond?: unknown;
  /** Holds the `/call/<name>` response for this long, so a caller can abort mid-flight. */
  delayMs?: number;
}

export interface UtcpFixtureServer {
  readonly url: string;
  readonly calls: Map<string, number>;
  hits(tool: string): number;
  total(): number;
  /** Replaces the served manual's tool list (simulates a server-side change). */
  setTools(tools: FixtureTool[]): void;
  stop(): void;
}

export interface FixtureOptions {
  tools?: FixtureTool[];
  /** Serves this body at the manual URL instead of the generated manual. */
  manual?: unknown;
  /** Returns this status for the manual request. */
  manualStatus?: number;
  /** Call templates the manual-wide fields, e.g. allowed_communication_protocols. */
  manualFields?: Record<string, unknown>;
}

function manualTool(tool: FixtureTool, baseUrl: string): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description ?? `Fixture tool ${tool.name}.`,
    inputs: tool.inputs ?? { type: "object", properties: {}, additionalProperties: false },
    outputs: tool.outputs ?? {},
    tags: ["fixture"],
    tool_call_template: {
      name: tool.name,
      call_template_type: "http",
      http_method: "POST",
      url: `${baseUrl}/call/${encodeURIComponent(tool.name)}`,
      content_type: "application/json",
      ...tool.template,
    },
    ...tool.extra,
  };
}

export function startUtcpFixture(options: FixtureOptions = {}): UtcpFixtureServer {
  const calls = new Map<string, number>();
  let tools: FixtureTool[] = (options.tools ?? []).slice();
  let baseUrl = "";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname === "/manual") {
        if (options.manual !== undefined) {
          return Response.json(options.manual as Record<string, unknown>, {
            status: options.manualStatus ?? 200,
          });
        }
        if (options.manualStatus !== undefined && options.manualStatus !== 200) {
          return new Response("nope", { status: options.manualStatus });
        }
        return Response.json({
          utcp_version: "1.0.0",
          manual_version: "1.0.0",
          ...options.manualFields,
          tools: tools.map((tool) => manualTool(tool, baseUrl)),
        });
      }

      if (url.pathname.startsWith("/call/")) {
        const tool = decodeURIComponent(url.pathname.slice("/call/".length));
        calls.set(tool, (calls.get(tool) ?? 0) + 1);
        let body: unknown = null;
        try {
          body = await request.json();
        } catch {
          body = null;
        }
        const query = Object.fromEntries(url.searchParams.entries());
        const configured = tools.find((candidate) => candidate.name === tool);
        if (configured !== undefined && configured.delayMs !== undefined) {
          await Bun.sleep(configured.delayMs);
        }
        if (configured !== undefined && configured.respond !== undefined) {
          return Response.json(configured.respond);
        }
        return Response.json({ ok: true, tool, body, query });
      }

      return new Response("not found", { status: 404 });
    },
  });

  baseUrl = `http://127.0.0.1:${server.port}`;

  return {
    url: baseUrl,
    calls,
    hits: (tool) => calls.get(tool) ?? 0,
    total: () => [...calls.values()].reduce((sum, value) => sum + value, 0),
    setTools: (next) => {
      tools = next.slice();
    },
    stop: () => server.stop(true),
  };
}

/** Manual template that points at a fixture server. */
export function httpManual(name: string, server: UtcpFixtureServer, extra: Record<string, unknown> = {}) {
  return {
    name,
    call_template_type: "http",
    http_method: "GET",
    url: `${server.url}/manual`,
    content_type: "application/json",
    ...extra,
  };
}

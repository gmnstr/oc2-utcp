/**
 * Isolated OC2 sandbox: private HOME/XDG tree, a local mock OpenAI-compatible
 * provider, and a plugin entry pointing at this repository.
 *
 * Nothing here touches the live session host: the binary is launched with
 * `--standalone`, which starts a private server inside the child process.
 * The executable comes from `host-bin.ts` (or `options.hostBin`), so no machine
 * layout is baked into the tests.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveHostOrThrow } from "./host-bin.js";

export const PLUGIN_DIR = resolve(import.meta.dir, "../..");

export interface ChatTool {
  type?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
}

export interface ChatRequest {
  model?: string;
  tools?: ChatTool[];
  messages?: Array<{ role?: string; content?: unknown }>;
}

export interface Sandbox {
  root: string;
  home: string;
  configDir: string;
  projectDir: string;
  /** Resolved OC2 executable used by `runHost`. */
  hostBin: string;
  env: Record<string, string>;
  requests: ChatRequest[];
  stop: () => void;
}

export interface SandboxOptions {
  /** Directory loaded as the plugin package. Defaults to this repository. */
  pluginDir?: string;
  /** Plugin options object handed to the plugin via `ctx.options`. */
  pluginOptions?: Record<string, unknown>;
  /** Extra top-level opencode.jsonc fields, e.g. `permission`. */
  config?: Record<string, unknown>;
  /** Reply text for every chat completion. */
  reply?: string;
  /**
   * Emit one tool call instead of a text reply. The mock answers the first
   * request that carries tools with a `tool_calls` delta, then replies with
   * text once the host has sent the tool result back — the minimum shape that
   * makes the real harness execute a tool.
   */
  toolCall?: { name: string; arguments: unknown };
  /** OC2 executable to run. Defaults to the discovered host. */
  hostBin?: string;
}

export function createSandbox(options: SandboxOptions = {}): Sandbox {
  const requests: ChatRequest[] = [];
  const reply = options.reply ?? "ok";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const body = (await request.json()) as ChatRequest;
      requests.push(body);
      const created = Math.floor(Date.now() / 1000);
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const sawToolResult = (body.messages ?? []).some((message) => message.role === "tool");
      if (options.toolCall !== undefined && hasTools && !sawToolResult) {
        const call = {
          id: "chatcmpl-probe",
          object: "chat.completion.chunk",
          created,
          model: body.model ?? "mock-model",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_probe",
                    type: "function",
                    function: {
                      name: options.toolCall.name,
                      arguments: JSON.stringify(options.toolCall.arguments),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        const halted = {
          id: "chatcmpl-probe",
          object: "chat.completion.chunk",
          created,
          model: body.model ?? "mock-model",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        };
        return new Response(
          `data: ${JSON.stringify(call)}\n\ndata: ${JSON.stringify(halted)}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
        );
      }
      const chunk = {
        id: "chatcmpl-probe",
        object: "chat.completion.chunk",
        created,
        model: body.model ?? "mock-model",
        choices: [
          { index: 0, delta: { role: "assistant", content: reply }, finish_reason: null },
        ],
      };
      const done = {
        id: "chatcmpl-probe",
        object: "chat.completion.chunk",
        created,
        model: body.model ?? "mock-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
      );
    },
  });

  const root = mkdtempSync(join(tmpdir(), "oc2-utcp-host-"));
  const hostBin = options.hostBin ?? resolveHostOrThrow();
  const home = join(root, "home");
  const configDir = join(home, ".config", "opencode");
  const projectDir = join(root, "project");
  for (const dir of [
    home,
    configDir,
    projectDir,
    join(home, ".local/share"),
    join(home, ".local/state"),
    join(home, ".cache"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "mock/mock-model",
    provider: {
      mock: {
        npm: "@ai-sdk/openai-compatible",
        name: "Mock",
        options: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "probe-key" },
        models: { "mock-model": { name: "Mock Model" } },
      },
    },
    plugins: [{ package: options.pluginDir ?? PLUGIN_DIR, options: options.pluginOptions ?? {} }],
    ...(options.config ?? {}),
  };
  writeFileSync(join(configDir, "opencode.jsonc"), JSON.stringify(config, null, 2));

  return {
    root,
    home,
    configDir,
    projectDir,
    hostBin,
    env: {
      PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      OPENCODE_CONFIG_DIR: configDir,
      NO_COLOR: "1",
      CI: "1",
      no_proxy: "127.0.0.1,localhost",
      NO_PROXY: "127.0.0.1,localhost",
    },
    requests,
    stop: () => server.stop(true),
  };
}

export interface HostRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run `opencode run` inside a sandbox and return its output. */
export async function runHost(
  sandbox: Sandbox,
  prompt: string,
  extraArgs: string[] = [],
  timeoutMs = 90_000,
): Promise<HostRun> {
  const child = Bun.spawn({
    cmd: [
      sandbox.hostBin,
      "run",
      "--standalone",
      "--log-level",
      "error",
      ...extraArgs,
      prompt,
    ],
    cwd: sandbox.projectDir,
    env: sandbox.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timeout);
  return { exitCode, stdout, stderr };
}

export function toolNames(body: ChatRequest | undefined): string[] {
  const list = body && Array.isArray(body.tools) ? body.tools : [];
  return list
    .map((entry) => entry?.function?.name)
    .filter((name): name is string => typeof name === "string")
    .sort();
}

export function executeDescription(body: ChatRequest | undefined): string {
  const list = body && Array.isArray(body.tools) ? body.tools : [];
  return list.find((entry) => entry?.function?.name === "execute")?.function?.description ?? "";
}

/** The last request that carried tools — the model-facing tool catalog. */
export function lastToolRequest(requests: ChatRequest[]): ChatRequest | undefined {
  const withTools = requests.filter((entry) => Array.isArray(entry.tools) && entry.tools.length > 0);
  return withTools[withTools.length - 1] ?? requests[requests.length - 1];
}

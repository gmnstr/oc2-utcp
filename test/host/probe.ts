/**
 * Host integration probe: does the real OC2 binary load this plugin, and what
 * names does the model actually see?
 *
 * Runs `opencode run --standalone` against a private HOME/XDG tree and a local
 * mock OpenAI-compatible provider, so the live session host is never touched.
 * The mock records every chat completion request, including the `tools` array
 * and the `execute` (Code Mode) tool description, which is where codemode-
 * registered tools are advertised.
 *
 * The executable is discovered by `host-bin.ts`: `OC2_OPENCODE_BIN` wins, then
 * `PATH`, then repo-local and user install locations.
 *
 * Usage: bun test/host/probe.ts [--json]
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describeUnavailable, discoveredHost } from "./host-bin.js";

const PLUGIN_DIR = process.env["PLUGIN_DIR"] ?? resolve(import.meta.dir, "../..");

interface ChatTool {
  type?: string;
  function?: { name?: string; description?: string };
}

interface ChatRequest {
  tools?: ChatTool[];
  model?: string;
}

export interface ProbeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  tools: string[];
  executeDescription: string;
  requests: number;
}

function toolNames(body: ChatRequest): string[] {
  const list = Array.isArray(body.tools) ? body.tools : [];
  return list
    .map((entry) => entry?.function?.name)
    .filter((name): name is string => typeof name === "string")
    .sort();
}

function executeDescription(body: ChatRequest): string {
  const list = Array.isArray(body.tools) ? body.tools : [];
  const found = list.find((entry) => entry?.function?.name === "execute");
  return found?.function?.description ?? "";
}

export async function probeHost(
  options: Record<string, unknown> = {},
  prompt = "say ok",
): Promise<ProbeResult> {
  const seen: ChatRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const body = (await request.json()) as ChatRequest;
      seen.push(body);
      const chunk = {
        id: "chatcmpl-probe",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? "mock-model",
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
      };
      const done = {
        id: "chatcmpl-probe",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? "mock-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
      const stream = `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`;
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });

  const root = mkdtempSync(join(tmpdir(), "oc2-utcp-host-"));
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

  const baseURL = `http://127.0.0.1:${server.port}/v1`;
  writeFileSync(
    join(configDir, "opencode.jsonc"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: "mock/mock-model",
        provider: {
          mock: {
            npm: "@ai-sdk/openai-compatible",
            name: "Mock",
            options: { baseURL, apiKey: "probe-key" },
            models: { "mock-model": { name: "Mock Model" } },
          },
        },
        plugins: [process.env["PLUGIN_SPEC"] === "string" ? PLUGIN_DIR : { package: PLUGIN_DIR, options }],
      },
      null,
      2,
    ),
  );

  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    OPENCODE_CONFIG_DIR: configDir,
    NO_COLOR: "1",
    CI: "1",
  };

  const host = discoveredHost();
  if (!host.ok) throw new Error(describeUnavailable(host));

  const child = Bun.spawn({
    cmd: [host.bin, "run", "--standalone", "--log-level", "error", prompt],
    cwd: projectDir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => child.kill(), 90_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timeout);
  server.stop(true);

  const withTools = seen.filter((entry) => Array.isArray(entry.tools) && entry.tools.length > 0);
  const chosen = withTools[withTools.length - 1] ?? seen[seen.length - 1];
  const tools = chosen ? toolNames(chosen) : [];
  return {
    exitCode,
    stdout,
    stderr,
    tools,
    executeDescription: chosen ? executeDescription(chosen) : "",
    requests: seen.length,
  };
}

if (import.meta.main) {
  const manuals = process.argv.includes("--with-manual")
    ? [
        {
          name: "probe",
          call_template_type: "http",
          http_method: "POST",
          url: "http://127.0.0.1:9/manual",
          content_type: "application/json",
        },
      ]
    : [];
  const result = await probeHost({ manuals }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`exit=${result.exitCode} requests=${result.requests}`);
    console.log(`tools=${result.tools.join(",")}`);
    console.log(`execute-description=${result.executeDescription.slice(0, 1200)}`);
    if (result.stderr.trim()) console.log(`stderr=${result.stderr.slice(0, 8000)}`);
  }
  process.exit(result.tools.length > 0 ? 0 : 1);
}

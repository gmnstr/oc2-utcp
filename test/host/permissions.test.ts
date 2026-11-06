/**
 * Real-host permission evidence for spec §11 items 12-14.
 *
 * The fake-`ctx` acceptance tests prove the adapter calls `ctx.permission.assert`
 * with the right shape; they cannot prove that OC2 turns such an assert into a
 * native rejection, that a denial never reaches the remote tool, or that two
 * tools from one manual are enforced independently. These tests drive the
 * installed binary (2.2.5) with a real `permissions` array in the generated
 * `opencode.jsonc`, a local UTCP fixture server that counts dispatches, and a
 * mock provider that asks the model to call the Code Mode `execute` tool.
 *
 * Nothing here touches the live session host: the binary runs `--standalone`
 * with an isolated HOME/XDG tree, a temporary project directory and a loopback
 * mock model. The permission rules exist only inside that sandbox config.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostGate } from "./host-bin.js";
import { createSandbox, lastToolRequest, runHost, toolNames } from "./sandbox.js";
import { stagePlugin } from "./stage.js";
import { httpManual, startUtcpFixture, type UtcpFixtureServer } from "../fixtures/utcp-http-server.js";

const HOST_TIMEOUT_MS = 240_000;

const TOOLS = [
  {
    name: "echo",
    description: "Echo a message back.",
    inputs: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
  },
  {
    name: "list_items",
    description: "List items.",
    inputs: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "delete_item",
    description: "Delete one item.",
    inputs: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
];

let stagedDir = "";
let stagedDigest = "";

const gate = hostGate("OC2 host permission enforcement");

// Same contract as the integration suite: skip without a host, fail when CI
// requires one. The staging hook below is guarded so a fresh clone without a
// host never runs `bun install`.
if (gate.required && !gate.runnable) {
  test("OC2 host permission enforcement requires an OpenCode executable", () => {
    throw new Error(gate.message);
  });
}
if (!gate.runnable && !gate.required) {
  console.warn(gate.message);
}

beforeAll(async () => {
  if (!gate.runnable) return;
  const staged = await stagePlugin();
  stagedDir = staged.dir;
  stagedDigest = staged.digest;
}, HOST_TIMEOUT_MS);

/** Sequential calls inside one `execute` so a denial does not abort sibling calls. */
function executeCode(calls: readonly (readonly [string, unknown])[]): string {
  return [
    "const out = [];",
    `for (const [name, args] of ${JSON.stringify(calls)}) {`,
    "  try { out.push(name + ' => ' + await tools.utcp.call({ name, arguments: args })); }",
    "  catch (error) { out.push(name + ' THREW ' + (error && error.message ? error.message : String(error))); }",
    "}",
    "return out.join('\\n---\\n');",
  ].join("\n");
}

function toolResults(sandbox: { requests: readonly unknown[] }): string {
  return sandbox.requests
    .flatMap((body) => ((body as { messages?: { role: string; content?: unknown }[] }).messages ?? []))
    .filter((message) => message.role === "tool")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n");
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

type Scenario = {
  fixture: UtcpFixtureServer;
  permissions?: unknown;
  tools?: string[];
  projectConfig?: string;
  calls: readonly (readonly [string, unknown])[];
};

async function drive(scenario: Scenario) {
  const sandbox = createSandbox({
    pluginDir: stagedDir,
    pluginOptions: {
      manuals: [httpManual("demo", scenario.fixture)],
      ...(scenario.tools === undefined ? {} : { tools: scenario.tools }),
    },
    config: scenario.permissions === undefined ? {} : { permissions: scenario.permissions },
    toolCall: { name: "execute", arguments: { code: executeCode(scenario.calls) } },
  });

  if (scenario.projectConfig !== undefined) {
    writeFileSync(join(sandbox.projectDir, "opencode.json"), scenario.projectConfig);
  }

  try {
    const run = await runHost(sandbox, "call the tool", ["--print-logs"]);
    return { run, sandbox, results: toolResults(sandbox) };
  } finally {
    sandbox.stop();
  }
}

const suite: (label: string, fn: () => void) => void = gate.runnable ? describe : describe.skip;

suite(gate.title, () => {
  test(
    "a denied tool is rejected natively and never dispatched",
    async () => {
      const fixture = startUtcpFixture({ tools: TOOLS });
      try {
        const { run, results } = await drive({
          fixture,
          permissions: [{ action: "utcp", resource: "demo.echo", effect: "deny" }],
          calls: [["demo.echo", { message: "x" }]],
        });

        expect(run.exitCode).toBe(0);
        // The host's own rejection text reaches the caller: not an adapter
        // error envelope, not a success, and not a retried call.
        expect(results).toContain("demo.echo THREW Permission denied: utcp");
        expect(count(results, "Permission denied")).toBe(1);
        expect(results).not.toContain('"ok":true');
        // Zero dispatches: the deny is decided before the transport runs.
        expect(fixture.hits("echo")).toBe(0);
        expect(fixture.total()).toBe(0);
        // The adapter neither retried nor reported the call as executed.
        expect(run.stderr).not.toContain('[oc2-utcp] {"event":"call","tool":"demo.echo"');
      } finally {
        fixture.stop();
      }
    },
    HOST_TIMEOUT_MS,
  );

  test(
    "with no utcp rule the allowed tool runs, a filtered tool is refused, and the baseline warning is logged once",
    async () => {
      const fixture = startUtcpFixture({ tools: TOOLS });
      try {
        const { run, results } = await drive({
          fixture,
          // A project config without a `utcp` rule: the shipped probe resolves
          // "no-rule" and warns, while OC2's base policy still allows the call.
          projectConfig: '{\n  "$schema": "https://opencode.ai/config.json"\n}\n',
          tools: ["demo.list_*"],
          calls: [
            ["demo.list_items", {}],
            ["demo.echo", { message: "x" }],
          ],
        });

        expect(run.exitCode).toBe(0);
        expect(results).toContain('demo.list_items => {"ok":true');
        expect(fixture.hits("list_items")).toBe(1);
        // Not permitted by this plugin's allow patterns: refused by the adapter
        // boundary, never reaching the manual.
        expect(results).toContain("TOOL_NOT_ALLOWED");
        expect(fixture.hits("echo")).toBe(0);
        // No prompt was raised and nothing was denied by the host.
        expect(results).not.toContain("Permission denied");
        // The warning is emitted once for the session, not per call.
        expect(count(run.stderr, '"notice":"policyBaselineUnverified"')).toBe(1);
      } finally {
        fixture.stop();
      }
    },
    HOST_TIMEOUT_MS,
  );

  test(
    "two tools from one manual are enforced independently",
    async () => {
      const fixture = startUtcpFixture({ tools: TOOLS });
      try {
        const { run, results } = await drive({
          fixture,
          permissions: [{ action: "utcp", resource: "demo.delete_item", effect: "deny" }],
          calls: [
            ["demo.list_items", {}],
            ["demo.delete_item", { id: "7" }],
          ],
        });

        expect(run.exitCode).toBe(0);
        // Same manual, same registration: one tool executes, the other does not.
        expect(results).toContain('demo.list_items => {"ok":true');
        expect(results).toContain("demo.delete_item THREW Permission denied: utcp");
        expect(fixture.hits("list_items")).toBe(1);
        expect(fixture.hits("delete_item")).toBe(0);
        expect(run.stderr).toContain('[oc2-utcp] {"event":"call","tool":"demo.list_items"');
        expect(run.stderr).not.toContain('[oc2-utcp] {"event":"call","tool":"demo.delete_item"');
      } finally {
        fixture.stop();
      }
    },
    HOST_TIMEOUT_MS,
  );

  /**
   * Code Mode is a property of the host's tool list, not of the plugin: the
   * plugin only sets `codemode: true`. Denying `execute` removes it, and the
   * host then offers the Code-Mode-only tools as direct chat tools — prefixed
   * with the declared namespace even though the plugin registers bare names.
   * Both halves run here so the assertion is discriminating on its own.
   */
  test(
    "denying execute promotes the Code Mode tools to direct utcp_* tools",
    async () => {
      const fixture = startUtcpFixture({ tools: TOOLS });

      const catalog = async (config: Record<string, unknown>): Promise<{ names: string[]; exitCode: number | null }> => {
        const sandbox = createSandbox({
          pluginDir: stagedDir,
          pluginOptions: { manuals: [httpManual("demo", fixture)] },
          config,
          reply: "ok",
        });
        try {
          const run = await runHost(sandbox, "say ok", ["--print-logs"]);
          return { names: toolNames(lastToolRequest(sandbox.requests)), exitCode: run.exitCode };
        } finally {
          sandbox.stop();
        }
      };

      try {
        const codeMode = await catalog({});
        expect(codeMode.exitCode).toBe(0);
        expect(codeMode.names).toContain("execute");
        expect(codeMode.names.filter((name) => name.startsWith("utcp"))).toEqual([]);

        const denied = await catalog({
          permissions: [{ action: "execute", resource: "*", effect: "deny" }],
        });
        expect(denied.exitCode).toBe(0);
        expect(denied.names).not.toContain("execute");
        // Direct tools, single namespace prefix, no doubled prefix.
        expect(denied.names).toContain("utcp_search");
        expect(denied.names).toContain("utcp_describe");
        expect(denied.names).toContain("utcp_call");
        expect(denied.names.some((name) => name.includes("utcp_utcp_"))).toBe(false);
      } finally {
        fixture.stop();
      }
    },
    HOST_TIMEOUT_MS,
  );

  /**
   * The scan and the policy are different things. Both halves deny the same
   * tool with the same rule text; only the file that carries it differs, so the
   * warning is the single variable the scan controls.
   */
  test(
    "the baseline scan reads the project config, not the effective policy",
    async () => {
      const fixture = startUtcpFixture({ tools: TOOLS });
      const deny = [{ action: "utcp", resource: "demo.echo", effect: "deny" }];
      const calls = [["demo.echo", { message: "x" }]] as const;

      try {
        // A: the rule sits in the project config the scan reads.
        const scanned = await drive({
          fixture,
          projectConfig: JSON.stringify({ permissions: deny }, null, 2),
          calls,
        });
        expect(scanned.run.exitCode).toBe(0);
        expect(scanned.results).toContain("demo.echo THREW Permission denied: utcp");
        expect(fixture.hits("echo")).toBe(0);
        expect(count(scanned.run.stderr, '"notice":"policyBaselineUnverified"')).toBe(0);

        // B: the same rule sits in the global config the scan never reads, while
        // the project config exists but carries no `utcp` rule.
        const unscanned = await drive({
          fixture,
          permissions: deny,
          projectConfig: JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2),
          calls,
        });
        expect(unscanned.run.exitCode).toBe(0);
        expect(unscanned.results).toContain("demo.echo THREW Permission denied: utcp");
        expect(fixture.hits("echo")).toBe(0);
        // Same effective policy, opposite verdict: the warning describes the scan.
        expect(count(unscanned.run.stderr, '"notice":"policyBaselineUnverified"')).toBe(1);
      } finally {
        fixture.stop();
      }
    },
    HOST_TIMEOUT_MS,
  );
});

afterAll(() => {
  if (!gate.runnable) return;
  // The staged copy is content-addressed scratch; the digest assertion keeps the
  // binding visible in test output if it ever silently changes.
  expect(stagedDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(stagedDir.endsWith(stagedDigest.slice(0, 12))).toBe(true);
});

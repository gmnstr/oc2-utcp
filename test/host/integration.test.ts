/**
 * Host integration evidence.
 *
 * Loads this plugin into the installed OC2 binary from a self-contained staged
 * copy (source + lockfile + production dependency closure, no symlinks) and
 * records what the host actually exposes:
 *   1. the plugin's own readiness log, whose tool names come from `ctx.tool.list()`;
 *   2. the model-facing Code Mode catalog, which lists the same three tools.
 *
 * The live session host is never touched: the binary runs with `--standalone`,
 * an isolated HOME/XDG tree and a local mock provider.
 */

import { describe, expect, test } from "bun:test";
import { hostGate } from "./host-bin.js";
import { createSandbox, runHost, lastToolRequest } from "./sandbox.js";
import { stagePlugin } from "./stage.js";

const HOST_TIMEOUT_MS = 240_000;

const gate = hostGate("OC2 host integration");

// The host is optional for this plugin, so a missing executable skips the
// suite. CI sets OC2_REQUIRE_HOST=1, where the same condition must fail.
if (gate.required && !gate.runnable) {
  test("OC2 host integration requires an OpenCode executable", () => {
    throw new Error(gate.message);
  });
}
if (!gate.runnable && !gate.required) {
  console.warn(gate.message);
}

const suite: (label: string, fn: () => void) => void = gate.runnable ? describe : describe.skip;

suite(gate.title, () => {
  test(
    "self-contained staged copy loads and exposes the three utcp tools",
    async () => {
      const staged = await stagePlugin();
      // The digest binds the staged directory to this exact source revision,
      // package.json and bun.lock; a different revision gets a different dir.
      expect(staged.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(staged.dir.endsWith(staged.digest.slice(0, 12))).toBe(true);

      const sandbox = createSandbox({
        pluginDir: staged.dir,
        pluginOptions: { manuals: [] },
      });

      try {
        const run = await runHost(sandbox, "say ok", ["--print-logs"]);

        expect(run.exitCode).toBe(0);
        expect(run.stderr).toContain('msg="loading plugin"');

        // 1. Adapter readiness gate, resolved from ctx.tool.list().
        expect(run.stderr).toContain('[oc2-utcp] {"event":"lifecycle","phase":"initializing"}');
        // OC2 2.2.5 reports the bare names for a namespaced registration; that
        // observed set, not the spec's `utcp_*` spelling, is asserted here.
        expect(run.stderr).toContain(
          '[oc2-utcp] {"event":"lifecycle","phase":"ready","detail":"search,describe,call"}',
        );
        // Pattern guard probe, logged before readiness: the worker path works in this host.
        expect(run.stderr).toContain('[oc2-utcp] {"event":"config","notice":"patternGuard","available":true}');

        // 2. Model-facing Code Mode catalog built from the same definitions.
        const body = JSON.stringify(lastToolRequest(sandbox.requests));
        expect(body).toContain("tools.utcp.search({");
        expect(body).toContain("tools.utcp.describe({");
        expect(body).toContain("tools.utcp.call({");
        expect(body).not.toContain("utcp_utcp_");
      } finally {
        sandbox.stop();
      }
    },
    HOST_TIMEOUT_MS,
  );
});

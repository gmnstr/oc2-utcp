/**
 * Naming investigation: for each supported registration form, ask the installed
 * host what effective names it publishes through `ctx.tool.list()`.
 *
 * Prints one line per form so the result can be quoted as evidence. Never touches
 * the live session host: every run uses `--standalone` plus an isolated HOME/XDG.
 */

import { createSandbox, runHost } from "./sandbox.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROBE_DIR = new URL("../fixtures/probe-plugin", import.meta.url).pathname;
const FORMS = ["literal", "namespace", "namespace-prefixed", "namespace-updated"] as const;

for (const form of FORMS) {
  const sandbox = createSandbox({ pluginOptions: { form } });
  const configPath = join(sandbox.configDir, "opencode.jsonc");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config["plugins"] = [{ package: PROBE_DIR, options: { form } }];
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const run = await runHost(sandbox, "say ok", ["--print-logs"]);
  const line = run.stderr
    .split("\n")
    .find((candidate) => candidate.includes("PROBE-PLUGIN-AFTER"));
  console.log(`${form}: exit=${run.exitCode} ${line ?? "(no AFTER line)"}`);
  sandbox.stop();
}

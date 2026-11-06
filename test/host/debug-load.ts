/** Debug helper: load a plugin directory in an isolated OC2 host and dump logs. */

import { createSandbox, runHost, PLUGIN_DIR } from "./sandbox.js";

const target = process.argv[2] ?? PLUGIN_DIR;
const sandbox = createSandbox({ pluginOptions: { manuals: [] } });
console.log(`root=${sandbox.root}`);
console.log(`config=${sandbox.configDir}/opencode.jsonc`);

// Rewrite the plugin entry to the requested directory.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const configPath = join(sandbox.configDir, "opencode.jsonc");
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.plugins = process.env["SPEC_JSON"] ? JSON.parse(process.env["SPEC_JSON"] as string) : [target];
writeFileSync(configPath, JSON.stringify(config, null, 2));

const run = await runHost(sandbox, "say ok", ["--print-logs", "--log-level", "debug"]);
console.log(`exit=${run.exitCode}`);
console.log("--- stdout ---");
console.log(run.stdout.slice(0, 2000));
console.log("--- stderr ---");
console.log(run.stderr.slice(0, 8000));
sandbox.stop();

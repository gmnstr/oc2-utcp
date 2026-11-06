/**
 * Debug helper: run the isolated host once with this plugin loaded and dump
 * every chat request body to /tmp/work/host-bodies.json for inspection.
 * Not part of the acceptance suite.
 */

import { writeFileSync } from "node:fs";
import { createSandbox, runHost } from "./sandbox.js";

const sandbox = createSandbox({ pluginOptions: { manuals: [] } });
try {
  const run = await runHost(sandbox, "say ok");
  writeFileSync(
    "/tmp/work/host-bodies.json",
    JSON.stringify({ exitCode: run.exitCode, stderr: run.stderr, requests: sandbox.requests }, null, 2),
  );
  console.log(`exit=${run.exitCode} requests=${sandbox.requests.length}`);
} finally {
  sandbox.stop();
}

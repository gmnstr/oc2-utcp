/**
 * Channel probe (spec §10, acceptance §11 #18).
 *
 * Runs the adapter against a local HTTP fixture in its own process so a test
 * can capture stdout and stderr separately. The adapter writes its events to
 * stderr; the UTCP SDK writes its own diagnostics to stdout on its own
 * initiative. Nothing here installs a global hook — the split is observed, not
 * enforced.
 */

import { makeFakeHost } from "../helpers/host.js";
import { startUtcpFixture } from "../fixtures/utcp-http-server.js";
import { UtcpAdapter } from "../../src/plugin.js";

const server = await startUtcpFixture({
  tools: [{ name: "echo", inputs: { type: "object", properties: { message: { type: "string" } } } }],
});

const host = makeFakeHost({
  manuals: [
    {
      name: "demo",
      call_template_type: "http",
      http_method: "GET",
      url: `${server.url}/manual`,
      content_type: "application/json",
    },
  ],
});

const adapter = new UtcpAdapter(host.ctx, { log: (event) => console.error(`[oc2-utcp] ${JSON.stringify(event)}`) });
await adapter.start();
await host.runJson("search", { query: "echo" });
await host.runJson("call", { name: "demo.echo", arguments: { message: "hi" } });
await adapter.dispose();
await server.stop();

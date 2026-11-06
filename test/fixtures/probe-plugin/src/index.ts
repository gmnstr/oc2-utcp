import { Plugin } from "@opencode/plugin";

console.error("PROBE-PLUGIN-MODULE-LOADED");

const input = { type: "object", properties: {}, additionalProperties: false } as const;
const execute = async () => ({ content: "probe" });

type Form = "namespace" | "literal" | "namespace-prefixed" | "namespace-updated";

const register = (editor: any, form: Form): void => {
  if (form === "namespace") {
    // Spec §5 literal reading: namespace + bare names.
    editor.namespace({ name: "utcp", description: "probe namespace" });
    for (const name of ["search", "describe", "call"]) {
      editor.add({ name, description: `ns ${name}`, input, options: { namespace: "utcp", codemode: true }, execute });
    }
    return;
  }
  if (form === "namespace-prefixed") {
    // Namespace plus already-prefixed names: does the namespace concatenate?
    editor.namespace({ name: "utcp", description: "probe namespace" });
    for (const name of ["utcp_search", "utcp_describe", "utcp_call"]) {
      editor.add({ name, description: `nsp ${name}`, input, options: { namespace: "utcp", codemode: true }, execute });
    }
    return;
  }
  if (form === "namespace-updated") {
    // Add bare, then rewrite the name via update (docs say updates preserve name).
    editor.namespace({ name: "utcp", description: "probe namespace" });
    for (const name of ["search", "describe", "call"]) {
      editor.add({ name, description: `nsu ${name}`, input, options: { namespace: "utcp", codemode: true }, execute });
    }
    editor.update("search", (tool: any) => {
      tool.name = "utcp_search";
    });
    return;
  }
  for (const name of ["utcp_search", "utcp_describe", "utcp_call"]) {
    editor.add({ name, description: `lit ${name}`, input, options: { codemode: true }, execute });
  }
};

export default Plugin.define({
  id: "probe-plugin",
  async setup(ctx: Plugin.Context) {
    console.error("PROBE-PLUGIN-SETUP", JSON.stringify(Object.keys(ctx.options ?? {})));
    const before = (await ctx.tool.list()).length;
    const form = String((ctx.options as Record<string, unknown>)["form"] ?? "literal") as Form;
    await ctx.tool.transform((editor) => register(editor, form));
    const after = (await ctx.tool.list()).map((info) => info.name);
    const interesting = after.filter((name) => name.includes("utcp") || name === "search" || name === "describe" || name === "call");
    console.error(
      "PROBE-PLUGIN-AFTER",
      form,
      JSON.stringify({ before, count: after.length, interesting }),
    );
  },
});

import type { Plugin } from "@opencode/plugin";

export interface RegisteredTool {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly input: unknown;
  readonly options?: unknown;
  readonly execute: (input: unknown, context: unknown) => Promise<unknown>;
}

export interface RecordedAssert {
  readonly action: string;
  readonly resources: readonly string[];
  readonly save?: readonly string[];
  readonly sessionID: string;
  readonly agent?: string;
  readonly source?: { type: string; messageID: string; id: string };
}

export interface FakeToolContext {
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
  readonly signal: AbortSignal;
  readonly progress: (update: Record<string, unknown>) => Promise<void>;
}

export interface FakeHost {
  readonly ctx: Plugin.Context;
  readonly tools: Map<string, RegisteredTool>;
  readonly asserts: RecordedAssert[];
  readonly progress: Record<string, unknown>[];
  readonly disposed: string[];
  listNames(): Promise<string[]>;
  /** Executes a registered tool by its effective name. */
  run(name: string, input: unknown, overrides?: Partial<FakeToolContext>): Promise<unknown>;
  /** Parses the JSON payload the adapter wraps into `{content}`. */
  runJson(name: string, input: unknown, overrides?: Partial<FakeToolContext>): Promise<any>;
}

export interface FakeHostOptions {
  directory?: string;
  /** Returning/throwng here simulates an OC2 permission decision. */
  onAssert?: (assert: RecordedAssert) => void | Promise<void>;
}

export function makeFakeHost(
  options: Record<string, unknown>,
  hostOptions: FakeHostOptions = {},
): FakeHost {
  const tools = new Map<string, RegisteredTool>();
  const asserts: RecordedAssert[] = [];
  const progress: Record<string, unknown>[] = [];
  const disposed: string[] = [];
  const directory = hostOptions.directory ?? "/tmp/oc2-utcp-test-project";

  const editor = {
    list: () => [...tools.values()],
    get: (id: string) => tools.get(id),
    namespace: () => undefined,
    add: (tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    },
    update: (id: string, update: (tool: RegisteredTool) => void) => {
      const current = tools.get(id);
      if (current !== undefined) update(current);
    },
    remove: (id: string) => {
      tools.delete(id);
    },
  };

  const ctx = {
    app: { name: "oc2-utcp-test", version: "2.2.5", channel: "test" },
    location: { directory, project: { id: "test", directory, canonical: directory } },
    options,
    tool: {
      async transform(callback: (input: typeof editor) => void) {
        const before = new Set(tools.keys());
        callback(editor);
        const added = [...tools.keys()].filter((name) => !before.has(name));
        return {
          async dispose() {
            for (const name of added) {
              tools.delete(name);
              disposed.push(name);
            }
          },
        };
      },
      async reload() {},
      async list() {
        return [...tools.values()].map((tool) => ({ ...tool }));
      },
    },
    permission: {
      async assert(input: RecordedAssert) {
        asserts.push(input);
        await hostOptions.onAssert?.(input);
      },
      async list() {
        return [];
      },
      async get() {
        return undefined;
      },
      async reply() {
        return undefined;
      },
    },
    storage: {
      async get() {
        return undefined;
      },
      async set() {},
      async remove() {},
      async scan() {
        return { entries: [] };
      },
    },
  } as unknown as Plugin.Context;

  const run = async (
    name: string,
    input: unknown,
    overrides: Partial<FakeToolContext> = {},
  ): Promise<unknown> => {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`tool '${name}' is not registered`);
    const controller = new AbortController();
    const context: FakeToolContext = {
      sessionID: "ses_test",
      agent: "build",
      messageID: "msg_test",
      id: "call_test",
      signal: controller.signal,
      progress: async (update) => {
        progress.push(update);
      },
      ...overrides,
    };
    return tool.execute(input, context);
  };

  return {
    ctx,
    tools,
    asserts,
    progress,
    disposed,
    async listNames() {
      return [...tools.keys()];
    },
    run,
    async runJson(name, input, overrides = {}) {
      const result = (await run(name, input, overrides)) as { content?: string };
      if (typeof result?.content !== "string") {
        throw new Error(`tool '${name}' did not return content: ${JSON.stringify(result)}`);
      }
      return JSON.parse(result.content);
    },
  };
}

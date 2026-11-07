/**
 * Model-facing serialization limit. This is deliberately SECONDARY protection:
 * UTCP transports parse their responses before the adapter receives them.
 * It prevents further expansion into the OC2 tool result, not an SDK OOM.
 */
export const MAX_MODEL_OUTPUT_BYTES = 262_144;
export const MAX_OUTPUT_NODES = 25_000;

/**
 * Return a complete JSON serialization only when its UTF-8 size is bounded.
 * Fail closed rather than silently truncating an operation's result.
 * The replacer stops early on large strings/collections before building the
 * full serialized response. SDK-produced JSON values are expected here.
 */
export function boundedJsonStringify(value: unknown): string | null {
  let nodes = 0;
  let approximateBytes = 0;
  try {
    const content = JSON.stringify(value, (key: string, current: unknown) => {
      nodes += 1;
      if (nodes > MAX_OUTPUT_NODES) throw new Error("output node budget");
      approximateBytes += Buffer.byteLength(key, "utf8") + 3;
      if (typeof current === "string") approximateBytes += Buffer.byteLength(current, "utf8") + 2;
      else if (typeof current === "number") approximateBytes += 32;
      else if (typeof current === "boolean") approximateBytes += 5;
      else approximateBytes += 4;
      if (approximateBytes > MAX_MODEL_OUTPUT_BYTES) throw new Error("output byte budget");
      return current;
    });
    if (typeof content !== "string") return null;
    return Buffer.byteLength(content, "utf8") <= MAX_MODEL_OUTPUT_BYTES ? content : null;
  } catch {
    return null;
  }
}

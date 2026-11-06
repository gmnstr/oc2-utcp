/**
 * Transport classification (spec §7.3).
 *
 * `call_template_type` alone cannot classify an MCP manual: the UTCP MCP
 * template uses "mcp" for both http and stdio servers, so the server entries
 * inside `config.mcpServers` are the only source of truth. Anything that does
 * not resolve unambiguously becomes `unclassified`, which is never enabled and
 * never registered.
 */

import type { CallTemplate, Tool } from "@utcp/sdk";

export const TRANSPORT_CLASSES = [
  "http",
  "local-file",
  "mcp-http",
  "mcp-stdio",
  "cli",
  "unclassified",
] as const;

export type TransportClass = (typeof TRANSPORT_CLASSES)[number];

/**
 * Default enablement. Only network transports that the spec enables by
 * default are on; host filesystem, process spawning and process execution
 * stay off until an operator turns them on explicitly.
 */
export const DEFAULT_TRANSPORTS: Record<TransportClass, boolean> = {
  http: true,
  "local-file": false,
  "mcp-http": true,
  "mcp-stdio": false,
  cli: false,
  unclassified: false,
};

/** Transport classes an operator may enable. `unclassified` is not one. */
export const CONFIGURABLE_TRANSPORTS: readonly TransportClass[] = [
  "http",
  "local-file",
  "mcp-http",
  "mcp-stdio",
  "cli",
];

/**
 * Normalize a `call_template_type`. The installed `@utcp/http` package
 * registers `streamable_http` (underscore); the spec writes
 * `streamable-http`. Both spellings collapse to the same normalized token so
 * neither spelling creates a hole in the fail-closed classification.
 */
export function normalizeCallTemplateType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  return normalized.length > 0 ? normalized : null;
}

/** Map an already-normalized type token to a transport class. */
export function classForType(normalizedType: string): TransportClass {
  switch (normalizedType) {
    case "http":
    case "sse":
    case "streamable_http":
      return "http";
    case "file":
    case "text":
      return "local-file";
    case "cli":
      return "cli";
    default:
      return "unclassified";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Classify an MCP server map. `mcpServers` entries are discriminated on
 * `transport`; a manual that mixes stdio and http servers is classified by its
 * most restrictive entry, and an entry whose transport cannot be read makes
 * the whole map unclassified.
 */
export function classifyMcpServers(serverMap: unknown): TransportClass {
  if (!isRecord(serverMap)) return "unclassified";
  const entries = Object.values(serverMap);
  if (entries.length === 0) return "unclassified";

  let sawHttp = false;
  for (const entry of entries) {
    if (!isRecord(entry)) return "unclassified";
    if (entry.transport === "stdio") return "mcp-stdio";
    if (entry.transport === "http") {
      sawHttp = true;
      continue;
    }
    return "unclassified";
  }
  return sawHttp ? "mcp-http" : "unclassified";
}

/** Classify a manual call template. */
export function classifyManual(template: CallTemplate): TransportClass {
  const type = normalizeCallTemplateType(template.call_template_type);
  if (type === null) return "unclassified";
  if (type === "mcp") {
    const config = (template as { config?: unknown }).config;
    return classifyMcpServers(isRecord(config) ? config.mcpServers : undefined);
  }
  return classForType(type);
}

/**
 * Classify a registered tool. The tool carries its own call template, which
 * for MCP points at a single server entry; when that entry cannot be resolved
 * the manual's classification is used, and a disagreement is reported by the
 * caller as a capability-boundary rejection rather than silently widened.
 */
export function classifyTool(tool: Tool, manual: CallTemplate | undefined): TransportClass {
  const template = tool.tool_call_template as CallTemplate | undefined;
  const type = normalizeCallTemplateType(template?.call_template_type);
  if (type === null) return "unclassified";
  if (type !== "mcp") return classForType(type);

  const config = (template as { config?: unknown } | undefined)?.config;
  const serverMap = isRecord(config) ? config.mcpServers : undefined;
  if (isRecord(serverMap) && Object.keys(serverMap).length > 0) {
    const direct = classifyMcpServers(serverMap);
    if (direct !== "unclassified") return direct;
    // A multi-server tool template is unresolvable: fall back to the manual.
  }
  return manual ? classifyManual(manual) : "unclassified";
}

export function isEnabled(
  transport: TransportClass,
  enabled: Record<TransportClass, boolean>,
): boolean {
  return transport !== "unclassified" && enabled[transport] === true;
}

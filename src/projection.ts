/**
 * Tool projection (spec §3.5).
 *
 * An SDK `Tool` object carries `tool_call_template`, which can hold URLs,
 * headers, auth material, command lines and environment variables. Nothing in
 * this module ever returns, copies or spreads a `Tool`: every field is read
 * explicitly and rebuilt into a small display object.
 */

import type { Tool } from "@utcp/sdk";
import { displayText } from "./errors.js";
import type { TransportClass } from "./transport.js";

/** Hard ceiling for a projected description; the value is untrusted text. */
const MAX_DESCRIPTION_LENGTH = 512;
/**
 * Ceiling for a projected tool name. Names drive resolution, so this is set
 * far above any real identifier: it exists only to stop a hostile manual from
 * inflating every result it appears in.
 */
const MAX_NAME_LENGTH = 200;
const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 64;

export interface ToolListItem {
  name: string;
  description: string;
  manual: string;
  transport: TransportClass;
  tags: string[];
}

export interface ToolDescription extends ToolListItem {
  inputSchema: unknown;
  outputSchema: unknown;
  schemaSupported: boolean;
  schemaIssues?: { path: string; keyword: string; message?: string }[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Manual name: the text before the first `.` of the tool name, falling back to
 * the call template's own name. Never guessed from a path or URL.
 */
export function manualOf(tool: Tool): string {
  const name = text(tool.name);
  const dot = name.indexOf(".");
  if (dot > 0) return name.slice(0, dot);
  const templateName = text(tool.tool_call_template?.name);
  const templateDot = templateName.indexOf(".");
  return templateDot > 0 ? templateName.slice(0, templateDot) : templateName;
}

export function projectDescription(value: unknown): string {
  return displayText(text(value).replace(/\s+/g, " ").trim(), MAX_DESCRIPTION_LENGTH);
}

export function projectTags(tool: Tool): string[] {
  const tags = Array.isArray(tool.tags) ? tool.tags : [];
  const out: string[] = [];
  for (const tag of tags) {
    if (out.length >= MAX_TAGS) break;
    const clean = displayText(text(tag), MAX_TAG_LENGTH);
    if (clean.length > 0) out.push(clean);
  }
  return out;
}

export function toListItem(tool: Tool, transport: TransportClass): ToolListItem {
  return {
    // Bounded like every other projected field: the name comes from a remote
    // manual, so it is not trusted to be short, and an unbounded string would
    // let a server inflate every search result it appears in.
    name: displayText(text(tool.name), MAX_NAME_LENGTH),
    description: projectDescription(tool.description),
    manual: displayText(manualOf(tool), 120),
    transport,
    tags: projectTags(tool),
  };
}

/**
 * Full description. `inputSchema`/`outputSchema` are the SDK's `inputs`/
 * `outputs` renamed only — no rewriting, so what the tool advertises is what
 * was validated against at readiness.
 */
export function toDescription(
  tool: Tool,
  transport: TransportClass,
  verdict: { supported: boolean; issues: readonly { path: string; keyword: string; message?: string }[] },
): ToolDescription {
  const base = toListItem(tool, transport);
  const description: ToolDescription = {
    ...base,
    inputSchema: tool.inputs ?? {},
    outputSchema: tool.outputs ?? {},
    schemaSupported: verdict.supported,
  };
  if (!verdict.supported) {
    description.schemaIssues = verdict.issues.map((issue) =>
      issue.message === undefined
        ? { path: issue.path, keyword: issue.keyword }
        : { path: issue.path, keyword: issue.keyword, message: issue.message },
    );
  }
  return description;
}

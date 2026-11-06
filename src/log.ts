/**
 * Adapter-side operational log (spec §10).
 *
 * Only structured fields the adapter itself produced are written: tool name,
 * manual, transport class, duration, outcome, error category and identifiers.
 * Descriptions, arguments, schemas, URLs, headers and raw SDK errors never
 * reach this sink — the SDK's own stdout/stderr channel is separate and is
 * documented (not intercepted) in the README.
 */

export type LogEvent =
  | {
      event: "call";
      tool: string;
      manual: string;
      transport: string;
      durationMs: number;
      ok: boolean;
      code?: string;
      sessionID: string;
      invocationID: string;
    }
  | {
      event: "policy";
      notice: "policyBaselineUnverified";
      sessionID: string;
    }
  | {
      event: "lifecycle";
      phase: "initializing" | "ready" | "closing" | "closed";
      detail?: string;
    }
  | {
      event: "manual";
      name: string;
      transport: string;
      registered: boolean;
      toolCount: number;
    };

export interface Logger {
  emit(event: LogEvent): void;
}

export type LogSink = (event: LogEvent) => void;

const PREFIX = "[oc2-utcp]";

/**
 * Default sink: a single line per event on stderr.
 *
 * stdout is deliberately unused: the UTCP SDK writes diagnostics of its own to
 * stdout and the adapter must not compete with that channel.
 */
const defaultSink: LogSink = (event) => {
  console.error(`${PREFIX} ${JSON.stringify(event)}`);
};

export function createLogger(sink: LogSink = defaultSink): Logger {
  return {
    emit(event: LogEvent): void {
      try {
        sink(event);
      } catch {
        // A log sink must never break a tool call.
      }
    },
  };
}

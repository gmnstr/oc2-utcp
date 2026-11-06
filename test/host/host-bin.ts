/**
 * Locate the OpenCode (OC2) executable that the host-integration tests drive.
 *
 * The plugin itself never starts OpenCode: only `test/host/**` does. Discovery
 * is therefore test-only, and deliberately explicit, so a fresh clone either
 * proves it has an OC2 2.2.5 executable or reports exactly what it looked for.
 *
 * Order:
 *   1. `OC2_OPENCODE_BIN` — an explicit path is authoritative. When it is set
 *      and unusable the lookup fails closed and no other candidate is tried.
 *   2. `PATH` — the normal case after `npm install -g @opencode/cli@2.2.5`.
 *   3. `node_modules/.bin` of this repository — a host installed locally.
 *   4. Well-known user install directories.
 *
 * A candidate counts only when it is an executable regular file and
 * `--version` prints an OpenCode version. Every side effect is injectable, so
 * the lookup is unit-tested for POSIX and Windows without touching PATH.
 */

import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The host version this repository's integration evidence was produced on. */
export const SUPPORTED_HOST_VERSION = "2.2.5";

/** Explicit path to the executable. Authoritative when set. */
export const HOST_BIN_ENV = "OC2_OPENCODE_BIN";

/** Set to a truthy value to turn a missing host into a failure instead of a skip. */
export const REQUIRE_HOST_ENV = "OC2_REQUIRE_HOST";

export const REPO_ROOT = resolve(import.meta.dir, "../..");

const VERSION_TIMEOUT_MS = 20_000;
const VERSION_LINE = /^(?:opencode\s+)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/i;

export type HostSource = "env" | "path" | "node_modules" | "user-install";

export interface HostCandidate {
  bin: string;
  source: HostSource;
}

export interface HostFound {
  ok: true;
  bin: string;
  version: string;
  source: HostSource;
  /** Every path the lookup considered, in order. */
  tried: string[];
}

export interface HostUnavailable {
  ok: false;
  code: "invalid" | "version-mismatch" | "not-found";
  reason: string;
  tried: string[];
}

export type HostResolution = HostFound | HostUnavailable;

export interface DiscoveryInput {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homeDir: string;
  repoRoot: string;
}

export interface DiscoveryIo {
  /** Resolve a bare command name on `PATH`; null when absent. */
  which: (name: string) => string | null;
  /** True only for a regular file this process may execute. */
  isExecutableFile: (path: string) => boolean;
  /** The version printed by the candidate, or null if it is not an OC2 binary. */
  version: (bin: string) => string | null;
}

export interface DiscoverOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  repoRoot?: string;
  io?: Partial<DiscoveryIo>;
}

/**
 * The first line of `opencode --version` is `opencode v2.2.5`; a bare semver is
 * accepted too, so a wrapper that forwards only the number still works. Any
 * other first line means the candidate is not an OpenCode executable.
 */
export function parseHostVersion(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = VERSION_LINE.exec(trimmed);
    return match?.[1] ?? null;
  }
  return null;
}

export function isRequired(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/** File names an OpenCode install may use on this platform, most specific first. */
export function binaryNames(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["opencode.exe", "opencode.cmd", "opencode"] : ["opencode"];
}

/** Directories a per-user OpenCode install is known to land in. */
export function installDirs(input: DiscoveryInput): string[] {
  if (input.platform === "win32") {
    const localAppData = input.env["LOCALAPPDATA"] ?? join(input.homeDir, "AppData", "Local");
    return [
      join(localAppData, "Programs", "opencode"),
      join(input.homeDir, ".opencode", "bin"),
    ];
  }
  return [
    join(input.homeDir, ".opencode", "bin"),
    join(input.homeDir, ".local", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
}

/**
 * Ordered candidates. An explicit `OC2_OPENCODE_BIN` short-circuits the list so
 * a mistyped override can never silently fall back to something else.
 */
export function planCandidates(
  input: DiscoveryInput,
  which: (name: string) => string | null,
): HostCandidate[] {
  const explicit = (input.env[HOST_BIN_ENV] ?? "").trim();
  if (explicit !== "") {
    return [{ bin: resolve(explicit), source: "env" }];
  }

  const candidates: HostCandidate[] = [];
  const seen = new Set<string>();
  const add = (bin: string | null, source: HostSource): void => {
    if (bin === null || bin === "") return;
    const key = resolve(bin);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ bin: key, source });
  };

  add(which("opencode"), "path");
  for (const name of binaryNames(input.platform)) {
    add(join(input.repoRoot, "node_modules", ".bin", name), "node_modules");
  }
  for (const dir of installDirs(input)) {
    for (const name of binaryNames(input.platform)) {
      add(join(dir, name), "user-install");
    }
  }
  return candidates;
}

function defaultIsExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    // Windows has no execute bit; the name filter above already narrowed it.
    if (platform === "win32") return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Run `--version` once. Never throws: an unusable binary is simply null. */
export function readHostVersion(
  bin: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync({
      cmd: [bin, "--version"],
      env: { ...env },
      stdout: "pipe",
      stderr: "pipe",
      timeout: VERSION_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  if (result.exitCode !== 0) return null;
  const stdout = result.stdout === undefined ? "" : result.stdout.toString();
  const stderr = result.stderr === undefined ? "" : result.stderr.toString();
  return parseHostVersion(stdout) ?? parseHostVersion(stderr);
}

export function discoverHost(options: DiscoverOptions = {}): HostResolution {
  const input: DiscoveryInput = {
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    homeDir: options.homeDir ?? homedir(),
    repoRoot: options.repoRoot ?? REPO_ROOT,
  };
  const io: DiscoveryIo = {
    which: options.io?.which ?? ((name) => Bun.which(name)),
    isExecutableFile:
      options.io?.isExecutableFile ?? ((path) => defaultIsExecutableFile(path, input.platform)),
    version: options.io?.version ?? ((bin) => readHostVersion(bin, input.env)),
  };

  const candidates = planCandidates(input, io.which);
  const pinned = candidates.length > 0 && candidates.every((entry) => entry.source === "env");
  const tried: string[] = [];

  for (const candidate of candidates) {
    tried.push(candidate.bin);

    if (!io.isExecutableFile(candidate.bin)) {
      if (pinned) {
        return {
          ok: false,
          code: "invalid",
          reason: `${HOST_BIN_ENV} points at ${candidate.bin}, which is not an executable file.`,
          tried,
        };
      }
      continue;
    }

    const version = io.version(candidate.bin);
    if (version === null) {
      if (pinned) {
        return {
          ok: false,
          code: "invalid",
          reason: `${HOST_BIN_ENV} points at ${candidate.bin}, but \`--version\` did not report an OpenCode version.`,
          tried,
        };
      }
      continue;
    }

    if (version !== SUPPORTED_HOST_VERSION) {
      return {
        ok: false,
        code: "version-mismatch",
        reason: `${candidate.bin} reports OpenCode ${version}; this repository targets ${SUPPORTED_HOST_VERSION}.`,
        tried,
      };
    }

    return { ok: true, bin: candidate.bin, version, source: candidate.source, tried };
  }

  return {
    ok: false,
    code: "not-found",
    reason: `no executable reporting OpenCode ${SUPPORTED_HOST_VERSION} was found`,
    tried,
  };
}

let cached: HostResolution | undefined;

/** Discovery result for this process; the `--version` probe runs once. */
export function discoveredHost(): HostResolution {
  cached ??= discoverHost();
  return cached;
}

export function describeUnavailable(host: HostUnavailable): string {
  const tried =
    host.tried.length === 0 ? "  (no candidates)" : host.tried.map((path) => `  - ${path}`).join("\n");
  return [
    `No usable OpenCode ${SUPPORTED_HOST_VERSION} executable was found: ${host.reason}`,
    "",
    "Tried:",
    tried,
    "",
    "Install the host and retry:",
    `  npm install -g @opencode/cli@${SUPPORTED_HOST_VERSION}`,
    "Or point the tests at an existing executable:",
    `  ${HOST_BIN_ENV}=/path/to/opencode bun test test/host`,
    "",
    `Host-integration tests skip when no host is found. Set ${REQUIRE_HOST_ENV}=1 to make a missing host a failure; CI does.`,
  ].join("\n");
}

/** The discovered binary, or a thrown diagnosis naming every candidate tried. */
export function resolveHostOrThrow(): string {
  const host = discoveredHost();
  if (host.ok) return host.bin;
  throw new Error(describeUnavailable(host));
}

export interface HostGate {
  /** True when a validated OC2 2.2.5 executable was found. */
  runnable: boolean;
  /** True when `OC2_REQUIRE_HOST` is set: a missing host must fail, not skip. */
  required: boolean;
  /** Suite name — the plain title, or one that records why it was skipped. */
  title: string;
  /** Full diagnosis, used for the failure and for the skip banner. */
  message: string;
  host: HostResolution;
}

/**
 * One gate per host test file:
 *
 *   const gate = hostGate("OC2 host integration");
 *   if (gate.required && !gate.runnable) test("...", () => { throw new Error(gate.message) });
 *   (gate.runnable ? describe : describe.skip)(gate.title, () => { ... });
 */
export function hostGate(title: string): HostGate {
  const host = discoveredHost();
  const required = isRequired(process.env[REQUIRE_HOST_ENV]);
  const message = host.ok
    ? `using OpenCode ${host.version} at ${host.bin} (${host.source})`
    : describeUnavailable(host);
  return {
    runnable: host.ok,
    required,
    title: host.ok ? title : `${title} — skipped: ${host.reason}`,
    message,
    host,
  };
}

/**
 * Unit tests for host-executable discovery.
 *
 * These run everywhere, with no OpenCode install: every filesystem and process
 * side effect is injected, so the same logic is exercised for POSIX and Windows
 * and for the failure modes a fresh clone hits (no host on PATH, an override
 * that points nowhere, a binary reporting the wrong version).
 */

import { describe, expect, test } from "bun:test";
import {
  HOST_BIN_ENV,
  REQUIRE_HOST_ENV,
  SUPPORTED_HOST_VERSION,
  binaryNames,
  describeUnavailable,
  discoverHost,
  isRequired,
  parseHostVersion,
  planCandidates,
  type DiscoveryInput,
  type DiscoveryIo,
} from "./host/host-bin.js";

const REPO = "/repo";
const HOME = "/home/dev";

function input(overrides: Partial<DiscoveryInput> = {}): DiscoveryInput {
  return { platform: "linux", env: {}, homeDir: HOME, repoRoot: REPO, ...overrides };
}

interface FakeSpec {
  /** Path `Bun.which("opencode")` would return. */
  onPath?: string | null;
  /** Paths that exist and are executable. */
  executable?: string[];
  /** `--version` output per path; absent means "not an OpenCode binary". */
  versions?: Record<string, string | null>;
}

function fakeIo(spec: FakeSpec): { io: Partial<DiscoveryIo>; versionCalls: string[] } {
  const versionCalls: string[] = [];
  return {
    versionCalls,
    io: {
      which: (name: string) => (name === "opencode" ? (spec.onPath ?? null) : null),
      isExecutableFile: (path: string) => (spec.executable ?? []).includes(path),
      version: (bin: string) => {
        versionCalls.push(bin);
        return spec.versions?.[bin] ?? null;
      },
    },
  };
}

describe("parseHostVersion", () => {
  const cases: Array<[string, string | null]> = [
    ["opencode v2.2.5\n", "2.2.5"],
    ["opencode 2.2.5\n", "2.2.5"],
    ["2.2.5\n", "2.2.5"],
    ["OpenCode v2.2.5\r\n", "2.2.5"],
    ["opencode v2.2.5-beta.1\n", "2.2.5-beta.1"],
    ["", null],
    ["opencode\n", null],
    ["bash: opencode: command not found\n", null],
    ["<html>404</html>\n", null],
  ];

  for (const [output, expected] of cases) {
    test(`parses ${JSON.stringify(output)}`, () => {
      expect(parseHostVersion(output)).toBe(expected);
    });
  }
});

describe("isRequired", () => {
  test("accepts the documented truthy spellings", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", " true "]) {
      expect(isRequired(value)).toBe(true);
    }
  });

  test("treats unset and falsy values as optional", () => {
    for (const value of [undefined, "", "0", "false", "no", "off", "maybe"]) {
      expect(isRequired(value)).toBe(false);
    }
  });
});

describe("planCandidates", () => {
  test("prefers a PATH hit over every fallback", () => {
    const candidates = planCandidates(input(), () => "/usr/local/bin/opencode");
    expect(candidates[0]).toEqual({ bin: "/usr/local/bin/opencode", source: "path" });
  });

  test("still plans repository and user locations when PATH has nothing", () => {
    const bins = planCandidates(input(), () => null).map((entry) => entry.bin);
    expect(bins).toContain(`${REPO}/node_modules/.bin/opencode`);
    expect(bins).toContain(`${HOME}/.opencode/bin/opencode`);
    expect(bins).toContain(`${HOME}/.local/bin/opencode`);
    expect(bins).toContain("/usr/local/bin/opencode");
    expect(bins).toContain("/opt/homebrew/bin/opencode");
  });

  test("an explicit override replaces the whole candidate list", () => {
    const candidates = planCandidates(input({ env: { [HOST_BIN_ENV]: "/opt/oc/bin/opencode" } }), () =>
      "/usr/local/bin/opencode",
    );
    expect(candidates).toEqual([{ bin: "/opt/oc/bin/opencode", source: "env" }]);
  });

  test("treats a blank override as unset", () => {
    const candidates = planCandidates(input({ env: { [HOST_BIN_ENV]: "   " } }), () => "/usr/bin/opencode");
    expect(candidates[0]?.source).toBe("path");
    expect(candidates.length).toBeGreaterThan(1);
  });

  test("does not list the same path twice", () => {
    const bins = planCandidates(input(), () => `${REPO}/node_modules/.bin/opencode`).map((entry) => entry.bin);
    expect(bins.filter((bin) => bin === `${REPO}/node_modules/.bin/opencode`)).toHaveLength(1);
  });

  test("uses platform-specific file names and install directories on Windows", () => {
    expect(binaryNames("win32")).toEqual(["opencode.exe", "opencode.cmd", "opencode"]);
    expect(binaryNames("linux")).toEqual(["opencode"]);

    const bins = planCandidates(input({ platform: "win32", env: { LOCALAPPDATA: "/local" } }), () => null).map(
      (entry) => entry.bin,
    );
    expect(bins).toContain(`${REPO}/node_modules/.bin/opencode.exe`);
    expect(bins).toContain(`${REPO}/node_modules/.bin/opencode.cmd`);
    expect(bins).toContain("/local/Programs/opencode/opencode.exe");
  });
});

describe("discoverHost", () => {
  test("resolves an executable found on PATH", () => {
    const bin = "/usr/local/bin/opencode";
    const { io } = fakeIo({ onPath: bin, executable: [bin], versions: { [bin]: SUPPORTED_HOST_VERSION } });
    const host = discoverHost({ ...input(), io });

    expect(host.ok).toBe(true);
    if (!host.ok) return;
    expect(host.bin).toBe(bin);
    expect(host.version).toBe(SUPPORTED_HOST_VERSION);
    expect(host.source).toBe("path");
  });

  test("falls back to a repository-local node_modules host", () => {
    const bin = `${REPO}/node_modules/.bin/opencode`;
    const { io } = fakeIo({ executable: [bin], versions: { [bin]: SUPPORTED_HOST_VERSION } });
    const host = discoverHost({ ...input(), io });

    expect(host.ok).toBe(true);
    if (!host.ok) return;
    expect(host.source).toBe("node_modules");
  });

  test("an explicit override is authoritative and never falls back", () => {
    const host = discoverHost({
      ...input({ env: { [HOST_BIN_ENV]: "/opt/oc/bin/opencode" } }),
      io: {
        which: () => {
          throw new Error("PATH must not be consulted when the override is set");
        },
        isExecutableFile: () => false,
        version: () => {
          throw new Error("an unusable override must be rejected before running it");
        },
      },
    });

    expect(host.ok).toBe(false);
    if (host.ok) return;
    expect(host.code).toBe("invalid");
    expect(host.reason).toContain(HOST_BIN_ENV);
    expect(host.tried).toEqual(["/opt/oc/bin/opencode"]);
  });

  test("an unusable override reports invalid instead of skipping", () => {
    // Real filesystem, real probe path: this is the fresh-clone shape where a
    // user points OC2_OPENCODE_BIN at a path that does not exist.
    const host = discoverHost({
      env: { ...process.env, [HOST_BIN_ENV]: "/nonexistent/oc2-opencode" },
      repoRoot: "/nonexistent-repo",
      homeDir: "/nonexistent-home",
    });

    expect(host.ok).toBe(false);
    if (host.ok) return;
    expect(host.code).toBe("invalid");
    expect(host.reason).toContain("/nonexistent/oc2-opencode");
  });

  test("a wrong version is a mismatch, not a silent fallback", () => {
    const bin = "/usr/bin/opencode";
    const { io } = fakeIo({ onPath: bin, executable: [bin], versions: { [bin]: "2.3.0" } });
    const host = discoverHost({ ...input(), io });

    expect(host.ok).toBe(false);
    if (host.ok) return;
    expect(host.code).toBe("version-mismatch");
    expect(host.reason).toContain("2.3.0");
    expect(host.reason).toContain(SUPPORTED_HOST_VERSION);
    expect(host.tried).toEqual([bin]);
  });

  test("a directory or non-executable file named opencode is ignored", () => {
    const bin = "/usr/local/bin/opencode";
    const { io, versionCalls } = fakeIo({ onPath: bin });
    const host = discoverHost({ ...input(), io });

    expect(host.ok).toBe(false);
    expect(versionCalls).not.toContain(bin);
  });

  test("an executable that does not report a version is skipped", () => {
    const bin = "/usr/local/bin/opencode";
    const { io } = fakeIo({ onPath: bin, executable: [bin], versions: { [bin]: null } });
    const host = discoverHost({ ...input(), io });

    expect(host.ok).toBe(false);
    if (host.ok) return;
    expect(host.code).toBe("not-found");
    expect(host.tried).toContain(bin);
  });

  test("reports every candidate it tried when nothing is installed", () => {
    const { io } = fakeIo({});
    const host = discoverHost({ ...input(), io });

    expect(host.ok).toBe(false);
    if (host.ok) return;
    expect(host.code).toBe("not-found");
    expect(host.tried).toEqual([
      `${REPO}/node_modules/.bin/opencode`,
      `${HOME}/.opencode/bin/opencode`,
      `${HOME}/.local/bin/opencode`,
      "/usr/local/bin/opencode",
      "/opt/homebrew/bin/opencode",
    ]);
  });
});

describe("describeUnavailable", () => {
  test("names the candidates, the install command and the requirement switch", () => {
    const host = discoverHost({ ...input(), io: fakeIo({}).io });
    expect(host.ok).toBe(false);
    if (host.ok) return;

    const message = describeUnavailable(host);
    expect(message).toContain(`${REPO}/node_modules/.bin/opencode`);
    expect(message).toContain(`npm install -g @opencode/cli@${SUPPORTED_HOST_VERSION}`);
    expect(message).toContain(HOST_BIN_ENV);
    expect(message).toContain(REQUIRE_HOST_ENV);
  });
});

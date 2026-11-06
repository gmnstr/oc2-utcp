import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Dependency guard for GHSA-mrhx-c7xc-m3w5 (zod < 4.6.6).
 *
 * The MCP SDK must resolve the patched zod (4.6.6+) for server-response
 * parsing. @utcp/sdk is intentionally kept on zod 3.25.76 via the lockfile
 * override `"@utcp/sdk/zod"`, because the SDK is incompatible with zod 4
 * (measured 40/119 failures when forced). This test asserts both facts against
 * the real on-disk module locations and fails on any new, unreviewed zod copy.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_MODULES = join(ROOT, "node_modules");

/** Lowest zod version that carries the GHSA-mrhx-c7xc-m3w5 fix. */
const PATCHED_ZOD: readonly [number, number, number] = [4, 6, 6];

/**
 * Reviewed zod copies under node_modules, keyed by path relative to the repo
 * root. Any addition, removal or version change must be reviewed and this map
 * updated deliberately.
 */
const EXPECTED_ZOD_COPIES: Readonly<Record<string, string>> = {
  "node_modules/zod": "4.6.7",
  "node_modules/@utcp/sdk/node_modules/zod": "3.25.76",
};

function readVersion(pkgJsonPath: string): string {
  const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error(`no string "version" in ${pkgJsonPath}`);
  }
  return parsed.version;
}

function parseSemver(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`unparseable version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function packageDir(name: string): string {
  const dir = join(NODE_MODULES, ...name.split("/"));
  if (!existsSync(join(dir, "package.json"))) {
    throw new Error(`package ${name} not installed at ${dir}`);
  }
  return dir;
}

/** Resolve `zod/package.json` the way the package itself would at runtime. */
function zodResolvedFrom(name: string): { path: string; version: string } {
  const requireFromPkg = createRequire(join(packageDir(name), "package.json"));
  const path = requireFromPkg.resolve("zod/package.json");
  return { path, version: readVersion(path) };
}

/**
 * Enumerate zod copies at the only places they can be hoisted to or nested
 * under a top-level package: `node_modules/zod`, `node_modules/<pkg>/node_modules/zod`
 * and `node_modules/@<scope>/<pkg>/node_modules/zod`. No deep recursive walk.
 */
function scanZodCopies(): Record<string, string> {
  const found: Record<string, string> = {};

  const consider = (dir: string) => {
    const pkgJson = join(dir, "package.json");
    if (existsSync(pkgJson) && statSync(dir).isDirectory()) {
      found[`node_modules/${dir.slice(NODE_MODULES.length + 1).replaceAll("\\", "/")}`] =
        readVersion(pkgJson);
    }
  };

  const subdirs = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => join(dir, entry.name));

  consider(join(NODE_MODULES, "zod"));

  for (const top of subdirs(NODE_MODULES)) {
    const name = top.slice(NODE_MODULES.length + 1);
    if (name === "zod") continue;

    if (name.startsWith("@")) {
      for (const scoped of subdirs(top)) {
        consider(join(scoped, "node_modules", "zod"));
      }
    } else if (!name.startsWith(".")) {
      consider(join(top, "node_modules", "zod"));
    }
  }

  return found;
}

describe("zod dependency split (GHSA-mrhx-c7xc-m3w5)", () => {
  test("MCP SDK resolves a patched zod (>= 4.6.6)", () => {
    const { path, version } = zodResolvedFrom("@modelcontextprotocol/sdk");
    expect(
      compareSemver(parseSemver(version), PATCHED_ZOD),
      `zod resolved from @modelcontextprotocol/sdk is ${version} at ${path}; need >= 4.6.6`,
    ).toBeGreaterThanOrEqual(0);
  });

  test("@utcp/sdk stays on zod major 3 (intentional split)", () => {
    const { path, version } = zodResolvedFrom("@utcp/sdk");
    const [major] = parseSemver(version);
    expect(
      major,
      `zod resolved from @utcp/sdk is ${version} at ${path}; expected major 3 (see lockfile override "@utcp/sdk/zod")`,
    ).toBe(3);
  });

  test("the set of zod copies matches the reviewed map", () => {
    const observed = scanZodCopies();
    const observedJson = JSON.stringify(observed, Object.keys(observed).sort(), 2);
    const expectedJson = JSON.stringify(
      EXPECTED_ZOD_COPIES,
      Object.keys(EXPECTED_ZOD_COPIES).sort(),
      2,
    );

    const added = Object.keys(observed).filter((k) => !(k in EXPECTED_ZOD_COPIES));
    const removed = Object.keys(EXPECTED_ZOD_COPIES).filter((k) => !(k in observed));
    const changed = Object.keys(observed).filter(
      (k) => k in EXPECTED_ZOD_COPIES && observed[k] !== EXPECTED_ZOD_COPIES[k],
    );

    const summary = [
      added.length ? `added: ${added.map((k) => `${k}@${observed[k]}`).join(", ")}` : "",
      removed.length ? `removed: ${removed.join(", ")}` : "",
      changed.length
        ? `version changed: ${changed.map((k) => `${k} ${EXPECTED_ZOD_COPIES[k]} -> ${observed[k]}`).join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("; ");

    if (observedJson !== expectedJson) {
      throw new Error(
        `zod copies changed (${summary || "no key-level diff"}).\n` +
          `Observed map:\n${observedJson}\n` +
          `Expected map (EXPECTED_ZOD_COPIES in test/deps-zod.test.ts):\n${expectedJson}\n` +
          `A new zod copy must be reviewed before the map is updated.`,
      );
    }
  });
});

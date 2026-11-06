/**
 * Builds a self-contained, reviewer-inspectable copy of this plugin:
 * `src/` plus `package.json` and `bun.lock`, with the production dependency
 * closure installed from the lockfile (no symlinks, no link to this checkout).
 *
 * The directory name is derived from a digest of every staged input, so the
 * same source revision and lockfile always resolve to the same directory and
 * the install runs once.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");

/** Content digest over `src/`, `package.json` and `bun.lock`. */
export function sourceDigest(): string {
  const hash = createHash("sha256");
  const files: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile()) files.push(rel);
    }
  };
  walk(join(REPO, "src"), "src");
  files.push("package.json", "bun.lock");
  files.sort();
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(join(REPO, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export interface StagedPlugin {
  dir: string;
  digest: string;
  reused: boolean;
  packages: number;
}

/** Stages (or reuses) a self-contained copy with production dependencies only. */
export async function stagePlugin(): Promise<StagedPlugin> {
  const digest = sourceDigest();
  const dir = join(tmpdir(), `oc2-utcp-stage-${digest.slice(0, 12)}`);
  const stamp = join(dir, ".stamp");
  if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === digest) {
    return { dir, digest, reused: true, packages: 0 };
  }

  mkdirSync(dir, { recursive: true });
  cpSync(join(REPO, "src"), join(dir, "src"), { recursive: true });
  for (const file of ["package.json", "bun.lock"]) {
    cpSync(join(REPO, file), join(dir, file));
  }

  const child = Bun.spawn({
    cmd: ["bun", "install", "--production", "--frozen-lockfile", "--backend=copy"],
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`bun install failed in ${dir}: ${stderr || stdout}`);
  }
  const match = /(\d+) packages installed/.exec(stdout);
  writeFileSync(stamp, `${digest}\n`);
  return { dir, digest, reused: false, packages: match ? Number(match[1]) : 0 };
}

/**
 * Nitro file-tracing pulls in `@electric-sql/pglite` JS but often drops the
 * co-located WASM / .data payloads. At runtime PGLite then throws:
 *   ENOENT .../_libs/pglite.data
 *
 * Copies payloads next to every traced `electric-sql__pglite*.mjs` bundle and
 * into the well-known Nitro output dirs for both:
 *   - node-server  → .output/server/_libs  (Docker)
 *   - vercel       → .vercel/output/functions/__server.func/_libs
 *
 * Source priority:
 *   1. node_modules/@electric-sql/pglite/dist  (preferred after npm install)
 *   2. vendor/pglite/                          (checked-in fallback for Docker / offline)
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = ["pglite.data", "pglite.wasm", "initdb.wasm"];

const pkgDist = join(root, "node_modules", "@electric-sql", "pglite", "dist");
const vendorDist = join(root, "vendor", "pglite");

function resolveSourceDir() {
  if (existsSync(join(pkgDist, "pglite.data"))) return pkgDist;
  if (existsSync(join(vendorDist, "pglite.data"))) return vendorDist;
  return null;
}

const knownTargets = [
  join(root, ".output", "server", "_libs"),
  join(root, ".output", "server", "node_modules", "@electric-sql", "pglite", "dist"),
  join(root, ".vercel", "output", "functions", "__server.func", "_libs"),
  join(
    root,
    ".vercel",
    "output",
    "functions",
    "__server.func",
    "node_modules",
    "@electric-sql",
    "pglite",
    "dist",
  ),
];

const sourceDir = resolveSourceDir();
if (!sourceDir) {
  console.error(
    "[copy-pglite-assets] FATAL: neither node_modules/@electric-sql/pglite/dist nor vendor/pglite contains pglite.data.\n" +
      "  Run `npm install` or ensure vendor/pglite/{pglite.data,pglite.wasm,initdb.wasm} exist.",
  );
  process.exit(1);
}

console.log(`[copy-pglite-assets] source: ${sourceDir}`);

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "node_modules" && !dir.includes(".output") && !dir.includes(".vercel")) continue;
      walk(full, acc);
    } else if (name.includes("pglite") && name.endsWith(".mjs")) {
      acc.push(dirname(full));
    }
  }
  return acc;
}

const dirs = new Set(knownTargets);
for (const found of walk(join(root, ".output"))) dirs.add(found);
for (const found of walk(join(root, ".vercel"))) dirs.add(found);

let copied = 0;
const missing = [];
for (const dir of dirs) {
  mkdirSync(dir, { recursive: true });
  for (const name of files) {
    const from = join(sourceDir, name);
    if (!existsSync(from)) {
      missing.push(from);
      continue;
    }
    copyFileSync(from, join(dir, name));
    copied += 1;
  }
}

if (missing.length) {
  console.warn(`[copy-pglite-assets] missing source file(s): ${missing.join(", ")}`);
}

if (copied === 0) {
  console.error("[copy-pglite-assets] FATAL: copied 0 assets — PGLite will fail at runtime with ENOENT");
  process.exit(1);
}

console.log(
  `[copy-pglite-assets] copied ${copied} asset(s) into ${dirs.size} dir(s)`,
);

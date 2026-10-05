#!/usr/bin/env node
/**
 * Production container entrypoint.
 *
 * 1. Drop root after making the PGLite data dir writable (named volumes
 *    mount as root; the app user is uid 1001).
 * 2. Apply SQL migrations when DATABASE_URL is set (auth schema, etc.).
 *    PGLite applies the same files itself on first query.
 * 3. Exec the Nitro node-server (must be built with NITRO_PRESET=node-server).
 */
import { mkdirSync, chownSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HUB_UID = Number(process.env.HUB_UID || 1001);
const HUB_GID = Number(process.env.HUB_GID || 1001);
const dataDir = (process.env.PGLITE_DATA_DIR || "/app/data/pglite").trim();

function warn(msg) {
  console.warn(`[knowledge-hub] ${msg}`);
}

function fail(msg) {
  console.error(`[knowledge-hub] ${msg}`);
  process.exit(1);
}

function dropPrivileges() {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  mkdirSync(dataDir, { recursive: true });
  try {
    chownSync(dataDir, HUB_UID, HUB_GID);
  } catch (err) {
    warn(`could not chown ${dataDir}: ${err instanceof Error ? err.message : err}`);
  }
  try {
    process.setgid(HUB_GID);
    process.setuid(HUB_UID);
  } catch (err) {
    warn(`could not drop privileges: ${err instanceof Error ? err.message : err}`);
  }
}

function checkAuthEnv() {
  const secret = (process.env.BETTER_AUTH_SECRET || "").trim();
  if (!secret) {
    warn(
      "BETTER_AUTH_SECRET is unset — sessions will use an ephemeral key and sign-outs will happen on every restart. Set a 32+ character secret.",
    );
  } else if (secret.includes("dev-only") || secret.length < 32) {
    warn(
      "BETTER_AUTH_SECRET looks like the compose default or is shorter than 32 characters. Generate one with: openssl rand -hex 32",
    );
  }

  const url = (process.env.BETTER_AUTH_URL || process.env.RENDER_EXTERNAL_URL || "").trim();
  if (!url) {
    warn(
      "BETTER_AUTH_URL is unset. Email/password sign-in requires this to match the exact public origin (scheme + host + port), e.g. https://hub.example.com or http://localhost:10000.",
    );
  } else if (url.includes("localhost") && process.env.NODE_ENV === "production") {
    warn(
      `BETTER_AUTH_URL is ${url}. Fine for local Docker; for a public deploy set it to your HTTPS origin and open the app at that same origin (not 127.0.0.1 if you set localhost, and vice versa).`,
    );
  }
}

/**
 * Vercel preset emits a Lambda-style handler that exits immediately under
 * `node index.mjs`. node-server emits a long-running HTTP listener.
 */
function assertNodeServerEntry(serverPath) {
  if (!existsSync(serverPath)) {
    fail(
      `Missing ${serverPath}. Rebuild with NITRO_PRESET=node-server (npm run build:node / Docker image).`,
    );
  }
  // Sample enough of the entry to detect a Vercel/Lambda handler export.
  let head = "";
  try {
    head = readFileSync(serverPath, "utf8").slice(0, 8000);
  } catch (err) {
    fail(`Could not read ${serverPath}: ${err instanceof Error ? err.message : err}`);
  }
  const looksLikeVercel =
    /from\s+["']@vercel\/node["']/.test(head) ||
    /exports\.handler\s*=/.test(head) ||
    /export\s+\{\s*default\s+as\s+handler/.test(head) ||
    (/vercel/i.test(head) && /listener:\s*false/.test(head));
  // node-server typically listens / creates a server in the entry or chunks.
  if (looksLikeVercel) {
    fail(
      `${serverPath} looks like a Vercel Lambda handler, not a node-server listener.\n` +
        `  Rebuild the image with NITRO_PRESET=node-server (see Dockerfile ENV / npm run build:node).\n` +
        `  vite.config.ts must pass process.env.NITRO_PRESET into nitro({ preset }).`,
    );
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      cwd: root,
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${args.join(" ")} killed by ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
        return;
      }
      resolve();
    });
  });
}

dropPrivileges();
checkAuthEnv();

await run(process.execPath, [join(root, "scripts", "migrate.mjs")]);

const server = join(root, ".output", "server", "index.mjs");
assertNodeServerEntry(server);

console.log(
  `[knowledge-hub] starting node-server on ${process.env.HOST || "0.0.0.0"}:${process.env.PORT || "10000"}`,
);

const child = spawn(process.execPath, [server], {
  stdio: "inherit",
  cwd: root,
  env: process.env,
});

function shutdown(signal) {
  if (!child.killed) child.kill(signal);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

const requiredFiles = [
  "dist/cli.js",
  "dist/codexx.js",
  "dist/index.d.ts",
  "dist/index.js",
  "README.md",
  "package.json",
];

const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const payload = JSON.parse(result.stdout) as Array<{
  files?: Array<{ path?: string }>;
}>;
const files = new Set(payload[0]?.files?.map((file) => file.path).filter(Boolean));
const missing = requiredFiles.filter((file) => !files.has(file));

if (missing.length > 0) {
  throw new Error(`Package tarball is missing required files: ${missing.join(", ")}`);
}

console.log(`Package tarball includes ${requiredFiles.length} required files.`);

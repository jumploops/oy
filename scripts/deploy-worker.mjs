#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const workerDir = path.join(repoRoot, "worker");

async function main() {
  const packageVersion = await readPackageVersion();
  const gitSha = resolveGitSha();
  const deployEnv = process.env.DEPLOY_ENV || "production";
  const deployVersion = process.env.DEPLOY_VERSION || buildDeployVersion(packageVersion, gitSha);
  const deployTag = process.env.DEPLOY_TAG || buildDeployTag(packageVersion, gitSha);
  const deployMessage = process.env.DEPLOY_MESSAGE || `oy@${deployVersion}`;

  const args = [
    "--dir",
    "worker",
    "exec",
    "wrangler",
    "deploy",
    "--var",
    `DEPLOY_ENV:${deployEnv}`,
    "--var",
    `DEPLOY_VERSION:${deployVersion}`,
    "--message",
    deployMessage,
    "--tag",
    deployTag,
    ...buildGitShaArgs(gitSha),
    ...process.argv.slice(2),
  ];

  console.log(`Deploying oy with deploy_env=${deployEnv} deploy_version=${deployVersion}`);
  if (gitSha) {
    console.log(`Git SHA: ${gitSha}`);
  }

  const result = spawnSync(resolvePnpmCommand(), args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || path.join(workerDir, ".wrangler", "config"),
    },
  });

  if (typeof result.status === "number") {
    process.exitCode = result.status;
    return;
  }

  if (result.error) {
    throw result.error;
  }

  process.exitCode = 1;
}

async function readPackageVersion() {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const version = typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  return version;
}

function resolveGitSha() {
  const envValue =
    process.env.DEPLOY_GIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    process.env.CF_PAGES_COMMIT_SHA;

  if (envValue) {
    return envValue.trim();
  }

  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function buildDeployVersion(packageVersion, gitSha) {
  if (!gitSha) {
    return packageVersion;
  }

  return `${packageVersion}+${gitSha.slice(0, 12)}`;
}

function buildDeployTag(packageVersion, gitSha) {
  return sanitizeTag(
    gitSha
      ? `oy-v${packageVersion}-${gitSha.slice(0, 12)}`
      : `oy-v${packageVersion}`,
  );
}

function buildGitShaArgs(gitSha) {
  return gitSha
    ? ["--var", `DEPLOY_GIT_SHA:${gitSha}`]
    : [];
}

function sanitizeTag(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function resolvePnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

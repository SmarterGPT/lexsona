#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveExpectedPackTarball } from "./pack-artifact-path.mjs";
import {
  calculateArtifactEvidence,
  candidateReceiptFilename,
  loadAndVerifyReleaseCandidate,
  writeCandidateReceipt,
} from "./release-candidate.mjs";
import { executeReleaseGate } from "./release-gate-runner.mjs";
import { resolveNpmInvocation } from "./run-npm.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
const packJsonPath = path.join(repoRoot, "pack.json");
const receiptPath = path.join(repoRoot, candidateReceiptFilename);

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function assertSourceIdentity(commit) {
  if (git(["rev-parse", "HEAD"]) !== commit) {
    throw new Error("Repository HEAD changed while preparing the release candidate");
  }
  if (git(["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("Release candidates must be created from a clean worktree");
  }
}

function parsePackResult(output) {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]") + 1;
  if (start === -1 || end === 0) throw new Error("Could not find JSON output from npm pack");
  return JSON.parse(output.slice(start, end));
}

const commit = git(["rev-parse", "HEAD"]);
assertSourceIdentity(commit);
const expectedTarball = resolveExpectedPackTarball(
  repoRoot,
  {
    name: packageJson.name,
    version: packageJson.version,
    filename: `${packageJson.name.replace(/^@/, "").replaceAll("/", "-")}-${packageJson.version}.tgz`,
  },
  packageJson
);
for (const generated of [packJsonPath, receiptPath, expectedTarball]) {
  fs.rmSync(generated, { force: true });
}

const npm = resolveNpmInvocation();
const lexDependency = packageLock.packages?.["node_modules/@smartergpt/lex"];
if (
  packageJson.devDependencies?.["@smartergpt/lex"] !== "4.4.4" ||
  packageJson.peerDependencies?.["@smartergpt/lex"] !== ">=4.0.1 <5" ||
  lexDependency?.version !== "4.4.4" ||
  !lexDependency.resolved?.startsWith("https://registry.npmjs.org/") ||
  !lexDependency.integrity
) {
  throw new Error("Release candidate requires exact public Lex 4.4.4 lock evidence");
}
const npmVersion = execFileSync(npm.command, [...npm.prefixArgs, "--version"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();
const definitions = [
  {
    name: "clean-release-outputs",
    command: process.execPath,
    args: [path.join(repoRoot, "scripts", "clean-release-outputs.mjs")],
    evidence: "Ignored generated package outputs were removed before compilation",
  },
  {
    name: "build",
    command: npm.command,
    args: [...npm.prefixArgs, "run", "build"],
    evidence: "Package outputs were rebuilt from the exact clean commit",
  },
  {
    name: "npm-pack",
    command: npm.command,
    args: [...npm.prefixArgs, "pack", "--ignore-scripts", "--json"],
    evidence: "npm created one retained tarball without lifecycle-script repacking",
  },
];

const gates = [];
let packOutput = "";
for (const definition of definitions) {
  const execution = executeReleaseGate({ ...definition, cwd: repoRoot, commit });
  gates.push(execution.result);
  if (execution.result.status !== "passed") {
    throw new Error(`Release candidate preparation gate failed: ${definition.name}`);
  }
  if (definition.name === "npm-pack") packOutput = execution.stdout;
  assertSourceIdentity(commit);
}

const packData = parsePackResult(packOutput);
if (packData.length !== 1) throw new Error("npm pack did not return exactly one package");
const packEntry = packData[0];
const tarballPath = resolveExpectedPackTarball(repoRoot, packEntry, packageJson);
const evidence = calculateArtifactEvidence(tarballPath);
for (const field of ["size", "shasum", "integrity"]) {
  if (evidence[field] !== packEntry[field]) {
    throw new Error(`npm pack ${field} does not match the generated tarball bytes`);
  }
}

const receipt = {
  schemaVersion: "lexsona-release-candidate-v1",
  artifactStatus: "prepared",
  acceptanceStatus: "external-required",
  package: { name: packageJson.name, version: packageJson.version },
  source: { commit, worktreeClean: true },
  environment: {
    node: process.version,
    npm: npmVersion,
    platform: process.platform,
    architecture: process.arch,
  },
  dependency: {
    lex: {
      version: lexDependency.version,
      resolved: lexDependency.resolved,
      integrity: lexDependency.integrity,
    },
  },
  artifact: {
    name: packEntry.name,
    version: packEntry.version,
    filename: packEntry.filename,
    ...evidence,
  },
  createdAt: new Date().toISOString(),
  gates,
};
fs.writeFileSync(packJsonPath, `${JSON.stringify(packData, null, 2)}\n`, "utf8");
writeCandidateReceipt(repoRoot, receiptPath, receipt);
const prepared = loadAndVerifyReleaseCandidate(repoRoot, receiptPath);
assertSourceIdentity(prepared.receipt.source.commit);
console.log(JSON.stringify(prepared.receipt, null, 2));

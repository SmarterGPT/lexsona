#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertArtifactVerified,
  assertPreparedCandidate,
  candidateReceiptFilename,
  loadAndVerifyReleaseCandidate,
  writeCandidateReceipt,
} from "./release-candidate.mjs";
import { executeReleaseGate, notRunReleaseGate } from "./release-gate-runner.mjs";
import { resolveNpmInvocation } from "./run-npm.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const receiptPath = path.join(repoRoot, candidateReceiptFilename);

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function assertSourceIdentity(receipt) {
  if (git(["rev-parse", "HEAD"]) !== receipt.source.commit) {
    throw new Error("Release candidate receipt is bound to a different commit");
  }
  if (git(["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("Release candidate verification requires a clean worktree");
  }
}

function assertPackMetadata(candidate) {
  const packData = JSON.parse(fs.readFileSync(path.join(repoRoot, "pack.json"), "utf8"));
  if (packData.length !== 1) throw new Error("pack.json must contain exactly one package");
  for (const field of ["name", "version", "filename", "size", "shasum", "integrity"]) {
    if (packData[0]?.[field] !== candidate.receipt.artifact[field]) {
      throw new Error(`pack.json ${field} is not bound to the release candidate receipt`);
    }
  }
}

const candidate = loadAndVerifyReleaseCandidate(repoRoot, receiptPath);
assertSourceIdentity(candidate.receipt);
if (process.argv.includes("--check-only")) {
  assertArtifactVerified(candidate.receipt);
  console.log(JSON.stringify(candidate.receipt, null, 2));
  process.exit(0);
}
if (candidate.receipt.artifactStatus === "verified") {
  assertArtifactVerified(candidate.receipt);
  console.log(JSON.stringify(candidate.receipt, null, 2));
  process.exit(0);
}
assertPreparedCandidate(candidate.receipt);
assertPackMetadata(candidate);

const npm = resolveNpmInvocation();
const definitions = [
  {
    name: "pack-guard",
    command: process.execPath,
    args: [path.join(repoRoot, "scripts", "pack-guard.mjs")],
    evidence: "Tarball structure and all declared export/bin artifacts validated",
  },
  {
    name: "packed-consumer-smoke",
    command: process.execPath,
    args: [path.join(repoRoot, "scripts", "consumer-smoke-test.mjs"), "--candidate", receiptPath],
    evidence: "Exact tarball and public Lex 4.4.4 installed and exercised in a disposable consumer",
  },
  {
    name: "npm-publish-dry-run",
    command: npm.command,
    args: [
      ...npm.prefixArgs,
      "publish",
      candidate.tarballPath,
      "--dry-run",
      "--access",
      "public",
      "--registry",
      "https://registry.npmjs.org/",
    ],
    evidence: "npm accepted the exact retained tarball for public publication in dry-run mode",
  },
];

const receipt = candidate.receipt;
for (let index = 0; index < definitions.length; index++) {
  const definition = definitions[index];
  const execution = executeReleaseGate({
    ...definition,
    cwd: repoRoot,
    commit: receipt.source.commit,
  });
  receipt.gates.push(execution.result);
  if (execution.result.status === "passed") {
    try {
      loadAndVerifyReleaseCandidate(repoRoot, receiptPath);
      assertSourceIdentity(receipt);
    } catch (error) {
      execution.result.status = "failed";
      execution.result.exitCode = 1;
      execution.result.error = error.message;
    }
  }
  if (execution.result.status !== "passed") {
    for (const remaining of definitions.slice(index + 1)) {
      receipt.gates.push(
        notRunReleaseGate({ ...remaining, cwd: repoRoot, commit: receipt.source.commit })
      );
    }
    receipt.artifactStatus = "failed";
    receipt.failedAt = new Date().toISOString();
    writeCandidateReceipt(repoRoot, receiptPath, receipt);
    process.exit(execution.result.exitCode ?? 1);
  }
}

receipt.artifactStatus = "verified";
receipt.verifiedAt = new Date().toISOString();
writeCandidateReceipt(repoRoot, receiptPath, receipt);
const sealed = loadAndVerifyReleaseCandidate(repoRoot, receiptPath);
assertSourceIdentity(sealed.receipt);
assertArtifactVerified(sealed.receipt);
console.log(JSON.stringify(sealed.receipt, null, 2));

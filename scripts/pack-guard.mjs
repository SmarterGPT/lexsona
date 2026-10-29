#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const packageLock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const packData = JSON.parse(fs.readFileSync("pack.json", "utf8"));
if (!Array.isArray(packData) || packData.length !== 1 || !Array.isArray(packData[0].files)) {
  throw new Error("pack.json must describe exactly one package with a file inventory");
}
const lockedLex = packageLock.packages?.["node_modules/@smartergpt/lex"];
if (
  packageJson.name !== "@smartergpt/lexsona" ||
  packageJson.engines?.node !== ">=24.0.0" ||
  packageJson.publishConfig?.access !== "public" ||
  packageJson.publishConfig?.registry !== "https://registry.npmjs.org/" ||
  packageJson.peerDependencies?.["@smartergpt/lex"] !== ">=4.0.1 <5" ||
  packageJson.devDependencies?.["@smartergpt/lex"] !== "4.4.4" ||
  lockedLex?.version !== "4.4.4" ||
  !lockedLex.resolved?.startsWith("https://registry.npmjs.org/") ||
  !lockedLex.integrity
) {
  throw new Error("Package policy or exact public Lex lock evidence is invalid");
}

const files = packData[0].files.map((entry) => entry?.path).filter(Boolean);
const tracked = new Set(
  execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean)
);
const untrackedInputs = files.filter((file) => !file.startsWith("dist/") && !tracked.has(file));
if (untrackedInputs.length) {
  throw new Error(`Tarball contains untracked static inputs: ${untrackedInputs.join(", ")}`);
}

function targets(entry) {
  if (typeof entry === "string") return [entry];
  if (entry && typeof entry === "object") return Object.values(entry).flatMap(targets);
  return [];
}
const required = [
  "LICENSE.md",
  "NOTICE.md",
  "GOVERNANCE.md",
  "BRAND.md",
  ...Object.values(packageJson.exports ?? {}).flatMap(targets),
  ...Object.values(packageJson.bin ?? {}),
].map((target) => target.replace(/^\.\//, ""));
const missing = required.filter((target) => !files.includes(target));
if (missing.length) throw new Error(`Public artifacts missing from tarball: ${missing.join(", ")}`);

const unexpected = files.filter(
  (file) =>
    !file.startsWith("dist/") &&
    !file.startsWith("personas/") &&
    ![
      "package.json",
      "README.md",
      "README.mcp.md",
      "LICENSE",
      "LICENSE.md",
      "NOTICE.md",
      "GOVERNANCE.md",
      "BRAND.md",
      "CHANGELOG.md",
    ].includes(file)
);
if (unexpected.length) throw new Error(`Unexpected files in tarball: ${unexpected.join(", ")}`);
const forbidden = files.filter(
  (file) =>
    file.endsWith(".tsbuildinfo") ||
    /^(src|tests|scripts|\.github)\//.test(file) ||
    /(^|\/)\.env($|\.)/.test(file)
);
if (forbidden.length) throw new Error(`Forbidden files in tarball: ${forbidden.join(", ")}`);

console.log(`Pack guard passed: ${files.length} files, ${new Set(required).size} public artifacts`);

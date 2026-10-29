#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { candidateReceiptFilename, loadAndVerifyReleaseCandidate } from "./release-candidate.mjs";
import { runNpm } from "./run-npm.mjs";
import { qualifyInstalledCurrentLexInChild } from "./current-lex-dependencies.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const receiptArgument = process.argv.indexOf("--candidate");
const receiptPath =
  receiptArgument >= 0
    ? process.argv[receiptArgument + 1]
    : path.join(repoRoot, candidateReceiptFilename);
if (!receiptPath) throw new Error("--candidate requires a receipt path");
const candidate = loadAndVerifyReleaseCandidate(repoRoot, receiptPath);
const sourceLock = JSON.parse(fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
const expectedLex = sourceLock.packages?.["node_modules/@smartergpt/lex"];
if (
  expectedLex?.version !== "4.4.4" ||
  !expectedLex.resolved?.startsWith("https://registry.npmjs.org/") ||
  !expectedLex.integrity
) {
  throw new Error("Source lock does not bind exact public @smartergpt/lex@4.4.4 bytes");
}
if (
  candidate.receipt.dependency.lex.version !== expectedLex.version ||
  candidate.receipt.dependency.lex.resolved !== expectedLex.resolved ||
  candidate.receipt.dependency.lex.integrity !== expectedLex.integrity
) {
  throw new Error("Candidate receipt Lex evidence does not match the reviewed source lock");
}

const consumer = fs.mkdtempSync(path.join(os.tmpdir(), "lexsona-consumer-"));
const externalCwd = fs.mkdtempSync(path.join(os.tmpdir(), "lexsona-external-cwd-"));
function run(command, args, { capture = false, cwd = consumer, env = process.env } = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}
function assertOrdinaryInstall(packageRoot, label) {
  const stat = fs.lstatSync(packageRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is linked`);
  const lexical = path.resolve(packageRoot);
  const physical = fs.realpathSync(packageRoot);
  const normalize = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  if (normalize(lexical) !== normalize(physical))
    throw new Error(`${label} resolves through a link`);
}

try {
  runNpm(["init", "--yes"], { cwd: consumer });
  runNpm(["pkg", "set", "type=module", "private=true"], { cwd: consumer });
  runNpm(
    [
      "install",
      candidate.tarballPath,
      "@smartergpt/lex@4.4.4",
      "--registry=https://registry.npmjs.org/",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: consumer }
  );

  const lexsonaRoot = path.join(consumer, "node_modules", "@smartergpt", "lexsona");
  const lexRoot = path.join(consumer, "node_modules", "@smartergpt", "lex");
  assertOrdinaryInstall(lexsonaRoot, "LexSona package root");
  assertOrdinaryInstall(lexRoot, "Lex package root");
  const lock = JSON.parse(fs.readFileSync(path.join(consumer, "package-lock.json"), "utf8"));
  const installedLex = lock.packages?.["node_modules/@smartergpt/lex"];
  const installedLexSona = lock.packages?.["node_modules/@smartergpt/lexsona"];
  if (
    installedLex?.version !== "4.4.4" ||
    installedLex.resolved !== expectedLex.resolved ||
    installedLex.integrity !== expectedLex.integrity
  ) {
    throw new Error("Consumer did not resolve the exact reviewed public Lex 4.4.4 bytes");
  }
  if (
    !installedLexSona?.resolved?.includes(candidate.receipt.artifact.filename) ||
    installedLexSona.resolved.includes("workspace:")
  ) {
    throw new Error("Consumer did not resolve LexSona from the retained tarball");
  }
  // Windows keeps a loaded .node DLL mapped until process exit. Let the child own it so
  // this cleanup-owning process can remove the disposable consumer after qualification.
  qualifyInstalledCurrentLexInChild(lexRoot, lexsonaRoot);
  const sqlitePackages = Object.entries(lock.packages ?? {}).filter(([name]) =>
    name.endsWith("node_modules/better-sqlite3-multiple-ciphers")
  );
  if (sqlitePackages.length !== 1 || sqlitePackages[0][1].version !== "13.0.3") {
    throw new Error("Packed current-train consumer did not deduplicate SQLite 13.0.3");
  }

  const smokePath = path.join(consumer, "smoke.mjs");
  fs.writeFileSync(
    smokePath,
    [
      'import { LexSona, VERSION } from "@smartergpt/lexsona";',
      'import * as rules from "@smartergpt/lexsona/rules";',
      'import * as persona from "@smartergpt/lexsona/persona";',
      'import { migratePostgresBehavioralStore } from "@smartergpt/lex/store";',
      `if (VERSION !== ${JSON.stringify(candidate.packageJson.version)}) throw new Error("version mismatch");`,
      'if (typeof LexSona !== "function" || !rules.matchScope || !persona.loadPersona || !migratePostgresBehavioralStore) throw new Error("exports missing");',
      "const instance = await LexSona.connect({});",
      'const constraints = await instance.deriveConstraints({ domain: "packed-consumer" });',
      'if (!constraints.metadata.offlineMode || constraints.metadata.rulesConsidered !== 0) throw new Error("offline derivation failed");',
      "await instance.close();",
      'console.log("LEXSONA_PACKED_IMPORTS_OK");',
    ].join("\n"),
    "utf8"
  );
  const isolatedLexDb = path.join(consumer, "isolated-lex.sqlite");
  const isolatedCache = path.join(consumer, "isolated-constraints.json");
  const smoke = run(process.execPath, [smokePath], {
    capture: true,
    env: {
      ...process.env,
      LEX_DB_PATH: isolatedLexDb,
      LEXSONA_CONSTRAINTS_CACHE_PATH: isolatedCache,
    },
  });
  if (!smoke.includes("LEXSONA_PACKED_IMPORTS_OK")) throw new Error("Runtime import smoke failed");
  if (fs.existsSync(isolatedLexDb) || fs.existsSync(isolatedCache)) {
    throw new Error("Offline packed derivation unexpectedly created storage");
  }

  const commonJsPath = path.join(consumer, "smoke.cjs");
  fs.writeFileSync(
    commonJsPath,
    'import("@smartergpt/lexsona").then((value) => { if (!value.LexSona) process.exit(1); console.log("CJS_DYNAMIC_IMPORT_OK"); });\n',
    "utf8"
  );
  const commonJs = run(process.execPath, [commonJsPath], { capture: true });
  if (!commonJs.includes("CJS_DYNAMIC_IMPORT_OK"))
    throw new Error("CommonJS dynamic import failed");

  const installedPackage = JSON.parse(
    fs.readFileSync(path.join(lexsonaRoot, "package.json"), "utf8")
  );
  const cliPath = path.join(lexsonaRoot, installedPackage.bin.lexsona.replace(/^\.\//, ""));
  const cliVersion = run(process.execPath, [cliPath, "--version"], { capture: true }).trim();
  if (cliVersion !== candidate.packageJson.version) throw new Error("Packed CLI version mismatch");
  const cliHelp = run(process.execPath, [cliPath, "--help"], { capture: true });
  if (!cliHelp.includes("Behavioral memory and persona engine")) {
    throw new Error("Packed CLI help failed");
  }
  const externalDoctor = spawnSync(process.execPath, [cliPath, "--json", "doctor"], {
    cwd: externalCwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: externalCwd,
      USERPROFILE: externalCwd,
      XDG_CONFIG_HOME: externalCwd,
      APPDATA: externalCwd,
      LOCALAPPDATA: externalCwd,
      LEX_DB_PATH: path.join(externalCwd, "missing-lex.db"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (externalDoctor.status !== 1 || externalDoctor.stderr) {
    throw new Error(
      "Packed CLI external-cwd doctor did not return the expected database-only failure"
    );
  }
  const externalReport = JSON.parse(externalDoctor.stdout);
  if (
    !externalReport.checks?.lex?.ok ||
    externalReport.checks.lex.version !== expectedLex.version ||
    externalReport.status?.issues?.some((issue) => issue.includes("Lex peer"))
  ) {
    throw new Error("Packed CLI external-cwd doctor did not resolve the reviewed Lex peer");
  }

  const typePath = path.join(consumer, "consumer.ts");
  fs.writeFileSync(
    typePath,
    [
      'import { LexSona, type ScopedLexSonaConfig } from "@smartergpt/lexsona";',
      'import { matchScope } from "@smartergpt/lexsona/rules";',
      'import { loadPersona } from "@smartergpt/lexsona/persona";',
      "void LexSona; void (null as unknown as ScopedLexSonaConfig); void matchScope; void loadPersona;",
    ].join("\n"),
    "utf8"
  );
  run(process.execPath, [
    path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
    "--noEmit",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--target",
    "ES2022",
    "--strict",
    typePath,
  ]);

  console.log("Packed consumer passed: exact public Lex, runtime exports, CLI, and declarations");
} finally {
  fs.rmSync(consumer, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(externalCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

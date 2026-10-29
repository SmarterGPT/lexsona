/**
 * CLI doctor integration tests.
 *
 * The subprocess runs from a test-owned directory with no node_modules so the
 * Lex peer check must resolve from the installed LexSona package graph rather
 * than from the caller's current working directory.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3-multiple-ciphers";

const CLI_PATH = fileURLToPath(new URL("../../dist/cli/lexsona.js", import.meta.url));

interface DoctorSandbox {
  root: string;
  project: string;
  home: string;
  config: string;
  temp: string;
  database: string;
}

let sandbox: DoctorSandbox;

function createSandbox(): DoctorSandbox {
  const root = mkdtempSync(join(tmpdir(), "lexsona-cli-doctor-"));
  const result = {
    root,
    project: join(root, "project"),
    home: join(root, "home"),
    config: join(root, "config"),
    temp: join(root, "temp"),
    database: join(root, "fixture", "lex.db"),
  };

  for (const directory of [result.project, result.home, result.config, result.temp]) {
    mkdirSync(directory, { recursive: true });
  }
  mkdirSync(join(root, "fixture"), { recursive: true });
  const database = new Database(result.database);
  database.exec("CREATE TABLE lexsona_behavior_rules (rule_id TEXT PRIMARY KEY)");
  database.close();
  return result;
}

function runCli(
  command: readonly string[],
  options: { lexDbPath?: string | null; json?: boolean } = {}
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const lexDbPath = options.lexDbPath === undefined ? sandbox.database : options.lexDbPath;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CLI_PATH, ...(options.json === false ? [] : ["--json"]), ...command],
      {
        cwd: sandbox.project,
        env: {
          ...process.env,
          HOME: sandbox.home,
          USERPROFILE: sandbox.home,
          XDG_CONFIG_HOME: sandbox.config,
          APPDATA: sandbox.config,
          LOCALAPPDATA: sandbox.config,
          TMPDIR: sandbox.temp,
          TEMP: sandbox.temp,
          TMP: sandbox.temp,
          PWD: sandbox.project,
          INIT_CWD: sandbox.project,
          ...(lexDbPath === null ? { LEX_DB_PATH: undefined } : { LEX_DB_PATH: lexDbPath }),
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
  });
}

function runDoctor(options: { lexDbPath?: string | null } = {}) {
  return runCli(["doctor"], options);
}

beforeAll(() => {
  sandbox = createSandbox();
});

afterAll(() => {
  rmSync(sandbox.root, { recursive: true, force: true });
});

describe("lexsona doctor", () => {
  it("resolves the Lex peer from LexSona's package graph outside a consumer project", async () => {
    const result = await runDoctor();
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      status: { healthy: boolean };
      checks: { lex: { version: string | null; ok: boolean } };
    };
    expect(result.code, result.stdout).toBe(0);
    expect(report.status.healthy).toBe(true);
    expect(report.checks.lex).toEqual({ version: "4.4.4", ok: true });
  });

  it("reports an absent compatibility database as optional without claiming scoped health", async () => {
    const result = await runDoctor({ lexDbPath: null });
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      status: {
        healthy: boolean;
        scope: string;
        assessment: string;
        issues: string[];
        warnings: string[];
      };
      checks: {
        database: {
          mode: string;
          removalTarget: string;
          status: string;
          explicit: boolean;
          path: string | null;
          connected: boolean;
        };
        scopedStore: { status: string; reason: string };
        activePersona: {
          state: string;
          application: { status: string };
          outcome: { status: string };
          authority: { grantsAuthority: boolean };
        };
      };
    };
    expect(result.code, result.stdout).toBe(0);
    expect(report.status.healthy).toBe(true);
    expect(report.status).toMatchObject({
      scope: "bare-cli-diagnostics",
      assessment: "partial",
    });
    expect(report.status.issues).toEqual([]);
    expect(report.status.warnings).toContain(
      "Legacy compatibility database is not configured; scoped runtime health must be verified by its trusted host"
    );
    expect(report.checks.database).toMatchObject({
      mode: "legacy-path-discovery",
      removalTarget: "3.0.0",
      status: "not-configured",
      explicit: false,
      path: null,
      connected: false,
    });
    expect(report.checks.scopedStore).toEqual({
      status: "not-assessed",
      reason: "Scoped storage requires a trusted host-provided binding",
    });
    expect(report.checks.activePersona).toMatchObject({
      state: "not-configured",
      application: { status: "not-assessed" },
      outcome: { status: "not-assessed" },
      authority: { grantsAuthority: false },
    });

    const textResult = await runCli(["doctor"], { lexDbPath: null, json: false });
    expect(textResult.code, textResult.stdout).toBe(0);
    expect(textResult.stdout).toContain("Overall (partial bare CLI diagnostics): ✓ Healthy");
    expect(textResult.stdout).toContain(
      "Scoped runtime: not assessed; verify it through the trusted host"
    );
  });

  it("fails when an explicitly selected compatibility database is missing", async () => {
    const missingPath = join(sandbox.root, "missing", "lex.db");
    const projectDatabasePath = join(sandbox.project, ".smartergpt", "lex", "lex.db");
    mkdirSync(join(sandbox.project, ".smartergpt", "lex"), { recursive: true });
    const projectDatabase = new Database(projectDatabasePath);
    projectDatabase.exec("CREATE TABLE lexsona_behavior_rules (rule_id TEXT PRIMARY KEY)");
    projectDatabase.close();
    try {
      const result = await runDoctor({ lexDbPath: missingPath });
      const report = JSON.parse(result.stdout) as {
        status: { healthy: boolean; issues: string[] };
        checks: {
          database: {
            status: string;
            explicit: boolean;
            path: string | null;
            source: string | null;
          };
        };
      };
      expect(result.code, result.stdout).toBe(1);
      expect(report.status.healthy).toBe(false);
      expect(report.status.issues).toEqual(["Legacy compatibility database Not found"]);
      expect(report.checks.database).toMatchObject({
        status: "unavailable",
        explicit: true,
        path: missingPath,
        source: "LEX_DB_PATH",
      });

      const dbStatusResult = await runCli(["db", "status"], { lexDbPath: missingPath });
      const dbStatus = JSON.parse(dbStatusResult.stdout) as {
        active: boolean;
        path: string | null;
        source: string | null;
        connection: { success: boolean; error?: string };
      };
      expect(dbStatusResult.code, dbStatusResult.stdout).toBe(0);
      expect(dbStatus).toMatchObject({
        active: false,
        path: missingPath,
        source: "LEX_DB_PATH",
        connection: { success: false },
      });
      expect(dbStatus.connection.error).toBe("Not found");
    } finally {
      rmSync(join(sandbox.project, ".smartergpt"), { recursive: true, force: true });
    }
  });

  it("does not fall through from an unusable discovered database to a valid later candidate", async () => {
    const projectDatabasePath = join(sandbox.project, ".smartergpt", "lex", "lex.db");
    const homeDatabasePath = join(sandbox.home, ".smartergpt", "lex", "lex.db");
    mkdirSync(join(sandbox.project, ".smartergpt", "lex"), { recursive: true });
    mkdirSync(join(sandbox.home, ".smartergpt", "lex"), { recursive: true });
    writeFileSync(projectDatabasePath, "not a sqlite database", "utf8");
    const homeDatabase = new Database(homeDatabasePath);
    homeDatabase.exec("CREATE TABLE lexsona_behavior_rules (rule_id TEXT PRIMARY KEY)");
    homeDatabase.close();

    try {
      const result = await runDoctor({ lexDbPath: null });
      const report = JSON.parse(result.stdout) as {
        status: { healthy: boolean; issues: string[] };
        checks: {
          database: {
            status: string;
            path: string | null;
            source: string | null;
            connected: boolean;
          };
        };
      };
      expect(result.code, result.stdout).toBe(1);
      expect(report.status.healthy).toBe(false);
      expect(report.checks.database).toMatchObject({
        status: "unavailable",
        path: projectDatabasePath,
        source: "project-local",
        connected: false,
      });
      expect(report.status.issues[0]).toContain("Legacy compatibility database");
      expect(report.checks.database.path).not.toBe(homeDatabasePath);
    } finally {
      rmSync(join(sandbox.project, ".smartergpt"), { recursive: true, force: true });
      rmSync(join(sandbox.home, ".smartergpt"), { recursive: true, force: true });
    }
  });
});

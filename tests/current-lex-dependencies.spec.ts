import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error Release tooling is plain ESM, outside the package build.
import {
  assertCurrentLexLock,
  assertInstalledCurrentLex,
  qualifyInstalledCurrentLexInChild,
} from "../scripts/current-lex-dependencies.mjs";

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));

describe("current Lex train qualification", () => {
  it("loads the shared native SQLite runtime used by Lex and LexSona", () => {
    assertCurrentLexLock(packageJson, lock);
    assertInstalledCurrentLex(path.join(root, "node_modules", "@smartergpt", "lex"), root);
  });

  it("rejects a second native binding hidden under the Lex dependency", () => {
    const drift = structuredClone(lock);
    drift.packages["node_modules/@smartergpt/lex/node_modules/better-sqlite3-multiple-ciphers"] = {
      version: "12.6.2",
    };
    expect(() => assertCurrentLexLock(packageJson, drift)).toThrow("one SQLite 13.0.3 package");
  });

  it("rejects a stale Lex lock even when the broad API peer range permits it", () => {
    const drift = structuredClone(lock);
    drift.packages["node_modules/@smartergpt/lex"].version = "4.0.3";
    expect(() => assertCurrentLexLock(packageJson, drift)).toThrow("exact public Lex 4.4.4");
  });

  it("releases a disposable consumer's native DLL before the owning process cleans it up", () => {
    const temporaryRoot = fs.realpathSync(os.tmpdir());
    const consumer = fs.mkdtempSync(path.join(temporaryRoot, "lexsona-native-child-test-"));
    try {
      const lexRoot = path.join(consumer, "node_modules", "@smartergpt", "lex");
      const sonaRoot = path.join(consumer, "node_modules", "@smartergpt", "lexsona");
      fs.mkdirSync(lexRoot, { recursive: true });
      fs.mkdirSync(sonaRoot, { recursive: true });
      fs.copyFileSync(
        path.join(root, "node_modules", "@smartergpt", "lex", "package.json"),
        path.join(lexRoot, "package.json")
      );
      fs.copyFileSync(path.join(root, "package.json"), path.join(sonaRoot, "package.json"));
      fs.cpSync(
        path.join(root, "node_modules", "better-sqlite3-multiple-ciphers"),
        path.join(consumer, "node_modules", "better-sqlite3-multiple-ciphers"),
        { recursive: true }
      );
      expect(qualifyInstalledCurrentLexInChild(lexRoot, sonaRoot)).toEqual({
        lex: "4.4.4",
        sqlite: "13.0.3",
        nativeRuntime: true,
      });
    } finally {
      const actual = fs.realpathSync(consumer);
      if (
        path.dirname(actual) !== temporaryRoot ||
        !path.basename(actual).startsWith("lexsona-native-child-test-")
      ) {
        throw new Error("Refusing cleanup outside the disposable native-child fixture");
      }
      fs.rmSync(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    expect(fs.existsSync(consumer)).toBe(false);
  });
});

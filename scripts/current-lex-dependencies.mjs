import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const currentLexVersion = "4.4.4";
export const currentSqliteVersion = "13.0.3";

export function assertCurrentLexLock(packageJson, lock) {
  const lex = lock.packages?.["node_modules/@smartergpt/lex"];
  if (
    packageJson.devDependencies?.["@smartergpt/lex"] !== currentLexVersion ||
    packageJson.dependencies?.["better-sqlite3-multiple-ciphers"] !== currentSqliteVersion ||
    lex?.version !== currentLexVersion ||
    !lex.resolved?.startsWith("https://registry.npmjs.org/") ||
    !lex.integrity
  ) {
    throw new Error(
      "Current-train qualification requires exact public Lex 4.4.4 and SQLite 13.0.3"
    );
  }
  const sqlite = Object.entries(lock.packages ?? {}).filter(([name]) =>
    name.endsWith("node_modules/better-sqlite3-multiple-ciphers")
  );
  if (sqlite.length !== 1 || sqlite[0][1].version !== currentSqliteVersion) {
    throw new Error("Current-train lock must resolve one SQLite 13.0.3 package");
  }
}

export function assertInstalledCurrentLex(lexRoot, lexsonaRoot) {
  const lex = JSON.parse(fs.readFileSync(path.join(lexRoot, "package.json"), "utf8"));
  if (lex.version !== currentLexVersion)
    throw new Error("Installed Lex is not the qualified 4.4.4");
  const lexRequire = createRequire(path.join(lexRoot, "package.json"));
  const sonaRequire = createRequire(path.join(lexsonaRoot, "package.json"));
  const lexSqlite = fs.realpathSync(
    lexRequire.resolve("better-sqlite3-multiple-ciphers/package.json")
  );
  const sonaSqlite = fs.realpathSync(
    sonaRequire.resolve("better-sqlite3-multiple-ciphers/package.json")
  );
  if (lexSqlite !== sonaSqlite)
    throw new Error("Lex and LexSona resolve different SQLite packages");
  if (JSON.parse(fs.readFileSync(lexSqlite, "utf8")).version !== currentSqliteVersion) {
    throw new Error("Installed SQLite is not the qualified 13.0.3");
  }
  const Database = sonaRequire("better-sqlite3-multiple-ciphers");
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE qualification (value TEXT NOT NULL)");
    db.prepare("INSERT INTO qualification VALUES (?)").run("current-train");
    if (db.prepare("SELECT value FROM qualification").get()?.value !== "current-train") {
      throw new Error("SQLite native runtime qualification failed");
    }
  } finally {
    db.close();
  }
}

export function qualifyInstalledCurrentLexInChild(lexRoot, lexsonaRoot) {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(import.meta.url), "--installed-consumer", lexRoot, lexsonaRoot],
    {
      cwd: lexsonaRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 65_536,
    }
  );
  const result = JSON.parse(output);
  if (
    result.lex !== currentLexVersion ||
    result.sqlite !== currentSqliteVersion ||
    result.nativeRuntime !== true
  ) {
    throw new Error("Installed-consumer child did not qualify the current native runtime");
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--installed-consumer" && process.argv.length === 5) {
    assertInstalledCurrentLex(process.argv[3], process.argv[4]);
    console.log(
      JSON.stringify({ lex: currentLexVersion, sqlite: currentSqliteVersion, nativeRuntime: true })
    );
  } else if (process.argv.length === 2) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    assertCurrentLexLock(packageJson, lock);
    assertInstalledCurrentLex(path.join(root, "node_modules", "@smartergpt", "lex"), root);
    console.log("Current train qualified: Lex 4.4.4, one SQLite 13.0.3, native runtime loaded");
  } else {
    throw new Error("Unsupported current-train qualification arguments");
  }
}

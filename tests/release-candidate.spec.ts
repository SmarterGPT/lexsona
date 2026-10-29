import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error Release tooling is intentionally plain ESM, outside the package build.
import { resolveExpectedPackTarball } from "../scripts/pack-artifact-path.mjs";
// @ts-expect-error Release tooling is intentionally plain ESM, outside the package build.
import {
  loadAndVerifyReleaseCandidate,
  writeCandidateReceipt,
} from "../scripts/release-candidate.mjs";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lexsona-release-test-"));
  temporaryRoots.push(root);
  const packageJson = { name: "@smartergpt/lexsona", version: "2.0.0" };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(packageJson));
  const filename = "smartergpt-lexsona-2.0.0.tgz";
  const bytes = Buffer.from("candidate bytes");
  fs.writeFileSync(path.join(root, filename), bytes);
  const receipt = {
    schemaVersion: "lexsona-release-candidate-v1",
    artifactStatus: "prepared",
    acceptanceStatus: "external-required",
    package: packageJson,
    source: { commit: "a".repeat(40), worktreeClean: true },
    environment: { node: "v24.14.1", npm: "11.11.0", platform: "test", architecture: "test" },
    dependency: {
      lex: {
        version: "4.4.4",
        resolved: "https://registry.npmjs.org/@smartergpt/lex/-/lex-4.4.4.tgz",
        integrity: "sha512-reviewed",
      },
    },
    artifact: {
      name: packageJson.name,
      version: packageJson.version,
      filename,
      size: bytes.length,
      shasum: createHash("sha1").update(bytes).digest("hex"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    },
    createdAt: new Date().toISOString(),
    gates: [],
  };
  const receiptPath = path.join(root, "release-candidate.json");
  writeCandidateReceipt(root, receiptPath, receipt);
  return { root, receiptPath, receipt };
}

describe("release candidate binding", () => {
  it("accepts only the exact root tarball identity", () => {
    const { root, receiptPath } = fixture();
    expect(loadAndVerifyReleaseCandidate(root, receiptPath).receipt.package.version).toBe("2.0.0");
    expect(() =>
      resolveExpectedPackTarball(
        root,
        { name: "@smartergpt/lexsona", version: "2.0.0", filename: "../escape.tgz" },
        { name: "@smartergpt/lexsona", version: "2.0.0" }
      )
    ).toThrow("unexpected package identity");
  });

  it("rejects tarball byte drift", () => {
    const { root, receiptPath, receipt } = fixture();
    fs.appendFileSync(path.join(root, receipt.artifact.filename), "tampered");
    expect(() => loadAndVerifyReleaseCandidate(root, receiptPath)).toThrow(
      "does not match the retained tarball"
    );
  });

  it("rejects receipt paths outside the repository root", () => {
    const { root, receipt } = fixture();
    expect(() =>
      writeCandidateReceipt(root, path.join(root, "nested", "receipt.json"), receipt)
    ).toThrow("repository-root receipt");
  });
});

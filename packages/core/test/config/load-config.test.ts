import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigIssueCode,
  ErrorCode,
  MAX_CONFIG_FILE_BYTES,
  PathGuard,
  loadProjectConfig,
} from "../../src/index.js";

let base: string;
let root: string;

async function writeConfig(content: string | Buffer): Promise<void> {
  await mkdir(path.join(root, ".devflow"), { recursive: true });
  await writeFile(path.join(root, ".devflow", "config.yaml"), content);
}

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "devflow-config-"));
  root = path.join(base, "workspace");
  await mkdir(root);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("loadProjectConfig", () => {
  it("uses the defaults when there is no configuration file", async () => {
    const loaded = await loadProjectConfig(await PathGuard.create(root));
    expect(loaded).toMatchObject({ exists: false, sha256: null, valid: true, issues: [] });
    expect(loaded.config?.workflow.requirePlanApproval).toBe(true);
  });

  it("parses a valid file and hashes its exact bytes", async () => {
    const text = "version: 1\nproject:\n  name: orders\nworkflow:\n  maxRepairAttempts: 1\n";
    await writeConfig(text);
    const loaded = await loadProjectConfig(await PathGuard.create(root));
    expect(loaded.valid).toBe(true);
    expect(loaded.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(loaded.config?.project.name).toBe("orders");
    expect(loaded.config?.workflow.maxRepairAttempts).toBe(1);
  });

  it("reports YAML syntax errors with line numbers", async () => {
    await writeConfig("version: 1\nproject:\n  name: [unclosed\n");
    const loaded = await loadProjectConfig(await PathGuard.create(root));
    expect(loaded.valid).toBe(false);
    expect(loaded.config).toBeUndefined();
    expect(loaded.issues[0]).toMatchObject({ code: ConfigIssueCode.ParseError, severity: "error" });
    expect(loaded.issues[0]?.line).toBeGreaterThan(0);
  });

  it("rejects keys that would grant permissions, with their line", async () => {
    await writeConfig("version: 1\nai:\n  provider: anthropic\n  apiKey: nope\n");
    const loaded = await loadProjectConfig(await PathGuard.create(root));
    expect(loaded.valid).toBe(false);
    expect(loaded.issues).toEqual([
      expect.objectContaining({ code: ConfigIssueCode.Schema, path: ["ai"], line: 4 }),
    ]);
    expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses files that cannot be used", async () => {
    await writeConfig(Buffer.from([0x76, 0x3a, 0x20, 0xff, 0xfe]));
    await expect(loadProjectConfig(await PathGuard.create(root))).rejects.toMatchObject({
      code: ErrorCode.ConfigFileUnreadable,
    });
    await writeConfig("#".repeat(MAX_CONFIG_FILE_BYTES + 1));
    await expect(loadProjectConfig(await PathGuard.create(root))).rejects.toMatchObject({
      code: ErrorCode.ConfigFileUnreadable,
    });
  });

  it("refuses a configuration that is a directory", async () => {
    await mkdir(path.join(root, ".devflow", "config.yaml"), { recursive: true });
    await expect(loadProjectConfig(await PathGuard.create(root))).rejects.toMatchObject({
      code: ErrorCode.ConfigFileUnreadable,
    });
  });

  it("refuses a configuration directory that links outside the workspace", async ({ skip }) => {
    const outside = path.join(base, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "config.yaml"), "version: 1\n");
    try {
      await symlink(
        outside,
        path.join(root, ".devflow"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      skip("cannot create directory links here");
    }
    await expect(loadProjectConfig(await PathGuard.create(root))).rejects.toMatchObject({
      code: ErrorCode.PathRejected,
    });
  });
});

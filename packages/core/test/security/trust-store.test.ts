import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErrorCode, TrustStore, defaultTrustStorePath } from "../../src/index.js";

let dir: string;
let file: string;
const clock = () => new Date("2026-11-07T12:00:00.000Z");
const ROOT = path.resolve("/work/orders");
const CONFIG_A = "a".repeat(64);
const CONFIG_B = "b".repeat(64);
const FINGERPRINT = "f".repeat(64);

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "devflow-trust-"));
  file = path.join(dir, "home", "trust.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const command = {
  fingerprint: FINGERPRINT,
  commandId: "web:test",
  summary: "pnpm test",
  approvedBy: "dev",
};

describe("TrustStore", () => {
  it("trusts nothing by default", async () => {
    const store = await TrustStore.open(file, { clock });
    expect(store.workspaceStatus(ROOT, CONFIG_A)).toBe("untrusted");
    expect(store.isCommandApproved(ROOT, CONFIG_A, FINGERPRINT)).toBe(false);
  });

  it("trusts a workspace for one configuration and persists it", async () => {
    const store = await TrustStore.open(file, { clock });
    await store.trustWorkspace(ROOT, CONFIG_A, "dev");
    expect(store.workspaceStatus(ROOT, CONFIG_A)).toBe("trusted");

    const reopened = await TrustStore.open(file, { clock });
    expect(reopened.workspaceStatus(ROOT, CONFIG_A)).toBe("trusted");
    expect(reopened.workspace(ROOT)).toMatchObject({
      root: ROOT,
      configSha256: CONFIG_A,
      trustedAt: "2026-11-07T12:00:00.000Z",
      trustedBy: "dev",
    });
  });

  it("treats a workspace without configuration as its own configuration", async () => {
    const store = await TrustStore.open(file, { clock });
    await store.trustWorkspace(ROOT, null, "dev");
    expect(store.workspaceStatus(ROOT, null)).toBe("trusted");
    expect(store.workspaceStatus(ROOT, CONFIG_A)).toBe("config-changed");
  });

  it("invalidates trust and approvals when the configuration changes", async () => {
    const store = await TrustStore.open(file, { clock });
    await store.trustWorkspace(ROOT, CONFIG_A, "dev");
    await store.approveCommand(ROOT, CONFIG_A, command);
    expect(store.isCommandApproved(ROOT, CONFIG_A, FINGERPRINT)).toBe(true);

    expect(store.workspaceStatus(ROOT, CONFIG_B)).toBe("config-changed");
    expect(store.isCommandApproved(ROOT, CONFIG_B, FINGERPRINT)).toBe(false);

    await store.trustWorkspace(ROOT, CONFIG_B, "dev");
    expect(store.isCommandApproved(ROOT, CONFIG_B, FINGERPRINT)).toBe(false);
    expect(store.workspace(ROOT)?.commands).toEqual([]);
  });

  it("keeps approvals when the same configuration is trusted again", async () => {
    const store = await TrustStore.open(file, { clock });
    await store.trustWorkspace(ROOT, CONFIG_A, "dev");
    await store.approveCommand(ROOT, CONFIG_A, command);
    await store.trustWorkspace(ROOT, CONFIG_A, "dev");
    expect(store.isCommandApproved(ROOT, CONFIG_A, FINGERPRINT)).toBe(true);
  });

  it("only approves commands in a trusted workspace", async () => {
    const store = await TrustStore.open(file, { clock });
    await expect(store.approveCommand(ROOT, CONFIG_A, command)).rejects.toMatchObject({
      code: ErrorCode.TrustStoreInvalid,
    });
  });

  it("revokes a workspace with its approvals", async () => {
    const store = await TrustStore.open(file, { clock });
    await store.trustWorkspace(ROOT, CONFIG_A, "dev");
    await store.approveCommand(ROOT, CONFIG_A, command);
    expect(await store.revokeWorkspace(ROOT)).toBe(true);
    expect(store.workspaceStatus(ROOT, CONFIG_A)).toBe("untrusted");
    expect(await store.revokeWorkspace(ROOT)).toBe(false);
  });

  it("compares workspace paths case-insensitively where the file system does", async () => {
    const store = await TrustStore.open(file, { clock, caseInsensitive: true });
    await store.trustWorkspace("C:\\Work\\Orders", CONFIG_A, "dev");
    expect(store.workspaceStatus("c:\\work\\orders", CONFIG_A)).toBe("trusted");
    const strict = await TrustStore.open(file, { clock, caseInsensitive: false });
    expect(strict.workspaceStatus("c:\\work\\orders", CONFIG_A)).toBe("untrusted");
  });

  it("refuses a corrupt or unexpected file instead of trusting anything", async () => {
    await TrustStore.open(file).then((s) => s.trustWorkspace(ROOT, CONFIG_A, "dev"));
    await writeFile(file, "{ not json");
    await expect(TrustStore.open(file)).rejects.toMatchObject({
      code: ErrorCode.TrustStoreInvalid,
    });
    await writeFile(file, JSON.stringify({ version: 2, workspaces: [] }));
    await expect(TrustStore.open(file)).rejects.toMatchObject({
      code: ErrorCode.TrustStoreInvalid,
    });
    await writeFile(file, JSON.stringify({ version: 1, workspaces: [{ root: ROOT }] }));
    await expect(TrustStore.open(file)).rejects.toMatchObject({
      code: ErrorCode.TrustStoreInvalid,
    });
  });

  it("writes a file only its owner can read", async ({ skip }) => {
    if (process.platform === "win32") skip("POSIX permissions do not apply on Windows");
    const store = await TrustStore.open(file, { clock });
    await store.trustWorkspace(ROOT, CONFIG_A, "dev");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1 });
  });
});

describe("defaultTrustStorePath", () => {
  it("uses DEVFLOW_HOME when set, the home directory otherwise", () => {
    expect(defaultTrustStorePath({ DEVFLOW_HOME: dir })).toBe(path.join(dir, "trust.json"));
    expect(defaultTrustStorePath({})).toBe(path.join(os.homedir(), ".devflow", "trust.json"));
    expect(defaultTrustStorePath({ DEVFLOW_HOME: "  " })).toBe(
      path.join(os.homedir(), ".devflow", "trust.json"),
    );
  });
});

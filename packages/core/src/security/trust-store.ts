import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DevflowError, ErrorCode } from "../errors.js";
import { IsoDateTime, Sha256 } from "../schemas/primitives.js";
import { caseInsensitiveFileSystem } from "./path-patterns.js";

/**
 * Workspace trust and command approvals (ADR 0007), stored outside every repository in
 * `~/.devflow/trust.json` (or `$DEVFLOW_HOME/trust.json`).
 *
 * - A workspace is trusted for one exact configuration: its real path plus the SHA-256 of
 *   `.devflow/config.yaml` (`null` when there is none). Editing the configuration makes the
 *   workspace untrusted again, and trusting it again drops the old command approvals.
 * - A command is approved by fingerprint (see `fingerprintCommand`), only inside a trusted
 *   workspace.
 * - A corrupt or unrecognized file is an error. Nothing is ever trusted by default.
 *
 * Writes are atomic (temporary file and rename) and the file is readable by its owner only.
 * Two DevFlow processes writing at the same moment can lose one update; that update is then
 * asked for again, so the failure mode is an extra prompt, never extra trust.
 */

const ApprovedCommandEntry = z.strictObject({
  fingerprint: Sha256,
  commandId: z.string().min(1).max(256),
  /** Human-readable argv, for `devflow trust --status`. */
  summary: z.string().max(4096),
  approvedAt: IsoDateTime,
  approvedBy: z.string().min(1).max(256),
});
export type ApprovedCommandEntry = z.infer<typeof ApprovedCommandEntry>;

const WorkspaceTrustEntry = z.strictObject({
  root: z.string().min(1),
  configSha256: Sha256.nullable(),
  trustedAt: IsoDateTime,
  trustedBy: z.string().min(1).max(256),
  commands: z.array(ApprovedCommandEntry),
});
export type WorkspaceTrustEntry = z.infer<typeof WorkspaceTrustEntry>;

const TrustFile = z.strictObject({
  version: z.literal(1),
  workspaces: z.array(WorkspaceTrustEntry),
});
type TrustFile = z.infer<typeof TrustFile>;

export type WorkspaceTrustStatus =
  /** Trusted for exactly this configuration. */
  | "trusted"
  /** Never trusted, or trust was revoked. */
  | "untrusted"
  /** Trusted earlier for a different configuration; the user must review it again. */
  | "config-changed";

/** Location of the trust store: `$DEVFLOW_HOME/trust.json`, else `~/.devflow/trust.json`. */
export function defaultTrustStorePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const home = env.DEVFLOW_HOME;
  if (home !== undefined && home.trim() !== "") return path.join(path.resolve(home), "trust.json");
  return path.join(os.homedir(), ".devflow", "trust.json");
}

export interface TrustStoreOptions {
  readonly clock?: () => Date;
  /** Overrides case sensitivity of workspace paths (tests only). */
  readonly caseInsensitive?: boolean;
}

export class TrustStore {
  readonly file: string;
  private data: TrustFile;
  private readonly clock: () => Date;
  private readonly caseInsensitive: boolean;

  private constructor(file: string, data: TrustFile, options: TrustStoreOptions) {
    this.file = file;
    this.data = data;
    this.clock = options.clock ?? (() => new Date());
    this.caseInsensitive = options.caseInsensitive ?? caseInsensitiveFileSystem();
  }

  /** Opens the store. A missing file is an empty store; an invalid file is an error. */
  static async open(file: string, options: TrustStoreOptions = {}): Promise<TrustStore> {
    return new TrustStore(file, await readTrustFile(file), options);
  }

  /** Trust status of a workspace (by real path) for a configuration hash. */
  workspaceStatus(root: string, configSha256: string | null): WorkspaceTrustStatus {
    const entry = this.find(root);
    if (entry === undefined) return "untrusted";
    return entry.configSha256 === configSha256 ? "trusted" : "config-changed";
  }

  /** The stored entry for a workspace, if any. */
  workspace(root: string): Readonly<WorkspaceTrustEntry> | undefined {
    return this.find(root);
  }

  /** Whether a command fingerprint is approved in a workspace trusted for this configuration. */
  isCommandApproved(root: string, configSha256: string | null, fingerprint: string): boolean {
    if (this.workspaceStatus(root, configSha256) !== "trusted") return false;
    return (
      this.find(root)?.commands.some((command) => command.fingerprint === fingerprint) ?? false
    );
  }

  /**
   * Trusts a workspace for one configuration. Trusting again after the configuration changed
   * removes every command approval of the old configuration.
   */
  async trustWorkspace(root: string, configSha256: string | null, by: string): Promise<void> {
    await this.update((data) => {
      const existing = this.findIn(data, root);
      const keep = existing?.configSha256 === configSha256 ? existing.commands : [];
      const entry: WorkspaceTrustEntry = {
        root,
        configSha256,
        trustedAt: this.clock().toISOString(),
        trustedBy: by,
        commands: keep,
      };
      return {
        ...data,
        workspaces: [...data.workspaces.filter((w) => !this.sameRoot(w.root, root)), entry],
      };
    });
  }

  /** Removes a workspace and all of its command approvals. Returns whether it was trusted. */
  async revokeWorkspace(root: string): Promise<boolean> {
    let removed = false;
    await this.update((data) => {
      const workspaces = data.workspaces.filter((w) => !this.sameRoot(w.root, root));
      removed = workspaces.length !== data.workspaces.length;
      return { ...data, workspaces };
    });
    return removed;
  }

  /** Records a command approval. The workspace must be trusted for this configuration. */
  async approveCommand(
    root: string,
    configSha256: string | null,
    command: Omit<ApprovedCommandEntry, "approvedAt">,
  ): Promise<void> {
    await this.update((data) => {
      const entry = this.findIn(data, root);
      if (entry?.configSha256 !== configSha256) {
        throw new DevflowError(
          ErrorCode.TrustStoreInvalid,
          "commands can only be approved in a trusted workspace",
          { details: { root } },
        );
      }
      const approved: ApprovedCommandEntry = { ...command, approvedAt: this.clock().toISOString() };
      const updated: WorkspaceTrustEntry = {
        ...entry,
        commands: [
          ...entry.commands.filter((c) => c.fingerprint !== command.fingerprint),
          approved,
        ],
      };
      return {
        ...data,
        workspaces: data.workspaces.map((w) => (this.sameRoot(w.root, root) ? updated : w)),
      };
    });
  }

  private find(root: string): WorkspaceTrustEntry | undefined {
    return this.findIn(this.data, root);
  }

  private findIn(data: TrustFile, root: string): WorkspaceTrustEntry | undefined {
    return data.workspaces.find((w) => this.sameRoot(w.root, root));
  }

  private sameRoot(a: string, b: string): boolean {
    return this.caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  /** Re-reads the file, applies a change and writes it atomically. */
  private async update(change: (data: TrustFile) => TrustFile): Promise<void> {
    const current = await readTrustFile(this.file);
    const next = TrustFile.parse(change(current));
    await writeTrustFile(this.file, next);
    this.data = next;
  }
}

async function readTrustFile(file: string): Promise<TrustFile> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workspaces: [] };
    throw new DevflowError(ErrorCode.TrustStoreInvalid, `cannot read the trust store ${file}`, {
      details: { file },
      cause: error,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new DevflowError(
      ErrorCode.TrustStoreInvalid,
      `the trust store ${file} is not valid JSON; fix or delete it (nothing is trusted meanwhile)`,
      { details: { file }, cause: error },
    );
  }
  const parsed = TrustFile.safeParse(json);
  if (!parsed.success) {
    throw new DevflowError(
      ErrorCode.TrustStoreInvalid,
      `the trust store ${file} has an unexpected format; fix or delete it (nothing is trusted meanwhile)`,
      { details: { file } },
    );
  }
  return parsed.data;
}

async function writeTrustFile(file: string, data: TrustFile): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.trust-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  if (process.platform !== "win32") await chmod(file, 0o600);
}

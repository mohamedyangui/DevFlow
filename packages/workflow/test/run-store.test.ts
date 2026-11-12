import { readdir, writeFile } from "node:fs/promises";
import { ErrorCode } from "@devflow-ai/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RunId, RunStore } from "../src/index.js";
import { workspace } from "./helpers.js";

const clock = () => new Date("2026-11-07T10:21:33.456Z");

describe("run store", () => {
  it("allocates unique ids for runs started in the same second", async () => {
    const root = await workspace({});
    const first = await RunStore.create(root, "TASK-142", { clock });
    const second = await RunStore.create(root, "TASK-142", { clock });
    expect(first.id).toBe("2026-11-07T10-21-33Z_TASK-142");
    expect(second.id).toBe("2026-11-07T10-21-33Z_TASK-142_2");
    expect(RunId.safeParse(second.id).success).toBe(true);
    expect(first.workspacePath("run.json")).toBe(
      ".devflow/runs/2026-11-07T10-21-33Z_TASK-142/run.json",
    );
    expect(await readdir(first.dir)).toEqual(expect.arrayContaining(["artifacts", "logs"]));
  });

  it("writes JSON atomically and validates it when reading", async () => {
    const root = await workspace({});
    const store = await RunStore.create(root, "TASK-1", { clock });
    const Schema = z.strictObject({ a: z.number() });
    await store.writeJson("artifacts/x.json", { a: 1 });
    expect(await store.readJson("artifacts/x.json", Schema)).toEqual({ a: 1 });
    expect(
      (await readdir(store.path("artifacts"))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);

    await writeFile(store.path("artifacts/x.json"), '{"a":"one"}');
    await expect(store.readJson("artifacts/x.json", Schema)).rejects.toMatchObject({
      code: ErrorCode.RunCorrupt,
    });
    await writeFile(store.path("artifacts/x.json"), "{");
    await expect(store.readJson("artifacts/x.json", Schema)).rejects.toMatchObject({
      code: ErrorCode.RunCorrupt,
    });
    await expect(store.readJson("artifacts/none.json", Schema)).rejects.toMatchObject({
      code: ErrorCode.RunCorrupt,
    });
    expect(await store.readJsonIfExists("artifacts/none.json", Schema)).toBeUndefined();
  });

  it("numbers events and continues the numbering when reopened", async () => {
    const root = await workspace({});
    const store = await RunStore.create(root, "TASK-1", { clock });
    await Promise.all([
      store.appendEvent({ type: "created", state: "TASK_RECEIVED" }),
      store.appendEvent({ type: "transition", state: "CONTEXT_LOADING", from: "TASK_RECEIVED" }),
    ]);
    await store.writeJson("run.json", {});
    const reopened = await RunStore.open(root, store.id, { clock });
    await reopened.appendEvent({ type: "step-started", state: "CONTEXT_LOADING", step: "x" });
    expect((await reopened.readEvents()).map((event) => event.seq)).toEqual([0, 1, 2]);

    await writeFile(store.path("events.jsonl"), '{"seq":0}\n');
    await expect(reopened.readEvents()).rejects.toMatchObject({ code: ErrorCode.RunCorrupt });
  });

  it("refuses unknown and malformed run ids", async () => {
    const root = await workspace({});
    for (const id of ["nope", "../x", "2026-11-07T10-21-33Z_TASK-1/../../x", ""]) {
      await expect(RunStore.open(root, id)).rejects.toMatchObject({ code: ErrorCode.RunNotFound });
    }
    await expect(RunStore.open(root, "2026-11-07T10-21-33Z_TASK-1")).rejects.toMatchObject({
      code: ErrorCode.RunNotFound,
    });
    expect(await RunStore.list(root)).toEqual([]);
  });

  it("holds a lock until it is released", async () => {
    const root = await workspace({});
    const store = await RunStore.create(root, "TASK-1", { clock });
    const release = await store.lock();
    // The same process taking the lock twice is a programming error, reported as locked.
    await expect(store.lock()).rejects.toMatchObject({ code: ErrorCode.RunLocked });
    await release();
    const again = await store.lock();
    await again();
    expect(await store.exists("lock.json")).toBe(false);
  });

  it("treats an unreadable lock as stale", async () => {
    const root = await workspace({});
    const store = await RunStore.create(root, "TASK-1", { clock });
    await writeFile(store.path("lock.json"), "{ half");
    const release = await store.lock();
    await release();
  });
});

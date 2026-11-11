import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "../repo/helpers.js";

/**
 * Runs the built `devflow mcp` as a real child process and speaks MCP to it over its stdin and
 * stdout, the way an MCP client launches a stdio server. It requires `pnpm build`.
 */
const bin = path.join(repoRoot, "packages", "cli", "dist", "bin.js");

beforeAll(() => {
  if (!existsSync(bin)) {
    throw new Error(`${bin} does not exist. Run \`pnpm build\` before the end-to-end tests.`);
  }
});

type Json = Record<string, unknown>;

describe("devflow mcp over stdio (built executable)", { timeout: 30_000 }, () => {
  it("initializes, lists the tools and validates an example task", async () => {
    const child = spawn(process.execPath, [bin, "mcp"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    const lines: string[] = [];
    const waiting = new Map<number, (message: Json) => void>();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        lines.push(line);
        const message = JSON.parse(line) as Json;
        waiting.get(Number(message.id))?.(message);
        newline = stdout.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    const request = (id: number, method: string, params: Json): Promise<Json> => {
      const answer = new Promise<Json>((resolve) => waiting.set(id, resolve));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return answer;
    };

    const init = await request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "e2e", version: "1" },
    });
    expect(init.result).toMatchObject({
      protocolVersion: "2025-03-26",
      serverInfo: { name: "devflow" },
      capabilities: { tools: { listChanged: false } },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );

    const listed = await request(2, "tools/list", {});
    const names = (listed.result as { tools: Json[] }).tools.map((tool) => tool.name);
    expect(names).toContain("devflow_task_validate");
    expect(names).not.toContain("devflow_approve");

    const called = await request(3, "tools/call", {
      name: "devflow_task_validate",
      arguments: { path: "examples/tasks/add-pagination.task.md" },
    });
    const result = called.result as Json;
    expect(result.isError).toBe(false);
    const text = String((result.content as Json[])[0]?.text);
    expect(text).toContain("is valid");
    expect(text).toContain('"valid": true');
    // 2025-03-26 has no structuredContent; the text carries the JSON.
    expect(result.structuredContent).toBeUndefined();

    child.stdin.end();
    expect(await exited).toBe(0);
    // stdout carried protocol messages only; the log went to stderr.
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    expect(stderr).toContain("devflow mcp: serving the DevFlow tools on stdio");
  });
});

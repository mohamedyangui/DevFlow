import {
  DevflowError,
  type EngineeringReport,
  ErrorCode,
  type Finding,
  SecretRedactor,
  type Verdict,
} from "@devflow-ai/core";
import { z } from "zod";
import { type GitHubClient, apiPath } from "./client.js";
import type { GitHubRepository } from "./repository.js";

/** Where a review is published: a pull request comment, or a check run on the head commit. */
export type PublishTarget = "comment" | "check";

export interface PublishInput {
  readonly repository: GitHubRepository;
  readonly number: number;
  /** The reviewed commit; a check run is attached to it. */
  readonly headSha: string;
  readonly report: EngineeringReport;
  /** Exact values that must never be published (tokens, keys). */
  readonly knownSecrets?: readonly string[];
}

export interface Published {
  readonly target: PublishTarget;
  readonly url: string;
}

/** The first line of every DevFlow comment, so a person or a tool can find them. */
export const COMMENT_MARKER = "<!-- devflow-review -->";
/** GitHub limits comment bodies and check run summaries to 65,536 characters. */
const MAX_BODY_CHARS = 60_000;
const MAX_TEXT_CHARS = 300;
const MAX_FINDINGS = 50;

const Created = z.object({ html_url: z.string().min(1) });

/**
 * Publishes a finished review (Phase 5, opt-in with `--publish`). The text is rendered from
 * the JSON report, every value that came from a model or a repository is neutralised
 * (mentions, HTML, links, table syntax), and the whole body is redacted again before it is
 * sent. AI findings are labelled as unverified.
 */
export async function publishReview(
  client: GitHubClient,
  target: PublishTarget,
  input: PublishInput,
  signal?: AbortSignal,
): Promise<Published> {
  if (!client.authenticated) {
    throw new DevflowError(
      ErrorCode.GitHubRequestFailed,
      "publishing needs a token: set GITHUB_TOKEN (pull-requests: write for a comment, " +
        "checks: write for a check run)",
    );
  }
  const body = new SecretRedactor({ knownSecrets: input.knownSecrets ?? [] }).redact(
    renderReview(input.report),
  ).text;
  const { owner, name } = input.repository;
  if (target === "comment") {
    const created = await client.request({
      method: "POST",
      path: apiPath("repos", owner, name, "issues", input.number, "comments"),
      body: { body },
      schema: Created,
      signal,
    });
    return { target, url: created.html_url };
  }
  const created = await client.request({
    method: "POST",
    path: apiPath("repos", owner, name, "check-runs"),
    body: {
      name: "DevFlow review",
      head_sha: input.headSha,
      status: "completed",
      conclusion: conclusionOf(input.report.verdict),
      output: { title: `Verdict: ${input.report.verdict}`, summary: body },
    },
    schema: Created,
    signal,
  });
  return { target, url: created.html_url };
}

/** The check run conclusion of a verdict: only a failed verification fails the check. */
export function conclusionOf(verdict: Verdict): "success" | "failure" | "neutral" {
  switch (verdict) {
    case "verified":
      return "success";
    case "failed_verification":
      return "failure";
    case "partially_verified":
    case "not_verified":
      return "neutral";
  }
}

/** The Markdown of a published review. */
export function renderReview(report: EngineeringReport): string {
  const lines: string[] = [COMMENT_MARKER, `## DevFlow review: ${report.verdict}`, ""];
  const head = report.run.headCommit;
  const base = report.run.baseCommit;
  lines.push(
    `**Task:** ${text(report.task.id)}: ${text(report.task.title)}` +
      (head === undefined ? "" : ` · **Head:** \`${head.slice(0, 12)}\``) +
      (base === undefined ? "" : ` · **Base:** \`${base.slice(0, 12)}\``),
    "",
  );
  lines.push(...renderEvidence(report));
  lines.push(
    "---",
    `_DevFlow AI ${text(report.run.devflowVersion)}, run \`${text(report.run.id)}\`. ` +
      "AI findings are a model's suggestions and stay unverified until a test or a person " +
      "confirms them._",
  );
  return limitBody(lines.join("\n"), "The review was cut here; the full report is in the run.");
}

/** Keeps a body within GitHub's limit. */
export function limitBody(body: string, note: string): string {
  return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n\n_${note}_` : body;
}

/**
 * The evidence sections of a published report, each followed by an empty line: acceptance
 * criteria, gates, findings (at most 50, AI findings labelled unverified) and manual checks.
 */
export function renderEvidence(report: EngineeringReport): string[] {
  const lines: string[] = [];
  if (report.acceptanceMatrix.length > 0) {
    lines.push(
      "### Acceptance criteria",
      "",
      "| Criterion | Status | Tests |",
      "| --- | --- | --- |",
    );
    for (const row of report.acceptanceMatrix) {
      const counts = new Map<string, number>();
      for (const test of row.tests) counts.set(test.status, (counts.get(test.status) ?? 0) + 1);
      const tests =
        [...counts].map(([status, count]) => `${String(count)} ${status}`).join(", ") || "none";
      lines.push(`| ${row.acId} | ${row.status} | ${tests} |`);
    }
    lines.push("");
  }

  lines.push("### Gates", "");
  if (report.gates.length === 0) {
    lines.push("No gate ran.", "");
  } else {
    lines.push("| Gate | Required | Status |", "| --- | --- | --- |");
    for (const gate of report.gates) {
      lines.push(`| ${text(gate.gateId)} | ${gate.required ? "yes" : "no"} | ${gate.status} |`);
    }
    lines.push("");
  }

  const deterministic = report.findings.filter((finding) => finding.source === "deterministic");
  const ai = report.findings.filter((finding) => finding.source === "ai");
  // Evidence-seeking review (ADR 0025): an AI finding a probe test confirmed is not a suggestion.
  const probed = ai.filter((finding) => finding.verification === "confirmed");
  const suggested = ai.filter((finding) => finding.verification !== "confirmed");
  let budget = MAX_FINDINGS;
  for (const [title, findings] of [
    ["Deterministic findings", deterministic],
    ["AI findings confirmed by a probe test", probed],
    ["AI findings (unverified suggestions)", suggested],
  ] as const) {
    if (findings.length === 0) continue;
    lines.push(`### ${title} (${String(findings.length)})`, "");
    for (const finding of findings) {
      if (budget === 0) break;
      budget -= 1;
      lines.push(...renderFinding(finding));
    }
    lines.push("");
  }
  if (budget === 0 && report.findings.length > MAX_FINDINGS) {
    lines.push(
      `_${String(report.findings.length - MAX_FINDINGS)} more findings are in the full report._`,
      "",
    );
  }

  if (report.manualChecks.length > 0) {
    lines.push("### Manual checks", "");
    for (const check of report.manualChecks) lines.push(`- ${text(check)}`);
    lines.push("");
  }
  return lines;
}

function renderFinding(finding: Finding): string[] {
  const where =
    finding.location === undefined
      ? ""
      : ` · \`${text(finding.location.path)}${finding.location.line === undefined ? "" : `:${String(finding.location.line)}`}\``;
  const confidence =
    finding.confidence === undefined
      ? ""
      : ` · confidence ${String(Math.round(finding.confidence * 100))}%`;
  return [
    `- **[${finding.severity}] ${text(finding.id)}: ${text(finding.title)}** · ${finding.category} · ` +
      `${finding.verification}${confidence}${where}`,
    `  ${text(finding.recommendation)}`,
  ];
}

/**
 * Neutralises text that came from a model or a repository: no mentions or team pings, no HTML,
 * no images or links, no code spans that could break the layout, one line, a length limit.
 */
export function neutralise(value: string): string {
  return text(value);
}

function text(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  const short = flat.length > MAX_TEXT_CHARS ? `${flat.slice(0, MAX_TEXT_CHARS - 1)}…` : flat;
  return short
    .replace(/[\\`*_[\]<>!|]/g, (char) => `\\${char}`)
    .replace(/@(?=[A-Za-z0-9])/g, "@​")
    .replace(/:\/\//g, ":​//");
}

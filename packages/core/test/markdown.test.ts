import { describe, expect, it } from "vitest";
import { TaskIssueCode, parseMarkdownTask, parseTaskText, type TaskSource } from "../src/index.js";

const source: TaskSource = { kind: "file", ref: "task.md", trust: "user" };

const md = (lines: string[]): string => lines.join("\n");

describe("parseMarkdownTask", () => {
  it("reads the title from the first H1 and the description from the preamble", () => {
    const result = parseMarkdownTask(
      md(["---", "id: T-1", "---", "# My task", "", "Some context.", "", "More context."]),
    );
    expect(result.data).toMatchObject({
      id: "T-1",
      title: "My task",
      description: "Some context.\n\nMore context.",
    });
    expect(result.issues).toEqual([]);
  });

  it.each([
    ["AC-1: Text", "AC-1", "Text"],
    ["**AC-1**: Text", "AC-1", "Text"],
    ["**AC-1:** Text", "AC-1", "Text"],
    ["AC-1 - Text", "AC-1", "Text"],
    ["[ ] AC-1 Text", "AC-1", "Text"],
    ["[x] **AC-1** — Text", "AC-1", "Text"],
    ["Text without id", undefined, "Text without id"],
  ])("parses the item head %j", (item, id, statement) => {
    const result = parseMarkdownTask(md(["## Acceptance Criteria", `- ${item}`]));
    const [ac] = result.data.acceptanceCriteria as Record<string, unknown>[];
    expect(ac?.id).toBe(id);
    expect(ac?.statement).toBe(statement);
  });

  it("parses trailing coverage and tags, and nested Given/When/Then bullets", () => {
    const result = parseMarkdownTask(
      md([
        "## Acceptance Criteria",
        "- AC-1: Paging (covers: FR-1, FR-2) (integration, regression)",
        "  - Given 25 orders exist",
        "  - And the user is signed in",
        "  - When page 2 is requested",
        "  - Then orders 11 to 20 are returned",
        "- AC-2: Checked by a person (manual)",
      ]),
    );
    expect(result.data.acceptanceCriteria).toEqual([
      {
        id: "AC-1",
        statement: "Paging",
        covers: ["FR-1", "FR-2"],
        testLevel: "integration",
        testIntent: "regression",
        given: "25 orders exist and the user is signed in",
        when: "page 2 is requested",
        then: "orders 11 to 20 are returned",
      },
      { id: "AC-2", statement: "Checked by a person", verification: "manual" },
    ]);
  });

  it("keeps parenthesised text that is not a known tag", () => {
    const result = parseMarkdownTask(
      md(["## Acceptance Criteria", "- Totals are rounded (HALF_UP)"]),
    );
    expect(result.data.acceptanceCriteria).toEqual([{ statement: "Totals are rounded (HALF_UP)" }]);
  });

  it("joins continuation lines into the current item", () => {
    const result = parseMarkdownTask(
      md(["## Constraints", "- Do not change the", "  public API.", "- Keep it small."]),
    );
    expect(result.data.constraints).toEqual(["Do not change the public API.", "Keep it small."]);
  });

  it("routes requirements by id prefix and by sub-heading, with NFR categories", () => {
    const result = parseMarkdownTask(
      md([
        "## Requirements",
        "- FR-1: Paging",
        "- NFR-1 [performance]: Fast",
        "### Non-functional",
        "- Secure by default",
      ]),
    );
    expect(result.data.requirements).toEqual({
      functional: [{ id: "FR-1", text: "Paging" }],
      nonFunctional: [
        { id: "NFR-1", category: "performance", text: "Fast" },
        { text: "Secure by default" },
      ],
    });
  });

  it("appends unknown sections to the description instead of dropping them", () => {
    const result = parseMarkdownTask(
      md(["# T", "## Background", "Legacy system.", "## Constraints", "- c"]),
    );
    expect(result.data.description).toBe("## Background\nLegacy system.");
    expect(result.data.constraints).toEqual(["c"]);
  });

  it("ignores headings and bullets inside fenced code blocks", () => {
    const result = parseMarkdownTask(
      md(["# T", "```md", "## Acceptance Criteria", "- not an AC", "```"]),
    );
    expect(result.data.acceptanceCriteria).toBeUndefined();
    expect(result.data.description).toContain("- not an AC");
  });

  it("warns, with a line number, about prose it cannot place in a list section", () => {
    const result = parseMarkdownTask(
      md(["## Acceptance Criteria", "- AC-1: ok", "", "This paragraph is ambiguous."]),
    );
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: TaskIssueCode.MarkdownUnparsedText,
        line: 4,
      }),
    ]);
  });

  it("reports fields defined in both the front matter and the body", () => {
    const result = parseMarkdownTask(
      md(["---", "constraints: [a]", "---", "## Constraints", "- b"]),
    );
    expect(result.issues).toEqual([
      expect.objectContaining({ severity: "error", code: TaskIssueCode.MarkdownConflict, line: 4 }),
    ]);
  });

  it("reports unclosed front matter", () => {
    const result = parseMarkdownTask(md(["---", "id: T-1", "# Title"]));
    expect(result.issues[0]?.code).toBe(TaskIssueCode.MarkdownFrontMatter);
  });

  it("reports front matter syntax errors at the file line", () => {
    const result = parseMarkdownTask(md(["---", "id: T-1", "id: T-2", "---", "# T"]));
    expect(result.issues[0]).toMatchObject({ code: TaskIssueCode.ParseError, line: 3 });
  });

  it("maps paths to body and front matter lines", () => {
    const result = parseMarkdownTask(
      md([
        "---",
        "id: T-1",
        "scope:",
        "  modules: [api]",
        "---",
        "# T",
        "## Acceptance Criteria",
        "- a",
        "- b",
      ]),
    );
    expect(result.lineOf(["acceptanceCriteria", 1, "covers", 0])).toBe(9);
    expect(result.lineOf(["scope", "modules", 0])).toBe(4);
    expect(result.lineOf(["id"])).toBe(2);
  });

  it("handles Windows line endings", () => {
    const result = parseMarkdownTask("---\r\nid: T-1\r\n---\r\n# T\r\n## Constraints\r\n- c\r\n");
    expect(result.data).toMatchObject({ id: "T-1", title: "T", constraints: ["c"] });
  });
});

describe("parseTaskText (markdown)", () => {
  it("validates the parsed document and attaches line numbers to schema issues", () => {
    const result = parseTaskText(
      md([
        "---",
        "id: T-1",
        "---",
        "# T",
        "## Acceptance Criteria",
        "- AC-1: ok",
        "- ACX-2: bad (covers: FR1)",
      ]),
      "markdown",
      source,
    );
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: TaskIssueCode.Schema,
        path: ["acceptanceCriteria", 1, "covers", 0],
        line: 7,
      }),
    ]);
  });
});

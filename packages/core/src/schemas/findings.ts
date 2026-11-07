import { z } from "zod";
import { Confidence, Evidence, SourceLocation } from "./primitives.js";

export const Severity = z.enum(["critical", "high", "medium", "low", "info"]);
export type Severity = z.infer<typeof Severity>;

/**
 * A review finding. Deterministic findings come from tools and rules; AI findings come from a
 * model. An AI finding may only be `confirmed` when deterministic evidence is attached (for
 * example a failing test that demonstrates the suspected defect).
 */
export const Finding = z
  .strictObject({
    id: z.string().min(1),
    title: z.string().min(1),
    severity: Severity,
    category: z.enum([
      "requirement",
      "regression",
      "test-gap",
      "test-fidelity",
      "convention",
      "security",
      "compatibility",
      "scope",
      "quality",
    ]),
    source: z.enum(["deterministic", "ai"]),
    verification: z.enum(["confirmed", "unverified", "refuted"]),
    confidence: Confidence.optional(),
    evidence: z.array(Evidence),
    location: SourceLocation.optional(),
    recommendation: z.string().min(1),
  })
  .superRefine((finding, ctx) => {
    const hasDeterministicEvidence = finding.evidence.some((e) => e.deterministic);
    if (finding.verification === "confirmed" && !hasDeterministicEvidence) {
      ctx.addIssue({
        code: "custom",
        path: ["verification"],
        message: "a finding can only be confirmed with deterministic evidence",
      });
    }
    if (finding.source === "ai" && finding.confidence === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["confidence"],
        message: "AI findings must state a confidence",
      });
    }
  });
export type Finding = z.infer<typeof Finding>;

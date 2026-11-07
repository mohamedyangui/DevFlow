import { createHash } from "node:crypto";

/**
 * Secret detection and redaction (docs/specs/security-model.md, section 7).
 *
 * Every piece of text that leaves DevFlow's process boundary towards a model, a log, the audit
 * trail or a report goes through a {@link SecretRedactor}. A detected value is replaced with a
 * marker such as `«REDACTED:github-token:3f2a»`, where the suffix is the first four hex digits of
 * the value's SHA-256. Repeated occurrences of the same value can be correlated; the value
 * itself is never written anywhere.
 *
 * Detection is heuristic. It covers well-known token formats, private keys, JWTs, credentials
 * in URLs, high-entropy values assigned to secret-looking names, and the exact values of
 * credential-like environment variables of the current process. Unknown formats can slip
 * through; this is a stated residual risk.
 */

/** A span of text that a detector identified as secret. */
export interface SecretMatch {
  readonly start: number;
  readonly end: number;
}

export interface SecretDetector {
  /** Stable identifier used in redaction markers and audit entries, e.g. `github-token`. */
  readonly id: string;
  readonly description: string;
  find(text: string): Iterable<SecretMatch>;
}

/** Where a value was redacted. Never contains the value. */
export interface Redaction {
  readonly detector: string;
  /** 1-based line and column of the start of the redacted value in the original text. */
  readonly line: number;
  readonly column: number;
  /** First four hex digits of the SHA-256 of the value. */
  readonly hash: string;
}

export interface RedactionResult {
  readonly text: string;
  readonly redactions: readonly Redaction[];
}

/** Names of environment variables whose values are treated as secrets. */
export const CREDENTIAL_ENV_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH)/i;

const MARKER_PREFIX = "«REDACTED:";

/** The marker that replaces a secret value. */
export function redactionMarker(detector: string, value: string): string {
  return `${MARKER_PREFIX}${detector}:${shortHash(value)}»`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 4);
}

/** Builds a detector from a global regular expression. A `secret` named group narrows the span. */
function regexDetector(
  id: string,
  description: string,
  source: RegExp,
  accept: (value: string) => boolean = () => true,
): SecretDetector {
  const flags = source.flags.includes("g") ? source.flags : `${source.flags}g`;
  return {
    id,
    description,
    *find(text) {
      const pattern = new RegExp(source.source, flags);
      for (const match of text.matchAll(pattern)) {
        const whole = match[0];
        const secret = match.groups?.secret;
        const index = match.index;
        if (secret === undefined) {
          if (accept(whole)) yield { start: index, end: index + whole.length };
          continue;
        }
        if (!accept(secret)) continue;
        // The named group is always the last part of these patterns, so it ends where the match ends.
        const end = index + whole.length;
        yield { start: end - secret.length, end };
      }
    },
  };
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  let length = 0;
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
    length += 1;
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const PLACEHOLDER_VALUE =
  /^(?:\$\{.*\}|\$[A-Za-z_][A-Za-z0-9_]*|\{\{.*\}\}|<[^>]*>|%\(.*\)s?|\*+|x+|changeme|change_me|password|secret|token|example|redacted|null|none|undefined|true|false)$/i;
/** Dotted references (`config.db.password`) and calls (`createTokenizer(options)`) are code. */
const CODE_REFERENCE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$|^[A-Za-z_$][\w$.]*\(/;

/** Accepts a value assigned to a secret-looking name only if it looks like a real secret. */
function looksLikeSecretValue(value: string): boolean {
  if (value.startsWith(MARKER_PREFIX)) return false;
  if (PLACEHOLDER_VALUE.test(value)) return false;
  if (CODE_REFERENCE.test(value)) return false;
  return shannonEntropy(value) >= 3;
}

const PRIVATE_KEY_BEGIN = "-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----";
const PRIVATE_KEY_END = "-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----";
const MAX_KEY_LENGTH = 65_536;

/**
 * Private keys in PEM, OpenSSH and PGP armour. The whole block is redacted up to its END line;
 * without an END line, the header and the following base64-looking lines are redacted.
 */
const privateKeyDetector: SecretDetector = {
  id: "private-key",
  description: "PEM, OpenSSH or PGP private key",
  *find(text) {
    const endPattern = new RegExp(PRIVATE_KEY_END, "g");
    for (const begin of text.matchAll(new RegExp(PRIVATE_KEY_BEGIN, "g"))) {
      const start = begin.index;
      endPattern.lastIndex = start;
      const end = endPattern.exec(text);
      if (end !== null && end.index - start <= MAX_KEY_LENGTH) {
        yield { start, end: end.index + end[0].length };
        continue;
      }
      let cursor = start + begin[0].length;
      const body = /\r?\n[A-Za-z0-9+/=:. -]*/y;
      for (;;) {
        body.lastIndex = cursor;
        const line = body.exec(text);
        if (line === null || line[0].trim().length === 0 || cursor - start > MAX_KEY_LENGTH) break;
        cursor += line[0].length;
      }
      yield { start, end: cursor };
    }
  },
};

/** The built-in detectors, most specific first. */
export const BUILT_IN_SECRET_DETECTORS: readonly SecretDetector[] = [
  privateKeyDetector,
  regexDetector(
    "github-token",
    "GitHub personal access, OAuth, app or refresh token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/,
  ),
  regexDetector("gitlab-token", "GitLab personal access token", /\bglpat-[A-Za-z0-9_-]{20,255}/),
  regexDetector("anthropic-api-key", "Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,255}/),
  regexDetector(
    "openai-api-key",
    "OpenAI API key",
    /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,255}/,
  ),
  regexDetector(
    "aws-access-key-id",
    "AWS access key id",
    /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/,
  ),
  regexDetector(
    "aws-secret-access-key",
    "AWS secret access key",
    /aws_?secret_?access_?key["']?\s{0,5}[:=]\s{0,5}["']?(?<secret>[A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/i,
  ),
  regexDetector("google-api-key", "Google API key", /\bAIza[0-9A-Za-z_-]{35}/),
  regexDetector("slack-token", "Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,255}/),
  regexDetector(
    "slack-webhook",
    "Slack incoming webhook URL",
    /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,255}/,
  ),
  regexDetector(
    "stripe-key",
    "Stripe secret or restricted key",
    /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,255}\b/,
  ),
  regexDetector("npm-token", "npm access token", /\bnpm_[A-Za-z0-9]{36}\b/),
  regexDetector(
    "jwt",
    "JSON Web Token",
    /\beyJ[A-Za-z0-9_-]{8,4096}\.eyJ[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{0,4096}/,
  ),
  regexDetector(
    "url-credentials",
    "password embedded in a URL or connection string",
    /\b[A-Za-z][A-Za-z0-9+.-]{1,30}:\/\/[^\s:/@]{1,256}:(?<secret>[^\s@/]{1,256})(?=@)/,
    (value) => !value.startsWith(MARKER_PREFIX),
  ),
  regexDetector(
    "connection-string-key",
    "account key or password in a connection string",
    /\b(?:AccountKey|SharedAccessKey|Password|Pwd)=(?<secret>[^;\s"']{8,512})/i,
    (value) => !value.startsWith(MARKER_PREFIX) && !PLACEHOLDER_VALUE.test(value),
  ),
  regexDetector(
    "secret-assignment",
    "high-entropy value assigned to a secret-looking name",
    /(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]{0,20}["']?\s{0,5}[:=]\s{0,5}["']?(?<secret>[^\s"'`,;«»]{8,512})/i,
    looksLikeSecretValue,
  ),
];

export interface SecretRedactorOptions {
  /** Detectors to use. Defaults to {@link BUILT_IN_SECRET_DETECTORS}. */
  readonly detectors?: readonly SecretDetector[];
  /**
   * Exact values that must never appear in output, such as the values of credential-like
   * environment variables. Values shorter than 8 characters are ignored to avoid redacting
   * common words.
   */
  readonly knownSecrets?: readonly string[];
}

/**
 * Collects the values of credential-like environment variables (for example
 * `ANTHROPIC_API_KEY`), so that they are redacted even when they have no recognizable format.
 */
export function credentialValuesFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return Object.entries(env)
    .filter(([name, value]) => value !== undefined && CREDENTIAL_ENV_NAME.test(name))
    .map(([, value]) => value ?? "")
    .filter((value) => value.length >= 8);
}

export class SecretRedactor {
  private readonly detectors: readonly SecretDetector[];

  constructor(options: SecretRedactorOptions = {}) {
    const known = [...new Set(options.knownSecrets ?? [])]
      .filter((value) => value.length >= 8)
      .sort((a, b) => b.length - a.length);
    const knownDetector: SecretDetector = {
      id: "known-secret",
      description: "value of a credential-like environment variable",
      *find(text) {
        for (const value of known) {
          let index = text.indexOf(value);
          while (index !== -1) {
            yield { start: index, end: index + value.length };
            index = text.indexOf(value, index + value.length);
          }
        }
      },
    };
    this.detectors = [knownDetector, ...(options.detectors ?? BUILT_IN_SECRET_DETECTORS)];
  }

  /** Replaces every detected secret in `text` with a redaction marker. */
  redact(text: string): RedactionResult {
    const spans: { start: number; end: number; detector: string }[] = [];
    for (const detector of this.detectors) {
      for (const match of detector.find(text)) {
        if (match.end > match.start) spans.push({ ...match, detector: detector.id });
      }
    }
    if (spans.length === 0) return { text, redactions: [] };

    // Earliest first; for equal starts the longest first. Overlapping spans are merged so a
    // value is never partly disclosed.
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: { start: number; end: number; detector: string }[] = [];
    for (const span of spans) {
      const last = merged.at(-1);
      if (last !== undefined && span.start < last.end) {
        last.end = Math.max(last.end, span.end);
      } else {
        merged.push({ ...span });
      }
    }

    const lineStarts = lineStartIndexes(text);
    const parts: string[] = [];
    const redactions: Redaction[] = [];
    let cursor = 0;
    for (const span of merged) {
      const value = text.slice(span.start, span.end);
      parts.push(text.slice(cursor, span.start), redactionMarker(span.detector, value));
      const { line, column } = position(lineStarts, span.start);
      redactions.push({ detector: span.detector, line, column, hash: shortHash(value) });
      cursor = span.end;
    }
    parts.push(text.slice(cursor));
    return { text: parts.join(""), redactions };
  }

  /** Redacts and returns only the text. */
  redactText(text: string): string {
    return this.redact(text).text;
  }

  /**
   * Returns a deep copy of a JSON-like value with every string redacted, object keys included.
   * Used for audit entries and reports.
   */
  redactValue<T>(value: T): T {
    return this.redactUnknown(value) as T;
  }

  private redactUnknown(value: unknown): unknown {
    if (typeof value === "string") return this.redactText(value);
    if (Array.isArray(value)) return value.map((item: unknown) => this.redactUnknown(item));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          this.redactText(key),
          this.redactUnknown(item),
        ]),
      );
    }
    return value;
  }
}

function lineStartIndexes(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function position(lineStarts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((lineStarts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - (lineStarts[low] ?? 0) + 1 };
}

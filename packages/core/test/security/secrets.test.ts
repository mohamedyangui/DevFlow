import { describe, expect, it } from "vitest";
import {
  SecretRedactor,
  credentialValuesFromEnv,
  redactionMarker,
  shannonEntropy,
} from "../../src/index.js";

/**
 * Corpus of fake secrets. Every value is assembled at runtime from pieces, so this file never
 * contains a literal that secret scanners (including GitHub push protection) would flag.
 */
const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function fake(length: number, alphabet = ALPHANUMERIC, seed = 7): string {
  let state = seed;
  let out = "";
  for (let i = 0; i < length; i += 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    out += alphabet.charAt(state % alphabet.length);
  }
  return out;
}

const join = (...parts: string[]): string => parts.join("");

const corpus: [detector: string, secret: string, context: (secret: string) => string][] = [
  ["github-token", join("gh", "p_", fake(36)), (s) => `export GH_PAT=${s}`],
  ["github-token", join("gh", "s_", fake(36, ALPHANUMERIC, 3)), (s) => `Authorization: token ${s}`],
  [
    "github-token",
    join("github", "_pat_", fake(22), "_", fake(59, ALPHANUMERIC, 5)),
    (s) => `pat ${s}`,
  ],
  ["gitlab-token", join("gl", "pat-", fake(20)), (s) => `token=${s} `],
  [
    "anthropic-api-key",
    join("sk", "-ant-", "api03-", fake(93, `${ALPHANUMERIC}_-`)),
    (s) => `key: ${s}`,
  ],
  ["openai-api-key", join("sk", "-proj-", fake(48, `${ALPHANUMERIC}_-`)), (s) => `OPENAI ${s}`],
  [
    "aws-access-key-id",
    join("AK", "IA", fake(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")),
    (s) => `id ${s}.`,
  ],
  [
    "aws-secret-access-key",
    fake(40, `${ALPHANUMERIC}/+`, 11),
    (s) => `aws_secret_access_key = ${s}\nregion = eu-west-1`,
  ],
  ["google-api-key", join("AI", "za", fake(35, `${ALPHANUMERIC}_-`)), (s) => `key=${s}`],
  ["slack-token", join("xo", "xb-", fake(12, "0123456789"), "-", fake(24)), (s) => `SLACK ${s}`],
  [
    "slack-webhook",
    join("https://hooks.", "slack.com/services/T", fake(10), "/B", fake(10), "/", fake(24)),
    (s) => `url: ${s}`,
  ],
  ["stripe-key", join("sk", "_live_", fake(24)), (s) => `stripe(${s})`],
  ["npm-token", join("np", "m_", fake(36)), (s) => `//registry.npmjs.org/:_authToken=${s}`],
  [
    "jwt",
    join(
      "ey",
      "JhbGciOiJIUzI1NiJ9.",
      "ey",
      "JzdWIiOiIxMjM0NTY3ODkwIn0.",
      fake(43, `${ALPHANUMERIC}_-`),
    ),
    (s) => `Bearer ${s}`,
  ],
  [
    "url-credentials",
    fake(16, ALPHANUMERIC, 13),
    (s) => `postgres://app:${s}@db.internal:5432/orders`,
  ],
  [
    "connection-string-key",
    `${fake(40, ALPHANUMERIC, 17)}==`,
    (s) => `DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=${s};EndpointSuffix=core`,
  ],
  ["secret-assignment", fake(24, `${ALPHANUMERIC}!#%`, 19), (s) => `DB_PASSWORD=${s}`],
  ["secret-assignment", fake(32, ALPHANUMERIC, 23), (s) => `{"clientSecret": "${s}"}`],
  ["secret-assignment", fake(28, ALPHANUMERIC, 29), (s) => `api_key: '${s}'`],
];

const PRIVATE_KEY_LABEL = join("PRIVATE", " KEY");

function privateKey(kind: string, lines = 6): string {
  const body = Array.from({ length: lines }, (_, i) => fake(64, `${ALPHANUMERIC}+/`, 31 + i));
  return [
    `-----BEGIN ${kind}${PRIVATE_KEY_LABEL}-----`,
    ...body,
    `-----END ${kind}${PRIVATE_KEY_LABEL}-----`,
  ].join("\n");
}

describe("SecretRedactor: corpus", () => {
  const redactor = new SecretRedactor();

  it.each(corpus)("detects and redacts %s", (detector, secret, context) => {
    const text = context(secret);
    const result = redactor.redact(text);
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain(redactionMarker(detector, secret));
    expect(result.redactions.map((r) => r.detector)).toContain(detector);
  });

  it.each(["RSA ", "EC ", "OPENSSH ", "ENCRYPTED ", ""])(
    "redacts a whole %sprivate key block",
    (kind) => {
      const key = privateKey(kind);
      const text = `before\n${key}\nafter: keep me`;
      const result = redactor.redact(text);
      expect(result.text).toBe(`before\n${redactionMarker("private-key", key)}\nafter: keep me`);
    },
  );

  it("redacts a truncated private key without disclosing its body", () => {
    const key = privateKey("RSA ").split("\n").slice(0, 4).join("\n");
    const result = redactor.redact(`${key}\n\nnext paragraph stays`);
    expect(result.text).not.toContain(key.split("\n")[2]);
    expect(result.text.endsWith("\n\nnext paragraph stays")).toBe(true);
  });

  it("redacts every occurrence and correlates repeats through the hash", () => {
    const token = corpus[0]?.[1] ?? "";
    const result = redactor.redact(`${token} and again ${token}`);
    const marker = redactionMarker("github-token", token);
    expect(result.text).toBe(`${marker} and again ${marker}`);
    expect(result.redactions).toHaveLength(2);
    expect(result.redactions[0]?.hash).toBe(result.redactions[1]?.hash);
    expect(marker).toMatch(/^«REDACTED:github-token:[0-9a-f]{4}»$/);
  });

  it("reports 1-based line and column of each redaction", () => {
    const token = corpus[0]?.[1] ?? "";
    const result = redactor.redact(`line one\n  value ${token}\n`);
    expect(result.redactions).toHaveLength(1);
    expect(result.redactions[0]).toMatchObject({ detector: "github-token", line: 2, column: 9 });
    expect(result.redactions[0]?.hash).toMatch(/^[0-9a-f]{4}$/);
  });

  it("is idempotent", () => {
    const text = corpus.map(([, secret, context]) => context(secret)).join("\n");
    const once = redactor.redactText(text);
    expect(redactor.redactText(once)).toBe(once);
  });
});

describe("SecretRedactor: no false positives on ordinary content", () => {
  const redactor = new SecretRedactor();

  it.each([
    "const password = config.database.password;",
    'password: "${DB_PASSWORD}"',
    "token: <your-token-here>",
    "api_key = changeme",
    "secret: xxxxxxxxxxxx",
    'if (token === undefined) throw new Error("missing token");',
    "const tokenizer = createTokenizer(options);",
    "password_hash = bcrypt(password, rounds)",
    "See https://docs.example.com/guide#section for details.",
    "postgres://localhost:5432/orders",
    "commit 3f2a9c1b8e7d6f5a4b3c2d1e0f9a8b7c6d5e4f3a",
    "sha256: 0123456789abcdef",
    "The skip-list implementation is in sk-structures.ts",
    '@Value("${app.secret}") private String secret;',
  ])("leaves %j unchanged", (text) => {
    expect(redactor.redact(text)).toEqual({ text, redactions: [] });
  });
});

describe("SecretRedactor: known secret values", () => {
  it("redacts the exact values of credential-like environment variables", () => {
    const value = `plain-${fake(12)}`;
    const env = { MY_SERVICE_TOKEN: value, HOME: "/home/user", SHORT_SECRET: "abc", PATH: "/bin" };
    expect(credentialValuesFromEnv(env)).toEqual([value]);
    const redactor = new SecretRedactor({ knownSecrets: credentialValuesFromEnv(env) });
    const result = redactor.redact(`test output: connecting with ${value}...`);
    expect(result.text).toBe(
      `test output: connecting with ${redactionMarker("known-secret", value)}...`,
    );
  });
});

describe("SecretRedactor: structured values", () => {
  it("redacts strings deep inside objects and arrays, keys included", () => {
    const token = corpus[0]?.[1] ?? "";
    const redactor = new SecretRedactor();
    const value = { argv: ["git", `--token=${token}`], nested: { [token]: 3, count: 2, ok: true } };
    const redacted = redactor.redactValue(value);
    expect(JSON.stringify(redacted)).not.toContain(token);
    expect(redacted.nested.count).toBe(2);
    expect(redacted.nested.ok).toBe(true);
    expect(value.argv[1]).toContain(token);
  });
});

describe("SecretRedactor: performance", () => {
  it("redacts 5 MB of command output in well under the command timeout", () => {
    const token = corpus[0]?.[1] ?? "";
    const line = "  at com.example.orders.OrderService.list(OrderService.java:42) password ok\n";
    const text = `${line.repeat(Math.ceil(5_000_000 / line.length))}${token}\n`;
    const redactor = new SecretRedactor();
    const started = performance.now();
    const result = redactor.redact(text);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(result.redactions).toHaveLength(1);
  });
});

describe("shannonEntropy", () => {
  it("measures bits per character", () => {
    expect(shannonEntropy("")).toBe(0);
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy("abcd")).toBe(2);
  });
});

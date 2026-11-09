import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as unknown;
}

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly redirect: RequestInit["redirect"];
  readonly body: string | undefined;
}

export type Answer =
  | { readonly status?: number; readonly json: unknown; readonly headers?: Record<string, string> }
  | { readonly status?: number; readonly text: string; readonly headers?: Record<string, string> }
  | { readonly error: Error };

/** A `fetch` that answers from a script, in order, and records every request. */
export function scriptedFetch(...answers: Answer[]): {
  readonly fetch: typeof fetch;
  readonly requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fake = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    requests.push({
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? "GET",
      headers,
      redirect: init?.redirect,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const answer = answers.shift();
    if (answer === undefined) return Promise.reject(new Error("no scripted answer left"));
    if ("error" in answer) return Promise.reject(answer.error);
    const text = "json" in answer ? JSON.stringify(answer.json) : answer.text;
    return Promise.resolve(
      new Response(text, {
        status: answer.status ?? 200,
        headers: { "content-type": "application/json; charset=utf-8", ...answer.headers },
      }),
    );
  };
  return { fetch: fake, requests };
}

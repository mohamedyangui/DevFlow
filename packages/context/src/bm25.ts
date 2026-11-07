/**
 * Tokenization and BM25 scoring (ADR 0008). Identifiers are split on case, digits and
 * separators, so `OrderController.findAll` yields `order`, `controller`, `find`, `all`.
 */

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could do does for from has have how if in into is it " +
    "its may must no not of on or our shall should so such than that the their them then there " +
    "these they this those to was we were when where which while who will with would you your " +
    "given also any all each every via per using use used new " +
    "public private protected static final void return import package class interface const let " +
    "var function export default async await null true false undefined this self def end"
  ).split(" "),
);

function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us")) {
    return token.slice(0, -1);
  }
  return token;
}

/** Lower-case, stemmed tokens without stopwords. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const word of text.split(/[^A-Za-z0-9]+/)) {
    if (word === "") continue;
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/([A-Za-z])([0-9])/g, "$1 $2")
      .split(" ");
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower.length < 2 || STOPWORDS.has(lower) || /^[0-9]+$/.test(lower)) continue;
      tokens.push(stem(lower));
    }
  }
  return tokens;
}

export interface Bm25Document {
  readonly id: string;
  readonly tokens: readonly string[];
}

export interface Bm25Match {
  readonly score: number;
  /** Query terms found in the document, highest contribution first. */
  readonly terms: readonly string[];
}

/** A BM25 index (k1 = 1.2, b = 0.75) over pre-tokenized documents. */
export class Bm25Index {
  private readonly frequencies = new Map<string, Map<string, number>>();
  private readonly lengths = new Map<string, number>();
  private readonly documentFrequency = new Map<string, number>();
  private readonly averageLength: number;

  constructor(
    documents: readonly Bm25Document[],
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {
    let total = 0;
    for (const document of documents) {
      const counts = new Map<string, number>();
      for (const token of document.tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
      this.frequencies.set(document.id, counts);
      this.lengths.set(document.id, document.tokens.length);
      total += document.tokens.length;
      for (const token of counts.keys()) {
        this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1);
      }
    }
    this.averageLength = documents.length === 0 ? 1 : Math.max(1, total / documents.length);
  }

  /** Scores every document that contains at least one query term. */
  search(query: readonly string[]): Map<string, Bm25Match> {
    const terms = [...new Set(query)];
    const documents = this.frequencies.size;
    const results = new Map<string, Bm25Match>();
    for (const [id, counts] of this.frequencies) {
      const length = this.lengths.get(id) ?? 0;
      let score = 0;
      const contributions: [string, number][] = [];
      for (const term of terms) {
        const frequency = counts.get(term);
        if (frequency === undefined) continue;
        const df = this.documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (documents - df + 0.5) / (df + 0.5));
        const norm = frequency + this.k1 * (1 - this.b + (this.b * length) / this.averageLength);
        const contribution = (idf * frequency * (this.k1 + 1)) / norm;
        score += contribution;
        contributions.push([term, contribution]);
      }
      if (score > 0) {
        contributions.sort((x, y) => y[1] - x[1]);
        results.set(id, { score, terms: contributions.map(([term]) => term) });
      }
    }
    return results;
  }
}

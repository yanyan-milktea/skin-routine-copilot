// ingredient-tokenizer-v1: pinned, deterministic text processing shared by the
// lexical scorer, the deterministic query classifier, and the synthetic fixture
// embedder. BM25 thresholds are only valid for this exact tokenizer version, so
// any behavior change must ship as a new version string.

export const TOKENIZER_VERSION = "ingredient-tokenizer-v1" as const;
export const ALIASES_SCHEMA_VERSION = 1 as const;

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "by", "is", "are", "was", "were", "be", "been",
  "being", "it", "its", "this", "that", "these", "those", "as", "at", "from", "do", "does", "did", "can", "could",
  "should", "would", "will", "i", "you", "me", "we", "they", "he", "she", "them", "our", "your", "their", "my", "about",
  "into", "if", "than", "then", "so", "such", "there", "here", "has", "have", "had", "any", "some", "also", "just", "how",
  "why", "when", "which", "may", "might", "must", "s", "t", "im", "ive", "dont", "doesnt", "very", "more", "most", "get",
  "using", "while", "during", "after", "before", "up", "out", "over", "all", "each", "other", "only", "own", "too", "really",
]);

export type CompiledPhrase = { tokens: readonly string[]; canonical: string };

export type IntentRule = {
  query_triggers: readonly (readonly string[])[];
  chunk_anchors: readonly (readonly string[])[];
};

export type ClassRule = {
  label: string;
  class_anchors: readonly (readonly string[])[];
  intents: Readonly<Record<string, IntentRule>>;
};

export type CompiledAliases = {
  aliases_version: string;
  tokenizer_version: typeof TOKENIZER_VERSION;
  phrases: readonly CompiledPhrase[];
  canonical_terms: ReadonlySet<string>;
  class_precedence: readonly string[];
  classes: Readonly<Record<string, ClassRule>>;
  blocked: Readonly<Record<string, readonly RegExp[]>>;
};

/** NFKC, lowercase, apostrophes removed, everything except letters, digits and % becomes a single space. */
export function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ']/g, " ")
    .replace(/[^\p{L}\p{N}%_]+/gu, " ")
    .replace(/_/g, " ")
    .trim();
}

function stem(token: string): string {
  if (token.length > 3 && token.endsWith("s") && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

/** Raw tokens: normalized, stopwords removed, light plural stemming. No alias canonicalization. */
export function rawTokens(value: string): string[] {
  const normalized = normalizeForMatch(value);
  if (!normalized) return [];
  const out: string[] = [];
  for (const word of normalized.split(" ")) {
    if (!word || STOPWORDS.has(word)) continue;
    const stemmed = stem(word);
    if (!stemmed || STOPWORDS.has(stemmed)) continue;
    out.push(stemmed);
  }
  return out;
}

/** Replace reviewed alias phrases (longest match first, left to right) with their canonical token. */
export function canonicalizeTokens(tokens: readonly string[], aliases: Pick<CompiledAliases, "phrases">): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    let matched: CompiledPhrase | null = null;
    for (const phrase of aliases.phrases) {
      if (phrase.tokens.length === 0 || index + phrase.tokens.length > tokens.length) continue;
      let ok = true;
      for (let offset = 0; offset < phrase.tokens.length; offset += 1) {
        if (tokens[index + offset] !== phrase.tokens[offset]) { ok = false; break; }
      }
      if (ok) { matched = phrase; break; }
    }
    if (matched) {
      out.push(matched.canonical);
      index += matched.tokens.length;
    } else {
      out.push(tokens[index]);
      index += 1;
    }
  }
  return out;
}

export function tokenize(value: string, aliases: Pick<CompiledAliases, "phrases">): string[] {
  return canonicalizeTokens(rawTokens(value), aliases);
}

/** True when `phrase` occurs as a contiguous token run in `tokens`. */
export function containsPhrase(tokens: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0 || phrase.length > tokens.length) return false;
  outer: for (let index = 0; index + phrase.length <= tokens.length; index += 1) {
    for (let offset = 0; offset < phrase.length; offset += 1) {
      if (tokens[index + offset] !== phrase[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`ALIASES_INVALID: unexpected ${path}.${key}`);
  for (const key of keys) if (!(key in value)) throw new Error(`ALIASES_INVALID: missing ${path}.${key}`);
}

function stringList(value: unknown, path: string, min = 1): string[] {
  if (!Array.isArray(value) || value.length < min || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new Error(`ALIASES_INVALID: ${path} must be a list of non-empty strings`);
  }
  return value as string[];
}

/** Validate the reviewed alias table (exact keys) and compile it against the pinned tokenizer. Throws on any problem. */
export function compileAliases(value: unknown): CompiledAliases {
  if (!isRecord(value)) throw new Error("ALIASES_INVALID: not an object");
  requireKeys(value, ["schema_version", "aliases_version", "tokenizer_version", "review", "canonical_terms", "class_precedence", "classes", "blocked_query_patterns"], "$");
  if (value.schema_version !== ALIASES_SCHEMA_VERSION) throw new Error("ALIASES_INVALID: schema_version");
  if (value.tokenizer_version !== TOKENIZER_VERSION) throw new Error("ALIASES_TOKENIZER_MISMATCH");
  if (typeof value.aliases_version !== "string" || !/^ingredient-aliases-v\d+$/.test(value.aliases_version)) throw new Error("ALIASES_INVALID: aliases_version");
  if (!isRecord(value.canonical_terms)) throw new Error("ALIASES_INVALID: canonical_terms");

  const canonical = new Set<string>();
  const phrases: CompiledPhrase[] = [];
  const seen = new Map<string, string>();
  for (const [name, list] of Object.entries(value.canonical_terms)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`ALIASES_INVALID: canonical name ${name}`);
    canonical.add(name);
    for (const alias of stringList(list, `$.canonical_terms.${name}`)) {
      const tokens = rawTokens(alias);
      if (tokens.length === 0) throw new Error(`ALIASES_INVALID: alias "${alias}" is empty after tokenization`);
      const key = tokens.join(" ");
      const previous = seen.get(key);
      if (previous && previous !== name) throw new Error(`ALIASES_CONFLICT: "${alias}" maps to ${previous} and ${name}`);
      seen.set(key, name);
      phrases.push({ tokens, canonical: name });
    }
  }
  // Longest phrase first; ties broken by token text so compilation is order-independent.
  phrases.sort((a, b) => b.tokens.length - a.tokens.length || a.tokens.join(" ").localeCompare(b.tokens.join(" ")) || a.canonical.localeCompare(b.canonical));
  const table = { phrases };

  const term = (raw: string, path: string): string[] => {
    if (canonical.has(raw)) return [raw];
    const tokens = canonicalizeTokens(rawTokens(raw), table);
    if (tokens.length === 0) throw new Error(`ALIASES_INVALID: ${path} "${raw}" is empty after tokenization`);
    return tokens;
  };

  if (!isRecord(value.classes)) throw new Error("ALIASES_INVALID: classes");
  const classes: Record<string, ClassRule> = {};
  for (const [classId, rawRule] of Object.entries(value.classes)) {
    if (!/^Q[1-5]$/.test(classId) || !isRecord(rawRule)) throw new Error(`ALIASES_INVALID: class ${classId}`);
    requireKeys(rawRule, ["label", "class_anchors", "intents"], `$.classes.${classId}`);
    if (!isRecord(rawRule.intents)) throw new Error(`ALIASES_INVALID: ${classId}.intents`);
    const intents: Record<string, IntentRule> = {};
    for (const [intentId, rawIntent] of Object.entries(rawRule.intents)) {
      if (!intentId.startsWith(`${classId.toLowerCase()}_`) || !isRecord(rawIntent)) throw new Error(`ALIASES_INVALID: intent ${intentId}`);
      requireKeys(rawIntent, ["query_triggers", "chunk_anchors"], `$.classes.${classId}.intents.${intentId}`);
      intents[intentId] = {
        query_triggers: stringList(rawIntent.query_triggers, `${intentId}.query_triggers`).map((item) => term(item, intentId)),
        chunk_anchors: stringList(rawIntent.chunk_anchors, `${intentId}.chunk_anchors`).map((item) => term(item, intentId)),
      };
    }
    classes[classId] = {
      label: String(rawRule.label),
      class_anchors: stringList(rawRule.class_anchors, `${classId}.class_anchors`).map((item) => term(item, classId)),
      intents,
    };
  }
  for (const classId of ["Q1", "Q2", "Q3", "Q4", "Q5"]) if (!classes[classId]) throw new Error(`ALIASES_INVALID: missing class ${classId}`);

  const precedence = stringList(value.class_precedence, "$.class_precedence", 0);
  for (const classId of precedence) if (!classes[classId]) throw new Error(`ALIASES_INVALID: precedence ${classId}`);

  if (!isRecord(value.blocked_query_patterns)) throw new Error("ALIASES_INVALID: blocked_query_patterns");
  const blocked: Record<string, RegExp[]> = {};
  for (const [family, patterns] of Object.entries(value.blocked_query_patterns)) {
    blocked[family] = stringList(patterns, `$.blocked_query_patterns.${family}`).map((pattern) => new RegExp(pattern, "u"));
  }

  return Object.freeze({
    aliases_version: value.aliases_version,
    tokenizer_version: TOKENIZER_VERSION,
    phrases: Object.freeze(phrases),
    canonical_terms: canonical,
    class_precedence: Object.freeze(precedence),
    classes: Object.freeze(classes),
    blocked: Object.freeze(blocked),
  });
}

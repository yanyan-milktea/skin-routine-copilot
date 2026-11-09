import { createChunkContentHash, createChunkId, normalizeCorpusText } from "./ingredient-corpus.ts";

// ingredient-chunker-v1: heading-aware chunking of normalized Markdown.
// Boundaries follow publisher headings; size limits only split inside a
// section. Every chunk is an exact slice of the normalized document.

export const CHUNKER_VERSION = "ingredient-chunker-v1" as const;
export const TOKEN_ESTIMATOR_VERSION = "ingredient-token-estimator-v1" as const;

export const CHUNKING = Object.freeze({
  target_min_tokens: 350,
  target_max_tokens: 500,
  max_tokens: 650,
  overlap_min_tokens: 60,
  overlap_max_tokens: 80,
});

/** Pinned estimate of embedding-model tokens: ceil(words * 4 / 3). Deterministic and provider independent. */
export function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil((words * 4) / 3);
}

const QUALIFIER_START = /^(however|except|unless|but|warning|caution|important|note|do not|don't|never|this does not|that does not)\b/i;

export type ChunkSourceDocument = {
  source_id: string;
  document_id: string;
  document_hash: string;
  publisher: string;
  title: string;
  canonical_url: string;
  retrieved_at: string;
  question_classes: readonly string[];
  normalized_text: string;
};

export type IndexChunk = {
  schema_version: 1;
  chunk_id: string;
  source_id: string;
  document_id: string;
  document_hash: string;
  publisher: string;
  title: string;
  canonical_url: string;
  retrieved_at: string;
  question_classes: string[];
  section_path: string[];
  ordinal: number;
  text: string;
  start_char: number;
  end_char: number;
  content_hash: string;
  token_estimate: number;
  overlaps_previous: boolean;
  qualifier_continuation: boolean;
};

type Range = { start: number; end: number };
type Section = { path: string[]; body: Range };

function trimRange(text: string, range: Range): Range | null {
  let { start, end } = range;
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  return end > start ? { start, end } : null;
}

function sections(text: string, title: string): Section[] {
  const lines: { start: number; end: number; line: string }[] = [];
  let cursor = 0;
  for (const line of text.split("\n")) {
    lines.push({ start: cursor, end: cursor + line.length, line });
    cursor += line.length + 1;
  }
  const out: Section[] = [];
  const stack: { level: number; heading: string }[] = [];
  let currentPath: string[] = [title];
  let bodyStart = 0;
  const flush = (end: number) => {
    const body = trimRange(text, { start: bodyStart, end });
    if (body) out.push({ path: [...currentPath], body });
  };
  for (const { start, end, line } of lines) {
    const match = /^(#{1,6}) +(.+?) *#*$/.exec(line);
    if (!match) continue;
    flush(start);
    const level = match[1].length;
    const heading = match[2].trim().slice(0, 120);
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, heading });
    currentPath = stack.map((item) => item.heading);
    if (currentPath[0] !== title) currentPath = [title, ...currentPath.filter((item) => item !== title)];
    bodyStart = Math.min(end + 1, text.length);
  }
  flush(text.length);
  return out;
}

function paragraphs(text: string, body: Range): Range[] {
  const out: Range[] = [];
  const slice = text.slice(body.start, body.end);
  const pattern = /\n\s*\n/g;
  let last = 0;
  for (let match = pattern.exec(slice); match; match = pattern.exec(slice)) {
    const range = trimRange(text, { start: body.start + last, end: body.start + match.index });
    if (range) out.push(range);
    last = match.index + match[0].length;
  }
  const tail = trimRange(text, { start: body.start + last, end: body.end });
  if (tail) out.push(tail);
  return out;
}

function sentences(text: string, range: Range): Range[] {
  const out: Range[] = [];
  const slice = text.slice(range.start, range.end);
  const pattern = /[^.!?]+(?:[.!?]+["')\]]*|$)/g;
  for (let match = pattern.exec(slice); match && match[0].length; match = pattern.exec(slice)) {
    const piece = trimRange(text, { start: range.start + match.index, end: range.start + match.index + match[0].length });
    if (piece) out.push(piece);
  }
  return out.length ? out : [range];
}

function hardSplit(text: string, range: Range, maxTokens: number): Range[] {
  // Last resort for a single over-long sentence: split on word boundaries.
  const out: Range[] = [];
  const maxWords = Math.floor((maxTokens * 3) / 4);
  const pattern = /\S+/g;
  const slice = text.slice(range.start, range.end);
  let count = 0;
  let pieceStart = -1;
  let pieceEnd = -1;
  for (let match = pattern.exec(slice); match; match = pattern.exec(slice)) {
    if (pieceStart < 0) pieceStart = match.index;
    pieceEnd = match.index + match[0].length;
    count += 1;
    if (count === maxWords) {
      out.push({ start: range.start + pieceStart, end: range.start + pieceEnd });
      count = 0;
      pieceStart = -1;
    }
  }
  if (pieceStart >= 0) out.push({ start: range.start + pieceStart, end: range.start + pieceEnd });
  return out;
}

/** Units are the smallest pieces packed into chunks: sentences, with qualifiers glued to the statement they qualify. */
function units(text: string, body: Range): Range[] {
  const pieces: Range[] = [];
  for (const paragraph of paragraphs(text, body)) {
    if (estimateTokens(text.slice(paragraph.start, paragraph.end)) <= CHUNKING.target_max_tokens) {
      pieces.push(paragraph);
    } else {
      for (const sentence of sentences(text, paragraph)) {
        if (estimateTokens(text.slice(sentence.start, sentence.end)) <= CHUNKING.max_tokens) pieces.push(sentence);
        else pieces.push(...hardSplit(text, sentence, CHUNKING.max_tokens));
      }
    }
  }
  const glued: Range[] = [];
  for (const piece of pieces) {
    const previous = glued[glued.length - 1];
    const candidate = previous ? { start: previous.start, end: piece.end } : null;
    if (
      previous &&
      candidate &&
      QUALIFIER_START.test(text.slice(piece.start, piece.end)) &&
      estimateTokens(text.slice(candidate.start, candidate.end)) <= CHUNKING.max_tokens
    ) {
      glued[glued.length - 1] = candidate;
    } else {
      glued.push(piece);
    }
  }
  return glued;
}

function overlapStart(text: string, chunk: Range): number | null {
  // Smallest whole-sentence suffix of the previous chunk with 60-80 estimated tokens.
  const parts = sentences(text, chunk);
  for (let index = parts.length - 1; index > 0; index -= 1) {
    const tokens = estimateTokens(text.slice(parts[index].start, chunk.end));
    if (tokens > CHUNKING.overlap_max_tokens) return null;
    if (tokens >= CHUNKING.overlap_min_tokens) return parts[index].start;
  }
  return null;
}

/** Chunk one normalized document. Throws if the document is not already normalized. */
export function chunkDocument(document: ChunkSourceDocument): IndexChunk[] {
  const text = document.normalized_text;
  if (normalizeCorpusText(text) !== text) throw new Error(`CHUNK_INPUT_NOT_NORMALIZED: ${document.source_id}`);
  const out: IndexChunk[] = [];
  for (const section of sections(text, document.title)) {
    const ranges: { range: Range; overlaps: boolean; qualifier: boolean }[] = [];
    let current: Range | null = null;
    let currentOverlaps = false;
    let currentQualifier = false;
    for (const unit of units(text, section.body)) {
      const merged: Range | null = current ? { start: current.start, end: unit.end } : null;
      if (current && merged && estimateTokens(text.slice(merged.start, merged.end)) <= CHUNKING.target_max_tokens) {
        current = merged;
        continue;
      }
      if (current) {
        ranges.push({ range: current, overlaps: currentOverlaps, qualifier: currentQualifier });
        const overlap: number | null = overlapStart(text, current);
        const withOverlap: Range | null = overlap !== null ? { start: overlap, end: unit.end } : null;
        if (withOverlap && estimateTokens(text.slice(withOverlap.start, withOverlap.end)) <= CHUNKING.max_tokens) {
          current = withOverlap;
          currentOverlaps = true;
        } else {
          current = unit;
          currentOverlaps = false;
        }
        // A new chunk whose first new unit opens with a qualifier continues the previous statement.
        currentQualifier = QUALIFIER_START.test(text.slice(unit.start, unit.end));
      } else {
        current = unit;
        currentOverlaps = false;
      }
    }
    if (current) ranges.push({ range: current, overlaps: currentOverlaps, qualifier: currentQualifier });

    ranges.forEach(({ range, overlaps, qualifier }, ordinal) => {
      const chunkText = text.slice(range.start, range.end);
      out.push({
        schema_version: 1,
        chunk_id: createChunkId(document.source_id, section.path, ordinal, chunkText),
        source_id: document.source_id,
        document_id: document.document_id,
        document_hash: document.document_hash,
        publisher: document.publisher,
        title: document.title,
        canonical_url: document.canonical_url,
        retrieved_at: document.retrieved_at,
        question_classes: [...document.question_classes],
        section_path: section.path,
        ordinal,
        text: chunkText,
        start_char: range.start,
        end_char: range.end,
        content_hash: createChunkContentHash(chunkText),
        token_estimate: estimateTokens(chunkText),
        overlaps_previous: overlaps,
        qualifier_continuation: ordinal > 0 && qualifier,
      });
    });
  }
  return out;
}

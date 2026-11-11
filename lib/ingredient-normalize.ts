// readability-normalizer@1.0.0 (design §4.4 steps 5–9).
// Deterministic HTML → normalized Markdown for reviewed corpus snapshots. No
// dependencies, no scripts, no network: a small tokenizer, a forgiving tree
// builder, and a block walker over the page's <main> element only.
import { APPROVED_PARSER, normalizeCorpusText } from "./ingredient-corpus.ts";

export const NORMALIZER = Object.freeze({ name: "readability-normalizer", version: "1.0.0" });
if (NORMALIZER.name !== APPROVED_PARSER.name || NORMALIZER.version !== APPROVED_PARSER.version) {
  throw new Error("Normalizer version does not match the manifest-pinned parser.");
}

type Element = { tag: string; attrs: Record<string, string>; children: Node[] };
type Node = Element | string;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "noscript", "template", "svg", "iframe"]);
// Opening one of these closes an open element of the listed kinds (HTML's implied end tags).
const IMPLIED_CLOSE: Record<string, readonly string[]> = {
  p: ["p"], li: ["li", "p"], dt: ["dt", "dd", "p"], dd: ["dt", "dd", "p"], tr: ["tr", "td", "th"], td: ["td", "th"], th: ["td", "th"], option: ["option"],
  h1: ["p"], h2: ["p"], h3: ["p"], h4: ["p"], h5: ["p"], h6: ["p"], ul: ["p"], ol: ["p"], div: ["p"], table: ["p"], blockquote: ["p"], pre: ["p"], section: ["p"],
};

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", bull: "•", middot: "·", deg: "°", micro: "µ", times: "×",
  alpha: "α", beta: "β", gamma: "γ", frac12: "½", frac14: "¼", frac34: "¾", eacute: "é", egrave: "è", ouml: "ö", uuml: "ü",
  sect: "§", para: "¶", shy: "", zwnj: "", zwj: "", ensp: " ", emsp: " ", thinsp: " ", plusmn: "±", le: "≤", ge: "≥",
};

export function decodeEntities(text: string, unknown: Set<string>): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const value = ENTITIES[body.toLowerCase()];
    if (value === undefined) { unknown.add(match); return match; }
    return value;
  });
}

function parseAttrs(source: string, unknown: Set<string>): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "", unknown);
  }
  return attrs;
}

/** Parses HTML into a tree, tolerating implied end tags and stray closing tags. */
export function parseHtml(html: string, unknown: Set<string> = new Set()): Element {
  const root: Element = { tag: "#root", attrs: {}, children: [] };
  const stack: Element[] = [root];
  const top = () => stack[stack.length - 1];
  // Attribute blobs may run together (id="a"class="b"); quotes are respected so ">" inside a value is fine.
  const tagPattern = /<!--[\s\S]*?-->|<![^>]*>|<\?[\s\S]*?>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let cursor = 0;
  for (let match = tagPattern.exec(html); match; match = tagPattern.exec(html)) {
    if (match.index > cursor) top().children.push(decodeEntities(html.slice(cursor, match.index), unknown));
    cursor = tagPattern.lastIndex;
    const [whole, closeName, openName, rawAttrs] = match;
    const selfClose = /\/\s*$/.test(rawAttrs ?? "");
    if (whole.startsWith("<!") || whole.startsWith("<?")) continue;
    if (closeName) {
      const name = closeName.toLowerCase();
      const at = stack.map((element) => element.tag).lastIndexOf(name);
      if (at > 0) stack.length = at;
      continue;
    }
    const name = openName.toLowerCase();
    for (const closes = IMPLIED_CLOSE[name] ?? []; ;) {
      const open = top();
      if (stack.length > 1 && closes.includes(open.tag)) { stack.pop(); continue; }
      // look one level further for li/td-like siblings (e.g. <li><p>..<li>)
      if (stack.length > 2 && closes.includes(stack[stack.length - 2].tag) && open.tag === "p") { stack.length -= 2; continue; }
      break;
    }
    const element: Element = { tag: name, attrs: parseAttrs((rawAttrs ?? "").replace(/\/\s*$/, ""), unknown), children: [] };
    top().children.push(element);
    if (RAW_TEXT.has(name)) {
      const end = new RegExp(`</${name}\\s*>`, "ig");
      end.lastIndex = cursor;
      const found = end.exec(html);
      cursor = found ? end.lastIndex : html.length;
      tagPattern.lastIndex = cursor;
      continue;
    }
    if (!VOID.has(name) && !selfClose) stack.push(element);
  }
  if (cursor < html.length) top().children.push(decodeEntities(html.slice(cursor), unknown));
  return root;
}

function find(node: Node, tag: string): Element | null {
  if (typeof node === "string") return null;
  if (node.tag === tag) return node;
  for (const child of node.children) { const hit = find(child, tag); if (hit) return hit; }
  return null;
}

const DROP = new Set([...RAW_TEXT, "nav", "form", "button", "select", "input", "img", "picture", "video", "audio", "canvas", "object", "head", "dialog"]);
const HIDDEN_CLASS = /(?:^|\s)(?:visually-hidden|element-invisible|sr-only|hidden|d-none)(?:\s|$)/i;
const BLOCK = new Set(["p", "li", "dt", "dd", "pre", "figcaption", "caption", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "div", "section", "article", "header", "footer", "aside", "main", "ul", "ol", "dl", "table", "tbody", "thead", "tfoot", "figure", "hr"]);

function isHidden(element: Element): boolean {
  return "hidden" in element.attrs || element.attrs["aria-hidden"] === "true" || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(element.attrs.style ?? "") || HIDDEN_CLASS.test(element.attrs.class ?? "");
}

export type NormalizedPage = { title: string; markdown: string; content_current_as_of: string | null; unknown_entities: string[]; block_count: number };

/**
 * Normalized Markdown from the page's <main> element: headings as #/##/###,
 * paragraphs separated by blank lines, list items as "- " or "1. ", table rows
 * as cells joined by " | ". Source text is never paraphrased.
 */
export function normalizeHtml(html: string, expectedTitle: string): NormalizedPage {
  const unknown = new Set<string>();
  const tree = parseHtml(html, unknown);
  const main = find(tree, "main");
  if (!main) throw new Error("MAIN_NOT_FOUND");
  const blocks: string[] = [];
  let buffer = "";
  let prefix = "";
  const flush = () => {
    const text = buffer.replace(/\s+/g, " ").trim();
    if (text) blocks.push(`${prefix}${text}`);
    buffer = "";
    prefix = "";
  };
  const walk = (node: Node, list: { ordered: boolean; index: number } | null) => {
    if (typeof node === "string") { buffer += node; return; }
    if (DROP.has(node.tag) || isHidden(node)) return;
    if (node.tag === "br") { buffer += " "; return; }
    if (node.tag === "tr") {
      flush();
      const cells = node.children.filter((child): child is Element => typeof child !== "string" && (child.tag === "td" || child.tag === "th") && !isHidden(child));
      const parts = cells.map((cell) => { const saved = buffer; buffer = ""; for (const child of cell.children) walk(child, null); const text = buffer.replace(/\s+/g, " ").trim(); buffer = saved; return text; });
      if (parts.some(Boolean)) blocks.push(parts.join(" | "));
      return;
    }
    if (!BLOCK.has(node.tag)) { for (const child of node.children) walk(child, list); return; }
    flush();
    const heading = /^h([1-6])$/.exec(node.tag);
    if (heading) prefix = `${"#".repeat(Math.min(Number(heading[1]), 4))} `;
    if (node.tag === "li") { prefix = list?.ordered ? `${(list.index += 1)}. ` : "- "; }
    const childList = node.tag === "ul" || node.tag === "ol" ? { ordered: node.tag === "ol", index: 0 } : list;
    const keepPrefix = prefix;
    for (const child of node.children) {
      walk(child, childList);
      if (!buffer && prefix === "" && keepPrefix && typeof child !== "string" && BLOCK.has(child.tag)) { /* nested block already flushed */ }
    }
    if (prefix === "" && keepPrefix && buffer.trim()) prefix = keepPrefix;
    flush();
  };
  for (const child of main.children) walk(child, null);
  flush();

  // FDA's page trailer ("Content current as of: <date>", "Regulated Product(s)") is
  // metadata, not content: record the date and drop the trailer.
  const trailer = blocks.findIndex((block) => /^#+ Content current as of:?$/i.test(block));
  const dateBlock = trailer >= 0 ? blocks[trailer + 1] ?? "" : "";
  const current = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateBlock.trim());
  const content = trailer >= 0 ? blocks.slice(0, trailer) : blocks;
  const title = expectedTitle.trim();
  const body = content.some((block) => block.startsWith("# ")) ? content : [`# ${title}`, ...content];
  const markdown = normalizeCorpusText(body.join("\n\n"));
  return { title, markdown, content_current_as_of: current ? `${current[3]}-${current[1]}-${current[2]}` : null, unknown_entities: [...unknown].sort(), block_count: body.length };
}

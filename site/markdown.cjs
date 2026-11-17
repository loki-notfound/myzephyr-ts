"use strict";
// A converter for exactly the Markdown subset the guide (docs/guide/) uses, shared by the site build
// (site/build_site.cjs) and the example check (site/check_guide.cjs). It knows ATX headings, paragraphs,
// fenced code blocks, bullet and numbered lists (nested by indentation), pipe tables, inline code,
// links, bold and emphasis with asterisks, and backslash escapes. Anything else (raw HTML, block quotes,
// rules, images, indented code, reference links, bare URLs, underscore emphasis, setext headings) is an
// error, so the build fails instead of emitting something GitHub would render differently.
// No dependency: Node.js built-ins only.

class MarkdownError extends Error {
  constructor(file, line, message) {
    super(`${file}:${line}: ${message}`);
    this.name = "MarkdownError";
  }
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The anchor GitHub derives from a heading's text: lower case, punctuation removed, spaces to hyphens. */
function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9 _-]/g, "").replace(/ /g, "-");
}

// ------------------------------------------------------------------ inline

/**
 * Parse inline Markdown into tokens: { t: "text"|"code"|"strong"|"em"|"link", ... }. Fails on raw HTML,
 * images, bare URLs, reference links and underscore emphasis.
 */
function parseInline(src, file, line) {
  const fail = (m) => { throw new MarkdownError(file, line, m); };
  const out = [];
  let text = "";
  const flush = () => { if (text) { out.push({ t: "text", v: text }); text = ""; } };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|<>]/.test(src[i + 1])) { text += src[i + 1]; i += 2; continue; }
    if (c === "`") {
      let n = 0; while (src[i + n] === "`") n++;
      const fence = "`".repeat(n);
      const end = src.indexOf(fence, i + n);
      if (end < 0) fail("unclosed code span");
      let code = src.slice(i + n, end);
      if (n > 1 && code.startsWith(" ") && code.endsWith(" ")) code = code.slice(1, -1);
      flush(); out.push({ t: "code", v: code.replace(/\\\|/g, "|") });
      i = end + n; continue;
    }
    if (c === "!" && src[i + 1] === "[") fail("images are not supported");
    if (c === "<" && /[A-Za-z/!?]/.test(src[i + 1] || "")) fail("raw HTML is not supported (put it in a code span)");
    if (c === "[") {
      const close = findClose(src, i, "[", "]");
      if (close < 0) fail("unclosed [");
      if (src[close + 1] === "(") {
        const end = findClose(src, close + 1, "(", ")");
        if (end < 0) fail("unclosed link target");
        const href = src.slice(close + 2, end);
        if (/\s/.test(href)) fail("a link target with a space or a title is not supported");
        flush(); out.push({ t: "link", href, children: parseInline(src.slice(i + 1, close), file, line) });
        i = end + 1; continue;
      }
      if (src[close + 1] === "[") fail("reference links are not supported");
      text += c; i++; continue;
    }
    if (c === "*") {
      const strong = src[i + 1] === "*";
      const marker = strong ? "**" : "*";
      const end = src.indexOf(marker, i + marker.length);
      const inner = end < 0 ? "" : src.slice(i + marker.length, end);
      if (end > i + marker.length && !/^\s/.test(inner) && !/\s$/.test(inner) && (strong || src[end + 1] !== "*")) {
        flush(); out.push({ t: strong ? "strong" : "em", children: parseInline(inner, file, line) });
        i = end + marker.length; continue;
      }
      text += c; i++; continue;
    }
    if (c === "_" && (i === 0 || /[\s(]/.test(src[i - 1])) && /\S/.test(src[i + 1] || "")) fail("underscore emphasis is not supported");
    if (/^https?:\/\//.test(src.slice(i)) && !/[(<]$/.test(src.slice(0, i))) fail("a bare URL is not supported (use a link)");
    text += c; i++;
  }
  flush();
  return out;
}

function findClose(s, start, open, close) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "`") { const e = s.indexOf("`", i + 1); if (e < 0) return -1; i = e; continue; }
    if (s[i] === open) depth++;
    else if (s[i] === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Plain text of inline tokens (code spans keep their content, links their text). */
function inlineText(tokens) {
  return tokens.map((k) => (k.t === "text" || k.t === "code" ? k.v : inlineText(k.children))).join("");
}

/** HTML of inline tokens; resolveLink(href) returns the href to emit. */
function inlineHtml(tokens, resolveLink) {
  return tokens.map((k) => {
    switch (k.t) {
      case "text": return escapeHtml(k.v);
      case "code": return `<code>${escapeHtml(k.v)}</code>`;
      case "strong": return `<strong>${inlineHtml(k.children, resolveLink)}</strong>`;
      case "em": return `<em>${inlineHtml(k.children, resolveLink)}</em>`;
      case "link": return `<a href="${escapeHtml(resolveLink(k.href))}">${inlineHtml(k.children, resolveLink)}</a>`;
      default: throw new Error("unknown inline token");
    }
  }).join("");
}

// ------------------------------------------------------------------ blocks

const LIST_ITEM = /^( *)([-*]|\d+\.) +(.*)$/;

/**
 * Parse a document into blocks: heading { level, inline, text, id, line }, paragraph { inline },
 * code { lang, info, text, line }, list { ordered, items: [{ blocks }] }, table { head, rows, line }.
 */
function parse(src, file) {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  const ids = new Map();
  let i = 0;
  const fail = (n, m) => { throw new MarkdownError(file, n + 1, m); };

  function uniqueId(text) {
    const base = slug(text);
    const n = ids.get(base) || 0;
    ids.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  }

  function checkBlockStart(line, n) {
    if (/^ {0,3}>/.test(line)) fail(n, "block quotes are not supported");
    if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line)) fail(n, "horizontal rules are not supported");
    if (/^ {0,3}<[A-Za-z!/]/.test(line)) fail(n, "raw HTML is not supported");
    if (/^\t/.test(line)) fail(n, "tabs are not supported");
  }

  // A list ends at the first blank line (loose lists are not supported). Nested lists are items indented
  // to the parent item's text; a nested list must be the last part of its item.
  function parseList(start) {
    const group = [];
    let n = start;
    while (n < lines.length && lines[n].trim() !== "") {
      if (/^ *```/.test(lines[n])) fail(n, "code blocks inside list items are not supported");
      group.push({ text: lines[n], n });
      n++;
    }
    if (n + 1 < lines.length && lines[n] !== undefined && LIST_ITEM.test(lines[n + 1]) && LIST_ITEM.exec(lines[n + 1])[1].length === 0) {
      fail(n, "loose lists (blank lines between items) are not supported");
    }
    return { block: buildList(group), next: n };
  }

  function buildList(group) {
    const first = LIST_ITEM.exec(group[0].text);
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const items = [];
    let k = 0;
    while (k < group.length) {
      const m = LIST_ITEM.exec(group[k].text);
      if (!m || m[1].length !== indent) fail(group[k].n, "unexpected indentation in a list");
      if (/\d/.test(m[2]) !== ordered) fail(group[k].n, "a list mixes bullets and numbers");
      const contentIndent = indent + m[2].length + 1;
      const para = [{ text: m[3], n: group[k].n }];
      const nested = [];
      k++;
      while (k < group.length) {
        const s = LIST_ITEM.exec(group[k].text);
        const lead = group[k].text.length - group[k].text.trimStart().length;
        if (s && s[1].length === indent) break;
        if (s && s[1].length < indent) fail(group[k].n, "unexpected indentation in a list");
        if (s || nested.length) {
          if (lead < contentIndent) fail(group[k].n, "a nested line must be indented to the item's text");
          nested.push(group[k]);
        } else {
          if (lead < contentIndent) fail(group[k].n, "a continuation line must be indented to the item's text");
          para.push(group[k]);
        }
        k++;
      }
      const blocksOfItem = [{ type: "paragraph", inline: parseInline(para.map((p) => p.text.trim()).join(" "), file, para[0].n + 1), line: para[0].n + 1 }];
      if (nested.length) {
        if (!LIST_ITEM.test(nested[0].text)) fail(nested[0].n, "text after a nested list is not supported");
        blocksOfItem.push(buildList(nested));
      }
      items.push({ blocks: blocksOfItem });
    }
    return { type: "list", ordered, items };
  }

  function splitRow(line, n) {
    let s = line.trim();
    if (!s.startsWith("|") || !s.endsWith("|")) fail(n, "a table row must start and end with |");
    s = s.slice(1, -1);
    const cells = [];
    let cur = "";
    for (let k = 0; k < s.length; k++) {
      if (s[k] === "\\" && s[k + 1] === "|") { cur += "\\|"; k++; continue; }
      if (s[k] === "|") { cells.push(cur.trim()); cur = ""; continue; }
      cur += s[k];
    }
    cells.push(cur.trim());
    return cells;
  }

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    checkBlockStart(line, i);
    if (/^ {4,}\S/.test(line)) fail(i, "indented code blocks are not supported (use a fenced block)");
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      const info = fence[1].trim();
      const start = i;
      const body = [];
      i++;
      while (i < lines.length && lines[i] !== "```") { body.push(lines[i]); i++; }
      if (i >= lines.length) fail(start, "unclosed code block");
      i++;
      const lang = info.split(/\s+/)[0] || "";
      if (!lang) fail(start, "a code block needs a language");
      blocks.push({ type: "code", lang, info, text: body.join("\n"), line: start + 1 });
      continue;
    }
    if (/^ {0,3}~{3}/.test(line)) fail(i, "tilde fences are not supported");
    const heading = /^(#{1,6}) +(.+?) *#* *$/.exec(line);
    if (heading) {
      const inline = parseInline(heading[2], file, i + 1);
      const text = inlineText(inline);
      blocks.push({ type: "heading", level: heading[1].length, inline, text, id: uniqueId(text), line: i + 1 });
      i++; continue;
    }
    if (/^#/.test(line)) fail(i, "a heading needs a space after #");
    if (LIST_ITEM.test(line)) {
      if (LIST_ITEM.exec(line)[1].length > 0) fail(i, "a list must start at the left margin");
      const r = parseList(i);
      blocks.push(r.block);
      i = r.next; continue;
    }
    if (/^\|/.test(line)) {
      const start = i;
      const head = splitRow(line, i);
      if (i + 1 >= lines.length || !/^\|( *:?-+:? *\|)+ *$/.test(lines[i + 1].trim())) fail(i, "a table needs a separator row");
      const sep = splitRow(lines[i + 1], i + 1);
      if (sep.length !== head.length) fail(i + 1, "the separator row has another number of cells");
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        const cells = splitRow(lines[i], i);
        if (cells.length !== head.length) fail(i, `a row with ${cells.length} cells in a table of ${head.length}`);
        rows.push(cells.map((c) => parseInline(c, file, i + 1)));
        i++;
      }
      blocks.push({ type: "table", head: head.map((c) => parseInline(c, file, start + 1)), rows, line: start + 1 });
      continue;
    }
    // paragraph: until a blank line or another block
    const start = i;
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(```|#{1,6} |\|)/.test(lines[i]) && !(LIST_ITEM.test(lines[i]) && para.length === 0)) {
      if (i > start && LIST_ITEM.test(lines[i])) fail(i, "a list must be separated from a paragraph by a blank line");
      if (i > start && /^(=+|-+) *$/.test(lines[i])) fail(i, "setext headings are not supported");
      checkBlockStart(lines[i], i);
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "paragraph", inline: parseInline(para.join(" "), file, start + 1), line: start + 1 });
  }
  return blocks;
}

/** Every link target of a block list, with its line. */
function links(blocks) {
  const out = [];
  const walkInline = (tokens, line) => { for (const k of tokens) { if (k.t === "link") out.push({ href: k.href, line }); if (k.children) walkInline(k.children, line); } };
  const walk = (bs) => {
    for (const b of bs) {
      if (b.type === "heading" || b.type === "paragraph") walkInline(b.inline, b.line);
      else if (b.type === "list") for (const it of b.items) walk(it.blocks);
      else if (b.type === "table") { walkInline(b.head.flat(), b.line); for (const r of b.rows) for (const c of r) walkInline(c, b.line); }
    }
  };
  walk(blocks);
  return out;
}

module.exports = { parse, parseInline, inlineText, inlineHtml, escapeHtml, slug, links, MarkdownError };

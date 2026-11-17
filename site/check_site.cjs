"use strict";
// Checks the built guide site (default build/site/): every page of the guide exists; every page has the
// strict policy in its head, one level-1 heading, headings without skipped levels, unique ids, a skip
// link to #main, no script, no style attribute or element, no event handler attribute, no absolute or
// protocol-relative path, no http:// at all and https:// only as the target of a link (<a href>); every
// relative link and every anchor resolves; the stylesheets load nothing from elsewhere.
// Usage: node site/check_site.cjs [--site <dir>]
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const GUIDE = path.join(ROOT, "docs", "guide");
const POLICY = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'";

function main() {
  const a = process.argv.slice(2);
  const si = a.indexOf("--site");
  const site = path.resolve(si >= 0 ? a[si + 1] : path.join(ROOT, "build", "site"));
  const failures = [];
  const fail = (f, m) => failures.push(`${f}: ${m}`);

  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(path.relative(site, p).split(path.sep).join("/")); } })(site);
  const pages = files.filter((f) => f.endsWith(".html")).sort();

  // every Markdown file of the guide has its page
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".md")) continue;
      const rel = path.relative(GUIDE, p).split(path.sep).join("/").replace(/(^|\/)README\.md$/, "$1index.html").replace(/\.md$/, ".html");
      if (!pages.includes(rel)) fail(rel, `no page for docs/guide/${path.relative(GUIDE, p)}`);
    }
  })(GUIDE);

  const idsOf = new Map();
  const html = new Map();
  for (const f of pages) {
    const s = fs.readFileSync(path.join(site, f), "utf8");
    html.set(f, s);
    const ids = [...s.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
    const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    if (dup.length) fail(f, "duplicate ids: " + [...new Set(dup)].join(", "));
    idsOf.set(f, new Set(ids));
  }

  let links = 0;
  for (const f of pages) {
    const s = html.get(f);
    if (!s.startsWith("<!doctype html>\n<html lang=\"en\">")) fail(f, "no doctype or no lang");
    if (!s.includes(`<meta http-equiv="Content-Security-Policy" content="${POLICY}">`)) fail(f, "the policy meta element is missing or different");
    if (/<script/i.test(s)) fail(f, "a script element");
    if (/<style/i.test(s)) fail(f, "a style element");
    // attributes are checked inside tags only (code text is escaped, so every "<x" is a real tag)
    const tags = [...s.matchAll(/<[a-z][^>]*>/gi)].map((m) => m[0]);
    if (tags.some((t) => /\sstyle\s*=/i.test(t))) fail(f, "a style attribute");
    if (tags.some((t) => /\son[a-z]+\s*=/i.test(t))) fail(f, "an event handler attribute");
    if (/<(iframe|object|embed|img|video|audio|source|form|input|base)\b/i.test(s)) fail(f, "an element the site does not use");
    if (/javascript:/i.test(s)) fail(f, "a javascript: URL");
    if (/http:\/\//i.test(s.replace(/<code>[\s\S]*?<\/code>/g, ""))) fail(f, "http:// outside code");
    if (!s.includes('<a class="lt-skip-link" href="#main">') || !idsOf.get(f).has("main")) fail(f, "no skip link to #main");
    const h1 = (s.match(/<h1[\s>]/g) || []).length;
    if (h1 !== 1) fail(f, `${h1} level-1 headings`);
    let level = 0;
    for (const m of s.matchAll(/<h([1-6])[\s>]/g)) {
      const l = Number(m[1]);
      if (level && l > level + 1) fail(f, `heading level ${l} after ${level}`);
      level = l;
    }
    // every URL-bearing attribute
    for (const m of s.matchAll(/<([a-z]+)\b([^>]*)>/gi)) {
      const tag = m[1].toLowerCase();
      for (const at of m[2].matchAll(/\s(href|src|srcset|action|poster|data|formaction|xlink:href)="([^"]*)"/gi)) {
        const name = at[1].toLowerCase();
        const v = at[2].replace(/&amp;/g, "&");
        if (/^https:\/\//i.test(v)) { if (!(tag === "a" && name === "href")) fail(f, `https:// in <${tag} ${name}>: a resource from elsewhere`); continue; }
        if (/^[a-z][a-z0-9+.-]*:/i.test(v)) { fail(f, `URL scheme in <${tag} ${name}="${v}">`); continue; }
        if (v.startsWith("/")) { fail(f, `absolute or protocol-relative path in <${tag} ${name}="${v}">`); continue; }
        links++;
        const [target, frag] = v.split("#");
        const resolved = target === "" ? f : path.posix.normalize(path.posix.join(path.posix.dirname(f), target));
        if (resolved.startsWith("..") || !files.includes(resolved)) { fail(f, `broken link ${v}`); continue; }
        if (frag !== undefined && frag !== "") {
          if (!resolved.endsWith(".html")) fail(f, `an anchor on a file that is not a page: ${v}`);
          else if (!idsOf.get(resolved).has(frag)) fail(f, `broken anchor ${v}`);
        }
      }
    }
    // https:// is allowed as text (code shows addresses) and as a link target, nowhere else
    const outsideText = s.replace(/<code>[\s\S]*?<\/code>/g, "").replace(/<a\b[^>]*\shref="https:\/\/[^"]*"/g, "<a");
    for (const m of outsideText.matchAll(/<[^>]*https:\/\/[^>]*>/g)) fail(f, "https:// inside a tag that is not a link: " + m[0].slice(0, 80));
  }

  for (const f of files.filter((x) => x.endsWith(".css"))) {
    const s = fs.readFileSync(path.join(site, f), "utf8");
    if (/@import|https?:|url\(\s*["']?(\/|data:)/i.test(s)) fail(f, "a stylesheet that loads something from elsewhere or uses an absolute path");
  }

  console.log(`site check: ${pages.length} pages, ${files.length - pages.length} other files, ${links} relative links and anchors checked`);
  for (const f of pages) console.log(`  ${f} ${fs.statSync(path.join(site, f)).size} bytes`);
  if (failures.length) { console.log(`${failures.length} failure(s):`); for (const x of failures) console.log("- " + x); process.exit(1); }
  console.log("site check passed");
}

try { main(); } catch (e) { console.error("site check failed: " + (e && e.message)); process.exit(1); }

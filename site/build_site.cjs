"use strict";
// Builds the static guide site from docs/guide/ into an output directory (default build/site/):
// one page per Markdown file, the house stylesheet and the site's assets, no JavaScript in any page.
// Usage: node site/build_site.cjs [--out <dir>]
// The pages use relative links only, so the site works under any sub-path (GitHub Pages serves it under
// /myzephyr-ts/). Links to guide files become links to their pages; links to other files of the
// repository become links to them on GitHub. The footer names the package version and the commit the
// site was built from. The Markdown converter (site/markdown.cjs) fails on anything it does not know.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const md = require("./markdown.cjs");

const ROOT = path.resolve(__dirname, "..");
const GUIDE = path.join(ROOT, "docs", "guide");
const REPO_URL = "https://github.com/loki-notfound/myzephyr-ts";
const POLICY = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'";
const ASSETS = ["content.css", "print.css", "site.css", "favicon.svg", "favicon-32.png", "apple-touch-icon-180.png",
  "STYLE-VERSION", "NOTICE.txt", "LICENSE-style.txt", "TRADEMARKS.txt"];

// the page order: the guide's index, the chapters, then the reference
const ORDER = ["README.md", ...fs.readdirSync(GUIDE).filter((f) => /^\d\d-.*\.md$/.test(f)).sort(),
  "reference/README.md", "reference/functions.md", "reference/wallet.md", "reference/daemon.md", "reference/types.md", "reference/errors.md"];

const esc = md.escapeHtml;
const outName = (rel) => rel.replace(/(^|\/)README\.md$/, "$1index.html").replace(/\.md$/, ".html");
const CODE_LABELS = { ts: "TypeScript", typescript: "TypeScript", js: "JavaScript", javascript: "JavaScript", sh: "Shell", text: "Text" };

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", env: Object.assign({}, process.env, { TZ: "UTC" }) }).trim();
}

function main() {
  const a = process.argv.slice(2);
  const oi = a.indexOf("--out");
  const out = path.resolve(oi >= 0 ? a[oi + 1] : path.join(ROOT, "build", "site"));
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const commit = git(["rev-parse", "--short=8", "HEAD"]);
  const date = git(["log", "-1", "--format=%cd", "--date=format-local:%Y-%m-%d"]);
  const dirty = git(["status", "--porcelain", "--", "docs/guide", "site"]) !== "";

  const all = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".md")) all.push(path.relative(GUIDE, p).split(path.sep).join("/")); } })(GUIDE);
  const missing = all.filter((f) => !ORDER.includes(f));
  if (missing.length) throw new Error("guide files without a place in the page order: " + missing.join(", "));

  // parse every page first: titles and heading ids are needed for links between pages
  const pages = ORDER.map((rel) => {
    const blocks = md.parse(fs.readFileSync(path.join(GUIDE, rel), "utf8"), "docs/guide/" + rel);
    const h1 = blocks.filter((b) => b.type === "heading" && b.level === 1);
    if (h1.length !== 1 || blocks[0] !== h1[0]) throw new Error(`docs/guide/${rel}: a page starts with its one level-1 heading`);
    let level = 1;
    for (const b of blocks) if (b.type === "heading") { if (b.level > level + 1) throw new Error(`docs/guide/${rel}:${b.line}: heading level ${b.level} after ${level}`); level = b.level; }
    return { rel, out: outName(rel), blocks, title: h1[0].text, ids: new Set(blocks.filter((b) => b.type === "heading").map((b) => b.id)) };
  });
  const byRel = new Map(pages.map((p) => [p.rel, p]));

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, "assets"), { recursive: true });
  fs.mkdirSync(path.join(out, "reference"), { recursive: true });
  for (const f of ASSETS) fs.copyFileSync(path.join(__dirname, "assets", f), path.join(out, "assets", f));

  for (const [n, page] of pages.entries()) {
    const html = renderPage(page, n, pages, byRel, { version, commit, date, dirty });
    fs.writeFileSync(path.join(out, page.out), html);
  }
  console.log(`site: ${pages.length} pages and ${ASSETS.length} assets in ${path.relative(ROOT, out) || out} (version ${version}, commit ${commit}${dirty ? " with local changes" : ""}, ${date})`);
}

function relLink(fromOut, toOut) {
  const r = path.posix.relative(path.posix.dirname(fromOut), toOut);
  return r === "" ? path.posix.basename(toOut) : r;
}

function renderPage(page, n, pages, byRel, meta) {
  const root = page.out.includes("/") ? "../" : "";
  const where = `docs/guide/${page.rel}`;
  const resolveLink = (href) => {
    if (/^https:\/\//.test(href)) return href;
    if (/^[a-z]+:/i.test(href) || href.startsWith("//") || href.startsWith("/")) throw new Error(`${where}: link "${href}" must be https:// or relative`);
    const [target, frag] = href.split("#");
    if (target === "") {
      if (!page.ids.has(frag)) throw new Error(`${where}: no heading #${frag} on this page`);
      return "#" + frag;
    }
    const guideRel = path.posix.normalize(path.posix.join(path.posix.dirname(page.rel), target));
    if (byRel.has(guideRel)) {
      const to = byRel.get(guideRel);
      if (frag !== undefined && !to.ids.has(frag)) throw new Error(`${where}: no heading #${frag} in ${guideRel}`);
      return relLink(page.out, to.out) + (frag !== undefined ? "#" + frag : "");
    }
    const repoRel = path.posix.normalize(path.posix.join("docs/guide", path.posix.dirname(page.rel), target));
    if (repoRel.startsWith("..") || !fs.existsSync(path.join(ROOT, repoRel))) throw new Error(`${where}: link target ${repoRel} does not exist`);
    if (repoRel.startsWith("docs/guide/")) throw new Error(`${where}: ${repoRel} is in the guide but has no page`);
    return `${REPO_URL}/blob/main/${repoRel}` + (frag !== undefined ? "#" + frag : "");
  };

  let lastHeadingId = "";
  const blockHtml = (b) => {
    switch (b.type) {
      case "heading": {
        lastHeadingId = b.id;
        if (b.level === 1) return `<h1 id="${b.id}">${md.inlineHtml(b.inline, resolveLink)}</h1>`;
        return `<h${b.level} id="${b.id}">${md.inlineHtml(b.inline, resolveLink)}<a class="heading-anchor" href="#${b.id}" aria-label="Link to this section">#</a></h${b.level}>`;
      }
      case "paragraph": return `<p>${md.inlineHtml(b.inline, resolveLink)}</p>`;
      case "list": {
        const tag = b.ordered ? "ol" : "ul";
        return `<${tag}>${b.items.map((it) => `<li>${it.blocks.map((x) => (x.type === "paragraph" ? md.inlineHtml(x.inline, resolveLink) : blockHtml(x))).join("")}</li>`).join("")}</${tag}>`;
      }
      case "table": {
        const head = b.head.map((c) => `<th scope="col">${md.inlineHtml(c, resolveLink)}</th>`).join("");
        const rows = b.rows.map((r) => `<tr>${r.map((c) => `<td>${md.inlineHtml(c, resolveLink)}</td>`).join("")}</tr>`).join("\n");
        return `<div class="lt-table-scroll" tabindex="0" role="region" aria-labelledby="${lastHeadingId}">\n<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>\n</div>`;
      }
      case "code": {
        const flags = b.info.slice(b.lang.length).trim();
        let label = CODE_LABELS[b.lang];
        if (label === undefined) throw new Error(`${where}:${b.line}: unknown code language ${b.lang}`);
        if (flags === "signature") label = "Declaration";
        else if (flags === "run") label += ", checked and run offline";
        else if (/^(ts|typescript|js|javascript)$/.test(b.lang)) label += ", checked";
        return `<div class="lt-code-block">\n<div class="lt-code-head"><span>${esc(label)}</span></div>\n<pre><code>${esc(b.text)}</code></pre>\n</div>`;
      }
      default: throw new Error("unknown block");
    }
  };
  const body = page.blocks.map(blockHtml).join("\n");

  // navigation: every page, and the level-2 headings of this page
  const isRef = (p) => p.rel.startsWith("reference/");
  const navItem = (p) => `<li><a href="${relLink(page.out, p.out)}"${p === page ? ' aria-current="page"' : ""}>${esc(p.title)}</a></li>`;
  const guideNav = pages.filter((p) => !isRef(p)).map(navItem).join("\n");
  const refNav = pages.filter(isRef).map(navItem).join("\n");
  const toc = page.blocks.filter((b) => b.type === "heading" && b.level === 2).map((b) => `<li><a href="#${b.id}">${esc(b.text)}</a></li>`).join("\n");
  const prev = n > 0 ? pages[n - 1] : undefined;
  const next = n < pages.length - 1 ? pages[n + 1] : undefined;
  const pager = [
    prev ? `<a class="site-prev" rel="prev" href="${relLink(page.out, prev.out)}">Previous: ${esc(prev.title)}</a>` : "",
    next ? `<a class="site-next" rel="next" href="${relLink(page.out, next.out)}">Next: ${esc(next.title)}</a>` : ""
  ].join("\n");
  const crumbs = isRef(page) && page.rel !== "reference/README.md"
    ? `<nav class="lt-breadcrumbs" aria-label="Breadcrumb"><ol><li><a href="${relLink(page.out, "index.html")}">Guide</a></li><li><a href="${relLink(page.out, "reference/index.html")}">API reference</a></li><li><a href="${relLink(page.out, page.out)}" aria-current="page">${esc(page.title)}</a></li></ol></nav>\n`
    : "";
  const title = page.rel === "README.md" ? "zephyr-ts guide" : `${page.title} - zephyr-ts guide`;
  const first = page.blocks.find((b) => b.type === "paragraph");
  const description = first ? md.inlineText(first.inline).slice(0, 200) : page.title;
  const built = `Guide for zephyr-ts ${esc(meta.version)}, built from commit <code>${esc(meta.commit)}</code>${meta.dirty ? " with local changes" : ""} (${esc(meta.date)} UTC).`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${esc(POLICY)}">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" href="${root}assets/favicon.svg" type="image/svg+xml">
<link rel="icon" href="${root}assets/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="${root}assets/apple-touch-icon-180.png">
<link rel="stylesheet" href="${root}assets/content.css">
<link rel="stylesheet" href="${root}assets/print.css">
<link rel="stylesheet" href="${root}assets/site.css">
</head>
<body>
<a class="lt-skip-link" href="#main">Skip to main content</a>
<nav class="lt-family-bar" aria-label="Site navigation">
  <div class="lt-family-bar-inner">
    <a class="lt-family-brand" href="https://lateo.dev/" data-product="home">
      <svg class="lt-family-mark" viewBox="0 0 64 64" width="16" height="16" fill="none" aria-hidden="true">
        <path d="M 8 24 H 16 V 48 H 40 V 56 H 16 C 11.58 56 8 52.42 8 48 Z" fill="currentColor"/>
        <path d="M 24 8 H 48 C 52.42 8 56 11.58 56 16 V 40 H 48 V 16 H 24 Z" fill="currentColor"/>
        <rect x="24" y="24" width="16" height="16" rx="3" fill="currentColor"/>
      </svg>
      <span>lateo</span>
    </a>
    <ul class="lt-family-links">
      <li><a class="lt-family-link" href="${relLink(page.out, "index.html")}"${isRef(page) ? "" : ' aria-current="page"'}>Guide</a></li>
      <li><a class="lt-family-link" href="${relLink(page.out, "reference/index.html")}"${isRef(page) ? ' aria-current="page"' : ""}>API reference</a></li>
      <li><a class="lt-family-link" href="${REPO_URL}">Repository</a></li>
      <li><a class="lt-family-link" href="${REPO_URL}/releases">Releases</a></li>
    </ul>
  </div>
</nav>
<header class="lt-header">
  <div class="lt-wrap lt-wrap-wide lt-header-inner">
    <div class="site-title">
      <a class="lt-brand" href="${relLink(page.out, "index.html")}">zephyr-ts</a>
      <p class="site-tagline">TypeScript wallet library for Zephyr, a lateo project</p>
    </div>
  </div>
</header>
<main id="main" tabindex="-1">
<div class="lt-wrap lt-wrap-wide lt-docs-layout">
<aside class="lt-toc" aria-label="Guide navigation">
<h2 id="site-nav-guide">Guide</h2>
<nav aria-labelledby="site-nav-guide">
<ol>
${guideNav}
</ol>
</nav>
<h2 id="site-nav-reference">API reference</h2>
<nav aria-labelledby="site-nav-reference">
<ol>
${refNav}
</ol>
</nav>
${toc ? `<h2 id="site-nav-page">On this page</h2>\n<nav aria-labelledby="site-nav-page">\n<ol>\n${toc}\n</ol>\n</nav>\n` : ""}</aside>
<article class="lt-docs-main lt-stack">
${crumbs}${body}
<nav class="site-pager" aria-label="Previous and next page">
${pager}
</nav>
</article>
</div>
</main>
<footer class="lt-footer">
<div class="lt-wrap lt-wrap-wide">
<p>${built}</p>
<p>zephyr-ts and this site are a <a href="https://lateo.dev/">lateo</a> project by an independent operator, not affiliated with or endorsed by ZephyrProtocol. Source: <a href="${REPO_URL}">github.com/loki-notfound/myzephyr-ts</a>.</p>
<p>The library and the guide are under the MIT license of the repository; the stylesheet is BSD 3-Clause; the lateo name, mark and favicons are not covered by either and all rights in them are reserved by their owner (<a href="${root}assets/NOTICE.txt">notice</a>).</p>
</div>
</footer>
</body>
</html>
`;
}

try { main(); } catch (e) { console.error("site build failed: " + (e && e.message)); process.exit(1); }

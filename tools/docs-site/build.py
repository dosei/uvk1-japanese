#!/usr/bin/env python3
"""Build the searchable docs site from the GitHub Wiki.

GitHub serves wiki pages with "X-Robots-Tag: none" (only wikis with 500+
stars and restricted editing are indexed), so the wiki itself never shows up
in search results. This script converts the wiki's Markdown into static HTML
under <out>/docs/ so that GitHub Pages can publish an indexable copy, and
writes <out>/sitemap.xml. The wiki stays the single source of the text.

Handles the GitHub Wiki dialect used by the RxJa wiki:
  [[Page]], [[Text|Page]], [[Page#Heading]]   links between pages
  > [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]   alerts
  _Sidebar.md, _Footer.md   navigation and footer on every page
  images/...   copied to docs/images/
Heading ids follow GitHub's rule, so links like [[はじめに#対応機種]] work.

Usage: build.py WIKI_DIR OUT_DIR
  WIKI_DIR  a clone of the wiki repository (full history for <lastmod>)
  OUT_DIR   the Pages site root (docs/ and sitemap.xml are written into it)
"""

import datetime
import html
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from urllib.parse import quote, unquote

from markdown_it import MarkdownIt

SITE_URL = "https://dosei.github.io/uvk1-japanese/"
SITE_NAME = "UVK1-RxJa"
TITLE_SUFFIX = "UVK1-RxJa（UV-K1 受信専用・日本語化ファーム）"
HOME = "Home"
HERE = os.path.dirname(os.path.abspath(__file__))

ALERTS = {
    "NOTE": "補足",
    "TIP": "ヒント",
    "IMPORTANT": "重要",
    "WARNING": "注意",
    "CAUTION": "警告",
}


def page_file(page):
    """Output file name (relative to docs/) for a wiki page name."""
    return "index.html" if page == HOME else page + ".html"


def page_url(page):
    """Absolute, percent-encoded URL of a page."""
    return SITE_URL + "docs/" + ("" if page == HOME else quote(page) + ".html")


def page_href(page, anchor=""):
    """Link from one docs page to another (all pages share docs/)."""
    href = "./" if page == HOME else quote(page) + ".html"
    return href + ("#" + quote(anchor) if anchor else "")


def github_slug(text, seen):
    """Heading id the way GitHub makes it: lower case, drop punctuation
    (keep letters, marks, decimal digits, '_', '-' and spaces; so circled
    numbers like ① go), spaces -> '-',
    and number repeated ids -1, -2, ..."""
    text = text.strip().lower()
    out = []
    for ch in text:
        cat = unicodedata.category(ch)
        if ch == " ":
            out.append("-")
        elif ch == "-" or cat[0] in "LM" or cat in ("Nd", "Pc"):
            out.append(ch)
    slug = "".join(out)
    n = seen.get(slug, 0)
    seen[slug] = n + 1
    return slug if n == 0 else f"{slug}-{n}"


class Wiki:
    def __init__(self, wiki_dir):
        self.dir = wiki_dir
        self.pages = sorted(
            f[:-3] for f in os.listdir(wiki_dir)
            if f.endswith(".md") and not f.startswith("_")
        )
        # Gollum matches page names case-insensitively, with spaces as '-'.
        self.lookup = {p.lower(): p for p in self.pages}
        self.missing = []
        self.md = MarkdownIt("gfm-like", {"html": True, "linkify": True})
        # Like GitHub, autolink only www. and http(s):// (not "upload.py").
        self.md.linkify.set({"fuzzy_link": False})

    def read(self, name):
        with open(os.path.join(self.dir, name + ".md"), encoding="utf-8") as f:
            return f.read()

    def resolve(self, target):
        page, _, anchor = target.partition("#")
        key = page.strip().replace(" ", "-").lower()
        if not key:
            return None, anchor
        return self.lookup.get(key), anchor

    def wiki_links(self, text, current):
        """Replace [[...]] with Markdown links (outside code)."""

        def repl(m):
            body = m.group(1)
            label, sep, target = body.partition("|")
            if not sep:
                # [[Page#Heading]] reads as "Page#Heading" on GitHub too.
                label = target = body
            page, anchor = self.resolve(target)
            if target.startswith("#"):
                href = "#" + quote(target[1:])
            elif page is None:
                self.missing.append((current, body))
                return label
            else:
                href = page_href(page, anchor)
            return f"[{label}]({href})"

        out = []
        for chunk in re.split(r"(```.*?```|`[^`\n]*`)", text, flags=re.S):
            if chunk.startswith("`"):
                out.append(chunk)
            else:
                out.append(re.sub(r"\[\[([^\]\n]+)\]\]", repl, chunk))
        return "".join(out)

    def render(self, text, current):
        text = self.wiki_links(text, current)
        tokens = self.md.parse(text)
        seen = {}
        title = None
        description = None
        for i, tok in enumerate(tokens):
            if tok.type == "heading_open":
                inline = tokens[i + 1]
                plain = inline_text(inline)
                tok.attrSet("id", github_slug(plain, seen))
                if tok.tag == "h1" and title is None:
                    title = plain
            elif (tok.type == "paragraph_open" and description is None
                  and tok.level == 0):
                plain = inline_text(tokens[i + 1])
                if plain:
                    description = plain
        body = self.md.renderer.render(tokens, self.md.options, {})
        body = alerts(body)
        body = re.sub(r"<table>", '<div class="table-wrap"><table>', body)
        body = re.sub(r"</table>", "</table></div>", body)
        body = rewrite_links(body)
        body = self.page_links(body)
        return body, title, description

    def page_links(self, body):
        """Plain Markdown links to a wiki page, [text](Page#Heading)."""

        def repl(m):
            path, anchor = m.group(1), m.group(2) or ""
            page, _ = self.resolve(unquote(path))
            if page is None:
                return m.group(0)
            return 'href="' + page_href(page) + anchor + '"'

        return re.sub(r'href="(?![a-z][a-z0-9+.-]*:|[#./])([^"#]+)(#[^"]*)?"',
                      repl, body)


def inline_text(inline):
    """Plain text of an inline token (for ids, titles and descriptions)."""
    parts = []
    for child in inline.children or []:
        if child.type in ("text", "code_inline"):
            parts.append(child.content)
        elif child.type in ("softbreak", "hardbreak"):
            parts.append(" ")
        elif child.type == "image":
            parts.append(child.content)
    return re.sub(r"\s+", " ", "".join(parts)).strip()


def alerts(body):
    """GitHub alerts: a blockquote whose first line is [!TYPE]."""

    def repl(m):
        kind = m.group(1)
        rest = m.group(2)
        head = (f'<blockquote class="alert alert-{kind.lower()}">\n'
                f'<p class="alert-title">{ALERTS[kind]}</p>\n')
        if rest.startswith("</p>"):
            return head + rest[len("</p>"):].lstrip("\n")
        return head + "<p>" + rest.lstrip("\n")

    pattern = r"<blockquote>\n<p>\[!(" + "|".join(ALERTS) + r")\]((?:</p>|\n)?)"
    return re.sub(pattern, repl, body)


def rewrite_links(body):
    """Links into the wiki itself point at the docs copy instead."""

    def repl(m):
        page = (m.group(1) or "").strip("/")
        return 'href="' + (page + ".html" if page else "./") + (m.group(2) or "") + '"'

    return re.sub(r'href="https://github\.com/dosei/uvk1-japanese/wiki(/[^"#]*)?(#[^"]*)?"',
                  repl, body)


def shorten(text, limit=120):
    """Cut a description at a full stop outside brackets, dropping
    bracketed asides first if that is what it takes to fit."""

    def cut(t):
        depth, stop = 0, -1
        for i, ch in enumerate(t[:limit]):
            if ch in "（(「":
                depth += 1
            elif ch in "）)」":
                depth = max(0, depth - 1)
            elif ch == "。" and depth == 0:
                stop = i
        return t[:stop + 1] if stop >= limit // 2 else None

    if len(text) <= limit:
        return text
    plain = re.sub(r"（[^（）]*）", "", text)
    return cut(text) or cut(plain) or text[:limit].rstrip() + "…"


def lastmod(wiki_dir, name):
    try:
        out = subprocess.run(
            ["git", "-C", wiki_dir, "log", "-1", "--format=%cI", "--", name + ".md"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        out = ""
    return out or datetime.datetime.now(datetime.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ")


def mark_current(nav, page):
    href = re.escape('href="' + page_href(page) + '"')
    return re.sub(href, r'\g<0> aria-current="page"', nav, count=1)


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    wiki_dir, out_dir = sys.argv[1], sys.argv[2]
    wiki = Wiki(wiki_dir)
    if HOME not in wiki.pages:
        sys.exit(f"{wiki_dir}: no {HOME}.md")

    docs = os.path.join(out_dir, "docs")
    if os.path.isdir(docs):
        shutil.rmtree(docs)
    os.makedirs(docs)

    with open(os.path.join(HERE, "template.html"), encoding="utf-8") as f:
        template = f.read()

    nav, _, _ = wiki.render(wiki.read("_Sidebar"), "_Sidebar")
    footer = ""
    if os.path.exists(os.path.join(wiki_dir, "_Footer.md")):
        footer, _, _ = wiki.render(wiki.read("_Footer"), "_Footer")

    sitemap = [(SITE_URL, lastmod(wiki_dir, HOME))]
    for page in wiki.pages:
        body, title, description = wiki.render(wiki.read(page), page)
        title = title or page.replace("-", " ")
        full_title = title if page == HOME else f"{title} | {TITLE_SUFFIX}"
        description = shorten(description or title)
        values = {
            "title": html.escape(full_title),
            "description": html.escape(description, quote=True),
            "canonical": html.escape(page_url(page), quote=True),
            "site_name": SITE_NAME,
            "og_type": "website" if page == HOME else "article",
            "nav": mark_current(nav, page),
            "body": body,
            "footer": footer,
            "wiki_url": html.escape(
                "https://github.com/dosei/uvk1-japanese/wiki"
                + ("" if page == HOME else "/" + quote(page)), quote=True),
        }
        out = re.sub(r"\{\{(\w+)\}\}", lambda m: values[m.group(1)], template)
        with open(os.path.join(docs, page_file(page)), "w", encoding="utf-8") as f:
            f.write(out)
        sitemap.append((page_url(page), lastmod(wiki_dir, page)))

    for name in ("style.css",):
        shutil.copy(os.path.join(HERE, name), os.path.join(docs, name))
    images = os.path.join(wiki_dir, "images")
    if os.path.isdir(images):
        shutil.copytree(images, os.path.join(docs, "images"))

    with open(os.path.join(out_dir, "sitemap.xml"), "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n')
        for loc, mod in sitemap:
            f.write(f"  <url><loc>{html.escape(loc)}</loc>"
                    f"<lastmod>{mod}</lastmod></url>\n")
        f.write("</urlset>\n")

    print(f"{len(wiki.pages)} pages -> {docs}, sitemap: {len(sitemap)} URLs")
    if wiki.missing:
        for page, link in wiki.missing:
            print(f"error: {page}: [[{link}]] links to no page", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

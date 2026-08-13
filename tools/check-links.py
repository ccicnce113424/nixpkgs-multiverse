#!/usr/bin/env python3
"""Check that every in-repository markdown link resolves.

Two renderers read the same files — GitHub, and tools/render-docs.py for the
website — and both turn a heading into an anchor the same way. A link that is
wrong here is wrong in both places, and the failure is silent: the browser
scrolls to the top of the page instead of erroring. Renaming a heading or a
page is the usual cause.

Checked, for README.md and docs/*.md:

  * `#anchor`            — a heading in the same file
  * `./page.md`          — a file that exists
  * `./page.md#anchor`   — a heading in that file

Usage: check-links.py <file>...
"""

import os
import re
import sys

# Fenced code blocks hold shell comments that start with `#`, which would
# otherwise be read as headings.
FENCE = re.compile(r"^\s*```")
HEADING = re.compile(r"^#{1,6}\s+(.*)$", re.M)
LINK = re.compile(r"\]\(([^)\s]+)\)")


def strip_fences(text):
    out, fenced = [], False
    for line in text.split("\n"):
        if FENCE.match(line):
            fenced = not fenced
            continue
        if not fenced:
            out.append(line)
    return "\n".join(out)


def slug(text):
    """GitHub's heading-anchor algorithm. Must stay identical to slug() in
    tools/render-docs.py, which stamps the ids this checks against."""
    text = text.strip().lower()
    text = re.sub(r"[^\w\s-]", "", text)
    return re.sub(r"\s+", "-", text)


def anchors_of(text):
    """Every anchor a file offers, with GitHub's numeric suffix for repeats."""
    seen, out = {}, set()
    for heading in HEADING.findall(strip_fences(text)):
        # Inline markup is not part of the anchor: `## The `mvs` CLI` is
        # `the-mvs-cli`.
        base = slug(re.sub(r"[`*_]", "", heading))
        n = seen.get(base, 0)
        seen[base] = n + 1
        out.add(base if n == 0 else f"{base}-{n}")
    return out


def main():
    paths = sys.argv[1:]
    if not paths:
        sys.exit("usage: check-links.py <file>...")

    texts = {p: open(p).read() for p in paths}
    anchors = {p: anchors_of(t) for p, t in texts.items()}
    problems = []

    for path, text in texts.items():
        base = os.path.dirname(path)
        for link in LINK.findall(strip_fences(text)):
            # External links and mailto: are somebody else's problem.
            if re.match(r"[a-z]+:", link):
                continue

            target, _, anchor = link.partition("#")

            if not target:
                if anchor not in anchors[path]:
                    problems.append(f"{path}: #{anchor} — no such heading")
                continue

            resolved = os.path.normpath(os.path.join(base, target))
            if not os.path.exists(resolved):
                problems.append(f"{path}: {link} — no such file")
                continue

            if not anchor or not resolved.endswith(".md"):
                continue

            # A link into a file this run was not asked to check would be
            # checked against an empty anchor set, so read it now.
            if resolved not in anchors:
                anchors[resolved] = anchors_of(open(resolved).read())
            if anchor not in anchors[resolved]:
                problems.append(f"{path}: {link} — no such heading in {resolved}")

    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        sys.exit(f"{len(problems)} broken link(s)")
    print(f"checked {len(paths)} files, all links resolve")


if __name__ == "__main__":
    main()

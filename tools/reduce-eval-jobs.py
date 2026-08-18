#!/usr/bin/env python3
"""Reduce one nix-eval-jobs run to the per-revision file the join reads.

nix-eval-jobs emits a JSON line per top-level attribute: either its outputs
(full store paths, plus drvPath and the derivation's `name`) or the error that
attribute raised. Both are far larger than the join needs, so this collapses a
run into

  {rev, system, attrCount, errorCount, attrs: {<attr>: {name, outputs}}}

where `name` is the store-path basename of the `out` output — NOT the reported
`name`, which is the derivation's `name` attribute and differs for anything
built through a namePrefix (`fabric-3.2.2` reported against a
`python3.13-fabric-3.2.2` store path).

An output is stored as its bare 32-character digest, since Nix names an output
path `<drv name>` for `out` and `<drv name>-<output>` for the rest, so the
basename is reconstructible from `name`. The handful of derivations that do not
follow that (sagetex has no `out` output at all) store the whole
`<digest>-<basename>` instead; a value longer than a digest is that case.
"""
import argparse
import json
import os
import sys

STORE_PREFIX = "/nix/store/"
DIGEST_LEN = 32
# How much of an attribute's error to keep. The full text is a stack trace of a
# few kB; what a validation run wants is the last `error:` line.
ERROR_CHARS = 200


def split_base(path):
    """/nix/store/<digest>-<name> -> (digest, name)."""
    base = path[len(STORE_PREFIX) :]
    return base[:DIGEST_LEN], base[DIGEST_LEN + 1 :]


def short_error(text):
    """The innermost `error:` line of a nix trace, one line, truncated."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip().startswith("error:")]
    msg = lines[-1] if lines else " ".join(text.split())
    return msg[:ERROR_CHARS]


def drv_name(outputs):
    """The store-path name every output of this derivation is built from.

    `out` carries it directly. Without an `out` output, take any output and
    strip the `-<output>` suffix Nix appended to it.
    """
    if "out" in outputs:
        return split_base(outputs["out"])[1]
    output, path = next(iter(sorted(outputs.items())))
    base = split_base(path)[1]
    suffix = "-" + output
    return base[: -len(suffix)] if base.endswith(suffix) else base


def encode(name, output, path):
    """A digest when the path's basename is the conventional one, else the
    whole basename."""
    digest, base = split_base(path)
    expected = name if output == "out" else f"{name}-{output}"
    return digest if base == expected else f"{digest}-{base}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", required=True, help="nix-eval-jobs JSONL, or - for stdin")
    ap.add_argument("--rev", required=True)
    ap.add_argument("--system", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--errors", help="where to write {attr: reason} for failures")
    a = ap.parse_args()

    src = sys.stdin if a.jobs == "-" else open(a.jobs)
    attrs, errors = {}, {}
    for line in src:
        line = line.strip()
        if not line:
            continue
        job = json.loads(line)
        attr = job.get("attr")

        # An attribute that raised keeps no entry: a revision the evaluator
        # could not read is exactly the case the old pipeline used to guess at.
        if "error" in job:
            errors[attr] = short_error(job["error"])
            continue

        outputs = job.get("outputs") or {}
        if not outputs:
            continue
        name = drv_name(outputs)
        attrs[attr] = {
            "name": name,
            "outputs": {o: encode(name, o, p) for o, p in sorted(outputs.items())},
        }

    doc = {
        "rev": a.rev,
        "system": a.system,
        "attrCount": len(attrs),
        "errorCount": len(errors),
        "attrs": attrs,
    }
    with open(a.out + ".tmp", "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    os.replace(a.out + ".tmp", a.out)

    if a.errors:
        with open(a.errors + ".tmp", "w") as f:
            json.dump(errors, f, separators=(",", ":"), indent=0)
        os.replace(a.errors + ".tmp", a.errors)

    print(f"{len(attrs)} attrs, {len(errors)} errors")


if __name__ == "__main__":
    main()

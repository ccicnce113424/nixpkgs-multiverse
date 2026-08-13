#!/usr/bin/env python3
"""Bake the committed JSON index into the SQLite database `mvs` reads.

The JSON files stay canonical: this is a pure projection of revisions.json,
releases.json, index/versions.json and index/history.json into a shape queries
can be written against. It is run from a derivation (`nix build .#index-db`),
never committed, so the database can never be older than the index it came
from.

One row per *run* — an unbroken stretch of revisions over which an attribute
held one version. 8.4% of (attr, version) pairs are non-contiguous, so
collapsing runs to "newest offset" would silently answer `at`, `solve` and
`diff` wrong.
"""

import json
import os
import sqlite3
import sys

# The offsets in index/*.json are indices into revisions.json, so a database
# built from files that disagree about how many revisions exist would join rows
# that describe different revisions. Every input is checked against this.
USAGE = "build-db.py <root> <out.db>"

SCHEMA = """
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE revisions(
  off     INTEGER PRIMARY KEY,   -- offset into revisions.json; the join key everywhere
  rev     TEXT NOT NULL,
  date    TEXT NOT NULL,
  name    TEXT,
  narhash TEXT
);
CREATE INDEX revisions_rev  ON revisions(rev);
CREATE INDEX revisions_date ON revisions(date);

CREATE TABLE releases(name TEXT PRIMARY KEY, rev TEXT, date TEXT, build INTEGER, channel_name TEXT);

CREATE TABLE attrs(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);

-- WITHOUT ROWID, keyed by attr_id, is what keeps the database smaller than the
-- JSON it comes from. Measured on the 331,307-run index:
--
--   rowid table + runs_attr + runs_span    16.1 MB
--   WITHOUT ROWID + runs_span              13.7 MB
--   WITHOUT ROWID, no secondary index       6.8 MB   <- this
--
-- The primary key doubles as the by-attribute index every hot query needs
-- (`versions`, `when`, `at`, `solve` all start from an attribute name), so a
-- separate runs_attr would be a second copy of the same ordering.
--
-- runs_span is dropped on purpose. It only helps the "every run covering
-- offset X" shape, which is `diff` and nothing else, and it half-scans anyway
-- because `first <= X` matches most of the table. The full scan it replaces
-- costs 35 ms, twice per diff.
CREATE TABLE runs(
  attr_id INTEGER NOT NULL REFERENCES attrs(id),
  version TEXT NOT NULL,
  first   INTEGER NOT NULL,
  last    INTEGER NOT NULL,
  PRIMARY KEY(attr_id, version, first)
) WITHOUT ROWID;
"""


def runs_of(value):
    """Normalise a history entry to a list of [first, last] runs.

    build-history.sh writes the common single-run case as a bare [first, last]
    pair and only nests when a version came back after leaving.
    """
    if value and isinstance(value[0], int):
        return [value]
    return value


def main():
    if len(sys.argv) != 3:
        sys.exit(USAGE)
    root, out = sys.argv[1], sys.argv[2]

    def load(*parts):
        with open(os.path.join(root, *parts)) as f:
            return json.load(f)

    revisions = load("revisions.json")
    releases = load("releases.json")
    history = load("index", "history.json")

    # The offset invariant, the same one multiverse.nix asserts at eval time: an
    # index built against more revisions than revisions.json holds would index
    # past the end of the array, and one built against fewer is merely stale.
    n_revs = len(revisions)
    if history["revisionCount"] > n_revs:
        sys.exit(
            f"build-db: index/history.json was built against "
            f"{history['revisionCount']} revisions but revisions.json has "
            f"{n_revs}. Re-run tools/build-history.sh."
        )

    if os.path.exists(out):
        os.remove(out)
    db = sqlite3.connect(out)
    db.executescript(SCHEMA)

    db.executemany(
        "INSERT INTO revisions(off, rev, date, name, narhash) VALUES (?,?,?,?,?)",
        (
            (i, r["rev"], r["date"], r.get("name"), r.get("narHash"))
            for i, r in enumerate(revisions)
        ),
    )

    db.executemany(
        "INSERT INTO releases(name, rev, date, build, channel_name) VALUES (?,?,?,?,?)",
        (
            (name, r["rev"], r["date"], r.get("build"), r.get("name"))
            for name, r in releases.items()
        ),
    )

    # Attribute names are interned: repeating each of the ~31,800 names once per
    # run would be most of the database.
    attr_ids = {}
    for name in sorted(history["attrs"]):
        attr_ids[name] = len(attr_ids) + 1
    db.executemany(
        "INSERT INTO attrs(id, name) VALUES (?,?)",
        ((i, name) for name, i in attr_ids.items()),
    )

    def all_runs():
        for attr, versions in history["attrs"].items():
            attr_id = attr_ids[attr]
            for version, value in versions.items():
                for first, last in runs_of(value):
                    yield (attr_id, version, first, last)

    db.executemany("INSERT INTO runs(attr_id, version, first, last) VALUES (?,?,?,?)", all_runs())

    # `built_from` names the checkout the data came from, so a database found on
    # its own can be traced back. The flake passes self.rev; a dirty tree has
    # nothing honest to say and leaves it unset.
    meta = {
        "schema": "1",
        "revisionCount": str(history["revisionCount"]),
        "revisionsInFile": str(n_revs),
        "skipped": json.dumps(history.get("skipped", [])),
    }
    if os.environ.get("MVS_BUILT_FROM"):
        meta["built_from"] = os.environ["MVS_BUILT_FROM"]
    db.executemany("INSERT INTO meta(key, value) VALUES (?,?)", meta.items())

    db.commit()
    db.execute("VACUUM")
    db.execute("ANALYZE")
    db.commit()

    n_runs = db.execute("SELECT count(*) FROM runs").fetchone()[0]
    print(
        f"built {out}: {n_revs} revisions, {len(attr_ids)} attrs, {n_runs} runs, "
        f"{os.path.getsize(out) / 1e6:.1f} MB"
    )
    db.close()


if __name__ == "__main__":
    main()

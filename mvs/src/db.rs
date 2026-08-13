//! The index, as `mvs` sees it: a SQLite database baked into the binary's own
//! store path at build time.
//!
//! Resolution is deliberately trivial — `--db` for development, otherwise
//! `$MVS_DB`, which the wrapper always sets. No cache directory, no fallback
//! chain, no network. The data version is the flake version.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use rusqlite::Connection;
use serde::Serialize;

/// The environment variable the Nix wrapper sets to the database's store path.
pub const DB_ENV: &str = "MVS_DB";

/// How many characters of a commit hash a revision label carries. The same 12
/// as `multiverse.nix`, so a label printed here feeds straight back into
/// `nix build .#<label>.<attr>`.
pub const LABEL_HASH_LEN: usize = 12;

/// One indexed revision of nixpkgs.
#[derive(Debug, Clone, Serialize)]
pub struct Revision {
    /// Offset into revisions.json — the join key for everything else, and the
    /// only ordering that matters, since revisions are date-ordered.
    pub off: i64,
    pub rev: String,
    pub date: String,
    /// The channel's own name for it, e.g. `nixos-26.05pre…`. Absent for
    /// release commits.
    pub name: Option<String>,
    pub narhash: Option<String>,
    /// `YYYY-MM-DD-<12 hex>`, the handle every other command accepts back.
    pub label: String,
}

/// A release channel's current tip, out of releases.json.
#[derive(Debug, Clone, Serialize)]
pub struct Release {
    pub name: String,
    pub rev: String,
    pub date: String,
    pub build: Option<i64>,
    pub channel_name: Option<String>,
}

/// An unbroken stretch of revisions over which an attribute held one version.
#[derive(Debug, Clone, Serialize)]
pub struct Run {
    pub version: String,
    pub first: i64,
    pub last: i64,
}

pub struct Index {
    conn: Connection,
    /// Number of revisions the history was built against. Runs index into this
    /// prefix, so it — not the length of revisions.json — is what "still
    /// current" is measured against.
    covered: i64,
}

impl Index {
    /// Open the database named by `--db`, or by `$MVS_DB` if that is unset.
    pub fn open(explicit: Option<&Path>) -> Result<Index> {
        let path: PathBuf = match explicit {
            Some(p) => p.to_path_buf(),
            None => std::env::var_os(DB_ENV).map(PathBuf::from).ok_or_else(|| {
                anyhow!(
                    "no index database: ${DB_ENV} is unset and --db was not given.\n\
                         The wrapper built by `nix build .#mvs` always sets it; running the \
                         binary directly needs `--db $(nix build --no-link --print-out-paths \
                         .#index-db)`."
                )
            })?,
        };

        if !path.exists() {
            return Err(anyhow!("index database {} does not exist", path.display()));
        }

        // Read-only, and not merely by convention: this is a store path, and
        // opening it read-write would try to create a -wal beside it.
        let conn = Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )
        .with_context(|| format!("opening index database {}", path.display()))?;

        let covered: i64 = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'revisionCount'",
                [],
                |r| r.get::<_, String>(0),
            )
            .context("reading revisionCount from the index database")?
            .parse()
            .context("revisionCount is not a number")?;

        Ok(Index { conn, covered })
    }

    /// The newest offset the history index covers. Runs never point past it,
    /// and a version whose run ends here is still current.
    pub fn covered_tip(&self) -> i64 {
        self.covered - 1
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .ok())
    }

    fn revision_from_row(row: &rusqlite::Row) -> rusqlite::Result<Revision> {
        let off: i64 = row.get(0)?;
        let rev: String = row.get(1)?;
        let date: String = row.get(2)?;
        let label = format!("{date}-{}", &rev[..LABEL_HASH_LEN]);
        Ok(Revision {
            off,
            rev,
            date,
            name: row.get(3)?,
            narhash: row.get(4)?,
            label,
        })
    }

    const REVISION_COLUMNS: &'static str = "off, rev, date, name, narhash";

    pub fn revision(&self, off: i64) -> Result<Revision> {
        let sql = format!(
            "SELECT {} FROM revisions WHERE off = ?1",
            Self::REVISION_COLUMNS
        );
        self.conn
            .query_row(&sql, [off], Self::revision_from_row)
            .with_context(|| format!("no revision at offset {off}"))
    }

    /// First revision whose commit hash starts with `prefix`.
    pub fn revision_by_prefix(&self, prefix: &str) -> Result<Option<Revision>> {
        let sql = format!(
            "SELECT {} FROM revisions WHERE rev >= ?1 AND rev < ?1 || 'g' ORDER BY off LIMIT 1",
            Self::REVISION_COLUMNS
        );
        Ok(self
            .conn
            .query_row(&sql, [prefix], Self::revision_from_row)
            .ok())
    }

    /// Newest revision dated on or before `date`, which is what a date selector
    /// means: the tree you would have got that day.
    pub fn revision_on_or_before(&self, date: &str) -> Result<Option<Revision>> {
        let sql = format!(
            "SELECT {} FROM revisions WHERE date <= ?1 ORDER BY off DESC LIMIT 1",
            Self::REVISION_COLUMNS
        );
        Ok(self
            .conn
            .query_row(&sql, [date], Self::revision_from_row)
            .ok())
    }

    /// What `tip` resolves to: the newest revision that can actually be
    /// materialised. A revision appended by fetch-unstable-revisions.sh has no
    /// narHash until build-index.sh reaches it, and nothing should land on one
    /// by walking off the end.
    pub fn tip(&self) -> Result<Revision> {
        let sql = format!(
            "SELECT {} FROM revisions WHERE narhash IS NOT NULL ORDER BY off DESC LIMIT 1",
            Self::REVISION_COLUMNS
        );
        self.conn
            .query_row(&sql, [], Self::revision_from_row)
            .context("no revision has a narHash; run tools/build-index.sh")
    }

    /// Newest offset in `first ..= last` that can actually be materialised.
    ///
    /// A revision appended by fetch-unstable-revisions.sh has no narHash until
    /// build-index.sh reaches it, and a pin naming one would resolve to a
    /// revision Nix cannot fetch.
    pub fn newest_materialisable_in(&self, first: i64, last: i64) -> Result<Option<i64>> {
        Ok(self.conn.query_row(
            "SELECT max(off) FROM revisions WHERE narhash IS NOT NULL AND off BETWEEN ?1 AND ?2",
            [first, last],
            |r| r.get::<_, Option<i64>>(0),
        )?)
    }

    pub fn release(&self, name: &str) -> Result<Option<Release>> {
        Ok(self
            .conn
            .query_row(
                "SELECT name, rev, date, build, channel_name FROM releases WHERE name = ?1",
                [name],
                |row| {
                    Ok(Release {
                        name: row.get(0)?,
                        rev: row.get(1)?,
                        date: row.get(2)?,
                        build: row.get(3)?,
                        channel_name: row.get(4)?,
                    })
                },
            )
            .ok())
    }

    /// Every run of every version of one attribute, oldest first.
    ///
    /// The primary key is (attr_id, version, first), so this is a range scan
    /// over one attribute's slice of the table.
    pub fn runs_of(&self, attr: &str) -> Result<Vec<Run>> {
        let mut stmt = self.conn.prepare(
            "SELECT runs.version, runs.first, runs.last
               FROM runs JOIN attrs ON attrs.id = runs.attr_id
              WHERE attrs.name = ?1
              ORDER BY runs.first",
        )?;
        let runs = stmt
            .query_map([attr], |row| {
                Ok(Run {
                    version: row.get(0)?,
                    first: row.get(1)?,
                    last: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(runs)
    }

    /// Whether the index has ever seen this attribute. Distinguishes "never in
    /// nixpkgs" from "in nixpkgs but gone", which are different answers.
    pub fn knows_attr(&self, attr: &str) -> Result<bool> {
        Ok(self
            .conn
            .query_row("SELECT 1 FROM attrs WHERE name = ?1", [attr], |_| Ok(()))
            .is_ok())
    }

    /// Every attribute and version present at one revision.
    ///
    /// A full scan of the runs table, on purpose: see the schema comment in
    /// build-db.py for why the index that would avoid it is not worth 5 MB.
    pub fn snapshot(&self, off: i64) -> Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT attrs.name, runs.version
               FROM runs JOIN attrs ON attrs.id = runs.attr_id
              WHERE runs.first <= ?1 AND runs.last >= ?1",
        )?;
        let rows = stmt
            .query_map([off], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Attributes matching a GLOB pattern. A pattern without wildcards is
    /// treated as a substring search, which is what people mean by `mvs query
    /// search python`.
    pub fn search(&self, pattern: &str, limit: usize) -> Result<Vec<String>> {
        let glob = if pattern.contains(['*', '?', '[']) {
            pattern.to_string()
        } else {
            format!("*{pattern}*")
        };

        let mut stmt = self
            .conn
            .prepare("SELECT name FROM attrs WHERE name GLOB ?1 ORDER BY name LIMIT ?2")?;
        let names = stmt
            .query_map(rusqlite::params![glob, limit as i64], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(names)
    }

    /// Case-insensitive fallback for a search that found nothing: GLOB is
    /// case-sensitive, and half of nixpkgs is lowercase while the half people
    /// type is not.
    pub fn search_nocase(&self, pattern: &str, limit: usize) -> Result<Vec<String>> {
        let like = if pattern.contains(['%', '_']) {
            pattern.to_string()
        } else {
            format!("%{pattern}%")
        };

        let mut stmt = self
            .conn
            .prepare("SELECT name FROM attrs WHERE name LIKE ?1 ORDER BY name LIMIT ?2")?;
        let names = stmt
            .query_map(rusqlite::params![like, limit as i64], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(names)
    }

    /// The connection itself, for the queries that are built rather than
    /// written out — `solve` composes one EXISTS clause per constraint.
    pub fn connection(&self) -> &Connection {
        &self.conn
    }
}

/// Group a flat list of runs into one entry per version, oldest run first.
///
/// Two runs of the same version mean the version left and came back, which is
/// 8.4% of pairs in the index — hence runs at all rather than a newest offset.
pub fn group_by_version(runs: Vec<Run>) -> Vec<(String, Vec<Run>)> {
    let mut grouped: Vec<(String, Vec<Run>)> = Vec::new();
    for run in runs {
        match grouped.iter_mut().find(|(v, _)| *v == run.version) {
            Some((_, rs)) => rs.push(run),
            None => grouped.push((run.version.clone(), vec![run])),
        }
    }
    for (_, rs) in grouped.iter_mut() {
        rs.sort_by_key(|r| r.first);
    }
    grouped
}

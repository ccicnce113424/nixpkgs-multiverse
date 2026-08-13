//! `mv` — read the multiverse index.
//!
//! Offline and read-only: every answer comes from the database baked into this
//! binary's own store path at build time. Growing the index is `tools/*.sh`'s
//! job, and a newer index arrives through `nix flake update multiverse`, which
//! rebuilds the database and rewraps the binary — so two people running the
//! same `nix run` get the same answers.

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};

use mv::db::Index;
use mv::lock;
use mv::query::{self, Format};
use mv::solve;

#[derive(Parser)]
#[command(
    name = "mv",
    about = "Read the nixpkgs multiverse index",
    long_about = "Read the nixpkgs multiverse index: versions, lifetimes, revision selection \
                  and constraint solving, offline and without materialising a revision.",
    version
)]
struct Cli {
    /// Index database to read. Defaults to $MV_DB, which the Nix wrapper sets.
    #[arg(long, global = true, value_name = "PATH")]
    db: Option<PathBuf>,

    /// Machine-readable output.
    #[arg(long, global = true)]
    json: bool,

    /// Lock file to read and write. Defaults to ./multiverse.lock.
    #[arg(long, global = true, value_name = "PATH")]
    file: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Read-only questions about the index
    #[command(subcommand)]
    Query(Query),

    /// Find one revision satisfying every constraint at once
    ///
    /// Each constraint is `attr` or `attr@version`, where the version is a
    /// prefix matched component by component: `python3@3.8` accepts 3.8.9 and
    /// refuses 3.81.
    Solve {
        #[arg(value_name = "ATTR[@VERSION]", required = true)]
        constraints: Vec<String>,
    },

    /// Per-package pins in multiverse.lock
    ///
    /// A pin can never point past what the index knows, so moving one is two
    /// steps: `nix flake update multiverse` to learn about newer revisions,
    /// then `mv lock update <attr>` to move that one package.
    #[command(subcommand)]
    Lock(Lock),
}

#[derive(Subcommand)]
enum Lock {
    /// Pin a package to the newest indexed revision providing it
    Add {
        #[arg(value_name = "ATTR[@VERSION]")]
        spec: String,
    },

    /// Remove a pin
    Rm { attr: String },

    /// Move one pin — or every pin — to the newest indexed revision
    Update {
        attr: Option<String>,

        /// Move every pin
        #[arg(long)]
        all: bool,
    },

    /// Show the pins
    List,

    /// How far behind each pin has fallen
    Status,
}

/// A *selector* names a revision: `tip`, a release (`26.05`), a date
/// (`2022-03-15`), a commit prefix, or a revision label
/// (`2021-07-18-967d40bec14b`).
#[derive(Subcommand)]
enum Query {
    /// Every version of an attribute, oldest first, with its lifetime
    Versions { attr: String },

    /// When a version was present: first and last sighting, every run, gaps
    When { attr: String, version: String },

    /// The version a revision shipped
    At { selector: String, attr: String },

    /// When an attribute was last seen, or whether it is still current
    Gone { attr: String },

    /// Resolve a selector to commit, date and label
    Rev { selector: String },

    /// Search attribute names
    Search {
        /// Substring, or a glob if it contains `*`, `?` or `[`
        pattern: String,

        #[arg(long, default_value_t = query::SEARCH_LIMIT)]
        limit: usize,
    },

    /// What changed between two revisions
    Diff {
        a: String,
        b: String,

        /// Entries to print per section; 0 for all
        #[arg(long, default_value_t = query::DIFF_LIMIT)]
        limit: usize,
    },

    /// Headline numbers about the index
    Stats,
}

fn main() {
    // Errors are the tool's own diagnostics rather than a panic trace: every
    // one of them is a sentence about the index or the selector, and the
    // caller is a person at a terminal.
    if let Err(err) = run() {
        anstream::eprintln!("mv: {err:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    let index = Index::open(cli.db.as_deref())?;
    let format = if cli.json {
        Format::Json
    } else {
        Format::Human
    };

    match &cli.command {
        Command::Query(q) => match q {
            Query::Versions { attr } => query::versions(&index, attr, format),
            Query::When { attr, version } => query::when(&index, attr, version, format),
            Query::At { selector, attr } => query::at(&index, selector, attr, format),
            Query::Gone { attr } => query::gone(&index, attr, format),
            Query::Rev { selector } => query::rev(&index, selector, format),
            Query::Search { pattern, limit } => query::search(&index, pattern, *limit, format),
            Query::Diff { a, b, limit } => query::diff(&index, a, b, *limit, format),
            Query::Stats => query::stats(&index, format),
        },
        Command::Solve { constraints } => solve::solve(&index, constraints, format),
        Command::Lock(l) => {
            let path = lock::lock_path(cli.file.as_deref());
            match l {
                Lock::Add { spec } => lock::add(&index, &path, spec, format),
                Lock::Rm { attr } => lock::remove(&path, attr, format),
                Lock::Update { attr, all } => {
                    lock::update(&index, &path, attr.as_deref(), *all, format)
                }
                Lock::List => lock::list(&path, format),
                Lock::Status => lock::status(&index, &path, format),
            }
        }
    }
}

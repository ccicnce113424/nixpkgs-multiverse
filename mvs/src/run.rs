//! `mvs run` and `mvs shell` — thin wrappers over `nix run` and `nix shell`.
//!
//! `mvs` resolves `attr@version` to the commit that shipped it and hands the
//! rest to Nix. It stays offline itself: the index says which revision, and
//! fetching that revision is Nix's job, subject to Nix's own substituters and
//! caches.
//!
//! Deliberately scoped to leaf tools. `mvs shell ripgrep@13.0.0 fd@8.7.0`
//! composes across revisions, which is right for standalone binaries and wrong
//! for a development environment: two revisions mean two libcs and two
//! opensslls in one closure. For an environment, `mvs solve` gives one coherent
//! revision instead.

use std::process::Command;

use anyhow::{anyhow, Result};
use owo_colors::OwoColorize;

use crate::db::Index;
use crate::output;
use crate::solve::{newest_pinnable, spans_for, Constraint};

/// Where a revision is fetched from. The same source `multiverse.nix` uses, so
/// a revision materialised by one is already in the store for the other.
const NIXPKGS: &str = "github:NixOS/nixpkgs";

/// Whether to execute the resolved command or only show it.
#[derive(Clone, Copy, PartialEq)]
pub enum Execute {
    Yes,
    /// `--dry-run`: print the `nix` command line and stop. Useful for seeing
    /// which revision a constraint resolved to before fetching ~378 MB of it.
    No,
}

/// Resolve `attr[@version]` to a flake installable naming the revision that
/// shipped it: `github:NixOS/nixpkgs/<rev>#<attr>`.
fn installable(index: &Index, spec: &str) -> Result<(String, String, String)> {
    let constraint = Constraint::parse(spec)?;
    let spans = spans_for(index, &constraint)?;
    if spans.is_empty() {
        return Err(anyhow!(
            "no revision ever had {}. `mvs query versions {}` lists what there is.",
            constraint.describe(),
            constraint.attr
        ));
    }

    let off = newest_pinnable(index, &spans)?;
    let revision = index.revision(off)?;
    let version = index
        .runs_of(&constraint.attr)?
        .into_iter()
        .find(|r| r.first <= off && off <= r.last)
        .map(|r| r.version)
        .ok_or_else(|| anyhow!("{} is not in {}", constraint.attr, revision.label))?;

    Ok((
        format!("{NIXPKGS}/{}#{}", revision.rev, constraint.attr),
        version,
        revision.label,
    ))
}

/// Report what each spec resolved to, on stderr so that `mvs run`'s own output
/// stays whatever the program printed.
fn report(attr: &str, version: &str, label: &str) {
    anstream::eprintln!(
        "{}",
        format!("{attr} {version} from {label}").style(output::muted())
    );
}

/// `mvs run <attr>[@ver] [-- args...]`
pub fn run(index: &Index, spec: &str, args: &[String], execute: Execute) -> Result<()> {
    let (installable, version, label) = installable(index, spec)?;
    let attr = spec.split('@').next().unwrap_or(spec);

    let mut argv = vec!["run".to_string(), installable];
    if !args.is_empty() {
        argv.push("--".to_string());
        argv.extend(args.iter().cloned());
    }

    report(attr, &version, &label);
    exec(argv, execute)
}

/// `mvs shell <attr>[@ver]... [-- command args...]`
pub fn shell(index: &Index, specs: &[String], args: &[String], execute: Execute) -> Result<()> {
    let mut argv = vec!["shell".to_string()];
    for spec in specs {
        let (installable, version, label) = installable(index, spec)?;
        report(spec.split('@').next().unwrap_or(spec), &version, &label);
        argv.push(installable);
    }

    if !args.is_empty() {
        // `--command` rather than a bare trailing argument: `nix shell` would
        // otherwise read the command as another installable.
        argv.push("--command".to_string());
        argv.extend(args.iter().cloned());
    }

    exec(argv, execute)
}

/// Hand over to `nix`, or print the command line under `--dry-run`.
///
/// Replaces this process rather than waiting on a child, so signals, the exit
/// status and the terminal all belong to the program being run — `mvs run` is
/// meant to be invisible once it has resolved the revision.
fn exec(argv: Vec<String>, execute: Execute) -> Result<()> {
    if execute == Execute::No {
        println!("nix {}", argv.join(" "));
        return Ok(());
    }

    use std::os::unix::process::CommandExt;
    let error = Command::new("nix").args(&argv).exec();

    Err(anyhow!(
        "could not run nix: {error}.\n`mvs run` and `mvs shell` are wrappers around \
         `nix run` and `nix shell`, so nix has to be on PATH."
    ))
}

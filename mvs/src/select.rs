//! Selectors: the one vocabulary every command uses to name a revision.
//!
//! `tip`, a release (`26.05`), a date (`2022-03-15`), a commit prefix, or a
//! revision label (`2021-07-18-967d40bec14b`). The rules are the ones
//! `multiverse.nix` resolves by, so a selector that works in `nix build
//! .#<sel>.<attr>` works here and vice versa.

use anyhow::{anyhow, Result};

use crate::db::{Index, Release, Revision};

/// What a selector names.
pub enum Target {
    /// An indexed revision — a fixed tree, with an offset the index can answer
    /// history questions about.
    Revision(Revision),
    /// A release channel's current tip. Deliberately *not* a revision: a
    /// release name resolves to a head that moves, so it has no offset and no
    /// history.
    Release(Release),
}

/// Whether the caller can accept a moving channel tip.
#[derive(PartialEq)]
pub enum Releases {
    Allowed,
    /// For anything that reads history: a release tip is not in the index, so
    /// there is no honest answer to give.
    Rejected,
}

pub fn resolve(index: &Index, selector: &str, releases: Releases) -> Result<Target> {
    // `tip` first: it is the only selector that is a word rather than a shape.
    if selector == "tip" {
        return Ok(Target::Revision(index.tip()?));
    }

    if let Some(release) = index.release(selector)? {
        if releases == Releases::Rejected {
            return Err(anyhow!(
                "{sel} is a release: a channel tip that moves, not a revision the index has \
                 an offset for.\nIts head as of {date} is {rev}. Select by date or by commit \
                 instead — `mvs query at {date} <attr>`.",
                sel = selector,
                date = release.date,
                rev = &release.rev[..12],
            ));
        }
        return Ok(Target::Release(release));
    }

    // A label carries a date for the reader and a commit prefix for the
    // machine; only the second half is a search key.
    if let Some((date, hash)) = split_label(selector) {
        return match index.revision_by_prefix(hash)? {
            Some(revision) => Ok(Target::Revision(revision)),
            None => Err(anyhow!(
                "no revision matches the label {selector} (no commit starts with {hash}, \
                 dated {date} or otherwise)"
            )),
        };
    }

    if is_date(selector) {
        return match index.revision_on_or_before(selector)? {
            Some(revision) => Ok(Target::Revision(revision)),
            None => Err(anyhow!(
                "no indexed revision on or before {selector}; the index starts at {}",
                index.revision(0)?.date
            )),
        };
    }

    if is_hex(selector) {
        return match index.revision_by_prefix(selector)? {
            Some(revision) => Ok(Target::Revision(revision)),
            None => Err(anyhow!(
                "no indexed revision starts with {selector}.\nThe index holds nixos-unstable \
                 channel bumps, not every commit in nixpkgs — a revision nixpkgs has \
                 but the index does not is expected."
            )),
        };
    }

    Err(anyhow!(
        "{selector} is not a selector. Give `tip`, a release like 26.05, a date like \
         2022-03-15, a revision label, or a commit hash."
    ))
}

/// Resolve a selector that must name an indexed revision.
pub fn resolve_revision(index: &Index, selector: &str) -> Result<Revision> {
    match resolve(index, selector, Releases::Rejected)? {
        Target::Revision(revision) => Ok(revision),
        // resolve() rejects releases before returning when they are not
        // allowed, so this arm cannot be reached.
        Target::Release(_) => unreachable!("releases are rejected above"),
    }
}

fn is_date(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

fn is_hex(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

/// Split `YYYY-MM-DD-<hex>` into its two halves, or `None` if it is not one.
fn split_label(s: &str) -> Option<(&str, &str)> {
    // A date is 10 characters and the separator one more; anything shorter is
    // not a label whatever else it might be.
    if s.len() < 12 {
        return None;
    }
    let (date, rest) = s.split_at(10);
    if !is_date(date) || !rest.starts_with('-') {
        return None;
    }
    let hash = &rest[1..];
    if !is_hex(hash) {
        return None;
    }
    Some((date, hash))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Selector shape recognition, which is what decides whether a string is
    /// searched for as a date or as a commit. Checks each shape and the
    /// near-misses that must not be mistaken for it.
    #[test]
    fn recognises_selector_shapes() {
        assert!(is_date("2022-03-15"));
        assert!(!is_date("2022-3-15"));
        assert!(!is_date("2022-03-15-abc"));

        assert!(is_hex("967d40bec14b"));
        assert!(is_hex("26"));
        // Uppercase is not how the index writes commits, and accepting it
        // would make a prefix search silently miss.
        assert!(!is_hex("967D40"));
        assert!(!is_hex("nixos-unstable"));

        assert_eq!(
            split_label("2021-07-18-967d40bec14b"),
            Some(("2021-07-18", "967d40bec14b"))
        );
        // A date on its own is a date, not a label with an empty hash.
        assert_eq!(split_label("2021-07-18"), None);
        assert_eq!(split_label("967d40bec14b"), None);
    }
}

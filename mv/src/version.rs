//! Nixpkgs version ordering.
//!
//! Nixpkgs versions are not semver. The index holds `0-unstable-2026-06-17`,
//! `202502`, `2.7.18.12`, `1.12-nightly` and `20250512.1`, so the only ordering
//! that can be correct here is the one Nix itself uses: whatever
//! `builtins.compareVersions` says. Anything else and `query versions`, `solve`
//! and `lock status` quietly disagree with the package manager they describe.
//!
//! This is a transliteration of `compareVersions` in Nix's libutil, not a
//! reimplementation, and `tests/version_diff.rs` checks it pair by pair against
//! a running `nix`.

use std::cmp::Ordering;

/// A version component: a run of digits, or a run of non-digits, with `.` and
/// `-` acting only as separators and belonging to neither.
struct Components<'a> {
    rest: &'a str,
}

impl<'a> Iterator for Components<'a> {
    type Item = &'a str;

    fn next(&mut self) -> Option<&'a str> {
        // Separators carry no information of their own: "1.2" and "1-2" are the
        // same version to Nix.
        self.rest = self.rest.trim_start_matches(['.', '-']);
        if self.rest.is_empty() {
            return None;
        }

        // A component is homogeneous — all digits or no digits — so its end is
        // wherever that character class stops.
        let digits = self.rest.starts_with(|c: char| c.is_ascii_digit());
        let end = self
            .rest
            .find(|c: char| {
                if digits {
                    !c.is_ascii_digit()
                } else {
                    c.is_ascii_digit() || c == '.' || c == '-'
                }
            })
            .unwrap_or(self.rest.len());

        let (component, rest) = self.rest.split_at(end);
        self.rest = rest;
        Some(component)
    }
}

fn components(s: &str) -> Components<'_> {
    Components { rest: s }
}

/// A component as a number, or `None` if it is not one.
///
/// `i32` rather than a wider type on purpose: Nix parses components with
/// `string2Int<int>`, so a run of digits that overflows a C `int` is not a
/// number to Nix either and falls through to the string rules below. That is
/// not hypothetical — `v2ray-domain-list-community` versions its releases
/// `20230106031328`, and getting the width wrong reorders them.
fn as_number(component: &str) -> Option<i32> {
    component.parse::<i32>().ok()
}

/// Order two components the way Nix's `componentsLT` does.
fn compare_components(a: &str, b: &str) -> Ordering {
    let (na, nb) = (as_number(a), as_number(b));

    match (na, nb) {
        // Two numbers compare as numbers, so 1.10 is above 1.9.
        (Some(x), Some(y)) => x.cmp(&y),

        // A version that ran out of components is below one that continues into
        // a number: 2.3 < 2.3.1.
        (None, Some(_)) if a.is_empty() => Ordering::Less,
        (Some(_), None) if b.is_empty() => Ordering::Greater,

        _ => {
            // "pre" sorts below everything, which is what makes 2.3pre1 < 2.3.
            if a == "pre" && b != "pre" {
                return Ordering::Less;
            }
            if b == "pre" && a != "pre" {
                return Ordering::Greater;
            }

            // A number outranks a letter component, so that 2.3a < 2.3.1.
            if nb.is_some() {
                return Ordering::Less;
            }
            if na.is_some() {
                return Ordering::Greater;
            }

            a.cmp(b)
        }
    }
}

/// `builtins.compareVersions a b`, as an [`Ordering`].
///
/// The two component streams are walked in lockstep, and a version that runs
/// out yields empty components — which is what lets the `2.3` versus `2.3.1`
/// rule above apply at the point the shorter one ends.
pub fn compare(a: &str, b: &str) -> Ordering {
    let (mut ca, mut cb) = (components(a), components(b));

    loop {
        let (x, y) = (ca.next(), cb.next());
        if x.is_none() && y.is_none() {
            return Ordering::Equal;
        }

        let ord = compare_components(x.unwrap_or(""), y.unwrap_or(""));
        if ord != Ordering::Equal {
            return ord;
        }
    }
}

/// Sort in place, oldest version first.
pub fn sort(versions: &mut [String]) {
    versions.sort_by(|a, b| compare(a, b));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering::*;

    /// Splitting into components: checks that separators are dropped, that
    /// digit and non-digit runs break apart, and that an empty version yields
    /// nothing.
    #[test]
    fn splits_into_components() {
        fn split(s: &str) -> Vec<&str> {
            components(s).collect()
        }

        assert_eq!(split("2.3.1"), ["2", "3", "1"]);
        assert_eq!(
            split("0-unstable-2026-06-17"),
            ["0", "unstable", "2026", "06", "17"]
        );
        assert_eq!(split("1.12-nightly"), ["1", "12", "nightly"]);
        assert_eq!(split("2.3pre1"), ["2", "3", "pre", "1"]);
        assert_eq!(split("...--"), Vec::<&str>::new());
        assert_eq!(split(""), Vec::<&str>::new());
    }

    /// The ordering rules, one test case per rule, using the examples from
    /// Nix's own test suite and from the index.
    #[test]
    fn orders_like_nix() {
        // Numeric components compare as numbers, not as strings.
        assert_eq!(compare("1.10", "1.9"), Greater);
        assert_eq!(compare("1.0", "1.00"), Equal);

        // A missing component is below a numeric one.
        assert_eq!(compare("2.3", "2.3.1"), Less);
        assert_eq!(compare("2.3.1", "2.3"), Greater);

        // "pre" is below everything, including the absence of a component.
        assert_eq!(compare("2.3pre1", "2.3"), Less);
        assert_eq!(compare("2.3pre1", "2.3a"), Less);
        assert_eq!(compare("2.3pre3", "2.3pre12"), Less);

        // A number outranks a letter run.
        assert_eq!(compare("2.3a", "2.3.1"), Less);

        // Separators are interchangeable.
        assert_eq!(compare("1.2", "1-2"), Equal);

        // Real strings out of the index.
        assert_eq!(compare("2.7.18.12", "2.7.18.8"), Greater);
        assert_eq!(compare("202502", "202411"), Greater);
        assert_eq!(compare("20250512.1", "20250512"), Greater);
        assert_eq!(
            compare("0-unstable-2026-06-17", "0-unstable-2026-06-16"),
            Greater
        );
    }

    /// The i32 rule: a digit run too wide for a C `int` stops being a number to
    /// Nix, so it compares as a string against the next component. Both of
    /// these are real `v2ray-domain-list-community` versions, and an i64
    /// comparator would order the pair the other way.
    #[test]
    fn overflowing_digit_runs_are_not_numbers() {
        assert_eq!(as_number("20230106031328"), None);
        assert_eq!(compare("20230106031328", "20221223102220"), Greater);

        // A number beats a non-number, so the overflowing run loses to a small
        // one however large it looks.
        assert_eq!(compare("4294967296", "5"), Less);
    }

    /// Sorting: checks that a shuffled list of one attribute's real versions
    /// comes back oldest first.
    #[test]
    fn sorts_oldest_first() {
        let mut versions: Vec<String> = ["3.10.2", "3.9.10", "3.8.9", "3.10.10", "3.9.9"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        sort(&mut versions);
        assert_eq!(versions, ["3.8.9", "3.9.9", "3.9.10", "3.10.2", "3.10.10"]);
    }
}

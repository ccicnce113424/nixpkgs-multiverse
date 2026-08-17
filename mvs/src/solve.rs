//! `mvs solve` — the fewest revisions that serve a set of pins.
//!
//! This is the answer to multiverse's one real weakness. Composing versions
//! from *different* revisions gives a closure with two libcs and two opensslls
//! — fine for a leaf CLI, wrong for anything that links. Every extra revision
//! is also a full nixpkgs fetch and evaluation. `solve` answers both at once:
//! the smallest set of revisions shipping every version asked for.
//!
//! The answer is always minimal, and carries its own proof. Each revision in
//! a plan is forced by one pin, and those pins never overlap each other, so no
//! smaller set can exist — a claim the reader can check from the dates alone,
//! without trusting the search. Proving minimality is the part no other tool
//! does: mise and asdf cannot, because they do not model compatibility at all.
//!
//! Minimality is cheap only because a pin is one *contiguous* block of
//! revisions — see `block_for`. Stabbing intervals with the fewest points is a
//! greedy sweep; the same question asked over blocks with holes in them is
//! vertex cover, and NP-hard. docs/design.md carries the argument in full.

use anyhow::{anyhow, Result};
use owo_colors::OwoColorize;
use serde_json::json;

use crate::date;
use crate::db::Index;
use crate::output;
use crate::query::Format;
use crate::version;

/// How many forcing pins the certificate line names before it summarises the
/// rest. Four fits a terminal line; past that the list stops being readable.
const CERTIFICATE_SHOWN: usize = 4;

/// A wanted attribute, and optionally the version prefix it must match.
pub struct Constraint {
    pub attr: String,
    pub version: Option<String>,
}

impl Constraint {
    /// Parse `attr` or `attr@version`.
    pub fn parse(spec: &str) -> Result<Constraint> {
        let (attr, version) = match spec.split_once('@') {
            None => (spec, None),
            Some((attr, ver)) if !ver.is_empty() => (attr, Some(ver.to_string())),
            Some((attr, _)) => {
                return Err(anyhow!(
                    "{attr}@ has no version after the @. Write {attr} for any version, or \
                     {attr}@3.8 for a version."
                ))
            }
        };

        if attr.is_empty() {
            return Err(anyhow!("{spec} has no attribute before the @"));
        }
        Ok(Constraint {
            attr: attr.to_string(),
            version,
        })
    }

    pub fn describe(&self) -> String {
        match &self.version {
            Some(v) => format!("{} {}.x", self.attr, v),
            None => self.attr.clone(),
        }
    }
}

/// Whether `version` satisfies the constraint's prefix.
///
/// Matched component by component rather than by string prefix, which is the
/// difference between `python3@3.1` meaning "3.1.x" and it also matching 3.10,
/// 3.11, 3.12 and 3.13. A GLOB in SQL cannot express this, so the filter is
/// applied in Rust after the query.
pub fn matches(version: &str, prefix: &str) -> bool {
    let mut wanted = version::components(prefix);
    let mut have = version::components(version);

    loop {
        match (wanted.next(), have.next()) {
            // The constraint ran out: everything it asked for matched.
            (None, _) => return true,
            // The version ran out first, so it is shorter than the constraint.
            (Some(_), None) => return false,
            (Some(w), Some(h)) if w != h => return false,
            _ => {}
        }
    }
}

/// A closed range of offsets in which one constraint holds throughout.
pub type Span = (i64, i64);

/// Every stretch of revisions in which one constraint is satisfied, merged and
/// in offset order.
pub fn spans_for(index: &Index, constraint: &Constraint) -> Result<Vec<Span>> {
    let runs = index.runs_of(&constraint.attr)?;
    if runs.is_empty() {
        return Err(anyhow!(
            "{} is not in the index, so nothing can satisfy it.",
            constraint.attr
        ));
    }

    let mut spans: Vec<Span> = runs
        .iter()
        .filter(|run| match &constraint.version {
            None => true,
            Some(prefix) => matches(&run.version, prefix),
        })
        .map(|run| (run.first, run.last))
        .collect();
    spans.sort();

    // Adjacent runs of *different* versions both satisfying the constraint —
    // 3.8.9 followed by 3.8.10 — are one stretch as far as the caller is
    // concerned, and merging them keeps the intersection below linear.
    let mut merged: Vec<Span> = Vec::new();
    for (first, last) in spans {
        match merged.last_mut() {
            Some(prev) if first <= prev.1 + 1 => prev.1 = prev.1.max(last),
            _ => merged.push((first, last)),
        }
    }
    Ok(merged)
}

/// The single block of revisions a pin is served by.
///
/// A version can leave nixpkgs and come back, so a constraint can hold over
/// several disjoint stretches. The pin takes the newest of them: that is the
/// revision `mvs lock add` and `mv.version` already resolve to, since
/// index/versions.json records only the newest revision shipping each version.
///
/// One block per pin is also what makes the plan below computable at all. A
/// pin allowed to pick any of its stretches turns the search into vertex
/// cover; holding it to one keeps every pin an interval, where a greedy sweep
/// is exactly optimal. 98.3% of versions have only one stretch, so the choice
/// is invisible to almost every pin — see docs/design.md.
pub fn block_for(index: &Index, constraint: &Constraint) -> Result<Span> {
    let spans = spans_for(index, constraint)?;
    spans.last().copied().ok_or_else(|| {
        anyhow!(
            "no revision ever shipped {}, so nothing can serve it.",
            constraint.describe()
        )
    })
}

/// One revision, and the pins it serves.
#[derive(Debug)]
pub struct Group {
    pub off: i64,
    /// Indices into the caller's pin list, in the order the pins were given.
    pub pins: Vec<usize>,
}

/// The fewest revisions that serve every pin, and the proof that no smaller
/// set exists.
#[derive(Debug)]
pub struct Plan {
    pub groups: Vec<Group>,
    /// The pin that forced each group's revision, in the same order as
    /// `groups`. Their blocks are pairwise disjoint, so every possible plan
    /// needs at least one revision per entry here.
    pub forced_by: Vec<usize>,
}

/// The greedy sweep: serve the pin whose block ends earliest with the last
/// revision in that block, drop everything that revision reaches, and repeat.
///
/// Optimal, by exchange. Every plan must hold some revision inside the
/// earliest-ending block; moving that revision forward to the block's last
/// revision loses nothing, because any other block still open there ends at or
/// after that point and began at or before it, so it contains the point too.
/// One optimal plan therefore uses this revision, and the argument repeats on
/// what is left.
pub fn plan(blocks: &[Span]) -> Plan {
    // Earliest-ending block first: the only order the exchange argument above
    // holds in.
    let mut order: Vec<usize> = (0..blocks.len()).collect();
    order.sort_by_key(|&i| blocks[i].1);

    // Revisions are therefore placed oldest to newest, so the last one placed
    // is the only one that can still reach the block under consideration.
    let mut offs: Vec<i64> = Vec::new();
    let mut forced_by: Vec<usize> = Vec::new();
    for &i in &order {
        let (first, last) = blocks[i];
        if offs.last().is_some_and(|&off| off >= first) {
            continue;
        }
        offs.push(last);
        forced_by.push(i);
    }

    // Each pin then joins the *newest* revision serving it, rather than the
    // first one placed. The plan is the same size either way, but a pin held
    // at an older revision than it needs is an older build of the same
    // version, so the later revision is strictly the better home.
    let mut groups: Vec<Group> = offs
        .iter()
        .map(|&off| Group {
            off,
            pins: Vec::new(),
        })
        .collect();
    for (i, &(first, last)) in blocks.iter().enumerate() {
        let group = offs
            .iter()
            .rposition(|&off| first <= off && off <= last)
            .expect("the sweep places a revision inside every block");
        groups[group].pins.push(i);
    }

    Plan { groups, forced_by }
}

/// The newest offset in `spans` that a pin can name: newest first, walking
/// back over any revision that has no narHash and so cannot be fetched.
pub fn newest_pinnable(index: &Index, spans: &[Span]) -> Result<i64> {
    for (first, last) in spans.iter().rev() {
        if let Some(off) = index.newest_materialisable_in(*first, *last)? {
            return Ok(off);
        }
    }

    Err(anyhow!(
        "every revision satisfying this has no narHash yet, so none of them can be \
         fetched. Run tools/add-narhashes.sh, or wait for the next index build."
    ))
}

/// What one constraint resolves to at one revision.
fn version_at(index: &Index, constraint: &Constraint, off: i64) -> Result<String> {
    Ok(index
        .runs_of(&constraint.attr)?
        .into_iter()
        .find(|r| r.first <= off && off <= r.last)
        .map(|r| r.version)
        .unwrap_or_else(|| "?".to_string()))
}

/// How much older than its own newest revision a pin ended up, in revisions
/// and in days. Zero for the pin that forced its group.
fn displacement(index: &Index, block: Span, off: i64) -> Result<(i64, i64)> {
    if block.1 == off {
        return Ok((0, 0));
    }

    let newest = index.revision(block.1)?;
    let chosen = index.revision(off)?;
    Ok((block.1 - off, date::days_between(&chosen.date, &newest.date)))
}

/// How many of the pins the store-path index can serve without evaluating
/// anything. `None` when the database was built without store data, which is
/// the difference between "none of them" and "cannot say".
fn fast_covered(index: &Index, resolved: &[(String, String)]) -> Result<Option<usize>> {
    if !index.has_store_data() {
        return Ok(None);
    }

    let mut covered = 0;
    for (attr, version) in resolved {
        let known = index
            .store_pairs_of(attr)?
            .into_iter()
            .any(|pair| &pair.version == version);
        if known {
            covered += 1;
        }
    }
    Ok(Some(covered))
}

/// The forcing pins, as the sentence that proves the plan is minimal.
fn why(constraints: &[Constraint], forced_by: &[usize]) -> String {
    let named: Vec<String> = forced_by
        .iter()
        .take(CERTIFICATE_SHOWN)
        .map(|&i| constraints[i].describe())
        .collect();

    match forced_by.len() {
        0 | 1 => "one revision serves every pin".to_string(),
        2 => format!("{} and {} never overlapped", named[0], named[1]),
        n if n <= CERTIFICATE_SHOWN => format!("{} never overlap", named.join(", ")),
        n => format!(
            "{} and {} others never overlap",
            named.join(", "),
            n - CERTIFICATE_SHOWN
        ),
    }
}

pub fn solve(index: &Index, specs: &[String], format: Format) -> Result<()> {
    let constraints = specs
        .iter()
        .map(|s| Constraint::parse(s))
        .collect::<Result<Vec<_>>>()?;
    if constraints.is_empty() {
        return Err(anyhow!("give at least one constraint, e.g. python3@3.8"));
    }

    let blocks = constraints
        .iter()
        .map(|c| block_for(index, c))
        .collect::<Result<Vec<_>>>()?;
    let plan = plan(&blocks);

    // Every offset the plan names comes off a run, and a revision carrying a
    // run was checked out by build-index.sh, which records its narHash from
    // the same checkout. An offset without one would therefore mean the index
    // and the revision list disagree, so it is worth a sentence rather than a
    // fetch that fails much later.
    for group in &plan.groups {
        if index.newest_materialisable_in(group.off, group.off)?.is_none() {
            return Err(anyhow!(
                "revision {} satisfies these pins but has no narHash, so it cannot be \
                 fetched. Run tools/add-narhashes.sh.",
                index.revision(group.off)?.rev
            ));
        }
    }

    // Resolved versions and how far each pin moved, in the order the pins were
    // given rather than in group order: a caller reading the table is looking
    // for the pin they typed.
    let mut rows: Vec<(usize, String, i64, i64)> = Vec::new();
    for group in &plan.groups {
        for &i in &group.pins {
            let version = version_at(index, &constraints[i], group.off)?;
            let (revs, days) = displacement(index, blocks[i], group.off)?;
            rows.push((i, version, revs, days));
        }
    }
    rows.sort_by_key(|(i, _, _, _)| *i);

    let resolved: Vec<(String, String)> = rows
        .iter()
        .map(|(i, version, _, _)| (constraints[*i].attr.clone(), version.clone()))
        .collect();
    let covered = fast_covered(index, &resolved)?;
    let explanation = why(&constraints, &plan.forced_by);

    // Which revision each pin landed on, needed by both output paths.
    let mut home = vec![0i64; constraints.len()];
    for group in &plan.groups {
        for &i in &group.pins {
            home[i] = group.off;
        }
    }

    if format == Format::Json {
        let groups = plan
            .groups
            .iter()
            .map(|group| {
                let revision = index.revision(group.off)?;
                let pins = group
                    .pins
                    .iter()
                    .map(|&i| {
                        let row = rows.iter().find(|(j, _, _, _)| *j == i).expect("row per pin");
                        json!({
                            "attr": constraints[i].attr,
                            "constraint": constraints[i].version,
                            "version": row.1,
                            "movedRevisions": row.2,
                            "movedDays": row.3,
                        })
                    })
                    .collect::<Vec<_>>();
                Ok(json!({ "revision": revision, "pins": pins }))
            })
            .collect::<Result<Vec<_>>>()?;

        return output::print_json(json!({
            "revisions": plan.groups.len(),
            "groups": groups,
            "certificate": plan.forced_by.iter().map(|&i| constraints[i].describe()).collect::<Vec<_>>(),
            "why": explanation,
            "fast": covered.map(|n| json!({"covered": n, "total": constraints.len()})),
        }));
    }

    anstream::println!(
        "{} · {}",
        output::plural(plan.groups.len(), "revision"),
        "minimal".style(output::current())
    );

    // What the plan actually costs to build. A pin the store-path index knows
    // needs no revision fetched at all, so the revision count on its own
    // overstates the work for anything going through `fast`.
    if let Some(covered) = covered {
        anstream::println!(
            "{}",
            format!(
                "{covered} of {} pins served by the store-path index",
                constraints.len()
            )
            .style(output::muted())
        );
    }

    let mut table = output::Table::new(&["ATTR", "VERSION", "REVISION", "DATE", "MOVED"]);
    for (i, version, revs, days) in &rows {
        let revision = index.revision(home[*i])?;
        table.row(vec![
            output::Cell::new(&constraints[*i].attr, output::plain()),
            output::Cell::new(version, output::current()),
            output::Cell::new(revision.rev[..12].to_string(), output::plain()),
            output::Cell::new(&revision.date, output::plain()),
            output::Cell::new(
                if *revs == 0 {
                    String::new()
                } else {
                    format!("{days} days ({revs} revs)")
                },
                output::muted(),
            ),
        ]);
    }
    anstream::println!();
    table.print();

    // The certificate earns its line only when there is something to prove.
    // "1 revision · minimal" above has already said everything a single group
    // has to say.
    if plan.groups.len() > 1 {
        anstream::println!(
            "\n{}",
            format!("  minimal: {explanation}").style(output::muted())
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Constraint parsing: attr alone, attr@version, and the two malformed
    /// shapes that would otherwise turn into a silent match-everything.
    #[test]
    fn parses_constraints() {
        let c = Constraint::parse("python3@3.8").unwrap();
        assert_eq!(c.attr, "python3");
        assert_eq!(c.version.as_deref(), Some("3.8"));

        let c = Constraint::parse("ripgrep").unwrap();
        assert_eq!(c.version, None);

        assert!(Constraint::parse("python3@").is_err());
        assert!(Constraint::parse("@3.8").is_err());
    }

    /// Prefix matching by component, which is what keeps `3.1` from meaning
    /// 3.10 through 3.13 — the bug a string prefix or a SQL GLOB would have.
    #[test]
    fn matches_by_component_not_by_string() {
        assert!(matches("3.8.9", "3.8"));
        assert!(matches("3.8", "3.8"));
        assert!(matches("14.1.1", "14"));
        assert!(matches("1.12-nightly", "1.12"));

        assert!(!matches("3.10.2", "3.1"));
        assert!(!matches("3.8", "3.8.9"));
        assert!(!matches("140.0", "14"));
    }

    /// The offsets a plan names, for the assertions below.
    fn offsets(plan: &Plan) -> Vec<i64> {
        plan.groups.iter().map(|g| g.off).collect()
    }

    /// The sweep on the three shapes that decide it: blocks sharing one
    /// revision, blocks that cannot, and a block containing another.
    #[test]
    fn plans_the_fewest_revisions() {
        // Overlapping blocks are served by the earliest ending point.
        assert_eq!(offsets(&plan(&[(0, 10), (5, 20)])), [10]);

        // Disjoint blocks each force their own revision.
        assert_eq!(offsets(&plan(&[(0, 4), (5, 20)])), [4, 20]);

        // A block wholly inside another is served by the inner block's end.
        assert_eq!(offsets(&plan(&[(0, 100), (5, 10)])), [10]);

        // One pin is one revision, at the newest it can name.
        assert_eq!(offsets(&plan(&[(3, 7)])), [7]);
    }

    /// The order pins are given in must not change the plan. Greedy sweeps
    /// that sort by the wrong key pass the sorted case and fail this one.
    #[test]
    fn plans_the_same_whatever_the_order() {
        let forward = offsets(&plan(&[(0, 4), (5, 9), (10, 14)]));
        let backward = offsets(&plan(&[(10, 14), (5, 9), (0, 4)]));
        assert_eq!(forward, backward);
        assert_eq!(forward, [4, 9, 14]);
    }

    /// A pin servable by more than one chosen revision joins the newest of
    /// them. Assigning to the first instead is the same size and leaves the
    /// pin on a needlessly old build.
    #[test]
    fn pins_join_the_newest_revision_serving_them() {
        // (0,4) forces 4 and (5,9) forces 9; the long block spans both, and
        // belongs on 9.
        let plan = plan(&[(0, 4), (5, 9), (0, 20)]);
        assert_eq!(offsets(&plan), [4, 9]);
        assert_eq!(plan.groups[0].pins, [0]);
        assert_eq!(plan.groups[1].pins, [1, 2]);
    }

    /// The certificate: the pins that forced the revisions never overlap, so
    /// the count they prove is the count the plan uses. This is the property
    /// that makes the answer checkable without re-running the search.
    #[test]
    fn the_forcing_pins_are_pairwise_disjoint() {
        let blocks = [(0, 10), (4, 12), (11, 30), (25, 26), (40, 41), (2, 50)];
        let plan = plan(&blocks);
        assert_eq!(plan.forced_by.len(), plan.groups.len());

        for a in 0..plan.forced_by.len() {
            for b in a + 1..plan.forced_by.len() {
                let (first_a, last_a) = blocks[plan.forced_by[a]];
                let (first_b, last_b) = blocks[plan.forced_by[b]];
                assert!(
                    last_a < first_b || last_b < first_a,
                    "forcing pins {first_a}..{last_a} and {first_b}..{last_b} overlap"
                );
            }
        }
    }

    /// Every pin lands in exactly one group, and inside its own block. A pin
    /// placed outside its block would be a plan naming a revision that does
    /// not ship the version asked for.
    #[test]
    fn every_pin_lands_inside_its_own_block() {
        let blocks = [(0, 10), (4, 12), (11, 30), (25, 26), (40, 41), (2, 50)];
        let plan = plan(&blocks);

        let mut seen = vec![0; blocks.len()];
        for group in &plan.groups {
            for &i in &group.pins {
                seen[i] += 1;
                assert!(
                    blocks[i].0 <= group.off && group.off <= blocks[i].1,
                    "pin {i} sits outside its block"
                );
            }
        }
        assert!(seen.iter().all(|&n| n == 1), "every pin lands exactly once");
    }

    /// The sentence the plan is sold on, at each shape it takes: one revision,
    /// the two-pin case that used to be an error, and a list long enough to be
    /// summarised.
    #[test]
    fn explains_why_the_plan_is_minimal() {
        let constraints: Vec<Constraint> = ["a@1", "b@2", "c@3", "d@4", "e@5", "f@6"]
            .iter()
            .map(|s| Constraint::parse(s).unwrap())
            .collect();

        assert_eq!(why(&constraints, &[0]), "one revision serves every pin");
        assert_eq!(why(&constraints, &[0, 1]), "a 1.x and b 2.x never overlapped");
        assert_eq!(
            why(&constraints, &[0, 1, 2]),
            "a 1.x, b 2.x, c 3.x never overlap"
        );
        assert_eq!(
            why(&constraints, &[0, 1, 2, 3, 4, 5]),
            "a 1.x, b 2.x, c 3.x, d 4.x and 2 others never overlap"
        );
    }
}

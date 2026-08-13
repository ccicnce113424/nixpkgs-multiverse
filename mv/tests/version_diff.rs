//! Differential test: `mv`'s version ordering against `builtins.compareVersions`.
//!
//! Every command that orders or ranges over versions is downstream of this one
//! function, and a version scheme that only shows up in 300 of the index's
//! 57,000 version strings is exactly the kind of thing a hand-written test
//! misses. So rather than assert on cases somebody thought of, this samples
//! real pairs out of the index and asks Nix what the answer is.
//!
//! It needs a `nix` on PATH, and uses it for both halves of the job: one
//! `nix build` for the database to sample from, one `nix eval` for the
//! verdicts. Absent nix — inside the build sandbox, say — it skips, because a
//! test that cannot reach the oracle has nothing to say.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::process::Command;

use mv::version;

/// How many pairs to check. One `nix eval` handles the whole batch, so the cost
/// is a fixed few seconds rather than per-pair.
const PAIRS: usize = 4000;

/// Multiplier and increment of the LCG that picks the pairs. Numerical Recipes'
/// constants; the sampling has to be pseudo-random to reach across version
/// schemes, but it must also be the same sample on every run, so a mismatch
/// reproduces instead of appearing every fifth CI job.
const LCG_MULT: u64 = 6364136223846793005;
const LCG_INC: u64 = 1442695040888963407;

struct Lcg(u64);

impl Lcg {
    fn next(&mut self, bound: usize) -> usize {
        self.0 = self.0.wrapping_mul(LCG_MULT).wrapping_add(LCG_INC);
        // The high bits of an LCG are the well-distributed ones.
        ((self.0 >> 33) as usize) % bound
    }
}

fn nix_available() -> bool {
    Command::new("nix")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("mv/ has a parent")
        .to_path_buf()
}

/// The database to sample versions from: `$MV_DB` if the caller has one built,
/// otherwise built out of the flake. Both are the same file; the environment
/// variable only saves the round trip.
fn index_db() -> PathBuf {
    if let Some(db) = std::env::var_os("MV_DB") {
        return PathBuf::from(db);
    }

    let out = Command::new("nix")
        .args(["build", "--no-link", "--print-out-paths", ".#index-db"])
        .current_dir(repo_root())
        .output()
        .expect("nix build .#index-db");
    assert!(
        out.status.success(),
        "nix build .#index-db failed:\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
    PathBuf::from(String::from_utf8(out.stdout).unwrap().trim())
}

/// Every distinct version string in the index, in a stable order so the sample
/// is reproducible.
fn distinct_versions(db: &PathBuf) -> Vec<String> {
    let conn = rusqlite::Connection::open(db).expect("open index database");
    let mut stmt = conn
        .prepare("SELECT DISTINCT version FROM runs")
        .expect("prepare");
    let versions: BTreeSet<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query")
        .map(|r| r.expect("row"))
        .collect();
    versions.into_iter().collect()
}

/// Ask Nix to compare every pair, in one evaluation.
///
/// The pairs go through a JSON file rather than being interpolated into the
/// expression: version strings contain `$`, backslashes and quotes, and every
/// one of those means something inside a Nix string literal.
fn nix_verdicts(pairs: &[(String, String)]) -> Vec<i64> {
    let dir = std::env::temp_dir().join(format!("mv-version-diff-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    let path = dir.join("pairs.json");
    std::fs::write(&path, serde_json::to_vec(pairs).expect("encode pairs")).expect("write pairs");

    let expr = format!(
        "map (p: builtins.compareVersions (builtins.elemAt p 0) (builtins.elemAt p 1)) \
         (builtins.fromJSON (builtins.readFile {}))",
        path.display()
    );
    let out = Command::new("nix")
        .args(["eval", "--json", "--impure", "--expr", &expr])
        .output()
        .expect("nix eval");
    assert!(
        out.status.success(),
        "nix eval failed:\n{}",
        String::from_utf8_lossy(&out.stderr)
    );

    let verdicts: Vec<i64> = serde_json::from_slice(&out.stdout).expect("decode verdicts");
    std::fs::remove_dir_all(&dir).ok();
    verdicts
}

/// Compares `mv`'s ordering against Nix's over 4000 real pairs drawn from the
/// index, half of them related (same attribute, so the same versioning scheme)
/// and half of them arbitrary.
#[test]
fn matches_builtins_compare_versions() {
    if !nix_available() {
        eprintln!("skipping: no nix on PATH, so there is no oracle to compare against");
        return;
    }

    let db = index_db();
    let versions = distinct_versions(&db);
    assert!(
        versions.len() > 1000,
        "index looks empty: {} distinct versions",
        versions.len()
    );

    // Neighbours in sorted order share a prefix and so exercise the fiddly
    // rules — pre-releases, unstable dates, trailing components — while the
    // random partner reaches across schemes.
    let mut rng = Lcg(0);
    let mut pairs = Vec::with_capacity(PAIRS);
    for _ in 0..PAIRS / 2 {
        let i = rng.next(versions.len() - 1);
        pairs.push((versions[i].clone(), versions[i + 1].clone()));

        let (a, b) = (rng.next(versions.len()), rng.next(versions.len()));
        pairs.push((versions[a].clone(), versions[b].clone()));
    }

    let verdicts = nix_verdicts(&pairs);
    assert_eq!(verdicts.len(), pairs.len());

    let mut mismatches = Vec::new();
    for ((a, b), nix) in pairs.iter().zip(&verdicts) {
        let ours = match version::compare(a, b) {
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
            std::cmp::Ordering::Greater => 1,
        };
        if ours != *nix {
            mismatches.push(format!("{a:?} vs {b:?}: nix says {nix}, mv says {ours}"));
        }
    }

    assert!(
        mismatches.is_empty(),
        "{} of {} pairs disagree with builtins.compareVersions:\n{}",
        mismatches.len(),
        pairs.len(),
        mismatches.join("\n")
    );
}

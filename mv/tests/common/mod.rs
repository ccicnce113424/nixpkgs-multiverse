//! Shared setup for the integration tests: finding the index database, and
//! deciding whether `nix` is reachable at all.

use std::path::PathBuf;
use std::process::Command;

pub fn nix_available() -> bool {
    Command::new("nix")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("mv/ has a parent")
        .to_path_buf()
}

/// The database to test against: `$MV_DB` if the caller has one built,
/// otherwise built out of the flake. Both are the same file; the environment
/// variable only saves the round trip.
pub fn index_db() -> PathBuf {
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

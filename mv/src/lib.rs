//! The multiverse index, read from the database baked into `mv`'s own store
//! path at build time. Read-only, offline: everything answered here comes out
//! of that file and nothing is fetched.
//!
//! A library as well as a binary so the differential test in `tests/` can hold
//! the version comparator against a running `nix`.

pub mod date;
pub mod db;
pub mod lock;
pub mod output;
pub mod query;
pub mod select;
pub mod solve;
pub mod version;

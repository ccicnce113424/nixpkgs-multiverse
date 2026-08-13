//! Calendar arithmetic on the `YYYY-MM-DD` dates the index stores.
//!
//! Hand-rolled rather than a date crate, for the same reason `multiverse.nix`
//! spells it out in Nix: the only operation anything here needs is "how many
//! days between these two dates", the dates are already normalised strings, and
//! there is no clock involved — `mv` never asks what today is, so that
//! everything it reports is reproducible from the index alone.

/// Days from 1970-01-01, or `None` if the string is not a date.
///
/// Howard Hinnant's days_from_civil: shift the year to start in March, which
/// puts the leap day last and makes the month-length pattern regular, then
/// count eras of 400 years. The same algorithm `multiverse.nix` uses, so the
/// two agree on every span they both compute.
pub fn days_from_civil(date: &str) -> Option<i64> {
    let mut parts = date.split('-');
    let y0: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let d: i64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }

    let y = if m <= 2 { y0 - 1 } else { y0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe - 719468)
}

/// Days from `from` to `to`, or 0 if either is not a date. Negative when `to`
/// is the earlier of the two.
pub fn days_between(from: &str, to: &str) -> i64 {
    match (days_from_civil(from), days_from_civil(to)) {
        (Some(a), Some(b)) => b - a,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The epoch, a leap day, and a century boundary — the three places a
    /// days-from-civil implementation goes wrong.
    #[test]
    fn counts_days_from_the_epoch() {
        assert_eq!(days_from_civil("1970-01-01"), Some(0));
        assert_eq!(days_from_civil("1970-01-02"), Some(1));
        assert_eq!(days_from_civil("2000-03-01"), Some(11017));
        assert_eq!(days_from_civil("2024-02-29"), Some(19782));
        // 2100 is not a leap year, which a naive every-fourth-year rule gets
        // wrong by exactly this one day.
        assert_eq!(days_from_civil("2100-03-01"), Some(47541));
    }

    /// Spans across a year boundary and a leap year, and the guard that keeps a
    /// malformed date from being reported as a real span.
    #[test]
    fn measures_spans() {
        assert_eq!(days_between("2026-01-01", "2026-12-31"), 364);
        assert_eq!(days_between("2024-02-28", "2024-03-01"), 2);
        assert_eq!(days_between("2026-08-10", "2026-06-24"), -47);
        assert_eq!(days_between("not-a-date", "2026-01-01"), 0);
    }
}

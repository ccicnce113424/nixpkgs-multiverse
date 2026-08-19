// The store paths a package page shows belong to one system, and the reader
// picks which.
//
// Two claims are worth a browser to check. That switching actually changes the
// paths — a picker wired to nothing looks identical to a working one — and
// that the second system costs nothing until it is asked for, since the whole
// design of the alternate shards is that they sit on disk unfetched.

import { test, expect } from "@playwright/test";

// Long-lived, built for both systems, and small enough that its shard loads
// quickly. The same attribute the other package tests drive.
const ATTR = "ripgrep";

// Where the alternate system's data lives, as built by
// tools/build-site-data.py. The default system keeps the unsuffixed
// directories. Both are per system for the same reason: a store path and the
// set of packages depending on it are both properties of one architecture.
const ALT_SYSTEM = "aarch64-linux";
const ALT_SHARDS = [`**/meta-${ALT_SYSTEM}/**`, `**/revdeps-${ALT_SYSTEM}/**`];

// The store path line of the first expanded version, as text.
const storePathOf = (page) =>
  page.locator(".cmd", { hasText: "nix-store --realise" }).first().innerText();

test("the picker offers both systems and defaults to the aggregated one", async ({
  page,
}) => {
  await page.goto(`/?pkg=${ATTR}`);

  const picker = page.locator(".syspick");
  await expect(picker).toBeVisible();
  await expect(picker.locator("button")).toHaveCount(2);

  // The first system in systems.json is the one every other view is built
  // from, so it is what the page shows before anyone chooses.
  await expect(picker.locator("button").first()).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("the alternate system's shards are not fetched until it is picked", async ({
  page,
}) => {
  const asked = new Set();
  for (const pattern of ALT_SHARDS) {
    await page.route(pattern, (route) => {
      asked.add(new URL(route.request().url()).pathname.split("/")[1]);
      return route.continue();
    });
  }

  await page.goto(`/?pkg=${ATTR}`);
  const first = page.locator(".row.cols-ver").first();
  await expect(first).toBeVisible();

  // Expanded, so the default system's store data has demonstrably landed: if
  // the page fetched both systems it would have fetched them together, and
  // this is the moment that would show.
  await first.click();
  await expect(
    page.locator(".cmd", { hasText: "nix-store --realise" }).first(),
  ).toBeVisible();
  expect([...asked]).toEqual([]);

  // Picking it fetches both of that system's directories, and only then.
  await page.locator(".syspick button", { hasText: ALT_SYSTEM }).click();
  await expect
    .poll(() => [...asked].sort(), {
      message: "picking a system fetches its shards",
    })
    .toEqual([`meta-${ALT_SYSTEM}`, `revdeps-${ALT_SYSTEM}`]);
});

test("switching system changes the store paths", async ({ page }) => {
  await page.goto(`/?pkg=${ATTR}`);

  const first = page.locator(".row.cols-ver").first();
  await expect(first).toBeVisible();
  await first.click();

  const before = await storePathOf(page);
  expect(before).toContain("/nix/store/");

  await page.locator(".syspick button", { hasText: ALT_SYSTEM }).click();

  // Same version, same page, different architecture: the digest has to move.
  // Polled rather than awaited once, because the shard is fetched on click.
  await expect
    .poll(() => storePathOf(page), {
      message: "the store path follows the picked system",
    })
    .not.toBe(before);

  await expect(
    page.locator(".capt", { hasText: `the ${ALT_SYSTEM} build` }),
  ).toBeVisible();
});

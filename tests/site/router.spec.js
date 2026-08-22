// The query string is the site's only state, so these are the tests that say
// a link means what it says.
//
// Two jobs are checked here. A shared URL has to restore the thing it names —
// the right tab, with the right row already open. And because every route is
// one query string over one index.html, the head has to be rewritten per route
// or a crawler sees the same document 30,000 times and indexes the homepage
// alone; that rewrite is invisible on screen and would rot silently.

import { test, expect } from "@playwright/test";

const ATTR = "ripgrep";
const SITE_NAME = "nixpkgs-multiverse";

// How much of a commit sha appears in the ?rev= param — REV_ABBREV in
// site/js/config.js.
const REV_ABBREV = 12;

// The canonical link the page is currently declaring.
const canonicalOf = (page) =>
  page.locator('link[rel="canonical"]').getAttribute("href");

test("a version deep link opens that version's row", async ({ page }) => {
  // The version is read off the rendered table rather than hardcoded: the
  // index is rebuilt hourly and this test is about the router, not about
  // which versions of ripgrep happen to be indexed today.
  await page.goto(`/?pkg=${ATTR}`);
  const version = await page.locator(".row.cols-ver code").first().innerText();

  await page.goto(`/?pkg=${ATTR}&ver=${encodeURIComponent(version)}`);
  await expect(
    page.getByRole("button", { name: `Collapse version ${version}` }),
  ).toBeVisible();
});

test("a revision deep link opens that revision's row", async ({ page }) => {
  // The newest revision, so it lands inside the first rendered window; an
  // older one exercises the widening path instead, which is a different test.
  const revisions = await page.request
    .get("/revisions.json")
    .then((r) => r.json());
  const rev = revisions[revisions.length - 1].rev.slice(0, REV_ABBREV);

  await page.goto(`/?view=revisions&rev=${rev}`);
  await expect(
    page.getByRole("button", { name: /^Collapse revision/ }),
  ).toBeVisible();
});

test("a release deep link opens that release's row", async ({ page }) => {
  await page.goto("/?view=releases");
  const name = await page.locator(".row.cols-rel code").first().innerText();

  await page.goto(`/?view=releases&release=${encodeURIComponent(name)}`);
  await expect(
    page.getByRole("button", { name: `Collapse release ${name}` }),
  ).toBeVisible();
});

test("each route describes itself to a crawler", async ({ page }) => {
  // index.html ships the homepage's title and a canonical hardcoded to "/", so
  // without the per-route rewrite every package URL declares itself a
  // duplicate of the front page and only the front page is ever indexed.
  await page.goto(`/?pkg=${ATTR}`);
  await expect(page).toHaveTitle(`${ATTR} — ${SITE_NAME}`);
  expect(await canonicalOf(page)).toContain(`?pkg=${ATTR}`);

  // The three system views are one document about one package, differing only
  // in which store paths it shows, so they consolidate onto one canonical
  // instead of competing as near-duplicates.
  await page.goto(`/?pkg=${ATTR}&sys=aarch64-linux`);
  expect(await canonicalOf(page)).toContain(`?pkg=${ATTR}`);
  expect(await canonicalOf(page)).not.toContain("sys=");

  // The bare page restores what index.html shipped, rather than keeping the
  // last route's copy.
  await page.goto("/");
  expect(await canonicalOf(page)).not.toContain("?");
});

test("search results are kept out of the index, package pages are not", async ({
  page,
}) => {
  // ?q= accepts anything, so it is an unbounded crawl space. The tag is absent
  // rather than "index,follow" everywhere else, which means asserting on its
  // absence — the case a typo'd selector would pass by default.
  await page.goto("/?q=python");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    /noindex/,
  );

  await page.goto(`/?pkg=${ATTR}`);
  expect(await page.locator('meta[name="robots"]').count()).toBe(0);
});

test("the nav switches view and writes the URL", async ({ page }) => {
  // Clicking, not navigating by URL: the tabs are Link components that
  // preventDefault and navigate in-page, so a broken handler still leaves a
  // working href and only a click can tell the difference.
  await page.goto("/");
  await page.locator("nav a", { hasText: "Revisions" }).click();

  await expect(page).toHaveURL(/\?view=revisions/);
  await expect(page.locator(".row.cols-rev").first()).toBeVisible();
});

test("back returns to the previous view", async ({ page }) => {
  // A tab click pushes history; opening a row replaces it. Back therefore has
  // to walk views rather than keystrokes, which is the behaviour a visitor
  // notices immediately when it breaks.
  await page.goto(`/?pkg=${ATTR}`);
  await page.locator("nav a", { hasText: "Stats" }).click();
  await expect(page).toHaveURL(/\?view=stats/);

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`\\?pkg=${ATTR}`));
  await expect(page.locator(".row.cols-ver").first()).toBeVisible();
});

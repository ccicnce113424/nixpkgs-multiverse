// The dependency graph explorer: the one feature that loads its library on
// demand, and the one that draws to a canvas rather than to the DOM.
//
// cache.nixos.org is stubbed. The question being asked is "does the walk feed
// a graph that draws", not "is the cache up" — and a test that walks a real
// closure fetches hundreds of narinfos and fails whenever the cache is slow.
// The stub is a three-path closure, which is enough to exercise the BFS, the
// parent mapping and the layout.

import { test, expect } from "@playwright/test";

const ATTR = "ripgrep";

// Two synthetic dependencies. Nix store digests are 32 characters of nix
// base-32, and these are valid in that alphabet, so the client's own digest
// checks accept them.
const DEP_A = "a".repeat(32);
const DEP_B = "b".repeat(32);

// "/nix/store/" plus a 32-character digest plus the separating dash: where
// parseNarinfo slices the name out of StorePath.
const NAME_OFFSET = 44;

const NAR_SIZE = 1024;
const FILE_SIZE = 512;

// Serves every narinfo the page asks for. The root references both synthetic
// dependencies; the dependencies reference nothing, so the walk terminates.
async function stubCache(page) {
  await page.route("https://cache.nixos.org/*.narinfo", (route) => {
    const path = new URL(route.request().url()).pathname;
    const digest = path.slice(1, path.indexOf(".narinfo"));
    const isLeaf = digest === DEP_A || digest === DEP_B;
    const storePath = `/nix/store/${digest}-pkg-1.0`;
    expect(storePath.slice(NAME_OFFSET)).toBe("pkg-1.0");

    route.fulfill({
      status: 200,
      contentType: "text/x-nix-narinfo",
      body: [
        `StorePath: ${storePath}`,
        `URL: nar/${digest}.nar.xz`,
        `NarSize: ${NAR_SIZE}`,
        `FileSize: ${FILE_SIZE}`,
        `References: ${isLeaf ? "" : `${DEP_A}-dep-a ${DEP_B}-dep-b`}`,
      ].join("\n"),
    });
  });
}

test("the graph library loads on the click that needs it, and draws", async ({
  page,
}) => {
  // Both halves in one test on purpose: that the library is absent until the
  // button is pressed is only meaningful alongside proof that pressing the
  // button still produces a graph.
  const cytoscapeRequests = [];
  page.on("request", (r) => {
    if (r.url().includes("cytoscape")) {
      cytoscapeRequests.push(r.url());
    }
  });
  await stubCache(page);

  await page.goto(`/?pkg=${ATTR}`);
  await expect(page.locator(".row.cols-ver").first()).toBeVisible();

  // Expanding every row surfaces the draw button without depending on which
  // versions of this attribute currently carry store metadata.
  await page.getByRole("button", { name: "expand all" }).click();
  const draw = page
    .getByRole("button", { name: /draw full dependency graph/ })
    .first();
  await expect(draw).toBeVisible();

  expect(cytoscapeRequests).toEqual([]);

  await draw.click();

  // cytoscape renders into canvases inside the container it is handed.
  await expect(page.locator(".graphbox canvas").first()).toBeVisible();
  expect(cytoscapeRequests.length).toBeGreaterThan(0);

  // The walk found the root and both stubbed dependencies.
  await expect(page.locator(".graphbox .capt")).toContainText("3 paths");
});

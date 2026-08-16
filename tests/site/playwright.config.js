// How the browser suite runs.
//
// The tree under test is a built `nix build .#site` output, not the site/
// source directory. That is the whole point: these tests exercise what GitHub
// Pages actually serves — the data files sitting beside the app, the js.<hash>
// directory rename, and the import map that pulls Preact off the CDN. A suite
// pointed at site/ would skip every one of those and still look green.

import { defineConfig } from "@playwright/test";

// Named by whatever invokes the suite: the flake check, `nix run .#test-site`,
// or a developer with a build of their own. Deliberately no default — a suite
// that silently tested the wrong tree is worse than one that refuses to start.
const SITE_ROOT = process.env.SITE_ROOT;
if (!SITE_ROOT) {
  throw new Error(
    "SITE_ROOT is unset — point it at the result of `nix build .#site`",
  );
}

// Overridable so two runs on one machine do not collide on the port.
const DEFAULT_PORT = 8123;
const PORT = Number(process.env.SITE_PORT ?? DEFAULT_PORT);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// The site fetches Preact from jsdelivr on every page and cytoscape on demand,
// so a run is only as quick as the network it is on. Generous enough that a
// slow CDN is not reported as a broken page.
const TEST_TIMEOUT_MS = 60_000;

// Wide enough that the charts get a real width to lay out in: they size
// themselves off the container, and a narrow viewport collapses them to
// nothing without failing.
const VIEWPORT = { width: 1280, height: 900 };

export default defineConfig({
  testDir: ".",
  timeout: TEST_TIMEOUT_MS,
  // A retry here would only hide a real intermittent failure behind a green
  // tick, and every one of these tests is deterministic given the network.
  retries: 0,
  reporter: "list",
  webServer: {
    command: `python3 -m http.server ${PORT} --directory ${SITE_ROOT}`,
    url: BASE_URL,
    // Always a fresh server on a known tree; reusing whatever happens to hold
    // the port would test an unknown build.
    reuseExistingServer: false,
    stdout: "ignore",
  },
  use: {
    baseURL: BASE_URL,
    viewport: VIEWPORT,
    // Chromium's own sandbox needs privileges a Nix builder does not have, and
    // the run is already confined by Nix.
    launchOptions: { chromiumSandbox: false },
  },
});

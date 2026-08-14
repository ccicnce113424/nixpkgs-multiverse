// The site is a Preact app written with htm tagged templates — no build
// step, no JSX. "htm/preact" resolves through the import map in index.html
// to a pinned, integrity-checked single-file CDN bundle (~13 KB).
import {
  html,
  render,
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
} from "htm/preact";

const FLAKE = "github:fzakaria/nixpkgs-multiverse";
const COMMIT_URL = "https://github.com/NixOS/nixpkgs/commit/";
// The binary cache every indexed path was built into. Serves narinfos with
// open CORS, so the page can ask it directly whether a path is still there.
const CACHE_URL = "https://cache.nixos.org/";
const STORE_DIR = "/nix/store/";
// A store digest: 32 chars of nix base-32.
const DIGEST_RE = /^[0-9abcdfghijklmnpqrsvwxyz]{32}$/;
// How many narinfos a live closure walk may touch before stopping.
const WALK_CAP = 1500;
// How many narinfos the walk fetches at once.
const WALK_BATCH = 24;
// The channel archive: releases.nixos.org fronts the nix-releases bucket and
// renders ?prefix= as a browsable listing (a bare directory URL 404s).
const ARCHIVE_URL = "https://releases.nixos.org/?prefix=nixos/";
const MAX_RESULTS = 200;
const MAX_PINS = 400;
// How many revision rows to render at once. All 1,538 is 52,000px of page
// before anything is even expanded, and expanding them all reaches 229,000px
// across 1,563 horizontally-scrollable <code> blocks — which lays out fine
// headless and janks a real browser badly. A window keeps both bounded.
const REV_PAGE = 150;
// How much of a nixpkgs commit sha appears in labels and in the ?rev= param.
const REV_ABBREV = 12;
const COPY_FLASH_MS = 1200;

const VIEWS = ["packages", "revisions", "releases", "stats"];

const HTTP_NOT_FOUND = 404;

// What a data fetch resolves to when it fails. A sentinel rather than null,
// because "still loading" and "will never load" render differently and both
// have to be distinguishable from data.
const SHARD_ERROR = "error";

const fetchJson = (f) =>
  fetch(f).then((r) => {
    if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
    return r.json();
  });

// Whether a navigation adds a history entry (clicks) or amends the current
// one (typing, opening a row) — so Back walks views, not keystrokes.
const Nav = { PUSH: "push", REPLACE: "replace" };

/* ---------- URL state ----------
 *
 * The query string is the single source of truth for what the page shows,
 * so every view is a shareable link:
 *   ?pkg=ripgrep                  a package's version table
 *   ?pkg=ripgrep&ver=14.1.0       …with one version row open
 *   ?q=python                     a search
 *   ?view=revisions&rev=<sha>     the revisions tab with one revision open
 *   ?view=releases&release=26.05  the releases tab with one release open
 */

function readRoute() {
  const p = new URLSearchParams(location.search);
  const view = VIEWS.includes(p.get("view")) ? p.get("view") : "packages";
  return {
    view,
    q: p.get("q") || "",
    pkg: p.get("pkg") || "",
    ver: p.get("ver") || "",
    rev: p.get("rev") || "",
    release: p.get("release") || "",
  };
}

// Serialize only what the active view needs, so URLs stay minimal and the
// bare page URL means "packages tab, empty search".
function routeToQuery(route) {
  const p = new URLSearchParams();
  if (route.view !== "packages") p.set("view", route.view);
  if (route.view === "packages" && route.pkg) {
    p.set("pkg", route.pkg);
    if (route.ver) p.set("ver", route.ver);
  } else if (route.view === "packages" && route.q) p.set("q", route.q);
  if (route.view === "revisions" && route.rev) p.set("rev", route.rev);
  if (route.view === "releases" && route.release)
    p.set("release", route.release);
  return p.toString();
}

const routeToHref = (route) => {
  const qs = routeToQuery(route);
  return location.pathname + (qs ? `?${qs}` : "");
};

/* ---------- what the page says it is ----------
 *
 * Every view is one query string over one HTML file, so a crawler that stops
 * at the markup sees the same document 30,000 times. index.html ships the
 * homepage's title, description and canonical URL; describeRoute supplies
 * them for everything else, and the effect in App rewrites the head on every
 * navigation. Without that rewrite each package URL keeps index.html's
 * canonical and declares itself a duplicate of the homepage.
 */

const SITE_NAME = "nixpkgs-multiverse";
const SITE_ORIGIN = "https://nixmultiverse.com";

// Whether a route belongs in a search index. ?q= accepts anything, so search
// results are an unbounded crawl space that Google asks sites to keep out of
// the index; the results themselves are still followed for discovery.
const Robots = { INDEX: "index,follow", NOINDEX: "noindex,follow" };

// Whether a <meta> keys off name= (the standard tags) or property= (Open
// Graph, which uses a different attribute for the same job).
const MetaAttr = { NAME: "name", PROPERTY: "property" };

// The homepage's own copy, read out of the tags index.html serves rather than
// spelled out a second time here. Navigating from a package back to the bare
// page restores exactly what was shipped.
const homeHead = {
  title: document.title,
  description: headMeta(MetaAttr.NAME, "description").content,
  ogTitle: headMeta(MetaAttr.PROPERTY, "og:title").content,
  ogDescription: headMeta(MetaAttr.PROPERTY, "og:description").content,
};

// The subject is what the title leads with, ahead of the site name: a search
// result is scanned left to right, and "nixpkgs-multiverse — " in front of
// every one of 30,000 package titles is 21 characters of nothing.
function describeRoute(route) {
  const { view, pkg, ver, q, rev, release } = route;

  if (view === "packages" && pkg && ver) {
    return {
      subject: `${pkg} ${ver}`,
      description:
        `Every nixpkgs revision that shipped ${pkg} ${ver}, with the exact ` +
        `nix run and flake pin commands for that version.`,
      robots: Robots.INDEX,
    };
  }

  if (view === "packages" && pkg) {
    return {
      subject: pkg,
      description:
        `Every version of ${pkg} ever packaged in nixpkgs, across 13 years ` +
        `of revisions, each with the exact nix run and flake pin command.`,
      robots: Robots.INDEX,
    };
  }

  if (view === "packages" && q) {
    return {
      subject: `search “${q}”`,
      description: `nixpkgs packages matching “${q}”, across 300,000+ package versions.`,
      robots: Robots.NOINDEX,
    };
  }

  if (view === "revisions" && rev) {
    return {
      subject: `revision ${rev}`,
      description:
        `The nixpkgs revision ${rev}: its date, its channel build, and every ` +
        `package version pinned at it.`,
      robots: Robots.INDEX,
    };
  }

  if (view === "revisions") {
    return {
      subject: view,
      description:
        "Every nixos-unstable channel revision indexed by nixpkgs-multiverse, " +
        "with its date, what it added and removed, and what it pinned.",
      robots: Robots.INDEX,
    };
  }

  if (view === "releases" && release) {
    return {
      subject: release,
      description:
        `The nixpkgs ${release} release channel: the tip commit it currently ` +
        `points at, its date and its channel build.`,
      robots: Robots.INDEX,
    };
  }

  if (view === "releases") {
    return {
      subject: view,
      description:
        "Every nixpkgs release channel, from 13.10 to today, with the " +
        "revision each one currently points at.",
      robots: Robots.INDEX,
    };
  }

  if (view === "stats") {
    return {
      subject: view,
      description:
        "Statistics over 13 years of nixpkgs: how many packages, how many " +
        "versions of each, and how fast they turn over.",
      robots: Robots.INDEX,
    };
  }

  // The bare page: the packages tab with an empty search, which is the
  // homepage index.html already describes.
  return {
    subject: null,
    description: homeHead.description,
    robots: Robots.INDEX,
  };
}

// The <head> tag carrying one piece of that description, created on first use
// if index.html does not already ship it.
function headMeta(attr, key) {
  let el = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.append(el);
  }
  return el;
}

function headCanonical() {
  let el = document.head.querySelector('link[rel="canonical"]');
  if (!el) {
    el = document.createElement("link");
    el.rel = "canonical";
    document.head.append(el);
  }
  return el;
}

/* ---------- small shared pieces ---------- */

const label = (r) => `${r.date}-${r.rev.slice(0, REV_ABBREV)}`;

// nixos/unstable/<name>/ for a revision, nixos/26.05/<name>/ for a release.
const archiveFor = (channelDir, name) =>
  name ? `${ARCHIVE_URL}${channelDir}/${encodeURIComponent(name)}/` : null;

// Nix-style version ordering: split into digit and non-digit runs, compare
// digit runs numerically. Enough to put 3.12.10 after 3.12.7.
function compareVersions(a, b) {
  const chunks = (s) => s.match(/\d+|\D+/g) || [];
  const ca = chunks(a),
    cb = chunks(b);
  for (let i = 0; i < Math.max(ca.length, cb.length); i++) {
    const x = ca[i] ?? "",
      y = cb[i] ?? "";
    if (x === y) continue;
    const nx = /^\d+$/.test(x),
      ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return 0;
}

// The index records only the NEWEST revision shipping each version, so this
// answers "which package versions are pinned at this revision", not "what was
// in it" — the full contents of a revision are the whole of nixpkgs.
// Built once per loaded index, on the first open row.
let pinsCache = null;
function pinsFor(index, offset) {
  if (!pinsCache) {
    pinsCache = new Map();
    for (const [attr, versions] of Object.entries(index.attrs))
      for (const [v, off] of Object.entries(versions)) {
        let l = pinsCache.get(off);
        if (!l) pinsCache.set(off, (l = []));
        l.push([attr, v]);
      }
    for (const l of pinsCache.values())
      l.sort((x, y) => (x[0] < y[0] ? -1 : 1));
  }
  return pinsCache.get(offset) || [];
}

const CopyIcon = () => html`
  <svg
    width="18"
    height="18"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
  >
    <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
    <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </svg>
`;

// An internal link: a real href for copy-link / middle-click, an in-page
// navigation for a plain click.
function Link({ to, navigate, children, ...rest }) {
  // `to` is a partial route, and `navigate` merges a patch onto the CURRENT
  // route — so navigating with the patch alone keeps whatever view the link
  // was clicked from. A package link inside the revisions tab then set `pkg`
  // and stayed on revisions, where routeToQuery drops `pkg` again, so the
  // click did nothing while the href beside it pointed at the package page.
  // Navigate to the same fully-resolved target the href names.
  const target = {
    view: "packages",
    q: "",
    pkg: "",
    ver: "",
    rev: "",
    release: "",
    ...to,
  };
  const onClick = (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    navigate(target);
  };
  return html`<a href=${routeToHref(target)} onClick=${onClick} ...${rest}
    >${children}</a
  >`;
}

// Shared behavior for a <details> row addressed by a URL param. A linked-to
// row (shared URL, or a click from another tab) opens itself and scrolls its
// summary line into view — the summary rather than the element, because
// centering the whole details would include the expanded body and land the
// viewport inside it. A row the user toggles by hand is already on screen,
// so it only records itself in the URL (or clears itself on close), without
// stacking history entries.
function useLinkableRow(selected, record, bulk) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!selected || open) return;
    setOpen(true);
    ref.current?.querySelector(".row").scrollIntoView({ block: "start" });
  }, [selected]);

  // Keyed on `seq` rather than on `open` so that expanding all, collapsing one
  // by hand, then expanding all again still fires.
  useEffect(() => {
    if (!bulk) return;
    setOpen(bulk.open);
  }, [bulk?.seq]);

  // Only a user action reaches here. The <details> version could not assume
  // that — the element fires `toggle` for programmatic opens too, so a bulk
  // expand looked exactly like 1,538 clicks and each one navigated. Driving
  // the open state ourselves makes the distinction structural.
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) record(true);
    else if (selected) record(false);
  };

  return { open, ref, toggle };
}

// A valid id from arbitrary text, for aria-controls.
const domId = (s) => "b-" + s.replace(/[^a-zA-Z0-9_-]/g, "_");

// The disclosure row.
//
// <details>/<summary> is the obvious markup and is exactly what Chromium
// flagged 348 times: everything visible while a row is collapsed has to live
// inside <summary>, these rows carry commit and channel-build links, and an
// interactive element nested inside a <summary> is not reliably reachable by
// keyboard or announced by assistive technology.
//
// So the disclosure is a real <button> and the links are its siblings — every
// one an ordinary tab stop, nothing nested inside anything interactive. The
// row stays clickable as a convenience on top of the button, never as the only
// way to open it, and a click that lands on a link is left alone.
function Row({ cols, id, label, open, toggle, rowRef, children, body }) {
  const onClick = (e) => {
    if (e.target.closest("a")) return;
    toggle();
  };
  return html`
    <div class="item" ref=${rowRef}>
      <div class=${`row ${cols}`} onClick=${onClick}>
        <button
          class="disclose"
          type="button"
          aria-expanded=${open ? "true" : "false"}
          aria-controls=${id}
          aria-label=${`${open ? "Collapse" : "Expand"} ${label}`}
          onClick=${(e) => {
            e.stopPropagation();
            toggle();
          }}
        >
          ${open ? "▾" : "▸"}
        </button>
        ${children}
      </div>
      <div class="body" id=${id} hidden=${!open}>${open && body}</div>
    </div>
  `;
}

// Every {open, seq} force — expand-all and per-version alike — draws its
// sequence number from here. useLinkableRow keys its effect on `seq`, so two
// independent counters collide the moment both reach the same value: after one
// expand-all (seq 1), the first per-version toggle also minted seq 1, the dep
// did not change, and clicking a bar silently did nothing.
let forceSeq = 0;
const nextSeq = () => ++forceSeq;

// One expand/collapse control per view. Returns the state to thread into every
// useLinkableRow on the page plus the button that drives it.
function useBulk() {
  const [bulk, setBulk] = useState(null);
  const button = html`<button
    class="bulk"
    onClick=${() => setBulk({ open: !bulk?.open, seq: nextSeq() })}
  >
    ${bulk?.open ? "collapse all" : "expand all"}
  </button>`;
  return [bulk, button];
}

// A copyable command: one block, the command never wraps, the icon rides
// on the right edge and flashes a check after copying.
function Cmd({ text, caption }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_FLASH_MS);
  };
  return html`
    ${caption && html`<div class="capt">${caption}</div>`}
    <div class="cmd">
      <code>${text}</code>
      <button title="copy" onClick=${copy}>
        ${copied ? "✓" : html`<${CopyIcon} />`}
      </button>
    </div>
  `;
}

/* ---------- store metadata: cache liveness, deps, closures ----------
 *
 * Everything here rides on two facts. The meta shards carry each version's
 * store digest, sizes, liveness at census time and direct references; and
 * cache.nixos.org serves narinfos with open CORS, so anything deeper — is it
 * still there right now, what is the full closure — the browser asks the
 * cache itself. The shards store breadth; the client computes depth.
 */

function fmtBytes(n) {
  if (n == null) return "?";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  for (const u of units) {
    v /= 1024;
    if (v < 1024) return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u}`;
  }
  return `${v.toFixed(1)} PB`;
}

// The full /nix/store path for a version's meta entry.
const storePathOf = (attr, v, entry) =>
  `${STORE_DIR}${entry.d}-${entry.n ?? `${attr}-${v}`}`;

// A narinfo is "Key: value" lines. References holds path basenames; only
// their digests matter here.
function parseNarinfo(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(": ");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 2);
  }
  return {
    ns: out.NarSize ? Number(out.NarSize) : null,
    fs: out.FileSize ? Number(out.FileSize) : null,
    url: out.URL || null,
    name: out.StorePath ? out.StorePath.slice(44) : null,
    refs: (out.References || "")
      .split(" ")
      .filter(Boolean)
      .map((b) => b.slice(0, 32)),
  };
}

const narinfoCache = new Map();
function fetchNarinfo(digest) {
  if (!narinfoCache.has(digest)) {
    narinfoCache.set(
      digest,
      fetch(`${CACHE_URL}${digest}.narinfo`).then((r) => {
        if (r.status === HTTP_NOT_FOUND) return { dead: true };
        if (!r.ok) throw new Error(`narinfo: HTTP ${r.status}`);
        return r.text().then(parseNarinfo);
      }),
    );
  }
  return narinfoCache.get(digest);
}

// Asks the cache, live, whether this exact path still substitutes — and what
// it costs. The census answer from the shard renders immediately; the live
// answer replaces it when it arrives, so the badge is never stale.
function CacheBadge({ entry }) {
  const [live, setLive] = useState(null);
  useEffect(() => {
    let on = true;
    fetchNarinfo(entry.d)
      .then((i) => on && setLive(i))
      .catch(() => on && setLive({ err: true }));
    return () => {
      on = false;
    };
  }, [entry.d]);

  // A failed fetch says nothing about the path — only a definite 404 does.
  // Anything else falls back to what the census recorded.
  const verified = live && !live.err;
  const alive = verified ? !live.dead : entry.ok !== 0;
  const ns = live?.ns ?? entry.ns;
  const fs = live?.fs ?? entry.fs;

  return html`
    <div class="cachebadge">
      <span class=${alive ? "badge-ok" : "badge-dead"}>
        ${alive ? "●" : "○"}
        ${alive
          ? ` still substitutable${verified ? "" : " (census)"}`
          : " no longer in the cache"}
      </span>
      ${fs != null &&
      html`<span class="muted">
        · ${fmtBytes(fs)} download · ${fmtBytes(ns)} installed</span
      >`}
      ${alive &&
      live?.url &&
      html`<span>
        · <a href=${CACHE_URL + live.url} rel="nofollow">download the NAR</a>
      </span>`}
    </div>
  `;
}

// Strip the version off a drv name: "openssl-1.0.1f" -> "openssl". Same rule
// as Nix's parseDrvName — the version starts at the first dash before a digit.
const pnameOf = (name) => name.split(/-(?=\d)/)[0];

// The direct dependencies of one version, as recorded in the cache the day it
// was built. A dep that is itself an indexed package links to its page at the
// exact version; anything else (multi-output libs, private packages) shows as
// its store name.
function Deps({ refs, src, navigate }) {
  const [showAll, setShowAll] = useState(false);
  if (!refs?.length) return null;
  const shown = showAll ? refs : refs.slice(0, 24);
  return html`
    <div class="capt">
      links against ${refs.length} paths directly
      ${src
        ? ` (from its ${src} output's narinfo — the default output is a stub)`
        : " (from its narinfo)"}
    </div>
    <div class="chips">
      ${shown.map((p) =>
        refAttr(p)
          ? html`<${Link}
              class="chip chip-link"
              to=${{ pkg: refAttr(p), ver: refVer(p) }}
              navigate=${navigate}
              key=${refName(p)}
            >
              ${refAttr(p)} <span class="muted">${refVer(p)}</span>
            <//>`
          : html`<span class="chip" key=${refName(p)} title=${refName(p)}>
              ${refName(p)}
            </span>`,
      )}
      ${refs.length > shown.length &&
      html`<button class="more" onClick=${() => setShowAll(true)}>
        +${refs.length - shown.length} more
      </button>`}
    </div>
  `;
}

// Who linked against this exact version — the inverted References index.
function UsedBy({ rd, navigate }) {
  const [showAll, setShowAll] = useState(false);
  if (!rd || !rd.c) return null;
  const shown = showAll ? rd.l : rd.l.slice(0, 24);
  return html`
    <div class="capt">
      used by ${rd.c.toLocaleString()} package version${rd.c === 1 ? "" : "s"}
      ${rd.c > rd.l.length ? ` (showing ${rd.l.length})` : ""}
    </div>
    <div class="chips">
      ${shown.map(
        ([a, v]) => html`
          <${Link}
            class="chip chip-link"
            to=${{ pkg: a, ver: v }}
            navigate=${navigate}
            key=${`${a}@${v}`}
          >
            ${a} <span class="muted">${v}</span>
          <//>
        `,
      )}
      ${rd.l.length > shown.length &&
      html`<button class="more" onClick=${() => setShowAll(true)}>
        +${rd.l.length - shown.length} more
      </button>`}
    </div>
  `;
}

// What changed structurally against the previous version: dependencies
// gained, dropped, or re-versioned. Identity is the dep's attribute when
// resolved, its pname otherwise, so an openssl bump reads as a change to
// openssl rather than as one dep leaving and an unrelated one arriving.
const DIFF_SHOWN = 14;

function DepDiff({ refs, prevRefs }) {
  const [showAll, setShowAll] = useState(false);
  if (!refs || !prevRefs) return null;
  const key = (p) => refAttr(p) ?? pnameOf(refName(p));
  const disp = (p) => refVer(p) ?? refName(p).slice(key(p).length + 1);
  const cur = new Map(refs.map((p) => [key(p), p]));
  const prev = new Map(prevRefs.map((p) => [key(p), p]));
  const items = [
    ...[...cur.keys()]
      .filter((k) => !prev.has(k))
      .map((k) => html`<span class="a" key=${`a${k}`}>+${k}</span>`),
    ...[...prev.keys()]
      .filter((k) => !cur.has(k))
      .map((k) => html`<span class="d" key=${`d${k}`}>−${k}</span>`),
    ...[...cur.keys()]
      .filter((k) => prev.has(k) && disp(cur.get(k)) !== disp(prev.get(k)))
      .map(
        (k) =>
          html`<span class="muted" key=${`b${k}`}
            >${k} ${disp(prev.get(k))}→${disp(cur.get(k))}</span
          >`,
      ),
  ];
  if (!items.length)
    return html`<div class="capt">
      same dependency set as the previous version
    </div>`;
  const shown = showAll ? items : items.slice(0, DIFF_SHOWN);
  return html`
    <div class="capt">vs the previous version (${items.length} changes)</div>
    <div class="depdiff delta">
      ${shown}
      ${items.length > shown.length &&
      html`<button class="more" onClick=${() => setShowAll(true)}>
        +${items.length - shown.length} more
      </button>`}
    </div>
  `;
}

// Walk the References graph live against cache.nixos.org, narinfo by narinfo,
// until the closure is complete (or the cap). No index data is involved —
// this is the browser asking the cache what the closure is, which both
// verifies the precomputed number and produces the full path list.
async function walkClosure(digest, onProgress) {
  const seen = new Map();
  const queued = new Set([digest]);
  let frontier = [digest];
  while (frontier.length && seen.size < WALK_CAP) {
    const batch = frontier.splice(0, WALK_BATCH);
    const infos = await Promise.all(
      batch.map((d) =>
        fetchNarinfo(d)
          .then((i) => ({ d, ...i }))
          .catch(() => ({ d, err: true })),
      ),
    );
    for (const i of infos) {
      seen.set(i.d, i);
      for (const r of i.refs || [])
        if (!queued.has(r)) {
          queued.add(r);
          frontier.push(r);
        }
    }
    onProgress(seen.size, frontier.length);
  }
  return { seen, complete: !frontier.length };
}

function ClosureLive({ entry }) {
  const [state, setState] = useState(null); // {n, left} | {done}
  const run = async () => {
    setState({ n: 0, left: 1 });
    const { seen, complete } = await walkClosure(entry.d, (n, left) =>
      setState({ n, left }),
    );
    const paths = [...seen.values()].filter((i) => !i.dead && !i.err);
    const dead = [...seen.values()].filter((i) => i.dead).length;
    const total = paths.reduce((s, i) => s + (i.ns || 0), 0);
    const top = paths
      .slice()
      .sort((a, b) => (b.ns || 0) - (a.ns || 0))
      .slice(0, 8);
    setState({ done: true, count: seen.size, dead, total, top, complete });
  };

  if (!state)
    return html`<button class="more" onClick=${run}>
      walk the full closure live from cache.nixos.org →
    </button>`;
  if (!state.done)
    return html`<div class="capt">
      walking… ${state.n} narinfos fetched, ${state.left} queued
    </div>`;
  return html`
    <div class="capt">
      closure, measured live:
      <b>${state.count} paths · ${fmtBytes(state.total)}</b>
      ${state.dead ? ` · ${state.dead} paths gone from the cache` : ""}
      ${state.complete ? "" : ` · stopped at ${WALK_CAP} paths`}
    </div>
    <div class="chips">
      ${state.top.map(
        (i) =>
          html`<span class="chip" key=${i.d} title=${i.name}
            >${i.name ?? i.d} <span class="muted">${fmtBytes(i.ns)}</span></span
          >`,
      )}
    </div>
  `;
}

/* ---------- dependency graph explorer ----------
 *
 * The FULL transitive closure of one version, drawn as concentric rings by
 * dependency depth — fetched live from cache.nixos.org by the same walk the
 * closure button uses, so every node is a real narinfo and every edge a real
 * References entry. Median closure is 16 paths and p99 is ~500, so plain SVG
 * with viewBox zoom is plenty; the walk cap bounds the 0.03% tail.
 *
 * Tree edges only (first-discovery parent), or dense closures become a
 * hairball. Node area tracks NAR size. Scroll to zoom, drag to pan; labels
 * are drawn in graph units, so zooming in makes them readable.
 */
const GRAPH_RING = 150; // px between depth rings
const GRAPH_LABELED = 40; // nodes past depth 1 that still get labels
const ZOOM_STEP = 1.2;
const ZOOM_MAX_FACTOR = 40;

function GraphExplorer({ attr, v, entry, navigate }) {
  const [state, setState] = useState(null); // null | {walking} | the graph
  const [view, setView] = useState(null); // viewBox override while zooming
  const svgRef = useRef(null);
  const drag = useRef(null);
  const names = useNames();

  const run = async () => {
    setState({ walking: 0 });
    const { seen, complete } = await walkClosure(entry.d, (n) =>
      setState({ walking: n }),
    );

    // BFS depths and a spanning tree (first-discovery parent) over the walk.
    const depth = new Map([[entry.d, 0]]);
    const parent = new Map();
    let frontier = [entry.d];
    while (frontier.length) {
      const next = [];
      for (const d of frontier)
        for (const r of seen.get(d)?.refs || [])
          if (seen.has(r) && !depth.has(r)) {
            depth.set(r, depth.get(d) + 1);
            parent.set(r, d);
            next.push(r);
          }
      frontier = next;
    }

    // Concentric rings by depth. Each ring is ordered by its parents' angles
    // so subtrees stay angularly together and tree edges rarely cross.
    const rings = [];
    for (const [d, dep] of depth) (rings[dep] ??= []).push(d);
    const angle = new Map([[entry.d, -Math.PI / 2]]);
    const maxDepth = rings.length - 1;
    const R = Math.max(1, maxDepth) * GRAPH_RING + 80;
    const posOf = new Map([[entry.d, [R, R]]]);
    for (let dep = 1; dep < rings.length; dep++) {
      const ring = rings[dep].slice().sort((a, b) => {
        const pa = angle.get(parent.get(a)) ?? 0;
        const pb = angle.get(parent.get(b)) ?? 0;
        return pa - pb || (a < b ? -1 : 1);
      });
      ring.forEach((d, i) => {
        const a = (i / ring.length) * 2 * Math.PI - Math.PI / 2;
        angle.set(d, a);
        posOf.set(d, [
          R + dep * GRAPH_RING * Math.cos(a),
          R + dep * GRAPH_RING * Math.sin(a),
        ]);
      });
    }

    // Labels: everything near the root, then only the heaviest of the rest.
    const labeled = new Set(rings[0].concat(rings[1] || []));
    [...depth.keys()]
      .filter((d) => depth.get(d) > 1)
      .sort((a, b) => (seen.get(b)?.ns || 0) - (seen.get(a)?.ns || 0))
      .slice(0, GRAPH_LABELED)
      .forEach((d) => labeled.add(d));

    const nodes = [...depth.keys()].map((d) => {
      const i = seen.get(d);
      const name = i?.name ?? d;
      const pn = pnameOf(name);
      return {
        d,
        name,
        ns: i?.ns,
        depth: depth.get(d),
        pos: posOf.get(d),
        label: labeled.has(d),
        link: names && names !== SHARD_ERROR && names[pn] ? pn : null,
        ver: name.slice(pn.length + 1),
      };
    });
    const total = nodes.reduce((s, nd) => s + (nd.ns || 0), 0);
    setState({ nodes, parent, posOf, R, complete, total });
  };

  if (!entry.d) return null;
  if (!state)
    return html`<button class="more" onClick=${run}>
      draw the full dependency graph — live from cache.nixos.org →
    </button>`;
  if (state.walking != null)
    return html`<div class="capt">
      walking the closure… ${state.walking} narinfos fetched
    </div>`;

  const { nodes, parent, posOf, R, complete, total } = state;
  const W = 2 * R;
  const vb = view ?? { x: 0, y: 0, w: W, h: W };

  const onWheel = (e) => {
    e.preventDefault();
    const box = svgRef.current.getBoundingClientRect();
    const px = vb.x + ((e.clientX - box.left) / box.width) * vb.w;
    const py = vb.y + ((e.clientY - box.top) / box.height) * vb.h;
    const k = e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    const w = Math.min(W * 1.5, Math.max(W / ZOOM_MAX_FACTOR, vb.w * k));
    setView({
      x: px - ((px - vb.x) / vb.w) * w,
      y: py - ((py - vb.y) / vb.h) * w,
      w,
      h: w,
    });
  };
  const onDown = (e) => {
    drag.current = { x: e.clientX, y: e.clientY, vb };
  };
  const onMove = (e) => {
    if (!drag.current) return;
    const box = svgRef.current.getBoundingClientRect();
    const d = drag.current;
    setView({
      ...d.vb,
      x: d.vb.x - ((e.clientX - d.x) / box.width) * d.vb.w,
      y: d.vb.y - ((e.clientY - d.y) / box.height) * d.vb.h,
    });
  };
  const onUp = () => (drag.current = null);
  const rOf = (ns) => 2.5 + Math.log10((ns || 1) / 1024 + 1) * 1.6;

  return html`
    <div class="graphbox">
      <svg
        ref=${svgRef}
        viewBox=${`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        style="height:480px;touch-action:none;cursor:grab"
        onWheel=${onWheel}
        onPointerDown=${onDown}
        onPointerMove=${onMove}
        onPointerUp=${onUp}
        onPointerLeave=${onUp}
      >
        ${nodes.map((nd) => {
          const p = parent.get(nd.d);
          if (!p) return null;
          const [px, py] = posOf.get(p);
          return html`<line
            class=${`g-edge${nd.depth > 1 ? " g-edge2" : ""}`}
            key=${`e${nd.d}`}
            x1=${px}
            y1=${py}
            x2=${nd.pos[0]}
            y2=${nd.pos[1]}
          />`;
        })}
        ${nodes.map((nd) => {
          const [x, y] = nd.pos;
          const isRoot = nd.depth === 0;
          const jump = () =>
            nd.link && navigate({ pkg: nd.link, ver: nd.ver });
          return html`
            <g key=${`n${nd.d}`}>
              <circle
                class=${isRoot
                  ? "g-node g-center"
                  : `g-node${nd.link ? " g-node-link" : ""}`}
                cx=${x}
                cy=${y}
                r=${isRoot ? 7 : rOf(nd.ns)}
                onClick=${jump}
              >
                <title>${nd.name} · ${fmtBytes(nd.ns)}</title>
              </circle>
              ${nd.label &&
              html`<text
                class=${isRoot
                  ? "g-label g-center-label"
                  : `g-label${nd.depth > 1 ? " g-label2" : ""}${
                      nd.link ? " g-label-link" : ""
                    }`}
                x=${x}
                y=${y - (isRoot ? 12 : rOf(nd.ns) + 3)}
                text-anchor="middle"
                onClick=${jump}
              >
                ${nd.name}
              </text>`}
            </g>
          `;
        })}
      </svg>
      <div class="capt">
        the complete runtime closure, fetched live from cache.nixos.org:
        <b>${nodes.length} paths · ${fmtBytes(total)}</b>
        ${complete ? "" : ` (stopped at ${WALK_CAP} paths)`} — one ring per
        dependency depth, node size tracks installed size, tree edges only.
        Scroll to zoom (labels get readable), drag to pan, click a blue node
        to jump to its package.
      </div>
    </div>
  `;
}

/* ---------- packages ---------- */

/* ---------- identify: a store path pasted into the search box ----------
 *
 * The reverse index: digest -> (attr, version). Sharded by the digest's own
 * first two characters. This answers "what IS this store path" — for any of
 * the 300,000 outputs the index knows, from any machine's /nix/store or any
 * closure dump, thirteen years back.
 */
function IdentifyCard({ digest, navigate }) {
  const file = useFile(`identify/${digest.slice(0, 2)}.json`);
  if (!file)
    return html`<div id="status" class="muted">Looking up the digest…</div>`;
  const hit = file !== SHARD_ERROR && file[digest];
  if (!hit)
    return html`<div id="status" class="muted">
      <code>${digest}</code> is not an output the index knows — not a package
      output of any indexed nixos-unstable revision (it may be a non-default
      output, or from a private build).
    </div>`;
  const [attr, ver] = hit;
  return html`
    <div id="status" class="muted">identified:</div>
    <div class="identify">
      <${Link} class="pkg" to=${{ pkg: attr, ver }} navigate=${navigate}>
        <b>${attr}</b> <span class="muted">${ver}</span> — see when it shipped
        and how to run it →
      <//>
    </div>
  `;
}

// depends:<attr> — every package that ever linked against any version of
// <attr>, aggregated out of the reverse-dependency shards.
function DependsSearch({ target, navigate }) {
  const rd = useShard(Shard.REVDEPS, target);
  if (!rd) return html`<div id="status" class="muted">Loading…</div>`;
  if (rd === SHARD_ERROR || !Object.keys(rd).length)
    return html`<div id="status" class="muted">
      Nothing ever recorded a runtime dependency on <code>${target}</code>.
    </div>`;
  const counts = new Map();
  for (const entry of Object.values(rd))
    for (const [a] of entry.l) counts.set(a, (counts.get(a) || 0) + 1);
  const rows = [...counts.entries()].sort((x, y) => y[1] - x[1]);
  const total = Object.values(rd).reduce((s, e) => s + e.c, 0);
  return html`
    <div id="status" class="muted">
      ${rows.length.toLocaleString()} packages linked against
      <code>${target}</code> across ${total.toLocaleString()} recorded
      version-edges
    </div>
    <div id="results">
      ${rows.slice(0, MAX_RESULTS).map(
        ([a, n]) => html`
          <${Link} class="pkg" to=${{ pkg: a, ver: "" }} navigate=${navigate} key=${a}>
            ${a} <span class="muted">· ${n} linked version${n === 1 ? "" : "s"}</span>
          <//>
        `,
      )}
    </div>
  `;
}

// Mounted whenever the packages tab is not showing one package, so landing on
// the bare page starts the name list downloading before anything is typed.
function SearchResults({ q, navigate }) {
  const names = useNames();
  // json.dump wrote the names sorted, but only a sort here says so.
  const attrNames = useMemo(
    () => (names && names !== SHARD_ERROR ? Object.keys(names).sort() : null),
    [names],
  );

  const raw = q.trim();

  // A pasted store path or bare digest short-circuits the name search: the
  // question is "what is this", not "what is called this" — and it needs no
  // name list, so it renders ahead of the loading states below.
  const pathish = raw.startsWith(STORE_DIR) ? raw.slice(STORE_DIR.length) : raw;
  const maybeDigest = pathish.split("-")[0];
  if (DIGEST_RE.test(maybeDigest))
    return html`<${IdentifyCard} digest=${maybeDigest} navigate=${navigate} />`;

  // depends:openssl — search by edge rather than by name.
  if (raw.toLowerCase().startsWith("depends:")) {
    const target = raw.slice("depends:".length).trim();
    if (target)
      return html`<${DependsSearch} target=${target} navigate=${navigate} />`;
  }

  if (names === SHARD_ERROR)
    return html`<div id="status" class="muted">
      Could not load the package list.
    </div>`;
  if (!names)
    return html`<div id="status" class="muted">Loading the package list…</div>`;

  const query = raw.toLowerCase();
  if (!query) return null;

  // startsWith matches rank ahead of substring matches.
  const starts = [],
    contains = [];
  for (const a of attrNames) {
    const i = a.toLowerCase().indexOf(query);
    if (i === 0) starts.push(a);
    else if (i > 0) contains.push(a);
    if (starts.length >= MAX_RESULTS) break;
  }
  const hits = starts.concat(contains).slice(0, MAX_RESULTS);
  const status = !hits.length
    ? "no matches"
    : hits.length === MAX_RESULTS
      ? `first ${MAX_RESULTS} matches`
      : `${hits.length} matches`;

  return html`
    <div id="status" class="muted">${status}</div>
    <div id="results">
      ${hits.map(
        (a) => html`
          <${Link}
            class="pkg"
            to=${{ pkg: a, ver: "" }}
            navigate=${navigate}
            key=${a}
          >
            ${a}
            <span class="muted">· ${names[a]} versions</span>
          <//>
        `,
      )}
    </div>
  `;
}

// The runs for one version: when it was actually the version nixpkgs shipped.
// Each end is a link to that revision, so a lifetime is navigable rather than
// just readable.
function Runs({ runs, revisions, navigate }) {
  if (!runs) return null;
  return html`
    <div class="capt">
      ${runs.length === 1
        ? "when this was the version nixpkgs shipped"
        : `${runs.length} separate stretches — it left nixpkgs and came back`}
    </div>
    <div class="runs">
      ${runs.map(([s, e]) => {
        const a = revisions[s],
          b = revisions[e];
        if (!a) return null;
        return html`<div>
          <${Link}
            to=${{ view: "revisions", rev: a.rev.slice(0, REV_ABBREV) }}
            navigate=${navigate}
            >${a.date}<//
          >${s === e
            ? html`<span class="muted"> · one revision</span>`
            : html`<span class="muted"> → </span>
                <${Link}
                  to=${{ view: "revisions", rev: b.rev.slice(0, REV_ABBREV) }}
                  navigate=${navigate}
                  >${b.date}<//
                >
                <span class="muted"> · ${e - s + 1} revisions</span>`}
        </div>`;
      })}
    </div>
  `;
}

function VersionRow({
  attr,
  v,
  r,
  runs,
  revisions,
  selected,
  bulk,
  onOpenChange,
  navigate,
  entry,
  paths,
  prevEntry,
  rd,
  metaReady,
}) {
  const { open, ref, toggle } = useLinkableRow(
    selected,
    (isOpen) => navigate({ ver: isOpen ? v : "" }, Nav.REPLACE),
    bulk,
  );

  useEffect(() => onOpenChange(v, open), [open]);

  const refsOf = (e) => e?.r && paths && e.r.map((i) => paths[i]);
  const archive = archiveFor("unstable", r.name);
  return html`
    <${Row}
      cols="cols-ver"
      id=${domId(`${attr}-${v}`)}
      label=${`version ${v}`}
      open=${open}
      toggle=${toggle}
      rowRef=${ref}
      body=${html`
        <${Cmd}
          text=${`nix run '${FLAKE}#versions.${attr}."${v}"'`}
          caption="run this version"
        />
        ${entry &&
        html`
          <${Cmd}
            text=${`nix-store --realise ${storePathOf(attr, v, entry)}`}
            caption="materialize with zero evaluation — substituted straight from cache.nixos.org"
          />
          <${CacheBadge} entry=${entry} />
        `}
        <${Cmd}
          text=${`github:NixOS/nixpkgs/${r.rev}`}
          caption="pin another flake's nixpkgs to it"
        />
        <${Runs} runs=${runs} revisions=${revisions} navigate=${navigate} />
        ${metaReady &&
        !entry &&
        html`<div class="capt">
          no store path is known for this version — it never appeared in a
          channel's store-paths listing (Hydra does not build unfree or broken
          packages), or its derivation name has drifted from the attribute
          name — so cache size, dependency and closure data are unavailable
        </div>`}
        ${entry &&
        !entry.r &&
        html`<div class="capt">
          no runtime references were recorded for this build — either the
          path genuinely references nothing, or this is a multi-output
          package whose payload lives in sibling outputs (‑lib, ‑bin)
          the prototype does not index
        </div>`}
        ${entry &&
        (() => {
          // A wrapper names its payload in its own references: the same
          // attribute with -unwrapped. Say so, or the tiny NAR above reads
          // as an error.
          const inner = refsOf(entry)?.find(
            (p) => refAttr(p) === `${attr}-unwrapped`,
          );
          return (
            inner &&
            html`<div class="capt">
              this attribute is a wrapper — the application itself is${" "}
              <${Link}
                to=${{ pkg: refAttr(inner), ver: refVer(inner) }}
                navigate=${navigate}
                >${refAttr(inner)} ${refVer(inner)}<//
              >; the installed size above is the wrapper's own
            </div>`
          );
        })()}
        ${entry?.o?.length &&
        html`<div class="capt">
          multi-output package — sibling outputs seen in consumers' closures:
          ${" " +
          entry.o.map(([s, sz]) => `${s} ${fmtBytes(sz)}`).join(" · ")}
        </div>`}
        ${entry &&
        html`
          <${Deps} refs=${refsOf(entry)} src=${entry.rsrc} navigate=${navigate} />
          <${DepDiff} refs=${refsOf(entry)} prevRefs=${refsOf(prevEntry)} />
          <${UsedBy} rd=${rd} navigate=${navigate} />
          ${entry.cs != null &&
          html`<div class="capt">
            closure at census: <b>${fmtBytes(entry.cs)}</b>
            ${` across ${entry.cn ?? "?"} paths`}
          </div>`}
          <div class="links">
            <${ClosureLive} entry=${entry} />
          </div>
          <${GraphExplorer}
            attr=${attr}
            v=${v}
            entry=${entry}
            paths=${paths}
            navigate=${navigate}
          />
        `}
      `}
    >
      <code>${v}</code>
      <span>
        <${Link}
          to=${{ view: "revisions", rev: r.rev.slice(0, REV_ABBREV) }}
          navigate=${navigate}
        >
          ${label(r)}
        <//>
      </span>
      <span class="rowsize muted">
        ${entry?.ns != null ? fmtBytes(entry.ns) : ""}
        ${entry && entry.ok === 0 ? html`<span class="badge-dead">○</span>` : ""}
      </span>
      <span class="muted"
        >${archive && html`<a href=${archive}>${r.name}</a>`}</span
      >
    <//>
  `;
}

function PackageDetail({ attr, route, revisions, navigate }) {
  const versions = useVersions(attr);
  const hist = useHistory(attr);
  const metaFile = useWholeShard(Shard.META, attr);
  const revdeps = useShard(Shard.REVDEPS, attr);
  const [bulk, bulkButton] = useBulk();
  const [openVers, setOpenVers] = useState(() => new Set());
  // Read inside toggleVer without making it depend on the set, so the callback
  // stays stable and every row does not re-render on each open/close.
  const openRef = useRef(openVers);
  openRef.current = openVers;

  const onOpenChange = useCallback((v, isOpen) => {
    setOpenVers((prev) => {
      if (prev.has(v) === isOpen) return prev;
      const next = new Set(prev);
      if (isOpen) next.add(v);
      else next.delete(v);
      return next;
    });
  }, []);

  // Clicking a bar drives the row directly rather than going through the URL.
  // `ver` can only name one version, so routing the click through it could
  // open a row but never close one — the timeline toggled on and never off.
  const [force, setForce] = useState({});
  // navigate closes over the current route, so it is a new function every
  // render; holding it in a ref keeps toggleVer stable and stops every row
  // re-rendering whenever the route changes.
  const navRef = useRef(navigate);
  navRef.current = navigate;

  const toggleVer = useCallback((v) => {
    const willOpen = !openRef.current.has(v);
    setForce((prev) => ({ ...prev, [v]: { open: willOpen, seq: nextSeq() } }));
    // The URL holds the most recently expanded version, whichever way it was
    // opened. Composing every open row into the query was the alternative and
    // does not scale: expanding all 1,538 revisions would be a ~20,000
    // character URL, past what servers and CDNs accept.
    navRef.current({ ver: willOpen ? v : "" }, Nav.REPLACE);
  }, []);

  // An expand-all supersedes every per-version force, otherwise a row touched
  // through the graph would ignore the button from then on.
  useEffect(() => setForce({}), [bulk?.seq]);
  if (!versions)
    return html`<div id="status" class="muted">Loading versions…</div>`;
  if (versions === SHARD_ERROR)
    return html`<div id="status" class="muted">
      Could not load the versions of <code>${attr}</code>.
    </div>`;
  if (!Object.keys(versions).length)
    return html`<div id="status" class="muted">
      No attribute named <code>${attr}</code> in the index.
    </div>`;
  // The table is a join against revisions.json: every row names the revision
  // that shipped its version, and the lifetime line below reads dates out of
  // it by offset. The shard is 11 KB and revisions.json is 342 KB, so the
  // shard now routinely wins the race that used to be impossible — versions
  // arrived behind revisions when both came out of one sequential chain.
  if (!revisions.length)
    return html`<div id="status" class="muted">Loading revisions…</div>`;

  const vers = Object.entries(versions).sort((a, b) =>
    compareVersions(b[0], a[0]),
  ); // newest first

  // Store metadata, when the shard has landed: per-version meta entries, the
  // shard's intern table for references, and this attr's reverse deps.
  const meta =
    metaFile && metaFile !== SHARD_ERROR ? metaFile.attrs?.[attr] : null;
  const metaPaths = metaFile && metaFile !== SHARD_ERROR ? metaFile.paths : null;
  const rds = revdeps && revdeps !== SHARD_ERROR ? revdeps : null;

  // Something the table does not already say: when this package entered
  // nixpkgs, and whether it is still there. "newest first, click to expand"
  // described the widget; this describes the package.
  // `hist` is the sentinel string "error" when the shard failed to load.
  // Treating that as data walks its characters and ends at revisions[NaN].date,
  // which throws — so everything below reads `history`, which is null instead.
  const history = hist && hist !== "error" ? hist : null;
  const offs = history
    ? Object.values(history).flatMap((v) => runsOf(v).flat())
    : [];
  const gone = offs.length && Math.max(...offs) < revisions.length - 1;
  // How much of this package the cache could measure, so a row without a
  // badge reads as a stated limit rather than a silent absence.
  const covered = meta ? vers.filter(([v]) => meta[v]).length : null;
  const coverage =
    covered != null && covered < vers.length
      ? ` · cache data for ${covered} of ${vers.length} versions`
      : "";
  const lifetime =
    (!offs.length
      ? `${vers.length} versions`
      : `${vers.length} versions · first packaged ${revisions[Math.min(...offs)].date}` +
        (gone ? ` · gone since ${revisions[Math.max(...offs)].date}` : "")) +
    coverage;

  return html`
    <h2 class="bulkline">
      <span>
        <code>${attr}</code>
        <span class="muted">· ${lifetime}</span>
      </span>
      ${bulkButton}
    </h2>
    <${Timeline}
      attr=${attr}
      hist=${hist}
      revisions=${revisions}
      openVers=${openVers}
      toggleVer=${toggleVer}
      route=${route}
      navigate=${navigate}
    />
    ${meta &&
    html`<${WeightChart} attr=${attr} meta=${meta} vers=${vers} />`}
    <div class="head cols-ver">
      <span></span><span>version</span><span>newest revision shipping it</span
      ><span>size</span><span>channel build</span>
    </div>
    ${vers.map(([v, off], i) => {
      const r = revisions[off];
      if (!r) return null;
      return html`
        <${VersionRow}
          key=${`${attr}:${v}`}
          attr=${attr}
          v=${v}
          r=${r}
          runs=${history?.[v] && runsOf(history[v])}
          revisions=${revisions}
          selected=${route.ver === v}
          bulk=${force[v] ?? bulk}
          onOpenChange=${onOpenChange}
          navigate=${navigate}
          entry=${meta?.[v]}
          paths=${metaPaths}
          prevEntry=${meta?.[vers[i + 1]?.[0]]}
          rd=${rds?.[v]}
          metaReady=${!!(metaFile && metaFile !== SHARD_ERROR)}
        />
      `;
    })}
  `;
}

/* ---------- the weight of a package over time ----------
 *
 * Installed size (NarSize) and closure size per version, oldest to newest.
 * The exact numbers the cache recorded when each version was built — a
 * software-bloat curve nobody has been able to draw from changelogs.
 */
function WeightChart({ attr, meta, vers }) {
  const [ref, width] = useWidth();
  // Chronological by shipping revision, NOT by version number: release
  // trains overlap (firefox ESR ships beside current), and this chart is
  // about weight over TIME — so its x order can differ from the version
  // table's, which is version-number order.
  const rows = vers
    .slice()
    .sort((a, b) => a[1] - b[1])
    .map(([v]) => ({ v, e: meta[v] }))
    .filter((r) => r.e?.ns != null);
  if (rows.length < 3) return null;

  const hasCs = rows.some((r) => r.e.cs != null);
  const max = Math.max(...rows.map((r) => Math.max(r.e.ns, r.e.cs || 0)));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const inner = width - PLOT.left - PLOT.right;
  const X = (n) => PLOT.left + (n / Math.max(1, rows.length - 1)) * inner;
  const Y = (v) => PLOT.top + (1 - v / top) * PLOT_H;
  const { i, onMove, onLeave } = useNearest(rows.length, width);

  const line = (val) =>
    rows
      .map((r, n) => {
        const y = val(r);
        return y == null ? null : `${n ? "L" : "M"}${X(n)},${Y(y)}`;
      })
      .filter(Boolean)
      .join("");

  // Version labels on the x axis, thinned by pixel distance like yearTicks.
  const labels = [];
  let lastX = -Infinity;
  rows.forEach((r, n) => {
    const x = X(n);
    if (x - lastX < 70) return;
    labels.push({ v: r.v, x });
    lastX = x;
  });

  return html`
    <div class="chart">
      <h3>How heavy each version was</h3>
      <p class="sub">
        Installed size${hasCs ? " and full closure size" : ""} of every version
        of <code>${attr}</code>, as recorded by cache.nixos.org the day it was
        built. Versions in shipping order, oldest to newest.
      </p>
      <div class="legend">
        <span
          class="whatis"
          title="The size of this version's own store path — the uncompressed NAR archive Hydra built. Its dependencies are not included; for wrappers and multi-output packages this can be tiny while the real payload sits in the closure."
          ><i style="background:var(--chart-series)"></i>installed (NAR)</span
        >
        ${hasCs &&
        html`<span
          class="whatis"
          title="The store path plus everything it references, transitively — what a fresh machine has to download to run this version."
          ><i style="background:var(--chart-removed)"></i>closure</span
        >`}
      </div>
      <figure ref=${ref}>
        <svg
          height=${PLOT_H + PLOT.top + PLOT.bottom}
          onMouseMove=${onMove}
          onMouseLeave=${onLeave}
        >
          <g class="grid">
            ${ticks.map(
              (t) =>
                html`<line
                  x1=${PLOT.left}
                  x2=${width - PLOT.right}
                  y1=${Y(t)}
                  y2=${Y(t)}
                />`,
            )}
          </g>
          ${ticks.map(
            (t) =>
              html`<text x=${PLOT.left - 6} y=${Y(t) + 4} text-anchor="end"
                >${fmtBytes(t)}</text
              >`,
          )}
          ${labels.map(
            ({ v, x }) =>
              html`<text x=${x} y=${PLOT_H + PLOT.top + 15} text-anchor="middle"
                >${v.length > 10 ? v.slice(0, 9) + "…" : v}</text
              >`,
          )}
          ${hasCs &&
          html`<path
            class="series series-closure"
            d=${line((r) => r.e.cs)}
          />`}
          <path class="series" d=${line((r) => r.e.ns)} />
          ${i !== null &&
          html`<line
            class="crosshair"
            x1=${X(i)}
            x2=${X(i)}
            y1=${PLOT.top}
            y2=${PLOT.top + PLOT_H}
          />`}
        </svg>
        ${i !== null &&
        html`<${Tooltip} x=${X(i)} width=${width}>
          <span class="k">${rows[i].v}</span>
          <b>${fmtBytes(rows[i].e.ns)}</b> installed
          ${rows[i].e.cs != null &&
          html`<div><b>${fmtBytes(rows[i].e.cs)}</b> closure</div>`}
        <//>`}
      </figure>
    </div>
  `;
}

function Packages({ route, navigate, revisions }) {
  // Focus the search box once on a fresh packages landing, like the old
  // autofocus attribute (which does not fire on framework-inserted nodes).
  const inputRef = useRef(null);
  useEffect(() => {
    if (route.view === "packages" && !route.pkg)
      inputRef.current?.focus({ preventScroll: true });
  }, []);

  return html`
    <input
      ref=${inputRef}
      type="search"
      placeholder="Search 30,000+ packages — or paste a /nix/store path, or try depends:openssl"
      value=${route.pkg || route.q}
      onInput=${(e) =>
        navigate({ q: e.currentTarget.value, pkg: "", ver: "" }, Nav.REPLACE)}
    />
    ${route.pkg
      ? html`<${PackageDetail}
          attr=${route.pkg}
          route=${route}
          revisions=${revisions}
          navigate=${navigate}
        />`
      : html`<${SearchResults} q=${route.q} navigate=${navigate} />`}
  `;
}

/* ---------- revisions ---------- */

function RevPins({ off, navigate }) {
  const [showAll, setShowAll] = useState(false);
  const index = useFullIndex();
  if (index === SHARD_ERROR)
    return html`<div class="muted">could not load the index</div>`;
  if (!index) return html`<div class="muted">index still loading…</div>`;

  const pins = pinsFor(index, off);
  const shown = showAll ? pins : pins.slice(0, MAX_PINS);
  return html`
    <div class="capt">
      ${pins.length.toLocaleString()} package versions pinned at this revision
      (their newest shipping revision is this one)
    </div>
    <div class="pins">
      ${shown.map(
        ([a, v]) => html`
          <div>
            <${Link} class="attr" to=${{ pkg: a, ver: "" }} navigate=${navigate}
              >${a}<//
            >${" "}
            <span class="muted">${v}</span>
          </div>
        `,
      )}
    </div>
    ${pins.length > shown.length &&
    html`<button class="more" onClick=${() => setShowAll(true)}>
      show all ${pins.length.toLocaleString()}
    </button>`}
  `;
}

// `churn` is [added, removed] for this revision against the one before it,
// read straight off stats.json by offset — the revisions table would otherwise
// have to load the 8 MB history to know it.
function RevRow({ r, off, selected, churn, bulk, navigate }) {
  // A revision pins up to MAX_PINS package versions, each one a link. That is
  // fine for a row opened on its own and ruinous for 150 at once, so a mass
  // expand shows the command and puts the pins one click away.
  //
  // Decided when the row opens, NOT read live from `bulk`: collapsing flips
  // bulk.open to false while every row is still open, so a live read renders
  // all 150 pin lists for one frame before the rows close — ~120k nodes built
  // and thrown away, measured at 2.8s against 60ms to expand.
  const [pins, setPins] = useState(false);
  const { open, ref, toggle } = useLinkableRow(
    selected,
    (isOpen) =>
      navigate({ rev: isOpen ? r.rev.slice(0, REV_ABBREV) : "" }, Nav.REPLACE),
    bulk,
  );
  // Must sit below `open` — naming it in the dependency array above the
  // declaration is a temporal-dead-zone throw at render time, not a warning.
  useEffect(() => setPins(open && !bulk?.open), [open]);

  const archive = archiveFor("unstable", r.name);
  return html`
    <${Row}
      cols="cols-rev"
      id=${domId(r.rev)}
      label=${`revision ${r.date}`}
      open=${open}
      toggle=${toggle}
      rowRef=${ref}
      body=${html`
        <${Cmd}
          text=${`nix run ${FLAKE}#${label(r)}.hello`}
          caption="run anything out of this revision"
        />
        ${pins
          ? html`<${RevPins} off=${off} navigate=${navigate} />`
          : html`<button class="more" onClick=${() => setPins(true)}>
              show the package versions pinned here
            </button>`}
      `}
    >
      <span>${r.date}</span>
      <code
        ><a href=${COMMIT_URL + r.rev}>${r.rev.slice(0, REV_ABBREV)}</a></code
      >
      <span class="delta">
        ${churn &&
        html`${churn[0]
          ? html`<span class="a">+${churn[0]}</span>`
          : null}${churn[0] && churn[1] ? " " : ""}${churn[1]
          ? html`<span class="d">−${churn[1]}</span>`
          : null}`}
      </span>
      <span class="muted">
        ${archive
          ? html`<a href=${archive}>${r.name}</a>`
          : r.name || r.channel || ""}
      </span>
    <//>
  `;
}

function Revisions({ route, revisions, stats, navigate }) {
  const all = revisions.map((r, off) => ({ r, off })).reverse();
  const [shown, setShown] = useState(REV_PAGE);
  const [bulk, bulkButton] = useBulk();
  // A linked-to revision has to be rendered for its row to open itself, so
  // widen the window far enough to include it.
  const linked = route.rev
    ? all.findIndex(({ r }) => r.rev.startsWith(route.rev))
    : -1;
  const limit = Math.max(shown, linked + 1);
  const rows = all.slice(0, limit);
  return html`
    <h2 class="bulkline">
      <span class="muted"
        >${revisions.length.toLocaleString()} channel bumps ·
        ${revisions[0].date} → ${revisions[revisions.length - 1].date}</span
      >
      ${bulkButton}
    </h2>
    <div class="head cols-rev">
      <span></span><span>date</span><span>commit</span><span>packages</span
      ><span>channel build</span>
    </div>
    ${rows.map(
      ({ r, off }) => html`
        <${RevRow}
          key=${r.rev}
          r=${r}
          off=${off}
          selected=${!!route.rev && r.rev.startsWith(route.rev)}
          churn=${stats?.churn?.[off]}
          bulk=${bulk}
          navigate=${navigate}
        />
      `,
    )}
    ${limit < all.length &&
    html`<button class="more" onClick=${() => setShown(limit + REV_PAGE)}>
      ${`show ${Math.min(REV_PAGE, all.length - limit)} more · ${(
        all.length - limit
      ).toLocaleString()} older revisions remaining`}
    </button>`}
  `;
}

/* ---------- releases ---------- */

function ReleaseRow({ name, r, near, selected, bulk, navigate }) {
  const { open, ref, toggle } = useLinkableRow(
    selected,
    (isOpen) => navigate({ release: isOpen ? name : "" }, Nav.REPLACE),
    bulk,
  );

  const archive = archiveFor(name, r.name);
  return html`
    <${Row}
      cols="cols-rel"
      id=${domId(`rel-${name}`)}
      label=${`release ${name}`}
      open=${open}
      toggle=${toggle}
      rowRef=${ref}
      body=${html`
        <${Cmd}
          text=${`nix run ${FLAKE}#${name}.hello`}
          caption="run anything out of this release, backports included"
        />
        ${near &&
        html`<div class="links">
          <${Link}
            to=${{ view: "revisions", rev: near.rev.slice(0, REV_ABBREV) }}
            navigate=${navigate}
          >
            unstable as of ${r.date} →
          <//>
        </div>`}
      `}
    >
      <code>${name}</code>
      <span>${r.date}</span>
      <code
        ><a href=${COMMIT_URL + r.rev}>${r.rev.slice(0, REV_ABBREV)}</a></code
      >
      <span class="muted"
        >${archive
          ? html`<a href=${archive}>${r.name}</a>`
          : r.name || ""}</span
      >
    <//>
  `;
}

function Releases({ route, releases, revisions, navigate }) {
  const rows = Object.entries(releases).reverse();
  const [bulk, bulkButton] = useBulk();
  return html`
    <p class="muted bulkline">
      <span>
        A release moves as backports land, exactly like
        <code>github:NixOS/nixpkgs/nixos-26.05</code>.
      </span>
      ${bulkButton}
    </p>
    <div class="head cols-rel">
      <span></span><span>release</span><span>as of</span><span>tip commit</span
      ><span>channel build</span>
    </div>
    ${rows.map(([name, r]) => {
      // A release tip lives on the release branch, so it is never an indexed
      // unstable revision; the honest internal link is unstable on the same
      // date — exactly what `at "<date>"` returns.
      let near = null;
      for (let i = revisions.length - 1; i >= 0; i--)
        if (revisions[i].date <= r.date) {
          near = revisions[i];
          break;
        }
      return html`
        <${ReleaseRow}
          key=${name}
          name=${name}
          r=${r}
          near=${near}
          selected=${route.release === name}
          bulk=${bulk}
          navigate=${navigate}
        />
      `;
    })}
  `;
}

/* ---------- charts ----------
 *
 * Hand-rolled SVG rather than a charting library: the page has no build step
 * and one pinned dependency, and these are three charts with one series each.
 *
 * Every chart here carries a hover layer AND a table view. The tooltip is an
 * enhancement — no value is reachable only by hovering, which is also what
 * keeps the charts usable from a keyboard and in the CVD case.
 */

// Left needs room for y-axis labels; right matches it so the plotted area is
// centred in the card rather than hugging the right edge — which also stops
// the end-dot and its surface ring being clipped by the figure bounds.
const PLOT = { top: 16, right: 44, bottom: 22, left: 44 };
const PLOT_H = 150;
const TL_ROW_H = 15; // one version's row in the package timeline
const TL_LABEL_W = 92;

// Axis ticks on clean numbers. A tick set derived from the raw max lands on
// values like 24,855 that nobody reads; step to the next 1/2/5×10ⁿ instead.
function niceTicks(max, count = 4) {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].find((m) => m * mag >= raw) * mag;
  // The top tick has to be at or above `max`. Stopping at the last tick within
  // `max` leaves the scale topping out below the data — 24,855 attributes on a
  // 20,000 axis draws the line 26px ABOVE the plot, and since the svg has
  // overflow visible it escapes upward into the subtitle rather than clipping.
  const top = Math.ceil(max / step) * step;
  const out = [];
  for (let v = 0; v <= top; v += step) out.push(v);
  return out;
}

const compact = (n) =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;

// Year labels for a time axis, placed by pixel distance rather than by index.
//
// Counting rows (every Nth month, every Nth year) assumes the months are evenly
// spread and they are not: the index is sparse before 2016 — one revision in
// 2013, none at all in 2014 — so the first four year-starts sit within a few
// pixels of each other and their labels overlap into mush. Dropping any label
// that lands within `minPx` of the last one drawn keeps the axis readable at
// every width, and is what lets the same code serve a 380px phone.
function yearTicks(rows, X, minPx) {
  const firsts = [];
  rows.forEach((r, n) => {
    const y = r.month.slice(0, 4);
    if (!firsts.length || firsts[firsts.length - 1].y !== y)
      firsts.push({ y, n });
  });
  const out = [];
  let lastX = -Infinity;
  for (const t of firsts) {
    const x = X(t.n);
    if (x - lastX < minPx) continue;
    out.push({ ...t, x });
    lastX = x;
  }
  return out;
}
const YEAR_GAP = 46; // px a four-digit year needs before the next one

// SVG scales to its container, but text must not scale with it, so the chart
// is drawn at the measured pixel width rather than through a viewBox.
//
// A callback ref rather than useRef + useEffect([]): a chart that shows a
// loading line before its figure exists has no node to measure at mount, and a
// once-only effect never gets a second chance — the chart then draws itself at
// the fallback width forever, overflowing its container on anything narrower.
// This attaches the observer whenever the node appears and detaches when it
// goes, so remounting is handled too.
function useWidth(fallback = 640) {
  const [w, setW] = useState(fallback);
  const obs = useRef(null);
  const ref = useCallback((node) => {
    obs.current?.disconnect();
    obs.current = null;
    if (!node) return;
    // Zero means the node is not rendered yet — inside a section still marked
    // hidden, or measured before layout. Taking it would compute a negative
    // plot width and draw nothing; hold the fallback until a real width
    // arrives, which the observer below delivers.
    const w0 = node.getBoundingClientRect().width;
    if (w0 > 0) setW(w0);
    obs.current = new ResizeObserver(([e]) => {
      if (e.contentRect.width > 0) setW(e.contentRect.width);
    });
    obs.current.observe(node);
  }, []);
  return [ref, w];
}

// Shared hover plumbing: map a pointer x to the nearest data index. The hit
// area is the whole plot rather than the marks, so there is no pinpointing.
function useNearest(count, width) {
  const [i, setI] = useState(null);
  const inner = width - PLOT.left - PLOT.right;
  const onMove = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left - PLOT.left;
    setI(
      Math.max(0, Math.min(count - 1, Math.round((x / inner) * (count - 1)))),
    );
  };
  return { i, onMove, onLeave: () => setI(null) };
}

function Tooltip({ x, width, children }) {
  // Flip the tooltip to the left of the crosshair near the right edge so it
  // never overflows the figure.
  const flip = x > width - 130;
  return html`<div
    class="tip"
    style=${`left:${flip ? x - 8 : x + 8}px; top:4px; transform:translateX(${flip ? "-100%" : "0"})`}
  >
    ${children}
  </div>`;
}

// A single-series trend over time. No legend by design — one series means the
// title already names what is plotted, and a one-swatch box just restates it.
function LineChart({ title, sub, rows, value, format, unit, tickFormat }) {
  const [ref, width] = useWidth();
  const pts = rows.map(value);
  const max = Math.max(...pts);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const inner = width - PLOT.left - PLOT.right;
  const X = (n) => PLOT.left + (n / (rows.length - 1)) * inner;
  const Y = (v) => PLOT.top + (1 - v / top) * PLOT_H;
  const { i, onMove, onLeave } = useNearest(rows.length, width);

  const line = pts.map((v, n) => `${n ? "L" : "M"}${X(n)},${Y(v)}`).join("");
  const area = `${line}L${X(pts.length - 1)},${Y(0)}L${X(0)},${Y(0)}Z`;
  const last = pts.length - 1;

  const years = yearTicks(rows, X, YEAR_GAP);

  return html`
    <div class="chart">
      <h3>${title}</h3>
      <p class="sub">${sub}</p>
      <figure ref=${ref}>
        <svg
          height=${PLOT_H + PLOT.top + PLOT.bottom}
          onMouseMove=${onMove}
          onMouseLeave=${onLeave}
        >
          <g class="grid">
            ${ticks.map(
              (t) =>
                html`<line
                  x1=${PLOT.left}
                  x2=${width - PLOT.right}
                  y1=${Y(t)}
                  y2=${Y(t)}
                />`,
            )}
          </g>
          ${ticks.map(
            (t) =>
              html`<text x=${PLOT.left - 6} y=${Y(t) + 4} text-anchor="end"
                >${(tickFormat ?? compact)(t)}</text
              >`,
          )}
          ${years.map(
            ({ y, x }) =>
              html`<text x=${x} y=${PLOT_H + PLOT.top + 15} text-anchor="middle"
                >${y}</text
              >`,
          )}
          <path class="area" d=${area} />
          <path class="series" d=${line} />
          ${i !== null &&
          html`<line
            class="crosshair"
            x1=${X(i)}
            x2=${X(i)}
            y1=${PLOT.top}
            y2=${PLOT.top + PLOT_H}
          />`}
          <circle
            class="enddot"
            cx=${X(i ?? last)}
            cy=${Y(pts[i ?? last])}
            r="4"
          />
        </svg>
        ${i !== null &&
        html`<${Tooltip} x=${X(i)} width=${width}>
          <span class="k">${rows[i].month}</span>
          <b>${format(pts[i])}</b> ${unit}
        <//>`}
      </figure>
      <details class="tableview">
        <summary>table view</summary>
        <table>
          <thead>
            <tr>
              <th>month</th>
              <th>${unit}</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (r, n) =>
                html`<tr>
                  <td>${r.month}</td>
                  <td>${format(pts[n])}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </details>
    </div>
  `;
}

// Added above the zero line, removed below — the polarity is the story, so
// this is a diverging pair rather than two arbitrary categorical hues.
function ChurnChart({ rows }) {
  const [ref, width] = useWidth();
  const max = Math.max(...rows.map((r) => Math.max(r.added, r.removed)));
  const ticks = niceTicks(max, 3);
  const top = ticks[ticks.length - 1];
  const half = PLOT_H / 2;
  const inner = width - PLOT.left - PLOT.right;
  const zero = PLOT.top + half;
  const Y = (v) => zero - (v / top) * half;
  // A 2px gap in the surface color separates neighbours; nothing is stroked.
  const bw = Math.max(1, inner / rows.length - 2);
  const X = (n) => PLOT.left + (n / rows.length) * inner;
  const { i, onMove, onLeave } = useNearest(rows.length, width);

  return html`
    <div class="chart">
      <h3>Packages added and removed</h3>
      <p class="sub">
        Attributes entering and leaving nixpkgs each month. Above the line is
        added, below is removed.
      </p>
      <div class="legend">
        <span><i style="background:var(--chart-added)"></i>added</span>
        <span><i style="background:var(--chart-removed)"></i>removed</span>
      </div>
      <figure ref=${ref}>
        <svg
          height=${PLOT_H + PLOT.top + PLOT.bottom}
          onMouseMove=${onMove}
          onMouseLeave=${onLeave}
        >
          ${ticks.slice(1).map(
            (t) => html`
              <g class="grid">
                <line
                  x1=${PLOT.left}
                  x2=${width - PLOT.right}
                  y1=${Y(t)}
                  y2=${Y(t)}
                />
                <line
                  x1=${PLOT.left}
                  x2=${width - PLOT.right}
                  y1=${Y(-t)}
                  y2=${Y(-t)}
                />
              </g>
              <text x=${PLOT.left - 6} y=${Y(t) + 4} text-anchor="end"
                >${compact(t)}</text
              >
              <text x=${PLOT.left - 6} y=${Y(-t) + 4} text-anchor="end"
                >${compact(t)}</text
              >
            `,
          )}
          ${rows.map(
            (r, n) => html`
              <rect
                class="bar-added"
                x=${X(n)}
                width=${bw}
                y=${Y(r.added)}
                height=${zero - Y(r.added)}
              />
              <rect
                class="bar-removed"
                x=${X(n)}
                width=${bw}
                y=${zero}
                height=${zero - Y(r.removed)}
              />
            `,
          )}
          <line
            class="zero"
            x1=${PLOT.left}
            x2=${width - PLOT.right}
            y1=${zero}
            y2=${zero}
          />
          ${yearTicks(rows, X, YEAR_GAP).map(
            ({ y, x }) =>
              html`<text x=${x} y=${PLOT_H + PLOT.top + 15} text-anchor="middle"
                >${y}</text
              >`,
          )}
        </svg>
        ${i !== null &&
        html`<${Tooltip} x=${X(i)} width=${width}>
          <span class="k">${rows[i].month}</span> <b>+${rows[i].added}</b> /
          <b>−${rows[i].removed}</b>
        <//>`}
      </figure>
      <details class="tableview">
        <summary>table view</summary>
        <table>
          <thead>
            <tr>
              <th>month</th>
              <th>added</th>
              <th>removed</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (r) =>
                html`<tr>
                  <td>${r.month}</td>
                  <td>${r.added}</td>
                  <td>${r.removed}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </details>
    </div>
  `;
}

// A plain top-N table in the charts' visual register.
function Leaderboard({ title, sub, cols, rows, navigate }) {
  if (!rows?.length) return null;
  return html`
    <div class="chart">
      <h3>${title}</h3>
      <p class="sub">${sub}</p>
      <div class="tableview" style="margin-top:0">
        <table>
          <thead>
            <tr>
              ${cols.map((c) => html`<th key=${c}>${c}</th>`)}
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (r, i) => html`
                <tr key=${i}>
                  <td>
                    <${Link}
                      to=${{ pkg: r[0], ver: r.ver || "" }}
                      navigate=${navigate}
                      >${r[0]}<//
                    >
                    ${r[1] ? html` <span class="muted">${r[1]}</span>` : ""}
                  </td>
                  <td>${r[2]}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/* ---------- the universe: every measured version, one dot each ----------
 *
 * A canvas scatter of all ~240k versions: x is the revision that first
 * shipped it, y is installed size on a log scale. The slider picks a moment
 * in the 13 years; versions alive at that revision light up, everything else
 * stays as dim background. Canvas, not SVG — a quarter-million dots redraw
 * in a few milliseconds, which is what makes scrubbing feel like time travel.
 */
const UNI_H = 430;
const UNI_PAD = { left: 54, right: 12, top: 12, bottom: 26 };
const UNI_LOG_LO = 3; // 1 KB
const UNI_LOG_HI = 10.3; // ~20 GB
const UNI_GRID = 10; // px per hover-lookup cell

function Universe({ revisions, navigate }) {
  const [data, setData] = useState(null);
  const [t, setT] = useState(null);
  const [hover, setHover] = useState(null);
  const canvasRef = useRef(null);
  const gridRef = useRef(null);
  const [wrapRef, width] = useWidth();

  const load = async () => {
    setData("loading");
    try {
      const [bin, meta] = await Promise.all([
        fetch("universe.bin").then((r) => {
          if (!r.ok) throw new Error(`universe.bin: HTTP ${r.status}`);
          return r.arrayBuffer();
        }),
        fetchJson("universe-meta.json"),
      ]);
      const n = new DataView(bin).getUint32(0, true);
      let o = 4;
      const firsts = new Uint16Array(bin, o, n);
      o += 2 * n;
      const lasts = new Uint16Array(bin, o, n);
      o += 2 * n;
      const sizes = new Uint32Array(bin, o, n);
      o += 4 * n;
      const attrs = new Uint16Array(bin, o, n);
      setData({ n, firsts, lasts, sizes, attrs, meta });
      setT(revisions.length - 1);
    } catch {
      setData("error");
    }
  };

  const alive = useMemo(() => {
    if (!data || typeof data === "string" || t == null) return 0;
    let a = 0;
    for (let i = 0; i < data.n; i++)
      if (data.firsts[i] <= t && t <= data.lasts[i]) a++;
    return a;
  }, [data, t]);

  useEffect(() => {
    if (!data || typeof data === "string" || t == null) return;
    const c = canvasRef.current;
    if (!c) return;
    const w = Math.max(320, Math.floor(width));
    const dpr = devicePixelRatio || 1;
    c.width = w * dpr;
    c.height = UNI_H * dpr;
    c.style.height = `${UNI_H}px`;
    const ctx = c.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, UNI_H);

    const css = getComputedStyle(document.documentElement);
    const cAlive = css.getPropertyValue("--chart-series").trim();
    const cDead = css.getPropertyValue("--muted").trim();
    const cText = css.getPropertyValue("--muted").trim();
    const cGrid = css.getPropertyValue("--line").trim();

    const plotW = w - UNI_PAD.left - UNI_PAD.right;
    const plotH = UNI_H - UNI_PAD.top - UNI_PAD.bottom;
    const nRev = revisions.length;
    const X = (off) => UNI_PAD.left + (off / (nRev - 1)) * plotW;
    const Y = (ns) =>
      UNI_PAD.top +
      (1 -
        (Math.min(UNI_LOG_HI, Math.max(UNI_LOG_LO, Math.log10(ns))) -
          UNI_LOG_LO) /
          (UNI_LOG_HI - UNI_LOG_LO)) *
        plotH;

    // Axes first, under the dots.
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = cText;
    ctx.strokeStyle = cGrid;
    ctx.lineWidth = 1;
    for (const [exp, label] of [
      [3, "1 KB"],
      [6, "1 MB"],
      [9, "1 GB"],
    ]) {
      const y = Y(10 ** exp);
      ctx.beginPath();
      ctx.moveTo(UNI_PAD.left, y);
      ctx.lineTo(w - UNI_PAD.right, y);
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(label, UNI_PAD.left - 6, y + 4);
    }
    ctx.textAlign = "center";
    let lastX = -Infinity;
    let lastYear = "";
    revisions.forEach((r, off) => {
      const year = r.date.slice(0, 4);
      if (year === lastYear) return;
      lastYear = year;
      const x = X(off);
      if (x - lastX < YEAR_GAP) return;
      lastX = x;
      ctx.fillText(year, x, UNI_H - 8);
    });

    // Dots in three states: alive at t (bright), superseded (its package
    // still ships a lit version — the ordinary march of upgrades, dim gray),
    // and extinct (no version of its package is alive at t — the lineage
    // itself is gone, dim red). Also rebuild the hover grid — cheap, and it
    // must match this exact layout.
    const cGone = css.getPropertyValue("--chart-removed").trim();
    const grid = new Map();
    const cell = (x, y) =>
      `${Math.floor(x / UNI_GRID)}:${Math.floor(y / UNI_GRID)}`;
    const { n, firsts, lasts, sizes, attrs } = data;
    const attrAlive = new Uint8Array(65536);
    for (let i = 0; i < n; i++)
      if (firsts[i] <= t && t <= lasts[i]) attrAlive[attrs[i]] = 1;
    // The future is not drawn: a version first shipped after `t` is unborn,
    // not dead, and painting it "extinct" red was a lie. Scrubbing forward
    // therefore grows the universe left to right.
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = cDead;
    for (let i = 0; i < n; i++) {
      if (firsts[i] > t) continue;
      const liveNow = t <= lasts[i];
      const x = X(firsts[i]);
      const y = Y(sizes[i]);
      if (!liveNow && attrAlive[attrs[i]]) ctx.fillRect(x, y, 1.5, 1.5);
      const k = cell(x, y);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = cGone;
    for (let i = 0; i < n; i++) {
      if (firsts[i] > t || t <= lasts[i]) continue;
      if (attrAlive[attrs[i]]) continue;
      ctx.fillRect(X(firsts[i]), Y(sizes[i]), 1.5, 1.5);
    }
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = cAlive;
    for (let i = 0; i < n; i++) {
      if (!(firsts[i] <= t && t <= lasts[i])) continue;
      ctx.fillRect(X(firsts[i]) - 1, Y(sizes[i]) - 1, 2.5, 2.5);
    }
    ctx.globalAlpha = 1;
    gridRef.current = { grid, X, Y };
  }, [data, t, width]);

  const findNearest = (e) => {
    const g = gridRef.current;
    if (!g || !data || typeof data === "string") return null;
    const box = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - box.left;
    const my = e.clientY - box.top;
    let best = null;
    let bestD = UNI_GRID * UNI_GRID;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const k = `${Math.floor(mx / UNI_GRID) + dx}:${Math.floor(my / UNI_GRID) + dy}`;
        for (const i of g.grid.get(k) || []) {
          const x = g.X(data.firsts[i]);
          const y = g.Y(data.sizes[i]);
          const d = (x - mx) ** 2 + (y - my) ** 2;
          if (d < bestD) {
            bestD = d;
            best = { i, x, y };
          }
        }
      }
    return best;
  };

  if (!data)
    return html`<button class="more" onClick=${load}>
      draw the universe — all measured versions on one canvas →
    </button>`;
  if (data === "loading")
    return html`<div class="capt">loading the universe…</div>`;
  if (data === "error")
    return html`<div class="capt">could not load universe.bin</div>`;

  const onMove = (e) => {
    const hit = findNearest(e);
    if (!hit) return setHover(null);
    const { i, x, y } = hit;
    setHover({
      x,
      y,
      attr: data.meta.attrs[data.attrs[i]],
      ver: data.meta.versions[i],
      ns: data.sizes[i],
      from: revisions[data.firsts[i]].date,
      to: revisions[data.lasts[i]].date,
    });
  };
  // The full target, not a patch: a patch merges onto the CURRENT route,
  // which here is view=stats — and the stats view drops `pkg` from the URL,
  // so the click silently did nothing. Same trap the Link component
  // documents.
  const onClick = () => {
    if (hover)
      navigate({
        view: "packages",
        pkg: hover.attr,
        ver: hover.ver,
        q: "",
        rev: "",
        release: "",
      });
  };

  return html`
    <figure class="universe" ref=${wrapRef}>
      <canvas
        ref=${canvasRef}
        onMouseMove=${onMove}
        onMouseLeave=${() => setHover(null)}
        onClick=${onClick}
        style=${hover ? "cursor:pointer" : ""}
      ></canvas>
      ${hover &&
      html`<${Tooltip} x=${hover.x} width=${width}>
        <b>${hover.attr}</b> ${hover.ver}
        <div class="k">${fmtBytes(hover.ns)} · ${hover.from} → ${hover.to}</div>
      <//>`}
      <div class="unislider">
        <input
          type="range"
          min="0"
          max=${revisions.length - 1}
          value=${t}
          onInput=${(e) => setT(+e.currentTarget.value)}
        />
        <span class="muted">
          ${revisions[t].date} — <b>${alive.toLocaleString()}</b> versions
          current, ${(data.n - alive).toLocaleString()} elsewhere in time
        </span>
      </div>
      <div class="capt">
        one dot per measured version (${data.n.toLocaleString()}): x is the
        revision that first shipped it, y its installed size (log scale).
        Drag the slider to move through thirteen years. Blue dots are what
        nixpkgs shipped at that moment; gray dots were superseded by a newer
        version of the same package; red dots belong to packages with no
        living version at that moment — extinct lineages. A version that left
        and returned stays lit across its gap. Hover to identify, click to
        open.
      </div>
    </figure>
  `;
}

/* ---------- the census: is thirteen years of software still alive ---------- */
function CacheHealth({ navigate }) {
  const census = useFile("census.json");
  if (!census || census === SHARD_ERROR) return null;
  const t = census.totals;
  const years = census.byYear.map((y) => ({ ...y, month: String(y.y) }));
  const bloat = census.bloat.filter((b) => b.medianNs != null);

  return html`
    <h2>The cache census</h2>
    <p class="muted">
      Every matched store path was asked for, by name, at cache.nixos.org
      ${" on "}${census.at}. This is not an estimate — it is a roll call.
    </p>
    <div class="kpis">
      <div class="kpi">
        <div class="v">${t.matched.toLocaleString()}</div>
        <div class="l">
          versions with a known store path${t.universe
            ? ` — ${Math.round((100 * t.matched) / t.universe)}% of
               ${t.universe.toLocaleString()}`
            : ""}
        </div>
      </div>
      <div class="kpi">
        <div class="v">${((t.alive / t.matched) * 100).toFixed(1)}%</div>
        <div class="l">of those still substitutable today</div>
      </div>
      <div class="kpi">
        <div class="v">${fmtBytes(t.aliveBytes)}</div>
        <div class="l">of history still downloadable</div>
      </div>
      <div class="kpi">
        <div class="v">${(t.matched - t.alive).toLocaleString()}</div>
        <div class="l">matched versions gone from the cache</div>
      </div>
    </div>
    <p class="muted">
      The unmatched remainder is a limit of the prototype's name matching, not
      evidence of deletion: unfree and broken packages were never built by
      Hydra at all, and some derivation names drifted from their attribute.
      Verified twice over: every narinfo answered, and a follow-up sweep
      HEAD-checked all 227,146 NAR payload files themselves — zero missing.
      Thirteen years, nothing lost.
    </p>

    <${LineChart}
      title="Survival by vintage"
      sub="Of the package versions whose newest build landed in each year, the share cache.nixos.org still serves."
      rows=${years}
      value=${(r) => (r.pairs ? (100 * r.alive) / r.pairs : 0)}
      format=${(v) => `${v.toFixed(1)}%`}
      unit="% alive"
    />

    ${bloat.length > 2 &&
    html`
      <${LineChart}
        title="The bloat curve"
        sub="Median installed (NAR) size of the package versions closing in each year. Measured from the cache's own records, not from changelogs."
        rows=${bloat.map((b) => ({ ...b, month: String(b.y) }))}
        value=${(r) => r.medianNs}
        format=${fmtBytes}
        tickFormat=${fmtBytes}
        unit="median installed size"
      />
    `}
    ${census.bloat.filter((b) => b.medianNd != null).length > 2 &&
    html`
      <${LineChart}
        title="Dependencies per package"
        sub="Median count of direct runtime references, by the year a version last shipped."
        rows=${census.bloat
          .filter((b) => b.medianNd != null)
          .map((b) => ({ ...b, month: String(b.y) }))}
        value=${(r) => r.medianNd}
        format=${(v) => v.toFixed(1)}
        unit="median direct deps"
      />
    `}

    <${Leaderboard}
      title="The immortals"
      sub="Versions still shipping today whose current unbroken run started longest ago."
      cols=${["package", "shipping since"]}
      rows=${(census.immortals || []).map(([a, v, d]) =>
        Object.assign([a, v, d], { ver: v }),
      )}
      navigate=${navigate}
    />
    <${Leaderboard}
      title="Biggest single-bump weight gains"
      sub="Consecutive versions of one package, ranked by how much installed size the bump added."
      cols=${["package", "gained"]}
      rows=${(census.jumps || []).map(([a, v1, v2, d]) =>
        Object.assign([a, `${v1} → ${v2}`, `+${fmtBytes(d)}`], { ver: v2 }),
      )}
      navigate=${navigate}
    />

    <${Leaderboard}
      title="Heaviest closures shipping today"
      sub="Current versions, ranked by full runtime closure."
      cols=${["package", "closure"]}
      rows=${(census.topClosures || []).map(([a, v, cs]) =>
        Object.assign([a, v, fmtBytes(cs)], { ver: v }),
      )}
      navigate=${navigate}
    />
    <${Leaderboard}
      title="Most depended-upon today"
      sub="Current versions, ranked by how many packages link against them at runtime."
      cols=${["package", "dependents"]}
      rows=${(census.topDeps || []).map(([a, n]) => [a, "", n.toLocaleString()])}
      navigate=${navigate}
    />
    <${Leaderboard}
      title="Largest losses"
      sub="The biggest builds the cache no longer serves."
      cols=${["package", "installed size"]}
      rows=${(census.biggestDead || []).map(([a, v, ns]) =>
        Object.assign([a, v, fmtBytes(ns)], { ver: v }),
      )}
      navigate=${navigate}
    />
  `;
}

function Stats({ stats, revisions, navigate }) {
  if (!stats)
    return html`<div id="status" class="muted">Loading stats.json…</div>`;
  const t = stats.totals;
  const velocity = stats.monthly.filter((m) => m.commitsPerDay != null);

  return html`
    <p class="muted">
      What the index says about nixpkgs itself, ${t.firstDate} → ${t.lastDate}.
    </p>
    <div class="kpis">
      <div class="kpi">
        <div class="v">${t.attrs.toLocaleString()}</div>
        <div class="l">versioned attributes today</div>
      </div>
      <div class="kpi">
        <div class="v">${t.versions.toLocaleString()}</div>
        <div class="l">package versions ever</div>
      </div>
      <div class="kpi">
        <div class="v">${t.additions.toLocaleString()}</div>
        <div class="l">attributes added all time</div>
      </div>
      <div class="kpi">
        <div class="v">${t.removals.toLocaleString()}</div>
        <div class="l">attributes removed all time</div>
      </div>
    </div>

    <${LineChart}
      title="Commits per day"
      sub=${"nixpkgs' own commit counter, read out of each channel bump's name and divided by the days since the previous one."}
      rows=${velocity}
      value=${(r) => r.commitsPerDay}
      format=${(v) => v.toFixed(0)}
      unit="commits/day"
    />

    <${LineChart}
      title="Versioned attributes in nixpkgs"
      sub="Top-level attributes carrying a version at each month's last channel bump. Package sets and anything without a .version are not counted."
      rows=${stats.monthly}
      value=${(r) => r.attrs}
      format=${(v) => v.toLocaleString()}
      unit="attributes"
    />

    <${ChurnChart} rows=${stats.monthly} />

    ${revisions.length > 1 &&
    html`
      <h2>The universe</h2>
      <p class="muted">
        Every package version the cache could measure, drawn at once.
      </p>
      <${Universe} revisions=${revisions} navigate=${navigate} />
    `}

    <${CacheHealth} navigate=${navigate} />
  `;
}

/* ---------- per-attribute shards ----------
 *
 * versions.json is 5.3 MB and history.json is 8 MB, and a package page is
 * about one attribute out of each, so the site build splits both by the first
 * two characters of the attribute name and this fetches the one shard of
 * each. Median shard is 1.4 KB of versions and 2 KB of history.
 *
 * That is what makes a package URL cheap enough to be worth indexing: the
 * whole page used to wait on the 5.3 MB index before it could draw a row.
 *
 * Cached per shard at module scope: opening five packages beginning "py"
 * fetches once.
 */
const Shard = {
  VERSIONS: "versions",
  HISTORY: "history",
  // Per-version store metadata: digest, sizes, closure, liveness, direct
  // references (interned in the shard's own "paths" table).
  META: "meta",
  // Inverted references: who depended on each version of this attribute.
  REVDEPS: "revdeps",
};

const shardOf = (attr) =>
  [...attr.slice(0, 2).toLowerCase()]
    .map((c) => (/[a-z0-9]/.test(c) ? c : "_"))
    .join("") || "_";

const shardCache = new Map();
function loadShard(dir, attr) {
  const path = `${dir}/${shardOf(attr)}.json`;
  if (!shardCache.has(path)) {
    shardCache.set(
      path,
      fetch(path).then((r) => {
        // A missing shard is not a failure: no file for "zz" means no
        // attribute starts with those two characters, which is the same
        // answer as a shard that loads and does not hold the attribute.
        if (r.status === HTTP_NOT_FOUND) return { attrs: {} };
        if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
        return r.json();
      }),
    );
  }
  return shardCache.get(path);
}

// One attribute's slice of a sharded file, refetched when the attribute
// changes.
//
// A failed fetch lands as the SHARD_ERROR sentinel rather than as {}. It used
// to be {}, which the timeline renders as nothing at all — indistinguishable
// from a package with no history, and the reason the graph looked like it
// "sometimes" did not appear.
function useShard(dir, attr) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    setData(null);
    loadShard(dir, attr)
      .then((d) => live && setData(d.attrs[attr] ?? {}))
      .catch(() => live && setData(SHARD_ERROR));
    return () => {
      live = false;
    };
  }, [dir, attr]);
  return data;
}

// One fetch per package page each. The timeline and every version row read
// the same two objects, so opening a row costs nothing extra.
const useHistory = (attr) => useShard(Shard.HISTORY, attr);
const useVersions = (attr) => useShard(Shard.VERSIONS, attr);

// The whole shard file rather than one attribute's slice: the meta shard
// carries a "paths" intern table beside "attrs" and every reference is an
// index into it, so a consumer needs both halves.
function useWholeShard(dir, attr) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    setData(null);
    loadShard(dir, attr)
      .then((d) => live && setData(d))
      .catch(() => live && setData(SHARD_ERROR));
    return () => {
      live = false;
    };
  }, [dir, attr]);
  return data;
}

const useMeta = (attr) => useWholeShard(Shard.META, attr);
const useRevdeps = (attr) => useShard(Shard.REVDEPS, attr);

// A reference entry out of the meta shard's intern table: [name] for a path
// that is not an indexed package, [name, attr, version] for one that is.
const refName = (p) => p[0];
const refAttr = (p) => p[1];
const refVer = (p) => p[2];

/* ---------- whole files, fetched only by what needs them ----------
 *
 * Neither of these belongs in the boot chain. A package page is the URL worth
 * indexing and the one a search engine renders 30,000 times, so it loads its
 * two shards and nothing else; the two files below are fetched by the
 * components that actually read them, the first time one is mounted.
 */

// Every attribute name and its version count: what the search box matches
// against, and all it needs.
const NAMES_FILE = "names.json";

// The whole index. Only the revisions tab reads it, because "what is pinned
// at this revision" is a question about every attribute at once and no shard
// can answer it.
const INDEX_FILE = "versions.json";

const fileCache = new Map();
function useFile(file) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    if (!fileCache.has(file)) fileCache.set(file, fetchJson(file));
    fileCache
      .get(file)
      .then((d) => live && setData(d))
      .catch(() => live && setData(SHARD_ERROR));
    return () => {
      live = false;
    };
  }, [file]);
  return data;
}

// The attribute-name map itself, unwrapped, with the error sentinel passed
// through so a caller can tell "failed" from "still loading".
function useNames() {
  const file = useFile(NAMES_FILE);
  return file && file !== SHARD_ERROR ? file.attrs : file;
}

const useFullIndex = () => useFile(INDEX_FILE);

// On disk a version with one unbroken run is [first, last]; one with gaps is a
// list of those pairs. Same collapse multiverse.nix expands in runsOf.
const runsOf = (v) => (v && !Array.isArray(v[0]) ? [v] : v);

function Timeline({
  attr,
  hist,
  revisions,
  openVers,
  toggleVer,
  route,
  navigate,
}) {
  const [hover, setHover] = useState(null);
  const [ref, width] = useWidth();

  if (hist === SHARD_ERROR)
    return html`<p class="muted">
      Could not load the version history for <code>${attr}</code>.
    </p>`;
  if (!hist) return html`<p class="muted">Loading timeline…</p>`;

  const vers = Object.keys(hist).sort((a, b) => compareVersions(b, a));
  if (!vers.length) return null;

  // The axis spans this package's own lifetime, not the whole index. A package
  // first packaged in 2022 would otherwise spend three quarters of its chart on
  // empty years, squeezing every bar it does have into the right-hand corner.
  const bounds = vers.flatMap((v) => runsOf(hist[v]).flat());
  const span = Math.max(1, Math.max(...bounds) - Math.min(...bounds));
  const pad = Math.max(1, Math.round(span * 0.02));
  const lo = Math.max(0, Math.min(...bounds) - pad);
  const hi = Math.min(revisions.length - 1, Math.max(...bounds) + pad);

  // Adaptive density: firefox has 300+ versions, and 15px rows would make
  // the chart taller than the rest of the page combined. Rows shrink to as
  // little as 2px — the bars stay hoverable strips — and the per-row labels
  // go once rows are too thin to label; the tooltip still names them.
  const rowH = Math.max(2, Math.min(TL_ROW_H, Math.floor(560 / vers.length)));
  const showLabels = rowH >= 10;
  const gutter = showLabels ? Math.min(TL_LABEL_W, width * 0.28) : 8;
  const inner = width - gutter - PLOT.right;
  const X = (off) => gutter + ((off - lo) / Math.max(1, hi - lo)) * inner;
  const height = vers.length * rowH + PLOT.bottom;
  const barPad = showLabels ? 3 : Math.max(0, Math.floor((rowH - 3) / 2));

  // Same distance rule as the trend charts, over the visible window only: the
  // index has one revision in 2013 and none in 2014, so year-start offsets
  // bunch up wherever the sparse early period is on screen.
  const years = yearTicks(
    revisions.slice(lo, hi + 1).map((r) => ({ month: r.date })),
    (n) => X(lo + n),
    YEAR_GAP + 14,
  );

  return html`
    <div class="chart">
      <h3>When each version was the one nixpkgs shipped</h3>
      <p class="sub">
        One row per version. A version with a gap draws as more than one bar —
        it left nixpkgs and came back.
      </p>
      <figure ref=${ref}>
        <svg height=${height} onMouseLeave=${() => setHover(null)}>
          <g class="grid">
            ${years.map(
              ({ x }) =>
                html`<line x1=${x} x2=${x} y1="0" y2=${vers.length * rowH} />`,
            )}
          </g>
          ${years.map(
            ({ y, x }) =>
              html`<text x=${x} y=${height - 6} text-anchor="middle"
                >${y}</text
              >`,
          )}
          ${vers.map((v, n) => {
            const y = n * rowH;
            // Every open row, not just the one in the URL: `ver` holds a
            // single version, so with several rows expanded the graph would
            // highlight one of them and silently ignore the rest.
            const sel = openVers.has(v) || route.ver === v;
            return html`
              <g
                class=${`tl-row${sel ? " tl-sel" : ""}`}
                onMouseEnter=${() => setHover({ v, y })}
                onClick=${() => toggleVer(v)}
                style="cursor:pointer"
              >
                <rect
                  class="tl-bg"
                  x="0"
                  y=${y}
                  width=${Math.max(0, width)}
                  height=${rowH}
                  fill="transparent"
                />
                ${showLabels &&
                html`<text class="tl-label" x="0" y=${y + 11}>${v}</text>`}
                ${runsOf(hist[v]).map(([s, e]) => {
                  // A single-revision run would otherwise be invisible, so
                  // every bar gets a 2px floor.
                  const x = X(s);
                  const w = Math.max(2, X(e) - x);
                  return html`<rect
                    class="tl-bar"
                    x=${x}
                    y=${y + barPad}
                    width=${w}
                    height=${Math.max(2, rowH - 2 * barPad)}
                    rx="1"
                  />`;
                })}
              </g>
            `;
          })}
        </svg>
        ${hover &&
        html`<div
          class="tip"
          style=${`left:${gutter}px; top:${hover.y + rowH}px`}
        >
          <b>${hover.v}</b>
          ${runsOf(hist[hover.v]).map(
            ([s, e]) =>
              html`<div class="k">
                ${revisions[s].date}${s === e ? "" : ` → ${revisions[e].date}`}
              </div>`,
          )}
        </div>`}
      </figure>
    </div>
  `;
}

/* ---------- app ---------- */

function App() {
  const [route, setRoute] = useState(readRoute);
  const [small, setSmall] = useState(null); // { revisions, releases } — load fast
  const [stats, setStats] = useState(null); // stats.json — 27 KB, charts
  const [error, setError] = useState(null);

  // Navigation writes the URL first, then re-renders from the same route, so
  // the address bar always matches the page. Re-navigating to the current
  // URL amends instead of stacking duplicate history entries.
  const navigate = (patch, mode = Nav.PUSH) => {
    const next = { ...route, ...patch };
    const href = routeToHref(next);
    // Safari rate-limits history writes; if one is refused the URL merely
    // lags a keystroke behind while the page itself stays correct.
    try {
      if (mode === Nav.PUSH && href !== location.pathname + location.search)
        history.pushState(null, "", href);
      else history.replaceState(null, "", href);
    } catch {
      /* throttled — ignore */
    }
    // A push is a move to a different page, so it starts at the top. Without
    // this the browser keeps the old offset: clicking a package from a
    // scrolled revisions list lands you part-way down its version table.
    // Replaces (opening a row, clicking a bar) deliberately keep their place,
    // and a row that scrolls itself into view does so in a later effect.
    if (mode === Nav.PUSH) scrollTo(0, 0);
    setRoute(next);
  };

  // Back/forward restore whatever route the URL then holds.
  useEffect(() => {
    const onPop = () => setRoute(readRoute());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  // Everything the first paint needs, and nothing else. stats.json rides with
  // the two small files: it is 27 KB, it is all the charts need, and it also
  // carries the totals the summary line used to count out of the whole index.
  useEffect(() => {
    Promise.all([
      fetchJson("revisions.json"),
      fetchJson("releases.json"),
      fetchJson("stats.json"),
    ])
      .then(([revisions, releases, s]) => {
        setSmall({ revisions, releases });
        setStats(s);
      })
      .catch((err) => setError(err.message));
  }, []);

  // Counting these by walking every attribute meant the line could not appear
  // until the whole 5.3 MB index had. stats.json states them outright.
  const summary = useMemo(() => {
    const t = stats?.totals;
    if (!t) return null;
    return (
      `${t.versions.toLocaleString()} package versions across ` +
      `${t.attrsEverSeen.toLocaleString()} attributes, from ` +
      `${t.revisions.toLocaleString()} revisions · ` +
      `${t.firstDate} → ${t.lastDate}`
    );
  }, [stats]);

  // Name the shared thing in the tab title, so pasted links read as what they
  // are — and tell a crawler the same thing, since the query string is the
  // only difference between this page and every other one served out of the
  // same index.html.
  useEffect(() => {
    const { subject, description, robots } = describeRoute(route);

    document.title = subject ? `${subject} — ${SITE_NAME}` : homeHead.title;
    headMeta(MetaAttr.NAME, "description").content = description;

    // The canonical URL is the whole point of the rewrite: index.html's is
    // hardcoded to the homepage, so without this every route consolidates
    // into "/" and only the homepage is ever indexed.
    const canonical = SITE_ORIGIN + routeToHref(route);
    headCanonical().href = canonical;

    // The share card follows the same route, so a pasted package link
    // previews as that package rather than as the front page. The bare page
    // restores index.html's wording, which is written for a share and says
    // more than the tab title does.
    const share = subject
      ? { title: document.title, description }
      : { title: homeHead.ogTitle, description: homeHead.ogDescription };
    headMeta(MetaAttr.PROPERTY, "og:url").content = canonical;
    headMeta(MetaAttr.PROPERTY, "og:title").content = share.title;
    headMeta(MetaAttr.PROPERTY, "og:description").content = share.description;

    // No robots tag at all is the same as index,follow, and the absent tag is
    // the cleaner statement of it.
    if (robots === Robots.NOINDEX) {
      headMeta(MetaAttr.NAME, "robots").content = robots;
      return;
    }
    document.head.querySelector('meta[name="robots"]')?.remove();
  }, [route]);

  return html`
    <p class="muted" id="stats">
      ${error
        ? `Failed to load index data: ${error}`
        : (summary ?? "Loading index…")}
    </p>

    <nav>
      ${VIEWS.map(
        (v) => html`
          <${Link}
            class=${route.view === v ? "active" : ""}
            to=${{ ...route, view: v }}
            navigate=${navigate}
            key=${v}
          >
            ${v[0].toUpperCase() + v.slice(1)}
          <//>
        `,
      )}
    </nav>

    <section hidden=${route.view !== "packages"}>
      <${Packages}
        route=${route}
        navigate=${navigate}
        revisions=${small?.revisions ?? []}
      />
    </section>

    <section hidden=${route.view !== "revisions"}>
      ${small &&
      html`<${Revisions}
        route=${route}
        revisions=${small.revisions}
        stats=${stats}
        navigate=${navigate}
      />`}
    </section>

    <section hidden=${route.view !== "stats"}>
      ${route.view === "stats" &&
      html`<${Stats}
        stats=${stats}
        revisions=${small?.revisions ?? []}
        navigate=${navigate}
      />`}
    </section>

    <section hidden=${route.view !== "releases"}>
      ${small &&
      html`<${Releases}
        route=${route}
        releases=${small.releases}
        revisions=${small.revisions}
        navigate=${navigate}
      />`}
    </section>
  `;
}

// The container ships a static "Loading index…" placeholder for the moment
// before this module executes; Preact does not clear pre-existing children,
// so drop the placeholder before mounting.
const root = document.getElementById("app");
root.textContent = "";
render(html`<${App} />`, root);

// The site build substitutes the deploying commit into BUILT_FROM and the
// derivation's own $out into STORE_PATH, so the footer names exactly the
// tree the data files came from and the store path serving them. A local
// checkout still carries the placeholders, and both lines stay hidden.
const BUILT_FROM = "__COMMIT__";
const STORE_PATH = "__STORE_PATH__";
const $ = (id) => document.getElementById(id);
if (!BUILT_FROM.startsWith("__")) {
  $("built-sha").textContent = BUILT_FROM.slice(0, REV_ABBREV);
  $("built-link").href =
    `https://github.com/fzakaria/nixpkgs-multiverse/commit/${BUILT_FROM}`;
  $("built").hidden = false;
}
if (!STORE_PATH.startsWith("__")) {
  $("store-path").textContent = STORE_PATH;
  $("store").hidden = false;
}

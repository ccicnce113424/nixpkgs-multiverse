// The site is a Preact app written with htm tagged templates — no build
// step, no JSX. "htm/preact" resolves through the import map in index.html
// to a pinned, integrity-checked single-file CDN bundle (~13 KB).
import { html, render, useState, useEffect, useMemo, useRef } from "htm/preact";

const FLAKE = "github:fzakaria/nixpkgs-multiverse";
const COMMIT_URL = "https://github.com/NixOS/nixpkgs/commit/";
// The channel archive: releases.nixos.org fronts the nix-releases bucket and
// renders ?prefix= as a browsable listing (a bare directory URL 404s).
const ARCHIVE_URL = "https://releases.nixos.org/?prefix=nixos/";
const MAX_RESULTS = 200;
const MAX_PINS = 400;
// How much of a nixpkgs commit sha appears in labels and in the ?rev= param.
const REV_ABBREV = 12;
const COPY_FLASH_MS = 1200;

const VIEWS = ["packages", "revisions", "releases"];

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
  const onClick = (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    navigate(to);
  };
  const target = {
    view: "packages",
    q: "",
    pkg: "",
    ver: "",
    rev: "",
    release: "",
    ...to,
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
function useLinkableRow(selected, record) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!selected || open) return;
    setOpen(true);
    ref.current?.querySelector("summary").scrollIntoView({ block: "start" });
  }, [selected]);

  const onToggle = (e) => {
    const isOpen = e.currentTarget.open;
    setOpen(isOpen);
    if (isOpen) record(true);
    else if (selected) record(false);
  };

  return { open, ref, onToggle };
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

/* ---------- packages ---------- */

function SearchResults({ q, index, attrNames, navigate }) {
  if (!index)
    return html`<div id="status" class="muted">Loading versions.json…</div>`;

  const query = q.trim().toLowerCase();
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
          <div class="pkg" onClick=${() => navigate({ pkg: a, ver: "" })}>
            ${a}
            <span class="muted"
              >· ${Object.keys(index.attrs[a]).length} versions</span
            >
          </div>
        `,
      )}
    </div>
  `;
}

function VersionRow({ attr, v, r, selected, navigate }) {
  const { open, ref, onToggle } = useLinkableRow(selected, (isOpen) =>
    navigate({ ver: isOpen ? v : "" }, Nav.REPLACE),
  );

  const archive = archiveFor("unstable", r.name);
  return html`
    <details class="item" ref=${ref} open=${open} onToggle=${onToggle}>
      <summary class="row cols-ver">
        <code>${v}</code>
        <span>
          <${Link}
            to=${{ view: "revisions", rev: r.rev.slice(0, REV_ABBREV) }}
            navigate=${navigate}
          >
            ${label(r)}
          <//>
        </span>
        <span class="muted"
          >${archive && html`<a href=${archive}>${r.name}</a>`}</span
        >
      </summary>
      <div class="body">
        <${Cmd}
          text=${`nix run '${FLAKE}#versions.${attr}."${v}"'`}
          caption="run this version"
        />
        <${Cmd}
          text=${`github:NixOS/nixpkgs/${r.rev}`}
          caption="pin another flake's nixpkgs to it"
        />
      </div>
    </details>
  `;
}

function PackageDetail({ attr, route, index, revisions, navigate }) {
  if (!index)
    return html`<div id="status" class="muted">Loading versions.json…</div>`;
  if (!index.attrs[attr])
    return html`<div id="status" class="muted">
      No attribute named <code>${attr}</code> in the index.
    </div>`;

  const vers = Object.entries(index.attrs[attr]).sort((a, b) =>
    compareVersions(b[0], a[0]),
  ); // newest first
  return html`
    <h2>
      <code>${attr}</code>
      <span class="muted"
        >· ${vers.length} versions, newest first — click a row to expand</span
      >
    </h2>
    <div class="head cols-ver">
      <span>version</span><span>newest revision shipping it</span
      ><span>channel build</span>
    </div>
    ${vers.map(([v, off]) => {
      const r = revisions[off];
      if (!r) return null;
      return html`
        <${VersionRow}
          key=${`${attr}:${v}`}
          attr=${attr}
          v=${v}
          r=${r}
          selected=${route.ver === v}
          navigate=${navigate}
        />
      `;
    })}
  `;
}

function Packages({ route, navigate, index, attrNames, revisions }) {
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
      placeholder="Search 30,000+ package attributes — e.g. python3, ripgrep, nodejs"
      value=${route.pkg || route.q}
      onInput=${(e) =>
        navigate({ q: e.currentTarget.value, pkg: "", ver: "" }, Nav.REPLACE)}
    />
    ${route.pkg
      ? html`<${PackageDetail}
          attr=${route.pkg}
          route=${route}
          index=${index}
          revisions=${revisions}
          navigate=${navigate}
        />`
      : html`<${SearchResults}
          q=${route.q}
          index=${index}
          attrNames=${attrNames}
          navigate=${navigate}
        />`}
  `;
}

/* ---------- revisions ---------- */

function RevPins({ off, index, navigate }) {
  const [showAll, setShowAll] = useState(false);
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

function RevRow({ r, off, selected, index, navigate }) {
  const { open, ref, onToggle } = useLinkableRow(selected, (isOpen) =>
    navigate({ rev: isOpen ? r.rev.slice(0, REV_ABBREV) : "" }, Nav.REPLACE),
  );

  const archive = archiveFor("unstable", r.name);
  return html`
    <details class="item" ref=${ref} open=${open} onToggle=${onToggle}>
      <summary class="row cols-rev">
        <span>${r.date}</span>
        <code
          ><a href=${COMMIT_URL + r.rev}>${r.rev.slice(0, REV_ABBREV)}</a></code
        >
        <span class="muted">
          ${archive
            ? html`<a href=${archive}>${r.name}</a>`
            : r.name || r.channel || ""}
        </span>
      </summary>
      <div class="body">
        ${open &&
        html`
          <${Cmd}
            text=${`nix run ${FLAKE}#${label(r)}.hello`}
            caption="run anything out of this revision"
          />
          <${RevPins} off=${off} index=${index} navigate=${navigate} />
        `}
      </div>
    </details>
  `;
}

function Revisions({ route, revisions, index, navigate }) {
  const rows = revisions.map((r, off) => ({ r, off })).reverse();
  return html`
    <p class="muted">
      Every indexed nixos-unstable channel bump, newest first. Click a row for
      the run command and the package versions the index pins to it.
    </p>
    <div class="head cols-rev">
      <span>date</span><span>commit</span><span>channel build</span>
    </div>
    ${rows.map(
      ({ r, off }) => html`
        <${RevRow}
          key=${r.rev}
          r=${r}
          off=${off}
          selected=${!!route.rev && r.rev.startsWith(route.rev)}
          index=${index}
          navigate=${navigate}
        />
      `,
    )}
  `;
}

/* ---------- releases ---------- */

function ReleaseRow({ name, r, near, selected, navigate }) {
  const { open, ref, onToggle } = useLinkableRow(selected, (isOpen) =>
    navigate({ release: isOpen ? name : "" }, Nav.REPLACE),
  );

  const archive = archiveFor(name, r.name);
  return html`
    <details class="item" ref=${ref} open=${open} onToggle=${onToggle}>
      <summary class="row cols-rel">
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
      </summary>
      <div class="body">
        <${Cmd}
          text=${`nix run ${FLAKE}#${name}.hello`}
          caption="run anything out of this release, backports included"
        />
        ${near &&
        html`<div class="links">
          <${Link}
            to=${{
              view: "revisions",
              rev: near.rev.slice(0, REV_ABBREV),
            }}
            navigate=${navigate}
          >
            unstable as of ${r.date} →
          <//>
        </div>`}
      </div>
    </details>
  `;
}

function Releases({ route, releases, revisions, navigate }) {
  const rows = Object.entries(releases).reverse();
  return html`
    <p class="muted">
      The current tip of every NixOS release channel. A release moves as
      backports land, exactly like
      <code>github:NixOS/nixpkgs/nixos-26.05</code>.
    </p>
    <div class="head cols-rel">
      <span>release</span><span>as of</span><span>tip commit</span
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
          navigate=${navigate}
        />
      `;
    })}
  `;
}

/* ---------- app ---------- */

function App() {
  const [route, setRoute] = useState(readRoute);
  const [small, setSmall] = useState(null); // { revisions, releases } — load fast
  const [index, setIndex] = useState(null); // versions.json — the big one
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
    setRoute(next);
  };

  // Back/forward restore whatever route the URL then holds.
  useEffect(() => {
    const onPop = () => setRoute(readRoute());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  // The two small files render their tabs immediately; versions.json is the
  // big one, so search lights up when it lands.
  useEffect(() => {
    const json = (f) =>
      fetch(f).then((r) => {
        if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
        return r.json();
      });
    Promise.all([json("revisions.json"), json("releases.json")])
      .then(([revisions, releases]) => {
        setSmall({ revisions, releases });
        return json("versions.json").then(setIndex);
      })
      .catch((err) => setError(err.message));
  }, []);

  const attrNames = useMemo(
    () => (index ? Object.keys(index.attrs).sort() : null),
    [index],
  );

  const stats = useMemo(() => {
    if (!index || !small) return null;
    let versions = 0;
    for (const a of attrNames) versions += Object.keys(index.attrs[a]).length;
    const { revisions } = small;
    return (
      `${versions.toLocaleString()} package versions across ` +
      `${attrNames.length.toLocaleString()} attributes, from ` +
      `${revisions.length.toLocaleString()} revisions · ` +
      `${revisions[0].date} → ${revisions[revisions.length - 1].date}`
    );
  }, [index]);

  // Name the shared thing in the tab title, so pasted links read as what
  // they are.
  useEffect(() => {
    const pkgPart =
      route.pkg && route.ver ? `${route.pkg} ${route.ver}` : route.pkg;
    const part =
      (route.view === "packages" &&
        (pkgPart || (route.q && `search “${route.q}”`))) ||
      (route.view === "releases" && route.release) ||
      (route.view !== "packages" && route.view);
    document.title = part
      ? `nixpkgs-multiverse — ${part}`
      : "nixpkgs-multiverse";
  }, [route]);

  return html`
    <p class="muted" id="stats">
      ${error
        ? `Failed to load index data: ${error}`
        : (stats ?? "Loading index…")}
    </p>

    <nav>
      ${VIEWS.map(
        (v) => html`
          <button
            class=${route.view === v ? "active" : ""}
            onClick=${() => navigate({ view: v })}
          >
            ${v[0].toUpperCase() + v.slice(1)}
          </button>
        `,
      )}
    </nav>

    <section hidden=${route.view !== "packages"}>
      <${Packages}
        route=${route}
        navigate=${navigate}
        index=${index}
        attrNames=${attrNames}
        revisions=${small?.revisions ?? []}
      />
    </section>

    <section hidden=${route.view !== "revisions"}>
      ${small &&
      html`<${Revisions}
        route=${route}
        revisions=${small.revisions}
        index=${index}
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

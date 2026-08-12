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
}) {
  const { open, ref, toggle } = useLinkableRow(
    selected,
    (isOpen) => navigate({ ver: isOpen ? v : "" }, Nav.REPLACE),
    bulk,
  );

  useEffect(() => onOpenChange(v, open), [open]);

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
        <${Cmd}
          text=${`github:NixOS/nixpkgs/${r.rev}`}
          caption="pin another flake's nixpkgs to it"
        />
        <${Runs} runs=${runs} revisions=${revisions} navigate=${navigate} />
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
      <span class="muted"
        >${archive && html`<a href=${archive}>${r.name}</a>`}</span
      >
    <//>
  `;
}

function PackageDetail({ attr, route, index, revisions, navigate }) {
  const hist = useHistory(attr);
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
  if (!index)
    return html`<div id="status" class="muted">Loading versions.json…</div>`;
  if (!index.attrs[attr])
    return html`<div id="status" class="muted">
      No attribute named <code>${attr}</code> in the index.
    </div>`;

  const vers = Object.entries(index.attrs[attr]).sort((a, b) =>
    compareVersions(b[0], a[0]),
  ); // newest first

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
  const lifetime = !offs.length
    ? `${vers.length} versions`
    : `${vers.length} versions · first packaged ${revisions[Math.min(...offs)].date}` +
      (gone ? ` · gone since ${revisions[Math.max(...offs)].date}` : "");

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
    <div class="head cols-ver">
      <span></span><span>version</span><span>newest revision shipping it</span
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
          runs=${history?.[v] && runsOf(history[v])}
          revisions=${revisions}
          selected=${route.ver === v}
          bulk=${force[v] ?? bulk}
          onOpenChange=${onOpenChange}
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

// `churn` is [added, removed] for this revision against the one before it,
// read straight off stats.json by offset — the revisions table would otherwise
// have to load the 8 MB history to know it.
function RevRow({ r, off, selected, index, churn, bulk, navigate }) {
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
          ? html`<${RevPins} off=${off} index=${index} navigate=${navigate} />`
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

function Revisions({ route, revisions, index, stats, navigate }) {
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
          index=${index}
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
function LineChart({ title, sub, rows, value, format, unit }) {
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
                >${compact(t)}</text
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

function Stats({ stats }) {
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
  `;
}

/* ---------- per-package timeline ----------
 *
 * history.json is 8 MB, and a timeline needs one attribute out of it, so the
 * site build splits it by the first two characters of the attribute name and
 * this fetches the one shard. Median shard is 2 KB.
 *
 * Cached per shard at module scope: opening five packages beginning "py"
 * fetches once.
 */
const shardOf = (attr) =>
  [...attr.slice(0, 2).toLowerCase()]
    .map((c) => (/[a-z0-9]/.test(c) ? c : "_"))
    .join("") || "_";

const shardCache = new Map();
function loadShard(attr) {
  const key = shardOf(attr);
  if (!shardCache.has(key))
    shardCache.set(
      key,
      fetch(`history/${key}.json`).then((r) => {
        if (!r.ok) throw new Error(`history/${key}.json: HTTP ${r.status}`);
        return r.json();
      }),
    );
  return shardCache.get(key);
}

// On disk a version with one unbroken run is [first, last]; one with gaps is a
// list of those pairs. Same collapse multiverse.nix expands in runsOf.
const runsOf = (v) => (v && !Array.isArray(v[0]) ? [v] : v);

// One fetch per package page. The timeline and every version row read the
// same object, so opening a row costs nothing extra.
function useHistory(attr) {
  const [hist, setHist] = useState(null);
  useEffect(() => {
    let live = true;
    setHist(null);
    loadShard(attr)
      .then((d) => live && setHist(d.attrs[attr] ?? {}))
      // A failed shard used to land here as {}, which Timeline renders as
      // nothing at all — indistinguishable from a package with no history and
      // the reason the graph looked like it "sometimes" did not appear.
      .catch(() => live && setHist("error"));
    return () => {
      live = false;
    };
  }, [attr]);
  return hist;
}

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

  if (hist === "error")
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

  const gutter = Math.min(TL_LABEL_W, width * 0.28);
  const inner = width - gutter - PLOT.right;
  const X = (off) => gutter + ((off - lo) / Math.max(1, hi - lo)) * inner;
  const height = vers.length * TL_ROW_H + PLOT.bottom;

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
                html`<line
                  x1=${x}
                  x2=${x}
                  y1="0"
                  y2=${vers.length * TL_ROW_H}
                />`,
            )}
          </g>
          ${years.map(
            ({ y, x }) =>
              html`<text x=${x} y=${height - 6} text-anchor="middle"
                >${y}</text
              >`,
          )}
          ${vers.map((v, n) => {
            const y = n * TL_ROW_H;
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
                  height=${TL_ROW_H}
                  fill="transparent"
                />
                <text class="tl-label" x="0" y=${y + 11}>${v}</text>
                ${runsOf(hist[v]).map(([s, e]) => {
                  // A single-revision run would otherwise be invisible, so
                  // every bar gets a 2px floor.
                  const x = X(s);
                  const w = Math.max(2, X(e) - x);
                  return html`<rect
                    class="tl-bar"
                    x=${x}
                    y=${y + 3}
                    width=${w}
                    height=${TL_ROW_H - 6}
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
          style=${`left:${gutter}px; top:${hover.y + TL_ROW_H}px`}
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
  const [index, setIndex] = useState(null); // versions.json — the big one
  const [stats, setStats] = useState(null); // stats.json — 13 KB, charts
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

  // The two small files render their tabs immediately; versions.json is the
  // big one, so search lights up when it lands.
  useEffect(() => {
    const json = (f) =>
      fetch(f).then((r) => {
        if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
        return r.json();
      });
    // stats.json rides with the two small files rather than behind the
    // index: it is 13 KB and it is all the charts need, so the Stats tab
    // renders on first paint instead of waiting on 5.5 MB it never reads.
    Promise.all([
      json("revisions.json"),
      json("releases.json"),
      json("stats.json"),
    ])
      .then(([revisions, releases, s]) => {
        setSmall({ revisions, releases });
        setStats(s);
        return json("versions.json").then(setIndex);
      })
      .catch((err) => setError(err.message));
  }, []);

  const attrNames = useMemo(
    () => (index ? Object.keys(index.attrs).sort() : null),
    [index],
  );

  const summary = useMemo(() => {
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
        : (summary ?? "Loading index…")}
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
        stats=${stats}
        navigate=${navigate}
      />`}
    </section>

    <section hidden=${route.view !== "stats"}>
      ${route.view === "stats" && html`<${Stats} stats=${stats} />`}
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

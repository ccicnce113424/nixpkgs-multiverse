"use strict";

const FLAKE = "github:fzakaria/nixpkgs-multiverse";
const COMMIT_URL = "https://github.com/NixOS/nixpkgs/commit/";
// The channel archive: releases.nixos.org fronts the nix-releases bucket and
// renders ?prefix= as a browsable listing (a bare directory URL 404s).
const ARCHIVE_URL = "https://releases.nixos.org/?prefix=nixos/";
const MAX_RESULTS = 200;
const MAX_PINS = 400;

const COPY_ICON =
  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
     <rect x="5.5" y="5.5" width="8" height="8" rx="1"/>
     <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>
   </svg>`;

// Populated by load(): the same three files the Nix API reads, copied into
// the site by the pages workflow so they deploy atomically with each other.
let revisions = null;   // [ {rev, date, channel, name, narHash?} ] oldest first
let releases = null;    // { "26.05": {rev, date, build, name}, ... }
let index = null;       // { revisionCount, attrs: { attr: {version: offset} } }
let attrNames = null;   // sorted keys of index.attrs, the search corpus
let pinsByOffset = null; // offset -> [attr, version][], built on first use

const $ = (id) => document.getElementById(id);

const esc = (s) => s.replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const label = (r) => `${r.date}-${r.rev.slice(0, 12)}`;

// nixos/unstable/<name>/ for a revision, nixos/26.05/<name>/ for a release.
const archiveFor = (channelDir, name) =>
  name ? `${ARCHIVE_URL}${channelDir}/${encodeURIComponent(name)}/` : null;

// Nix-style version ordering: split into digit and non-digit runs, compare
// digit runs numerically. Enough to put 3.12.10 after 3.12.7.
function compareVersions(a, b) {
  const chunks = (s) => s.match(/\d+|\D+/g) || [];
  const ca = chunks(a), cb = chunks(b);
  for (let i = 0; i < Math.max(ca.length, cb.length); i++) {
    const x = ca[i] ?? "", y = cb[i] ?? "";
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return 0;
}

function cmdBlock(text, caption) {
  return (caption ? `<div class="capt">${esc(caption)}</div>` : "") +
    `<div class="cmd"><code>${esc(text)}</code>` +
    `<button data-copy="${esc(text)}" title="copy">${COPY_ICON}</button></div>`;
}

// The index records only the NEWEST revision shipping each version, so this
// answers "which package versions are pinned at this revision", not "what was
// in it" — the full contents of a revision are the whole of nixpkgs.
function pinsFor(offset) {
  if (!pinsByOffset) {
    pinsByOffset = new Map();
    for (const a of attrNames)
      for (const [v, off] of Object.entries(index.attrs[a])) {
        let l = pinsByOffset.get(off);
        if (!l) pinsByOffset.set(off, l = []);
        l.push([a, v]);
      }
    for (const l of pinsByOffset.values()) l.sort((x, y) => x[0] < y[0] ? -1 : 1);
  }
  return pinsByOffset.get(offset) || [];
}

const pinLinks = (pins) => pins.map(([a, v]) =>
  `<div><a href="#" class="attr" data-attr="${esc(a)}">${esc(a)}</a> <span class="muted">${esc(v)}</span></div>`).join("");

function renderStats() {
  let versions = 0;
  for (const a of attrNames) versions += Object.keys(index.attrs[a]).length;
  const first = revisions[0].date, last = revisions[revisions.length - 1].date;
  $("stats").textContent =
    `${versions.toLocaleString()} package versions across ${attrNames.length.toLocaleString()} attributes, ` +
    `from ${revisions.length.toLocaleString()} revisions · ${first} → ${last}`;
}

/* ---------- packages ---------- */

function renderSearch() {
  const q = $("search").value.trim().toLowerCase();
  const out = $("results"), status = $("status");
  out.textContent = "";
  if (!index) { status.textContent = "Loading versions.json…"; return; }
  if (!q) { status.textContent = ""; return; }

  // startsWith matches rank ahead of substring matches.
  const starts = [], contains = [];
  for (const a of attrNames) {
    const i = a.toLowerCase().indexOf(q);
    if (i === 0) starts.push(a);
    else if (i > 0) contains.push(a);
    if (starts.length >= MAX_RESULTS) break;
  }
  const hits = starts.concat(contains).slice(0, MAX_RESULTS);
  status.textContent = hits.length
    ? (hits.length === MAX_RESULTS ? `first ${MAX_RESULTS} matches` : `${hits.length} matches`)
    : "no matches";
  out.innerHTML = hits.map((a) =>
    `<div class="pkg" data-attr="${esc(a)}">${esc(a)}
       <span class="muted">· ${Object.keys(index.attrs[a]).length} versions</span></div>`).join("");
}

function renderPackage(attr) {
  const vers = Object.entries(index.attrs[attr])
    .sort((a, b) => compareVersions(b[0], a[0]));   // newest first
  const rows = vers.map(([v, off]) => {
    const r = revisions[off];
    if (!r) return "";
    const archive = archiveFor("unstable", r.name);
    return `<details class="item">
      <summary class="row cols-ver"><code>${esc(v)}</code>
        <span><a href="#" class="rev" data-offset="${off}">${label(r)}</a></span>
        <span class="muted">${archive ? `<a href="${archive}">${esc(r.name)}</a>` : ""}</span></summary>
      <div class="body">
        ${cmdBlock(`nix run '${FLAKE}#versions.${attr}."${v}"'`, "run this version")}
        ${cmdBlock(`github:NixOS/nixpkgs/${r.rev}`, "pin another flake's nixpkgs to it")}
      </div>
    </details>`;
  }).join("");
  $("status").textContent = "";
  $("results").innerHTML = `
    <h2><code>${esc(attr)}</code> <span class="muted">· ${vers.length} versions, newest first — click a row to expand</span></h2>
    <div class="head cols-ver"><span>version</span><span>newest revision shipping it</span><span>channel build</span></div>
    ${rows}`;
}

function goToPackage(attr) {
  selectTab("packages");
  $("search").value = attr;
  renderPackage(attr);
}

/* ---------- revisions ---------- */

function renderRevisions() {
  const rows = revisions.map((r, off) => ({ r, off })).reverse().map(({ r, off }) => {
    const archive = archiveFor("unstable", r.name);
    return `<details class="item" data-offset="${off}">
      <summary class="row cols-rev"><span>${r.date}</span>
        <code><a href="${COMMIT_URL}${r.rev}">${r.rev.slice(0, 12)}</a></code>
        <span class="muted">${archive
          ? `<a href="${archive}">${esc(r.name)}</a>`
          : esc(r.name || r.channel || "")}</span></summary>
      <div class="body"></div>
    </details>`;
  }).join("");
  $("revlist").innerHTML =
    `<div class="head cols-rev"><span>date</span><span>commit</span><span>channel build</span></div>${rows}`;
}

// Filled on first open, so 1,538 closed rows cost nothing.
function fillRevision(el) {
  if (el.dataset.filled) return;
  el.dataset.filled = "1";
  const off = Number(el.dataset.offset);
  const r = revisions[off];
  let pinsHtml = `<div class="muted">index still loading — reopen in a moment</div>`;
  if (index) {
    const pins = pinsFor(off);
    const shown = pins.slice(0, MAX_PINS);
    pinsHtml = `
      <div class="capt">${pins.length.toLocaleString()} package versions pinned at this revision
        (their newest shipping revision is this one)</div>
      <div class="pins">${pinLinks(shown)}</div>` +
      (pins.length > shown.length
        ? `<button class="more" data-offset="${off}">show all ${pins.length.toLocaleString()}</button>`
        : "");
  }
  el.querySelector(".body").innerHTML = `
    ${cmdBlock(`nix run ${FLAKE}#${label(r)}.hello`, "run anything out of this revision")}
    ${pinsHtml}`;
}

function goToRevision(off) {
  selectTab("revisions");
  const el = document.querySelector(`#revlist details[data-offset="${off}"]`);
  if (!el) return;
  fillRevision(el);
  el.open = true;
  // Scroll the summary line, not the element: centering the whole details
  // would include the expanded body and land the viewport inside it.
  el.querySelector("summary").scrollIntoView({ block: "start" });
}

/* ---------- releases ---------- */

function renderReleases() {
  const rows = Object.entries(releases).reverse().map(([name, r]) => {
    const archive = archiveFor(name, r.name);
    // A release tip lives on the release branch, so it is never an indexed
    // unstable revision; the honest internal link is unstable on the same
    // date — exactly what `at "<date>"` returns.
    let near = -1;
    for (let i = revisions.length - 1; i >= 0; i--)
      if (revisions[i].date <= r.date) { near = i; break; }
    return `<details class="item">
      <summary class="row cols-rel"><code>${esc(name)}</code><span>${r.date}</span>
        <code><a href="${COMMIT_URL}${r.rev}">${r.rev.slice(0, 12)}</a></code>
        <span class="muted">${archive ? `<a href="${archive}">${esc(r.name)}</a>` : esc(r.name || "")}</span></summary>
      <div class="body">
        ${cmdBlock(`nix run ${FLAKE}#${name}.hello`, "run anything out of this release, backports included")}
        ${near >= 0
          ? `<div class="links"><a href="#" class="rev" data-offset="${near}">unstable as of ${r.date} →</a></div>`
          : ""}
      </div>
    </details>`;
  }).join("");
  $("rellist").innerHTML =
    `<div class="head cols-rel"><span>release</span><span>as of</span><span>tip commit</span><span>channel build</span></div>${rows}`;
}

/* ---------- wiring ---------- */

function selectTab(view) {
  document.querySelectorAll("nav button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === view));
  for (const v of ["packages", "revisions", "releases"]) $(v).hidden = v !== view;
}

document.querySelectorAll("nav button").forEach((b) =>
  b.addEventListener("click", () => selectTab(b.dataset.view)));

// One listener for everything clickable, present or future.
document.addEventListener("click", (e) => {
  const copy = e.target.closest("button[data-copy]");
  if (copy) {
    navigator.clipboard.writeText(copy.dataset.copy);
    copy.innerHTML = "✓";
    setTimeout(() => { copy.innerHTML = COPY_ICON; }, 1200);
    return;
  }
  const more = e.target.closest("button.more");
  if (more) {
    more.previousElementSibling.innerHTML = pinLinks(pinsFor(Number(more.dataset.offset)));
    more.remove();
    return;
  }
  const pkg = e.target.closest(".pkg");
  if (pkg) { renderPackage(pkg.dataset.attr); return; }
  const attr = e.target.closest("a.attr");
  if (attr) { e.preventDefault(); goToPackage(attr.dataset.attr); return; }
  const rev = e.target.closest("a.rev");
  if (rev) { e.preventDefault(); goToRevision(Number(rev.dataset.offset)); return; }
  const summary = e.target.closest("#revlist details > summary");
  if (summary) fillRevision(summary.parentElement);
});

$("search").addEventListener("input", renderSearch);

// The two small files render their tabs immediately; versions.json is the
// big one, so search lights up when it lands.
async function load() {
  const json = (f) => fetch(f).then((r) => {
    if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
    return r.json();
  });
  try {
    [revisions, releases] = await Promise.all([json("revisions.json"), json("releases.json")]);
    renderRevisions();
    renderReleases();
    index = await json("versions.json");
    attrNames = Object.keys(index.attrs).sort();
    renderStats();
    renderSearch();
  } catch (err) {
    $("stats").textContent = `Failed to load index data: ${err.message}`;
  }
}
load();

// The pages workflow substitutes the deploying commit into BUILT_FROM, so the
// footer names exactly the tree the data files came from. A local checkout
// still carries the placeholder, and the span stays hidden.
const BUILT_FROM = "__COMMIT__";
if (!BUILT_FROM.startsWith("__")) {
  $("built-sha").textContent = BUILT_FROM.slice(0, 12);
  $("built-link").href = `https://github.com/fzakaria/nixpkgs-multiverse/commit/${BUILT_FROM}`;
  $("built").hidden = false;
}

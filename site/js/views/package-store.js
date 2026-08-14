/* ---------- store metadata: cache liveness, deps, closures ----------
 *
 * Everything here rides on two facts. The meta shards carry each version's
 * store digest, sizes, liveness at census time and direct references; and
 * cache.nixos.org serves narinfos with open CORS, so anything deeper — is it
 * still there right now, what is the full closure — the browser asks the
 * cache itself. The shards store breadth; the client computes depth. The
 * narinfo client and the walker live in cache.js; the components rendering
 * their answers inside a version row live here.
 */

import { html, useState, useEffect, useRef } from "htm/preact";

import { SHARD_ERROR } from "../config.js";
import { CACHE_URL, WALK_CAP, fetchNarinfo, walkClosure } from "../cache.js";
import { refName, refAttr, refVer, useNames } from "../data.js";
import { fmtBytes, pnameOf } from "../format.js";
import { Link } from "../router.js";

// Asks the cache, live, whether this exact path still substitutes — and what
// it costs. The census answer from the shard renders immediately; the live
// answer replaces it when it arrives, so the badge is never stale.
export function CacheBadge({ entry }) {
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

// The direct dependencies of one version, as recorded in the cache the day it
// was built. A dep that is itself an indexed package links to its page at the
// exact version; anything else (multi-output libs, private packages) shows as
// its store name.
export function Deps({ refs, src, navigate }) {
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
export function UsedBy({ rd, navigate }) {
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

export function DepDiff({ refs, prevRefs }) {
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

export function ClosureLive({ entry }) {
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
      closure, measured live:${" "}
      <b>${state.count} paths · ${fmtBytes(state.total)}</b>
      ${state.dead ? ` · ${state.dead} paths gone from the cache` : ""}
      ${state.complete ? "" : ` · stopped at ${WALK_CAP} paths`} ·
      heaviest${" "} ${state.top.length} paths:
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

export function GraphExplorer({ attr, v, entry, navigate }) {
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
      draw full dependency graph live from cache.nixos.org →
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
          const jump = () => nd.link && navigate({ pkg: nd.link, ver: nd.ver });
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
        the complete runtime closure, fetched live from${" "}
        <a href="https://cache.nixos.org">cache.nixos.org</a>:${" "}
        <b>${nodes.length} paths · ${fmtBytes(total)}</b>
        ${complete ? "" : ` (stopped at ${WALK_CAP} paths)`}
      </div>
    </div>
  `;
}

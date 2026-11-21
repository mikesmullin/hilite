// ── hilite ──────────────────────────────────────────────────────────────────
// A single-file DOM inspector for citing UI regions back to an agent.
//
// Why this is a plain script rather than app code: it is a measurement tool
// over whatever the page happens to render, so it must not depend on the
// app's component tree, its stores, or a rebuild. It reads the DOM and
// nothing else, injects its own CSS, and needs one <script> tag:
//
//   <script src="https://mikesmullin.github.io/hilite/hilite.js"
//           data-hilite-root="#app"></script>
//
// Config (data attributes on the script tag, or window.hilite.init()):
//   data-hilite-root     CSS selector for the content to measure.
//                        Default: #app if present, else body.
//   data-hilite-key      Key that arms / disarms. Default: e
//   data-hilite-enabled  "0" disables. localStorage "hilite"="0" also does.
//
// Contract:
//   E            arm / disarm (ignored while a form control has focus).
//                Either direction clears all selections and resets to group 1.
//   Esc          disarm
//   hover        outline the candidate + fill the reference panel
//   click        toggle the hovered element in/out of the current citation group:
//                a new element gets .hilite and the aggregate report goes to
//                the clipboard; clicking a cited element removes it and re-copies.
//   enter/space  while armed: cite whatever the hover outline is on. The
//                mouse never reaches a disabled control (the browser
//                suppresses its presses), so this is how disabled buttons
//                and inputs get cited. Never fires while typing.
//   right-click  while armed: clear the current group's selection (its .hilite
//                marks and its retained data) and copy the updated report.
//                The group number does not advance — that is `n`'s job.
//   n            while armed: clear the current selection (its .hilite marks)
//                and move to the next citation group. Citations already made
//                are retained in the report. Groups start at 1.
//   click+drag   lasso; the outermost fully-contained elements are added to the
//                current group, marked .hilite, and the report goes to the clipboard
//
// "Outermost fully-contained" is the rule that makes a lasso legible. Mark
// every contained element and a lasso over a card paints the card *and* its
// paragraphs *and* their inline spans, so the yellow is a solid block with no
// structure. Marking only elements whose parent is not contained gives one
// band per top-level thing inside the lasso, which is what a reader means by
// "these paragraphs".
//
// .hilite survives disarming on purpose: the point is to leave marks on the
// page for the agent to find via the browser tools, not just to copy text.
// The marks are only *visible* while body.citing is present, so disarming
// hides stale-looking paint without destroying the citation.
//
// MIT — see LICENSE.
(function () {
  "use strict";
  if (window.hilite) return window.hilite; // included twice: keep the first

  const VERSION = "1.1.4";
  const MARK = "hilite";
  const UI_ATTR = "data-hilite-ui";
  const DRAG_THRESHOLD_PX = 4;
  const TEXT_SNIPPET = 300;

  const scriptTag =
    document.currentScript || document.querySelector('script[src*="hilite"]');
  const attr = (name) =>
    scriptTag ? scriptTag.getAttribute("data-hilite-" + name) : null;

  const cfg = {
    root: attr("root") || undefined, // a CSS selector, or undefined for the default
    key: (attr("key") || "e").toLowerCase(),
    enabled:
      attr("enabled") !== "0" &&
      attr("disabled") === null &&
      localStorage.getItem("hilite") !== "0",
  };

  // #app is the conventional app root; everything else (a dev panel, a
  // toolbar) is measured only when no #app exists or a root is given.
  const root = () =>
    (cfg.root && document.querySelector(cfg.root)) ||
    document.querySelector("#app") ||
    document.body;

  const disabled = () => !cfg.enabled;

  // ── css ───────────────────────────────────────────────────────────────────
  // The module injects its own skin so a host page needs no CSS at all. Every
  // value is a namespaced --hl-* token with a fallback chain into common host
  // tokens, so it themes itself to whatever page it lands on, and a host that
  // defines --hl-* wins. Everything is inert until the inspector arms, except
  // .hilite, which is the durable mark a citation leaves behind: the agent
  // reads it straight off the DOM, so it has to be real CSS.

  const CSS = `
:root {
  --hl-surface: var(--panel, #11161f);
  --hl-line: var(--border, var(--line, #2d3a4f));
  --hl-line-soft: var(--line-soft, var(--border-soft, color-mix(in srgb, var(--hl-line) 55%, transparent)));
  --hl-ink: var(--text, var(--ink, #e7ecf3));
  --hl-dim: var(--muted, var(--ink-dim, #8b9bb4));
  --hl-faint: var(--faint, var(--ink-faint, #5d6d87));
  --hl-accent: var(--accent, #3b82f6);
  --hl-good: var(--ok, var(--good, #22c55e));
  --hl-mark: var(--hilite-mark, #f5c518);
  --hl-radius: var(--radius, 8px);
  --hl-mono: var(--mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
  --hl-sans: var(--sans, ui-sans-serif, system-ui, sans-serif);
}

/* The crosshair belongs to us while armed, so the pointer does not compete
   with the highlighter glyph. */
html.hilite-armed,
html.hilite-armed * { cursor: none !important; }

html.hilite-armed ::selection { background: transparent; }

.hilite-icon {
  position: fixed; left: 0; top: 0; z-index: 2147483000;
  pointer-events: none; opacity: 0;
  transition: opacity .08s linear;
  filter: drop-shadow(0 1px 3px rgba(0,0,0,.6));
}
.hilite-icon.show { opacity: 1; }

.hilite-panel {
  position: fixed; left: 0; top: 0; z-index: 2147483001;
  display: none; width: min(460px, calc(100vw - 28px));
  background: var(--hl-surface);
  background: color-mix(in srgb, var(--hl-surface) 92%, transparent);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  border: 1px solid var(--hl-line);
  border-radius: var(--hl-radius);
  box-shadow: 0 12px 34px rgba(0,0,0,.55);
  color: var(--hl-ink);
  font: 400 12px/1.5 var(--hl-sans);
}
.hilite-panel.show { display: block; }

.hilite-head {
  display: flex; justify-content: space-between; align-items: center; gap: 10px;
  padding: 7px 10px; border-bottom: 1px solid var(--hl-line-soft);
  font: 600 10px/1 var(--hl-mono); letter-spacing: .12em; text-transform: uppercase;
  color: var(--hl-faint);
}
.hilite-count { color: var(--hl-mark); font-weight: 700; }
.hilite-group { color: var(--hl-faint); font-weight: 400; margin-left: 6px; letter-spacing: .08em; }

.hilite-dl { margin: 0; padding: 8px 10px 4px; display: grid; gap: 5px; }
.hilite-dl > div { display: grid; grid-template-columns: 58px minmax(0,1fr); gap: 10px; align-items: baseline; }
.hilite-dl dt {
  margin: 0; font: 500 10px/1.5 var(--hl-mono); letter-spacing: .06em;
  text-transform: uppercase; color: var(--hl-faint);
}
.hilite-dl dd { margin: 0; font-family: var(--hl-mono); overflow-wrap: anywhere; user-select: text; }
.hilite-dl .f-url { color: var(--hl-accent); }
.hilite-dl .f-xpath, .hilite-dl .f-tag { color: var(--hl-dim); }
.hilite-dl .f-text { font-family: var(--hl-sans); color: var(--hl-ink); max-height: 7.5em; overflow: hidden; }

.hilite-hint {
  padding: 6px 10px 8px; border-top: 1px solid var(--hl-line-soft);
  color: var(--hl-faint); font: 400 10.5px/1.4 var(--hl-mono);
}

/* Hover candidate and the lasso itself. Scoped to body.citing so a stale
   outline can never survive a disarm and masquerade as a selection. */
body.citing .hilite-target {
  outline: 2px solid var(--hl-accent) !important;
  outline-offset: 1px;
  background-color: rgba(124,196,255,.07);
  background-color: color-mix(in srgb, var(--hl-accent) 9%, transparent);
}

.hilite-lasso {
  position: fixed; z-index: 2147483002; display: none; pointer-events: none;
  border: 1px dashed var(--hl-accent);
  background: rgba(124,196,255,.10);
  background: color-mix(in srgb, var(--hl-accent) 10%, transparent);
}
.hilite-lasso.show { display: block; }

/* The citation handle, painted only while the inspector is armed (body.citing).
   The .hilite *class* is the selection and lives on the DOM; this rule is just
   its visibility, so disarming hides a selection without destroying it -- the
   agent can still read document.querySelectorAll('.hilite'), and re-arming
   brings the marks back. Bright but translucent: at 30% the mark reads as
   paint laid over the page rather than paint replacing it, so the text keeps
   its own colour and a code span still looks like a code span underneath.
   The ring -- not the fill -- is what makes the boundary unambiguous. */
body.citing .${MARK} {
  background-color: rgba(245, 197, 24, .30);
  background-color: color-mix(in srgb, var(--hl-mark) 30%, transparent);
  border-radius: 3px;
  box-shadow: 0 0 0 2px rgba(245,197,24,.60);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--hl-mark) 60%, transparent);
  /* Citations often land on inline <code>/<a> runs that wrap across lines, and
     without this a ring is drawn only at the very start and end of the run. */
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}

.hilite-toast {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483003;
  display: none; padding: 8px 12px;
  background: var(--hl-surface);
  background: color-mix(in srgb, var(--hl-surface) 92%, transparent);
  border: 1px solid var(--hl-line);
  border-radius: 99px; color: var(--hl-good);
  font: 500 11.5px/1.4 var(--hl-mono);
  box-shadow: 0 8px 24px rgba(0,0,0,.5);
}
.hilite-toast.show { display: block; }

.hilite-fallback {
  position: fixed; left: -9999px; top: 0; opacity: 0;
  width: 1px; height: 1px;
}
`;

  if (!document.getElementById("css-hilite")) {
    const s = document.createElement("style");
    s.id = "css-hilite";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ── state ─────────────────────────────────────────────────────────────────

  let armed = false;
  let target = null; // hovered element
  let drag = null; // {x0,y0,x,y,moved}
  let lastCopy = null; // { text, count, at } of the last reference copied

  // Citation groups: every selection lands in the current group (groupNo).
  // `n` clears the visible selection but keeps the retained data, then moves
  // to the next group. The clipboard report is rebuilt from this data — never
  // re-read from the live DOM — so cleared groups still render. Each element
  // record keeps its node so repeated citations of the same node dedupe.
  // group entry: { when, url, scroll:{x,y}, via, region:{l,t,r,b}, elements: [...] }
  let groups = new Map();
  let groupNo = 1;

  // Remove one element from the current citation group (the toggle-off half
  // of a click). Returns true when the element was cited. The group's header
  // metadata is left alone — it still describes how the remaining elements
  // got there.
  function removeFromSelection(el) {
    const g = groups.get(groupNo);
    if (!g) return false;
    const i = g.elements.findIndex((e) => e.el === el);
    if (i === -1) return false;
    g.elements.splice(i, 1);
    el.classList.remove(MARK);
    refreshHead();
    return true;
  }

  // A right-click while armed is a gesture in our tool, never in the app: it
  // clears the current group's selection — marks *and* retained data — and
  // copies the updated report. The group number does not advance (that is
  // `n`'s job). Right-clicks on our own panel are left alone so its text
  // menu keeps working.
  document.addEventListener(
    "contextmenu",
    async (e) => {
      if (!armed) return;
      if (e.target.closest(`[${UI_ATTR}]`)) return;
      e.preventDefault();
      e.stopPropagation();
      const g = groups.get(groupNo);
      if (!g || !g.elements.length) {
        flash("nothing selected");
        return;
      }
      for (const item of g.elements) item.el.classList.remove(MARK);
      g.elements.length = 0;
      refreshHead();
      await copy();
      flash(`group ${groupNo} cleared`);
    },
    true,
  );
  // A completed lasso must survive the `click` the browser fires when the drag
  // ends. That click arrives *after* mouseup, by which point `drag` has already
  // been released, so a guard reading `drag.moved` is necessarily false by then
  // and the click handler wipes the marks the lasso just painted -- the citation
  // copies correctly while the page looks untouched, which is worse than failing
  // loudly. The flag is set on release and consumed by that click, or expires.
  let lassoJustFinished = false;
  let lassoFlagTimer = 0;

  // ── ui ────────────────────────────────────────────────────────────────────

  function ui(tag, cls) {
    const el = document.createElement(tag);
    el.className = cls;
    el.setAttribute(UI_ATTR, "");
    return el;
  }

  const icon = ui("div", "hilite-icon");
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">' +
    '<path fill="#f5c518" stroke="#1a1d24" stroke-width="1.2" ' +
    'd="M14.6 3.2 20.8 9.4 9.9 20.3 3.7 14.1Z M8.2 18.6 5.4 21.5 2 22l.5-3.4 3.1-3.1Z"/>' +
    '<path fill="#1a1d24" d="m15.9 4.5 3.6 3.6-1.3 1.3-3.6-3.6Z"/></svg>';

  const panel = ui("div", "hilite-panel");
  panel.innerHTML =
    '<div class="hilite-head"><span>hilite<span class="hilite-group"></span></span><b class="hilite-count"></b></div>' +
    '<dl class="hilite-dl">' +
    '<div><dt>url</dt><dd class="f-url"></dd></div>' +
    '<div><dt>xpath</dt><dd class="f-xpath"></dd></div>' +
    '<div><dt>element</dt><dd class="f-tag"></dd></div>' +
    '<div><dt>bounds</dt><dd class="f-bounds"></dd></div>' +
    '<div><dt>scroll</dt><dd class="f-scroll"></dd></div>' +
    '<div><dt>text</dt><dd class="f-text"></dd></div>' +
    "</dl>" +
    '<div class="hilite-hint">click&nbsp;=&nbsp;toggle &nbsp;·&nbsp; enter&nbsp;=&nbsp;cite hovered &nbsp;·&nbsp; right-click&nbsp;=&nbsp;clear &nbsp;·&nbsp; drag&nbsp;=&nbsp;lasso+copy &nbsp;·&nbsp; n&nbsp;=&nbsp;new group</div>';

  const lasso = ui("div", "hilite-lasso");
  const toast = ui("div", "hilite-toast");
  const layers = [icon, panel, lasso, toast];

  let mounted = false;
  function mount() {
    if (mounted) return;
    mounted = true;
    for (const el of layers) document.body.appendChild(el);
  }
  function unmount() {
    for (const el of layers) el.remove();
    mounted = false;
  }

  function showPanel(on) {
    panel.classList.toggle("show", on);
    icon.classList.toggle("show", on);
    if (!on) lasso.classList.remove("show");
  }

  function place(x, y) {
    icon.style.transform = `translate(${x}px, ${y}px)`;
    const pad = 14;
    const r = panel.getBoundingClientRect();
    let px = x + 18;
    let py = y + 18;
    if (px + r.width > innerWidth - pad) px = x - r.width - 18;
    if (py + r.height > innerHeight - pad) py = y - r.height - 18;
    panel.style.transform = `translate(${Math.max(pad, px)}px, ${Math.max(pad, py)}px)`;
  }

  function set(field, value) {
    const el = panel.querySelector(field);
    if (el) el.textContent = value;
  }

  // ── measurement ───────────────────────────────────────────────────────────

  const n = (v) => Math.round(v);

  // The inspector's own state classes are not part of the element's identity,
  // so they must never appear in a citation: reporting `p.hilite-target`
  // describes the tool, not the thing being cited.
  const OURS = new Set(["hilite-target", MARK]);
  function classList(el) {
    return (el.getAttribute("class") || "")
      .trim()
      .split(/\s+/)
      .filter((c) => c && !OURS.has(c))
      .slice(0, 3);
  }
  function tagOf(el) {
    const cls = classList(el);
    return el.tagName.toLowerCase() + (cls.length ? "." + cls.join(".") : "");
  }

  function xpath(el) {
    if (!(el instanceof Element)) return "";
    if (el.id) return `//*[@id="${el.id}"]`;
    const seg = [];
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur.id) {
        seg.unshift(`/*[@id="${cur.id}"]`);
        return "/" + seg.join("/").replace(/^\/+/, "");
      }
      const sib = cur.parentElement
        ? Array.prototype.filter.call(
            cur.parentElement.children,
            (c) => c.tagName === cur.tagName,
          )
        : [cur];
      const i = sib.indexOf(cur) + 1;
      seg.unshift(
        sib.length > 1
          ? `${cur.tagName.toLowerCase()}[${i}]`
          : cur.tagName.toLowerCase(),
      );
    }
    return "/" + seg.join("/");
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    set(".f-url", location.href);
    set(".f-xpath", xpath(el) || "—");
    set(".f-tag", tagOf(el));
    set(".f-bounds", `x=${n(r.left)} y=${n(r.top)} w=${n(r.width)} h=${n(r.height)}`);
    set(".f-scroll", `x=${n(scrollX)} y=${n(scrollY)}`);
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    set(".f-text", text.length > 400 ? text.slice(0, 400) + "…" : text || "—");
  }

  function clearTarget() {
    if (target) target.classList.remove("hilite-target");
    target = null;
  }

  function setTarget(el) {
    if (el === target) return;
    clearTarget();
    target = el;
    if (target) target.classList.add("hilite-target");
  }

  // ── lasso ─────────────────────────────────────────────────────────────────

  // Hand-drawn lassos land a few pixels short of the edge they meant to reach.
  // Without slack, being 1px short of a paragraph silently changes the answer
  // from "this paragraph" to "the three inline spans inside it" — a different
  // citation than the one that was drawn. 3px is enough for the pointer to be
  // approximate without letting a deliberate half-selection claim a whole block.
  const CONTAIN_TOL_PX = 3;

  const inside = (r, b) =>
    r.left >= b.left - CONTAIN_TOL_PX &&
    r.top >= b.top - CONTAIN_TOL_PX &&
    r.right <= b.right + CONTAIN_TOL_PX &&
    r.bottom <= b.bottom + CONTAIN_TOL_PX;

  function boxFrom(x0, y0, x1, y1) {
    return {
      left: Math.min(x0, x1),
      top: Math.min(y0, y1),
      right: Math.max(x0, x1),
      bottom: Math.max(y0, y1),
    };
  }

  // The outermost fully-contained elements with rendered text — or, when
  // nothing in the box has any, the outermost fully-contained elements
  // regardless of text. The second pass only runs on an empty first pass,
  // so every lasso that matches today matches exactly as before; the only
  // behavior change is the empty case. Without it, icon-only controls
  // (a bell button whose subtree is all `<i>` glyphs) lasso to nothing,
  // while a click on the same button cites fine — and the hover outline
  // and the lasso must agree the way hover and click already do.
  function lassoHits(x0, y0, x1, y1) {
    const hits = collectLasso(x0, y0, x1, y1, true);
    return hits.length ? hits : collectLasso(x0, y0, x1, y1, false);
  }

  function collectLasso(x0, y0, x1, y1, requireText) {
    const b = boxFrom(x0, y0, x1, y1);
    const r = root();
    if (!r) return [];
    const contained = new Set();
    for (const el of r.querySelectorAll("*")) {
      if (el.closest(`[${UI_ATTR}]`)) continue;
      const t = el.tagName;
      if (t === "SCRIPT" || t === "STYLE" || t === "LINK" || t === "META") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      if (requireText && !(el.innerText || el.textContent || "").trim()) continue;
      if (inside(rect, b)) contained.add(el);
    }
    const hits = [];
    for (const el of contained) {
      let hasContainedAncestor = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (contained.has(p)) {
          hasContainedAncestor = true;
          break;
        }
      }
      if (!hasContainedAncestor) hits.push(el);
    }
    // Reading order, so the copied list matches what the eye sees.
    return hits.sort((a, b2) => {
      const ra = a.getBoundingClientRect();
      const rb = b2.getBoundingClientRect();
      return Math.abs(ra.top - rb.top) > 3 ? ra.top - rb.top : ra.left - rb.left;
    });
  }

  function drawLasso(x0, y0, x1, y1) {
    const b = boxFrom(x0, y0, x1, y1);
    lasso.style.left = `${b.left}px`;
    lasso.style.top = `${b.top}px`;
    lasso.style.width = `${b.right - b.left}px`;
    lasso.style.height = `${b.bottom - b.top}px`;
    lasso.classList.add("show");
  }

  // The selection is the .hilite class set, not its paint. Marks stay on the
  // DOM after disarming -- that is the handle the agent reads -- but they are
  // only *visible* while body.citing is present, so disarming hides a
  // stale-looking highlight without destroying the citation.

  function setCount(k) {
    panel.querySelector(".hilite-count").textContent = k ? `${k} selected` : "";
  }

  function setGroup(no) {
    const el = panel.querySelector(".hilite-group");
    if (el) el.textContent = ` · group ${no}`;
  }

  const currentGroupEntry = () => groups.get(groupNo);
  const currentCount = () => {
    const g = currentGroupEntry();
    return g ? g.elements.length : 0;
  };

  // The head always reflects the live citation state: how many elements the
  // current group holds, and which group new selections will land in.
  function refreshHead() {
    setCount(currentCount());
    setGroup(groupNo);
  }

  function clearHilite() {
    for (const el of document.querySelectorAll(`.${MARK}`)) el.classList.remove(MARK);
    setCount(0);
  }

  // Fresh start: drop every mark and every retained group, back to group 1.
  // The E toggle calls this in both directions; Esc and API disarm preserve.
  function resetState() {
    groups = new Map();
    groupNo = 1;
    clearHilite();
    refreshHead();
  }

  // ── clipboard ─────────────────────────────────────────────────────────────

  // One metadata blob per element, captured at the moment it is cited. Because
  // a citation is retained in the report even after its .hilite mark is cleared
  // (by `n`), the report is rebuilt from this data — never re-read from the DOM.
  function elInfo(el) {
    const r = el.getBoundingClientRect();
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    return {
      el,
      xpath: xpath(el) || "—",
      tag: tagOf(el),
      bounds: `x=${n(r.left)} y=${n(r.top)} w=${n(r.width)} h=${n(r.height)}`,
      text,
    };
  }

  function currentGroup() {
    let g = groups.get(groupNo);
    if (!g) {
      g = { when: 0, url: "", scroll: { x: 0, y: 0 }, via: "", region: null, elements: [] };
      groups.set(groupNo, g);
    }
    return g;
  }

  // Add elements to the current citation group (idempotent per node) and
  // reflect them as .hilite marks. The header metadata tracks the most recent
  // selection in the group. Returns the number of newly added elements.
  function addSelection(via, region, els) {
    const g = currentGroup();
    let added = 0;
    for (const el of els) {
      if (g.elements.some((e) => e.el === el)) continue;
      el.classList.add(MARK);
      g.elements.push(elInfo(el));
      added++;
    }
    if (added) {
      g.when = Date.now();
      g.url = location.href;
      g.scroll = { x: n(scrollX), y: n(scrollY) };
      g.via = via;
      g.region = region;
    }
    refreshHead();
    return added;
  }

  // The aggregate citation: every non-empty group in group-number order.
  // Groups are numbered by their group number (not re-indexed), so a skipped
  // empty group keeps its number and the pasted report still reads (1), (2),
  // (3), … as the user cited them.
  function buildReport() {
    const lines = ["# hilite reference", ""];
    const nos = Array.from(groups.keys())
      .filter((k) => groups.get(k) && groups.get(k).elements.length)
      .sort((a, b) => a - b);
    for (const no of nos) {
      const g = groups.get(no);
      lines.push(
        `## [${no}] Citation Group`,
        "",
        `url:     ${g.url}`,
        `when:    ${new Date(g.when).toISOString()}`,
        `tool:    hilite v${VERSION}`,
        `scroll:  x=${g.scroll.x} y=${g.scroll.y}`,
        `via:     ${g.via}`,
        `region:  x=${n(g.region.left)} y=${n(g.region.top)} w=${n(g.region.right - g.region.left)} h=${n(g.region.bottom - g.region.top)}`,
        `matched: ${g.elements.length} element(s) — .hilite applied in the DOM`,
        "",
      );
      for (const e of g.elements) {
        lines.push(
          `- xpath:  ${e.xpath}`,
          `  tag:    ${e.tag}`,
          `  bounds: ${e.bounds}`,
          `  text:   ${JSON.stringify(
            e.text.length > TEXT_SNIPPET ? e.text.slice(0, TEXT_SNIPPET) + "…" : e.text,
          )}`,
        );
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  const fence = (text) => "```\n" + text.trimEnd() + "\n```";

  function presentGroupCount() {
    let c = 0;
    for (const g of groups.values()) if (g.elements.length) c++;
    return c;
  }

  function totalElementCount() {
    let t = 0;
    for (const g of groups.values()) t += g.elements.length;
    return t;
  }

  // Build the aggregate report from the retained groups, wrap it in
  // triple-backticks, and put that fenced block on the clipboard.
  async function copy() {
    const report = buildReport();
    const text = fence(report);
    const count = totalElementCount();
    const gc = presentGroupCount();
    lastCopy = { text, count, at: Date.now() };
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API needs focus + a secure context; 127.0.0.1 and localhost
      // qualify, but a blurred window or an older browser does not. The
      // textarea path is the fallback, and `last` keeps the reference
      // retrievable either way.
      const ta = ui("textarea", "hilite-fallback");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {}
      ta.remove();
    }
    flash(
      count
        ? `copied ${count} element${count === 1 ? "" : "s"} · ${gc} group${gc === 1 ? "" : "s"}`
        : "no elements cited yet — click or drag to start",
    );
  }

  let toastTimer = 0;
  function flash(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
  }

  // ── modes ─────────────────────────────────────────────────────────────────

  function arm() {
    if (armed || disabled()) return;
    armed = true;
    mount();
    document.documentElement.classList.add("hilite-armed");
    document.body.classList.add("citing"); // reveals .hilite -- see hasSelection()
    showPanel(true);
    set(".f-url", location.href);
    set(".f-xpath", "—");
    set(".f-tag", "—");
    set(".f-bounds", "—");
    set(".f-scroll", `x=${n(scrollX)} y=${n(scrollY)}`);
    set(".f-text", "hover something…");
    // A selection from before is still live, so report its true count, not 0.
    refreshHead();
  }

  function disarm() {
    if (!armed) return;
    armed = false;
    drag = null;
    clearTarget();
    document.documentElement.classList.remove("hilite-armed");
    document.body.classList.remove("citing");
    showPanel(false);
    // .hilite intentionally persists on the DOM — that is the handle for the
    // agent. Whether it is *visible* is a body.citing CSS concern, not a data
    // one.
  }

  // ── events ────────────────────────────────────────────────────────────────

  const inForm = (t) =>
    !!t &&
    (t.tagName === "INPUT" ||
      t.tagName === "TEXTAREA" ||
      t.tagName === "SELECT" ||
      t.tagName === "BUTTON" ||
      t.isContentEditable);

  document.addEventListener(
    "keydown",
    (e) => {
      if (disabled() || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape" && armed) {
        disarm();
        return;
      }
      const key = e.key.toLowerCase();
      // `n` starts the next citation group: the visible selection is cleared
      // but the retained citations stay in the report. Only while armed, and
      // never while typing. When the arm key itself is `n`, arming wins.
      if (key === "n" && key !== cfg.key && armed) {
        if (inForm(e.target) || inForm(document.activeElement)) return;
        e.preventDefault();
        nextGroup();
        return;
      }
      // Enter/Space cites whatever the hover outline is on. Mouse presses
      // never reach a disabled control — the browser suppresses mousedown,
      // mouseup and click on them entirely, so no click handler can fire —
      // but hover still tracks them, which means the outline can sit on a
      // button a click could never cite. The keyboard has no such gate, so
      // outline + Enter selects disabled buttons, disabled inputs and any
      // other element a press cannot reach. Never while typing.
      if ((key === "enter" || key === " ") && armed) {
        // Typing wins: Enter sends the message, Space types a space. But
        // silence here feels exactly like the disabled-button bug (press
        // vanishes, nothing cited), so when the outline is sitting on
        // something citable, say what to do instead of saying nothing.
        if (inForm(e.target) || inForm(document.activeElement)) {
          if (target) flash("click empty space first — then Enter cites the outline");
          return;
        }
        e.preventDefault();
        const el = selectable(target);
        if (!el) {
          flash("hover something to cite");
          return;
        }
        if (!removeFromSelection(el)) {
          const r = el.getBoundingClientRect();
          addSelection(
            "key",
            { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
            [el],
          );
        }
        copy();
        return;
      }
      if (key !== cfg.key) return;
      if (inForm(e.target) || inForm(document.activeElement)) return; // typing, not pointing
      e.preventDefault();
      // Either direction of the toggle starts fresh: closing or opening the
      // dialog clears every selection and resets to group 1.
      resetState();
      armed ? disarm() : arm();
    },
    true,
  );

  function nextGroup() {
    // Clear the visible selection (its .hilite marks); the citation data is
    // retained in `groups`, so the already-copied report still contains it.
    // The next selection starts a new group with the incremented number.
    groupNo++;
    clearHilite();
    refreshHead(); // show the new (empty) group
    flash(`group ${groupNo} — selection cleared`);
  }

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!armed) return;
      const { clientX: x, clientY: y } = e;
      place(x, y);
      if (drag) {
        if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) > DRAG_THRESHOLD_PX)
          drag.moved = true;
        if (drag.moved) {
          drag.x = x;
          drag.y = y;
          drawLasso(drag.x0, drag.y0, x, y);
        }
        return;
      }
      const el = document.elementFromPoint(x, y);
      if (!el || el.closest(`[${UI_ATTR}]`)) return;
      setTarget(el);
      describe(el);
    },
    true,
  );

  // Bounds are viewport-relative, so a scroll while armed makes the panel lie;
  // re-measure rather than let it drift.
  document.addEventListener(
    "scroll",
    () => {
      if (!armed) return;
      set(".f-scroll", `x=${n(scrollX)} y=${n(scrollY)}`);
      if (target) describe(target);
    },
    true,
  );

  // A click while armed is a gesture in our tool, never in the app: stop the
  // SPA from navigating out from under the citation.
  // A click toggles one element in/out of the current citation group and
  // copies the aggregate report. Clearing the whole group is right-click's
  // job (`n` clears the marks while advancing the group).
  // A click cites whatever the panel describes: any real element with a
  // measurable box. The hover outline and the click must agree — describing
  // an element the click then refuses with "nothing to select here" is the
  // bug. So there is no text requirement (icon buttons cite fine with an
  // empty `text`) and no lasso-root scoping here; the root knob scopes the
  // lasso, not the single-element fast path.
  //
  // The click prefers the hovered element over the click point, with a few
  // pixels of grace: a press that starts on a pill button and releases 2px
  // off its rounded corner (or a live re-layout that shifts the button
  // under a stationary cursor) still cites the outlined control the user
  // was looking at, instead of the giant row behind it.
  //
  // The preference walks UP, not down: the outline is often on a glyph
  // inside the control (`i` in `button`), and the point lands on the
  // control's own padding — inside the button's box but outside the
  // glyph's. The walk stops past a real control, so text elements still
  // resolve to whatever is actually under the point. A click genuinely
  // elsewhere misses every chain box and cites the point — the grace is
  // a bound on the outline's authority, not a fallback.
  const CLICK_GRACE_PX = 4;
  const CLICK_CHAIN_DEPTH = 2;
  const selectable = (el) => {
    if (!(el instanceof Element) || el.closest(`[${UI_ATTR}]`)) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return el;
  };

  document.addEventListener(
    "click",
    async (e) => {
      if (!armed) return;
      if (e.target.closest(`[${UI_ATTR}]`)) return;
      e.preventDefault();
      e.stopPropagation();
      // The trailing click of a lasso is not a new selection.
      if (lassoJustFinished) {
        lassoJustFinished = false;
        clearTimeout(lassoFlagTimer);
        return;
      }
      // Prefer the element the hover outline is on -- that is the one the user
      // is aiming at -- and fall back to hit-testing the click point. The
      // outline wins only while the point is still on it (plus grace): a
      // stale outline from before a scroll or a long move must not override
      // a click that genuinely landed elsewhere.
      //
      // The walk ascends past the outline itself because the outline is
      // often on a glyph inside the control (`i` in `button`) while the
      // point lands on the control's own padding. Past the control the
      // walk stops: text elements ascend to whatever merely contains
      // them, and the point's own element is the better answer there.
      const CONTROL_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab"]);
      const nearChain = (el, x, y) => {
        let node = el instanceof Element ? el : null;
        for (let d = 0; d <= CLICK_CHAIN_DEPTH && node; d++) {
          const tag = node.tagName;
          if (d > 0 && !(tag === "BUTTON" || tag === "A" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || tag === "LABEL" || tag === "SUMMARY" || CONTROL_ROLES.has(node.getAttribute && node.getAttribute("role")))) {
            break;
          }
          const r = node.getBoundingClientRect();
          const m = CLICK_GRACE_PX;
          if (x >= r.left - m && x <= r.right + m && y >= r.top - m && y <= r.bottom + m) {
            const hit = selectable(node);
            if (hit) return hit;
          }
          node = node.parentElement;
        }
        return null;
      };
      const el =
        nearChain(target, e.clientX, e.clientY) ??
        selectable(document.elementFromPoint(e.clientX, e.clientY));
      if (!el) {
        flash("nothing to select here");
        return;
      }
      if (!removeFromSelection(el)) {
        const r = el.getBoundingClientRect();
        addSelection(
          "click",
          { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
          [el],
        );
      }
      await copy();
    },
    true,
  );

  document.addEventListener(
    "mousedown",
    (e) => {
      if (!armed || e.button !== 0) return;
      if (e.target.closest(`[${UI_ATTR}]`)) return; // panel is interactive; don't lasso from it
      e.preventDefault();
      // A fresh press supersedes any unconsumed flag, so a click that never
      // fired cannot swallow this gesture.
      lassoJustFinished = false;
      clearTimeout(lassoFlagTimer);
      drag = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false };
    },
    true,
  );

  document.addEventListener(
    "mouseup",
    async (e) => {
      if (!armed || !drag) return;
      const d = drag;
      drag = null;
      if (!d.moved) return; // a plain click: the click handler owns that case
      lasso.classList.remove("show");
      const hits = lassoHits(d.x0, d.y0, e.clientX, e.clientY);
      // Guard the click the browser is about to fire for this same drag.
      lassoJustFinished = true;
      clearTimeout(lassoFlagTimer);
      lassoFlagTimer = setTimeout(() => {
        lassoJustFinished = false;
      }, 350);
      if (!hits.length) {
        flash("lasso matched nothing — click to cite");
        return;
      }
      // Accumulate: earlier selections in this group keep their marks.
      addSelection("lasso", boxFrom(d.x0, d.y0, e.clientX, e.clientY), hits);
      await copy();
    },
    true,
  );

  // ── handle ────────────────────────────────────────────────────────────────

  window.hilite = {
    version: VERSION,
    init(options = {}) {
      if (options.root !== undefined) cfg.root = options.root;
      if (options.key) cfg.key = String(options.key).toLowerCase();
      if (options.enabled !== undefined) {
        cfg.enabled = !!options.enabled;
        localStorage.setItem("hilite", cfg.enabled ? "1" : "0");
        if (!cfg.enabled) disarm();
      }
      return window.hilite;
    },
    on: arm,
    off: disarm,
    clear: clearHilite,
    setEnabled(on) {
      cfg.enabled = !!on;
      localStorage.setItem("hilite", cfg.enabled ? "1" : "0");
      if (!cfg.enabled) disarm();
    },
    get enabled() {
      return cfg.enabled;
    },
    get armed() {
      return armed;
    },
    get last() {
      return lastCopy;
    },
    get group() {
      return groupNo;
    },
    report: () => buildReport(),
    reset() {
      resetState();
      return window.hilite;
    },
    hilited: () => Array.from(document.querySelectorAll(`.${MARK}`)).map(xpath),
    selected: () => document.querySelectorAll(`.${MARK}`).length,
    help: () =>
      `press ${cfg.key.toUpperCase()} to arm or disarm — either direction clears all selections ` +
      `and resets to group 1. Hover for a reference. A click toggles the hovered element in/out ` +
      `of the current citation group (Enter/Space cites it too — the only way to cite a ` +
      `disabled control, whose clicks the browser swallows), a lasso adds its matches, and the aggregate triple-backticked ` +
      `report goes to the clipboard. Right-click clears the current group's selection. Press N while ` +
      `armed to clear the visible marks and start the next group (citations are retained in the ` +
      `report). Esc disarms but keeps the current group's marks on the DOM, hidden (E re-arms ` +
      `fresh). window.hilite.last holds the last copy; window.hilite.report() rebuilds the ` +
      `(unfenced) report.`,
  };

  if (cfg.enabled)
    console.info(
      `hilite v${VERSION}: press ${cfg.key.toUpperCase()} to inspect and cite, N for the next citation ` +
        "group, Esc to exit. window.hilite for the API.",
    );
  else
    console.info(
      `hilite v${VERSION} is disabled on this origin (localStorage "hilite" is "0"). ` +
        "window.hilite.setEnabled(true) to re-enable.",
    );
})();

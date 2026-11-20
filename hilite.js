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
//   E            arm / disarm (ignored while a form control has focus)
//   Esc          disarm
//   hover        outline the candidate + fill the reference panel
//   click        no selection: cite the hovered element.
//                selection present: clear every .hilite mark
//   click+drag   lasso; the outermost fully-contained elements get .hilite
//                and a plaintext reference block goes to the clipboard
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

  const VERSION = "1.0.0";
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
    '<div class="hilite-head"><span>hilite</span><b class="hilite-count"></b></div>' +
    '<dl class="hilite-dl">' +
    '<div><dt>url</dt><dd class="f-url"></dd></div>' +
    '<div><dt>xpath</dt><dd class="f-xpath"></dd></div>' +
    '<div><dt>element</dt><dd class="f-tag"></dd></div>' +
    '<div><dt>bounds</dt><dd class="f-bounds"></dd></div>' +
    '<div><dt>scroll</dt><dd class="f-scroll"></dd></div>' +
    '<div><dt>text</dt><dd class="f-text"></dd></div>' +
    "</dl>" +
    '<div class="hilite-hint">click&nbsp;=&nbsp;clear &nbsp;·&nbsp; drag&nbsp;=&nbsp;lasso+copy</div>';

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

  // The outermost fully-contained elements with rendered text.
  function lassoHits(x0, y0, x1, y1) {
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
      if (!(el.innerText || el.textContent || "").trim()) continue;
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
  const hasSelection = () => document.querySelectorAll(`.${MARK}`).length > 0;

  function setCount(k) {
    panel.querySelector(".hilite-count").textContent = k ? `${k} selected` : "";
  }

  function clearHilite() {
    for (const el of document.querySelectorAll(`.${MARK}`)) el.classList.remove(MARK);
    setCount(0);
  }

  // ── clipboard ─────────────────────────────────────────────────────────────

  function reference(hits, b, via) {
    const lines = [
      "hilite reference",
      `url:     ${location.href}`,
      `when:    ${new Date().toISOString()}`,
      `tool:    hilite v${VERSION}`,
      `scroll:  x=${n(scrollX)} y=${n(scrollY)}`,
      `via:     ${via}`, // lasso | click
      `region:  x=${n(b.left)} y=${n(b.top)} w=${n(b.right - b.left)} h=${n(b.bottom - b.top)}`,
      `matched: ${hits.length} element(s) — .hilite applied in the DOM`,
      "",
    ];
    hits.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      lines.push(
        `[${i + 1}] xpath:  ${xpath(el)}`,
        `    tag:    ${tagOf(el)}`,
        `    bounds: x=${n(r.left)} y=${n(r.top)} w=${n(r.width)} h=${n(r.height)}`,
        `    text:   ${JSON.stringify(
          text.length > TEXT_SNIPPET ? text.slice(0, TEXT_SNIPPET) + "…" : text,
        )}`,
        "",
      );
    });
    return lines.join("\n");
  }

  async function copy(text, count) {
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
        ? `copied ${count} reference${count === 1 ? "" : "s"}`
        : "lasso matched nothing — click to clear",
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
    setCount(document.querySelectorAll(`.${MARK}`).length);
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
      if (e.key.toLowerCase() !== cfg.key) return;
      if (inForm(e.target) || inForm(document.activeElement)) return; // typing, not pointing
      e.preventDefault();
      armed ? disarm() : arm();
    },
    true,
  );

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
  // A click is one gesture with two meanings, decided by whether a selection
  // already exists: with marks present it is "clear"; with none it is "take
  // this one element", which is the fast path for citing a single field and
  // the reason a hover outline exists at all.
  const selectable = (el) => {
    if (!(el instanceof Element) || el.closest(`[${UI_ATTR}]`)) return null;
    const r = root();
    if (!r || !r.contains(el)) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    if (!(el.innerText || el.textContent || "").trim()) return null;
    return el;
  };

  document.addEventListener(
    "click",
    async (e) => {
      if (!armed) return;
      if (e.target.closest(`[${UI_ATTR}]`)) return;
      e.preventDefault();
      e.stopPropagation();
      // The trailing click of a lasso is neither a clear nor a new selection.
      if (lassoJustFinished) {
        lassoJustFinished = false;
        clearTimeout(lassoFlagTimer);
        return;
      }
      if (hasSelection()) {
        clearHilite();
        flash("cleared");
        return;
      }
      // Prefer the element the hover outline is on -- that is the one the user
      // is aiming at -- and fall back to hit-testing the click point.
      const el =
        selectable(target) ?? selectable(document.elementFromPoint(e.clientX, e.clientY));
      if (!el) {
        flash("nothing to select here");
        return;
      }
      const r = el.getBoundingClientRect();
      el.classList.add(MARK);
      setCount(1);
      await copy(
        reference([el], { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, "click"),
        1,
      );
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
      // fired cannot swallow this gesture's clear.
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
      clearHilite();
      for (const el of hits) el.classList.add(MARK);
      setCount(hits.length);
      // Guard the click the browser is about to fire for this same drag.
      lassoJustFinished = true;
      clearTimeout(lassoFlagTimer);
      lassoFlagTimer = setTimeout(() => {
        lassoJustFinished = false;
      }, 350);
      await copy(
        reference(hits, boxFrom(d.x0, d.y0, e.clientX, e.clientY), "lasso"),
        hits.length,
      );
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
    hilited: () => Array.from(document.querySelectorAll(`.${MARK}`)).map(xpath),
    selected: () => document.querySelectorAll(`.${MARK}`).length,
    help: () =>
      `press ${cfg.key.toUpperCase()} to arm; hover for a reference; with no selection a click cites ` +
      "the hovered element (marks it .hilite and copies a reference), and with a selection a click " +
      "clears it; click+drag lassos, marks .hilite and copies. Marks stay on the DOM when disarmed " +
      "but are hidden until you re-arm. window.hilite.last holds the last copy.",
  };

  if (cfg.enabled)
    console.info(
      `hilite v${VERSION}: press ${cfg.key.toUpperCase()} to inspect and cite, Esc to exit. window.hilite for the API.`,
    );
  else
    console.info(
      `hilite v${VERSION} is disabled on this origin (localStorage "hilite" is "0"). ` +
        "window.hilite.setEnabled(true) to re-enable.",
    );
})();

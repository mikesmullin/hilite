# hilite

A single-file DOM inspector for citing UI regions back to an agent. Drop it on
any page, press **E**, and point: hover shows a reference card, click cites
one element, click+drag lassos a region. Every citation is copied to your
clipboard as one fenced block holding every citation group (press **N** to
start the next group) **and** a set of `.hilite` marks is left on the DOM for
the agent to read back.

No build, no dependencies, no framework — one `<script>` tag:

```html
<script src="https://mikesmullin.github.io/hilite/hilite.js?v=1.1.0"
        data-hilite-root="#app"></script>
```

Cloud-hosted from this repo's GitHub Pages, or vendor a copy of `hilite.js` if
the page must work offline. The script injects its own CSS, so nothing else
from this repo is needed. Bump the `?v=` on the hosted URL whenever the module
changes, so browsers don't keep serving a cached older generation.

## Usage

| gesture            | effect                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------- |
| `E`                | arm / disarm. Ignored while a form control has focus, so typing is never hijacked.       |
| `Esc`              | disarm                                                                                   |
| hover              | outline the candidate and fill the reference panel: url, xpath, tag, bounds, scroll, text |
| click              | cite the hovered element into the current citation group — marks it `.hilite` and copies the aggregate fenced report |
| `n` (while armed)  | clear the current selection and start the next citation group — citations already made are retained in the report |
| click + drag       | lasso — the *outermost fully-contained* elements are added to the current group, marked `.hilite`, and the aggregate report goes to the clipboard |

The marks of the *current* group survive disarming: that is the handle an
agent reads with `document.querySelectorAll(".hilite")` or
`window.hilite.hilited()`. They are only *visible* while armed, so a stale
selection never paints on a page nobody is inspecting. Press `n` to clear the
visible marks and move on — the citations stay in the copied report.

## The reference

What the clipboard receives: one triple-backticked block with every citation
group, numbered so you can paste it once and refer to `(1)`, `(2)`, `(3)`, …

````
```
# hilite reference

## [1] Citation Group

url:     https://example.com/chat
when:    2026-11-17T15:38:19.221Z
tool:    hilite v1.1.0
scroll:  x=0 y=412
via:     click
region:  x=48 y=210 w=520 h=96
matched: 1 element(s) — .hilite applied in the DOM

- xpath:  //*[@id="transcript"]/div[2]
  tag:    div.bubble
  bounds: x=48 y=210 w=520 h=96
  text:   "The spike correlates with the model list fetch…"

## [2] Citation Group

url:     https://example.com/chat
when:    2026-11-17T15:38:26.400Z
tool:    hilite v1.1.0
scroll:  x=0 y=412
via:     lasso
region:  x=48 y=320 w=520 h=120
matched: 2 element(s) — .hilite applied in the DOM

- xpath:  //*[@id="models"]/tbody/tr[2]
  tag:    tr
  bounds: x=48 y=320 w=520 h=60
  text:   "h2o-mini 32 768 21 ms 212"
- xpath:  //*[@id="models"]/tbody/tr[3]
  tag:    tr
  bounds: x=48 y=380 w=520 h=60
  text:   "gate-3b 8 192 9 ms 390"
```
````

Repeated clicks/lassos accumulate in the current group; press `n` while armed
to clear the visible selection and start the next group. Each group's header
(`via`, `region`, `when`) tracks its most recent addition, and every element
carries its own `bounds`.

## Configuration

Data attributes on the script tag:

| attribute             | default                                    |
| --------------------- | ------------------------------------------ |
| `data-hilite-root`    | `#app` if present, else `body`             |
| `data-hilite-key`     | `e`                                        |
| `data-hilite-enabled` | `0` disables (also `localStorage.hilite`)  |

Or at runtime:

```js
window.hilite.init({ root: "#main", key: "h" });
window.hilite.on();            // arm
window.hilite.off();           // disarm
window.hilite.clear();         // remove every .hilite mark (retained citations stay in the report)
window.hilite.reset();         // clear marks, drop all groups, back to group 1
window.hilite.group;           // current citation group number
window.hilite.report();        // rebuild the (unfenced) aggregate report
window.hilite.hilited();       // [xpaths of the marked elements]
window.hilite.selected();      // count
window.hilite.last;            // { text, count, at } of the last copy (text is the fenced block)
window.hilite.setEnabled(true) // persist across reloads
window.hilite.help();
```

## Theming

The injected CSS is namespaced under `--hl-*` tokens, each with a fallback
chain into common host tokens (`--panel`, `--border`, `--text`, `--muted`,
`--accent`, `--ok`, `--mono`, `--sans`). A page that defines those gets a
matching inspector for free; define `--hl-*` (e.g. `--hl-mark` for the
highlight colour) to override.

## How it works

- **Outermost fully-contained.** A lasso marks elements whose *parent* is not
  inside the lasso. Marking everything contained would paint a card and every
  paragraph and inline span in it as one solid block; one band per top-level
  thing is what a reader means by "these paragraphs". A 3&nbsp;px containment
  tolerance absorbs hand-drawn imprecision without letting a deliberate
  half-selection claim a whole block.
- **The click after a drag is swallowed.** `mouseup` fires before the trailing
  `click`, so a one-shot flag keeps the lasso's click from becoming a second
  citation for the same gesture.
- **Citations are grouped and retained.** Each click/lasso appends to the
  current group; `n` clears the visible marks and advances the group number.
  The report is rebuilt from the retained per-element data — never re-read
  from the live DOM — so a cleared group still renders exactly as cited.
- **Clipboard with a fallback.** `navigator.clipboard` needs a secure context
  and focus; a textarea + `execCommand` path covers the rest, and
  `window.hilite.last` keeps the reference retrievable either way.

## Files

| file           | what it is                                             |
| -------------- | ------------------------------------------------------ |
| `hilite.js`    | the module — the only file a host page needs           |
| `index.html`   | the live demo (this site)                              |
| `LICENSE`      | MIT                                                    |

## License

MIT — see [LICENSE](LICENSE).

# promo/website

The MultiZone promotional site. Five pages, no build step — open `index.html` in a
browser, or serve the directory with anything static.

```
python -m http.server -d promo/website 8080      # then http://localhost:8080
```

## Pages

| Mark | File | Movement |
|---|---|---|
| A | `index.html` | Title page, the six-zone panel, the tutti, install |
| B | `multizone.html` | *Divisi* — the Response Leader, teamwork, the Code Team |
| C | `tools.html` | *Apparatus* — web tools, terminals, replay, voice, MCP, API |
| D | `appearance.html` | *Colore* — the background effects, palette, custom CSS |
| E | `privacy.html` | *Sotto voce* — privacy and the honest limits |

Design decisions live in [DESIGN.md](DESIGN.md); product truth in
[../../PRODUCT.md](../../PRODUCT.md). Read DESIGN.md before changing the look — the
score structure and the app-matched finish are both deliberate.

## What is real and what is not

**Real:** `assets/img/app-dark.png` and `app-light.png` are unretouched captures of the
app in perspective mode. `assets/img/mark.png` is the app icon. Every capability,
tool name, setting path, limitation and version number traces to the repository README.

**Synthetic, and labelled as such on the page:** every model transcript. The panel on
`index.html`, the Response Leader's call tree on `multizone.html`, the search results and
terminal session and replay on `tools.html` are all written for the site. They are
written to be *representative*, not aspirational — no capability is shown that the app
does not have.

**Never invent:** users, testimonials, press, benchmark numbers, pricing, or a company.
There are none, and the page says so where it matters.

## Before publishing — check these

- [ ] **The repository is public.** Every download and source link points at
      `https://github.com/JammingDino/MultiZone2`. That repository is currently private;
      until it is public these links 404 for visitors. Change them, or publish the repo.
- [ ] **The version.** `v0.15.7` appears in the title-page meta row on `index.html`, in
      the plate number (`M.Z. 0·15·7`) in every footer, and in the limits list on
      `privacy.html`. It must track `package.json`.
- [ ] **`og:image`** is a relative path. Make it absolute once the site has a domain, or
      link previews will not render.

## Structure

```
assets/
  score.css      tokens, score furniture, masthead, shared blocks   (all pages)
  home.css       title page, the tutti, contents, close             (all pages)
  stream.css     the full-bleed band + the app's `.markdown`, ported (index)
  divisi.css     movement heads, call tree, claims, roster, attacca (B–E)
  pages.css      RRF, terminal, replay, effect gallery, limits      (C–E)

  score.js       house lights, reveal, nav, scroll-spy, window.MZ helpers
  effects.js     the background engine; window.MZFX.mount(canvas, opts)
  appstream.js   the six-zone panel + the markdown renderer (window.MZMD)
  resolve.js     the tutti
  divisi.js      the call tree + claim_files
  apparatus.js   the RRF fan-out + terminal + replay
  colore.js      the effect gallery
```

`effects.js` is a web port of the app's `src/components/BackgroundEffect.tsx` — eight of
its thirteen effects, with the same Speed / Density / Opacity / Hue-variation controls.
If the app gains an effect, this is where to add it: one `draw*()` function and one entry
in `MZFX.list`.

`stream.css`'s `.mdx` rules mirror `.markdown` in `src/styles.css`. If the app's message
rendering changes, change them together — the whole point of that section is that it
matches.

## Behaviour worth knowing

- **House lights** (top right) swaps the app's dark and light themes, and the real
  screenshots swap with it. The choice persists in `localStorage`;
  `prefers-color-scheme` decides the first visit.
- **`prefers-reduced-motion: reduce`** settles every demo to its final state at once,
  draws each canvas one frame and stops, and removes every caret. Nothing is hidden
  behind a motion gate.
- Every canvas pauses when off-screen or the tab is hidden.
- Demos start when scrolled into view and can be replayed from their own controls.

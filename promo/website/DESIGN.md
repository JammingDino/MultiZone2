# Design — MultiZone promotional site

<!-- Scope: promo/website/ only. The MultiZone application has its own visual
     system (src/styles.css); this surface inherits it directly rather than
     inventing a marketing look beside it. Product truth lives in /PRODUCT.md. -->

## The world

**The conductor's full score, rendered in the app's own register.**

A full score is the only notation humans built to display several independent voices
sounding at the same instant — stacked staves, locked to one barline, read down as well
as across. That is perspective mode. The rest of the product is already in the grammar:
only the conductor holds every stave while each player sees one part (a sub-agent cannot
read another's transcript; the Response Leader can). Seven zones on one model at seven
temperatures is a section playing one line at seven dynamics. *Divisi* is
`spawn_subagent`. *Tutti* is the synthesised answer. A zone that stays quiet is *tacet*.

The score supplies the **structure**: staves, barlines, the brace, rehearsal marks A–E
as the site's addresses, dynamics for temperature, expression marks in the margin,
*attacca* between pages. The app supplies the **finish**: its exact palette, its
`#4f9cf9` accent, its bloom, its live cursor-reactive background effects, its markdown
rendering. Not an engraved print plate — MultiZone lets people repaint the whole
interface and run a flock of boids behind their chat, and a page about it that reads as
fine typography is describing a different product.

The anti-reference is the dev-tool template this category always ships: near-black page,
one neon accent, glowing gradient orbs, a floating browser-chrome screenshot, a bento
grid of feature cards. This page is near-black and that is where it stops: its rules are
*staves*, its colour is six inks owning whole regions, its hero is the product actually
running rather than a picture of it, and its background is the app's own effect engine.

## Colour

Full palette: one accent plus six named voice roles, on the app's dark ground.
Justified by product truth — the app colours each zone, and the panel demo needs six
distinguishable simultaneous speakers.

```
--hall       #07080b   page ground          --ink        #e4e6eb   (app --color-text)
--hall-deep  #040507   recessed             --ink-dim    #a2a8b4
--plate      #0d0f14   panels               --ink-quiet  #8b929e   (app --color-text-muted)
--plate-lift #14171c   (app --color-panel)  --ink-faint  #5c636f
--plate-hi   #1c212a                        --rule       #2d333d   (app --color-border)
                                            --rule-soft  #21262e
--accent     #4f9cf9   the app's accent, exactly. Leads everything: primary actions,
                       rehearsal marks, the Response Leader, the user's message bubble,
                       every focus ring, the bloom.
```

The six voice inks, one per model in the panel demo:

```
--v-claude   #e2915a      --v-deepseek #4f9cf9
--v-gpt      #2fd08a      --v-kimi     #f06aa0
--v-gemini   #8b8cf9      --v-glm      #35d6c8
```

Each has a `-lit` variant for names on dark. A voice ink is never used for a
conductor/leader element — the leader is always `--accent` — so a reader can tell "one
of the panel" from "the one resolving the panel" without a label.

**House lights up** swaps the whole set for the app's real light theme (`#2f80ed`
accent, white panels), and the screenshots swap with it. Default is down;
`prefers-color-scheme: light` raises them on a first visit; an explicit choice persists
in `localStorage` and always wins.

**Bloom** is ported from `html.bloom` in the app: accent-filled controls and focused
frames *emit*. It marks state, not structure.

## Type

| Role | Face | Use |
|---|---|---|
| Display | **Bricolage Grotesque** | Movement titles, section heads, contents. Bold, wide, opinionated — carrying the expressiveness the app's appearance settings exist for. |
| UI &amp; body | **Inter** | Everything else. This is MultiZone's own default UI face; the site is set in it so the page and the product read as one thing. |
| Apparatus | **JetBrains Mono** | Tool names, zone ids, API paths, code, plate numbers, terminal output. |
| Marks | **Bodoni Moda italic** | *Only* `.espress` and `.dyn` — expression and dynamic marks. These are engraved italics in every score ever printed and read as nothing else. Loaded italic-only. |

Fallback stacks are mandatory: the site is opened from disk as often as from a host.
Never set Bricolage below 15px.

## Composition

- **The system** — a `--margin-w: 132px` left margin of rubrics against a hairline,
  then the content. Below 900px it folds above the content, keeping the rubric and its
  rehearsal mark.
- **Staves** — five 1px `--rule` lines at 8px pitch via `repeating-linear-gradient`.
- **Barlines** — a vertical rule crossing a system; a turn boundary.
- **The brace** — an SVG bracket joining the leader to its sub-agents on `multizone`.
- **Rehearsal marks** — boxed capitals `A`–`E`, one per page. They *are* the navigation;
  the current one inverts and blooms. In-page sections carry a rubric and a bar number,
  never a competing letter.
- **Plate number** — `M.Z. 0·15·7` bottom-left of every page, the way a publisher stamps
  a plate. It is the version and must track `package.json`.
- **The bracket** — a 2–3px voice-coloured left edge marking a region as belonging to
  one voice. It is the score's own device, used consistently for that one meaning, and
  is the single exception to the usual "no coloured left borders" rule.
- Radius 8px on panels, 5px on controls — the app's, not a print plate's.
- Spacing: `--pad-y: clamp(56px, 6.4vw, 106px)`. More space above a heading than below.

## Motion

- **The ambient layer is the app's own background effect**, ported to canvas in
  `assets/effects.js` — eight of the thirteen, with the same four controls (Speed,
  Density, Opacity, Hue variation) and the same cursor reaction. Each page picks one at
  low opacity; the Colore page runs a full-size stage with the real controls, and can
  push the visitor's choice behind the whole page.
- **Streaming is the signature.** The panel band re-parses the markdown *prefix*
  received so far and re-renders, which is what the app's `StreamingMarkdown` does.
  Models emit bursts, not characters, and each zone types at its own rate.
- **Reveal** — `.rise` (translate + fade) and `.draw` (a retracting cover; never a
  `clip-path` on the observed element, which zeroes its area and deadlocks the
  IntersectionObserver that was meant to un-clip it).
- `prefers-reduced-motion: reduce` settles every demo to its final state immediately,
  stops all canvas loops after one frame, and removes every caret. Content is visible by
  default; animation only ever modifies an already-rendered element.
- Every canvas pauses when off-screen or the tab is hidden.

## Rules

- Every claim traces to `/PRODUCT.md`. **No invented users, testimonials, press,
  pricing, benchmarks, or company.** Model names are used as configuration examples only;
  no capability is attributed to a named model that the panel transcript does not
  itself show, and the transcripts are synthetic.
- **Every synthetic transcript carries a `.synthetic` label in its own section.**
- Screenshots are real captures at full fidelity — no fake browser chrome, no
  perspective tilt, no gradient mask.
- State a limit next to the capability it belongs to. Windows-only, pre-1.0, plain-text
  keys, pipes-not-a-PTY, no headless browser, no diarization: page content, not fine
  print. Movement E is entirely this.
- Icons are hand-drawn inline SVG in the world's grammar. No icon-set tiles, no glass,
  no gradient orbs.
- No build step. Hand-authored HTML/CSS/JS; Google Fonts with real fallbacks.

## Structure

| Mark | Page | Movement | Live demo |
|---|---|---|---|
| A | `index.html` | Title page, the panel, the tutti | Six zones streaming app-formatted markdown; the leader resolving them |
| B | `multizone.html` | *Divisi* — the Response Leader | A stepped call tree; `claim_files` refusing a write |
| C | `tools.html` | *Apparatus* — what a zone reaches | Seven-engine RRF fan-out; a live terminal; a scrubbable replay |
| D | `appearance.html` | *Colore* — the finish | Eight background effects with the app's four sliders |
| E | `privacy.html` | *Sotto voce* — privacy and limits | — |

Each page ends with an **attacca** block leading to the next.

## Files

```
index.html  multizone.html  tools.html  appearance.html  privacy.html
assets/
  score.css      tokens, score furniture, masthead, shared blocks   (all pages)
  home.css       title page, the tutti, contents, close             (all pages)
  stream.css     the full-bleed band and the ported `.markdown`     (index)
  divisi.css     movement heads, call tree, claims, roster, attacca (B–E)
  pages.css      RRF, terminal, replay, effect gallery, limits      (C–E)
  score.js       lights, reveal, nav, scroll-spy, MZ helpers        (all pages)
  effects.js     the background engine + MZFX.mount                 (all pages)
  appstream.js   the panel band + the markdown renderer (window.MZMD)
  resolve.js     the tutti
  divisi.js      call tree + claim_files
  apparatus.js   RRF + terminal + replay
  colore.js      the effect gallery
  img/           real app captures and the mark
```

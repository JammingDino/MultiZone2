# Test strategy for the open 1.0.0 items

[TEST_CHECKLIST.md](TEST_CHECKLIST.md) is the manual pass. This file is about
the six 1.0.0 items that a manual pass cannot honestly close, and what it would
take to close each one for real.

## Where we start from

- **37 Rust files carry `#[cfg(test)]` tests.** `cargo test --lib` is a real
  suite and it is not run by CI.
- **No frontend test runner.** No vitest, no jest, no Playwright in
  `package.json` — the Playwright work in 0.12.3 was ad-hoc via `npx`.
- **CI is release-only.** [release.yml](../.github/workflows/release.yml) builds
  NSIS on `windows-latest` when `releaseBuild` is true. There is no job that
  runs on an ordinary push, so nothing is verified between releases.
- **A build publishes.** The release path is push-to-main, which is why any
  updater test that uses the real pipeline is also a public release.

The cheapest thing on this page, and the prerequisite for the rest: **a CI job
that runs `npm run build` and `cargo test --lib` on every push.** It costs
minutes and it catches the class of bug the checklist's own preamble names —
"most of what has broken here compiled cleanly first."

---

## 1 · Performance

> *measure and optimize startup time, first message render, large chat (500+ messages) scroll*

The blocker is not optimisation, it is that no number has ever been taken. The
item cannot be ticked because there is nothing to compare against.

**Seed data.** A dev-only Tauri command (or a Rust integration test writing the
same SQLite file) that generates a synthetic chat: N messages, a stated mix of
plain answers, tool steps, code blocks and diagrams. Deterministic from a seed,
so two runs measure the same thing. Sizes 50 / 500 / 2000.

**Startup.** Three marks, emitted to the log on every launch behind a setting:
process start → first paint → thread interactive. Tauri knows process start; the
boot splash already brackets the second one. Report the median of 10 cold
launches after a reboot, and 10 warm.

**First message render.** Time from send to first token painted, against the
mock provider below so the network is not in the measurement.

**Scroll.** The built frontend runs in a browser harness with `window.__TAURI__`
mocked — the same harness 0.12.3 used. Drive it with Playwright, sample
`requestAnimationFrame` deltas during a programmatic scroll of the 500- and
2000-message chats, report median and 95th-percentile frame time. Long-list
virtualisation is the open work; this is how you find out whether it is needed
at 500 or only at 2000.

**Write the thresholds down before measuring**, or the first numbers become the
target by default. Suggested: cold start to interactive under 2.5s, first token
under 150ms after the provider's first byte, 95th-percentile frame time under
20ms while scrolling 500.

**Effort:** the harness and seeder are a day; they are also reused by items 2
and 5.

---

## 2 · Streaming under sustained use

> *verify no dropped tokens or UI lag under sustained use*

"No dropped tokens" cannot be established by watching, which is why this item
has sat open. It can be established exactly, and cheaply.

**A mock provider.** ~100 lines of Node speaking the OpenAI-compatible SSE
shape, streaming a *known* sequence — numbered tokens, `0001 0002 0003 …` — at a
configurable rate, with configurable pauses, tool calls interleaved, and
optional mid-stream failures. Add it as an ordinary provider pointing at
localhost.

**The assertion.** After the stream, read the stored message and compare against
the generated sequence. A gap is a dropped token, named by index. This turns an
unfalsifiable claim into a diff.

**What to run against it:**

| Scenario | What it catches |
| --- | --- |
| 100k tokens, single chat | The base case, and the throttle's behaviour under sustained load |
| 7 concurrent zones, 20k each | Perspective and panel streaming — the case with the most moving parts |
| Stream + interleaved tool calls | The pending-args path, which has its own renderer |
| Chat switch mid-stream | 🔁 the crossover regression the checklist already tracks |
| Stop mid-stream, resume | Cancellation leaving the buffer consistent |
| 30-minute soak, memory sampled | Leaks and the drift the "sustained use" wording is really about |

The mock also unblocks CI: none of this needs a real provider, a key, or the
network, so it can run on every push.

**Effort:** the mock is half a day, the scenarios another day. Highest value per
hour on this page.

---

## 3 · Installers for macOS and Linux

> *Installer: Windows (NSIS or WiX), macOS (DMG), Linux (AppImage)*

This is not a testing problem and should stop being filed as one. Windows ships
today. The other two are a distribution project:

- **macOS** — a DMG that is not signed and notarised gets a Gatekeeper block
  that most users read as "broken", not "unsigned". Notarisation needs an Apple
  Developer account at $99/year and a signing identity in CI. Building on
  `macos-latest` is easy; shipping something a stranger can open is the cost.
- **Linux** — AppImage builds on `ubuntu-22.04` with webkit2gtk dev packages.
  The distribution question is milder, but glibc pins the AppImage to that
  baseline and older distributions will refuse it.
- **Private repo** — GitHub's macOS runners bill at a multiplier on private
  repos. Budget it before turning the matrix on.

**The realistic 1.0 options**, in order of preference:

1. **Ship Windows, document the rest.** 1.0 is Windows; macOS and Linux move to
   1.1 with the signing work sized properly. Honest, and it matches where the
   testing capability actually is.
2. **Build all three, ship two as "unverified".** Matrix the workflow, publish
   the DMG and AppImage with an explicit note on the Gatekeeper step. Costs
   little, sets expectations badly.
3. **Do the signing work now.** Only if someone is going to own an Apple
   Developer account.

**What is testable regardless:** a build-and-launch smoke job per platform —
build, launch the binary (`xvfb-run` on Linux), assert the process survives 30
seconds and the log shows the database initialised. That is a genuine CI signal
and it is the same three lines on every runner.

---

## 4 · Auto-updater end to end

> *two blockers: the signing secrets, and verification needs two successive builds*

The second blocker is only real if the test uses the release pipeline — where a
build is a publish. It does not have to.

**Local end-to-end, fully offline:**

1. `tauri signer generate` a throwaway keypair; point a scratch
   `tauri.conf.json` at its public half.
2. Build `0.0.1`, install it.
3. Build `0.0.2` with `--bundles nsis,updater`.
4. Serve `latest.json` and the bundle from `python -m http.server` on localhost,
   with the endpoint overridden to that URL.
5. Install 0.0.1, launch, check for updates, download, install, restart, confirm
   the version. Then repeat with a *deliberately corrupted* signature and
   confirm it is refused — an updater that accepts a bad manifest is worse than
   one that never runs.

Nothing is published, and the whole loop is repeatable on one machine in an
afternoon.

**The part that must be tested against the real pipeline** is the private-repo
manifest rewrite — [scripts/rewrite-updater-manifest.mjs](../scripts/rewrite-updater-manifest.mjs)
turns the URLs into token-authenticated asset endpoints, and that is the piece
most likely to be wrong in a way local testing cannot see. Give it a fixture
test: a sample `latest.json` in, the expected rewritten form out. Pure function,
no network, runs in CI.

**Not a blocker after all.** An earlier revision of this file called the signing
secrets missing. They are set, and the tree proves it: `updater/latest.json`
carries a real 420-character signature per platform for v0.13.0, with URLs
already rewritten to the token-authenticated asset endpoints. Both the signing
step and the manifest rewrite are working in production.

**What a local clone sees.** Nothing, and that is correct. GitHub secrets are
readable only by workflows, so a local build produces unsigned bundles and
prints `MULTIZONE_UPDATER_TOKEN not set — this build cannot check for updates`.
Neither matters for a build that will never be published; use the throwaway
keypair above when rehearsing the update flow locally.

**What is genuinely still unverified** is the receiving half: nobody has watched
an installed build discover an update, download it, and restart into the new
version. Three releases have shipped, so this needs no special setup — install
the previous one, publish the next, watch it.

---

## 5 · Cross-platform smoke tests

> *Windows 11, macOS, Linux*

Dependent on item 3 — there is nothing to smoke-test on two of the three
platforms yet. When there is, the split is:

- **Automated per platform:** build, launch, database initialises, window
  appears, one message sent against the mock provider from item 2, clean exit.
  Roughly section 0 and the first half of section 2 of the checklist.
- **Manual per platform:** anything involving the OS — file dialogs, the tray,
  reveal-in-folder, drag and drop, the installer's own UI, and every 🖥️
  fresh-install item.

Windows 11 is the only one testable today, and its manual pass is what
TEST_CHECKLIST.md already describes.

---

## 6 · Clean uninstall

> *no orphaned files or registry entries*

Automatable on Windows today, and worth doing because the answer is currently
unknown rather than believed-good.

**Method.** In a fresh Windows Sandbox or a VM snapshot:

1. Snapshot `%APPDATA%`, `%LOCALAPPDATA%`, `%PROGRAMFILES%` and
   `HKCU:\Software` (a PowerShell recursive listing to a file).
2. Install, launch, use the app enough to write data — a chat, a zone, a
   knowledge base, a checkpoint store, a downloaded update.
3. Uninstall.
4. Snapshot again, diff.

Every remaining path is then a decision rather than a discovery: the SQLite
database and the checkpoint blob store are arguably *meant* to survive an
uninstall, and NSIS should be asking. What must not survive is registry entries,
the WebView2 user-data folder, and anything under Program Files.

**Note the checkpoint store specifically** — `checkpoints.rs` writes file blobs
outside the database, and `prune_checkpoints` exists, so there is a directory
here that can be large and is easy to orphan.

**Effort:** a PowerShell script and a VM; half a day, and it produces a
definitive answer rather than a tick.

---

## Recommended order

| # | Work | Why first |
| --- | --- | --- |
| 1 | CI job: `npm run build` + `cargo test --lib` on push | Hours of work; starts protecting 37 test files that nothing currently runs |
| 2 | Mock streaming provider + drop assertions | Closes item 2, unblocks 1 and 5, needs no provider or network |
| 3 | Updater secrets, then the local two-build loop | Highest consequence of anything open; the secrets are a settings page |
| 4 | Fixture test for the manifest rewrite | Pure function, the piece local testing cannot cover |
| 5 | Perf harness: seeder, boot marks, frame sampling | Turns item 1 from "optimise" into a number |
| 6 | Uninstall diff on a VM | Half a day, definitive answer |
| 7 | Decide the macOS/Linux question | A distribution decision, not an engineering one — and 1.0's scope hangs on it |

## What stays manual, permanently

Worth stating so it is not repeatedly re-litigated:

- Touch and pen window dragging — no touchscreen in any harness, and the
  0.12.3 item already says so
- SmartScreen behaviour on a genuinely fresh machine
- Anything about how something *looks*: theme transitions, the boot splash,
  entrance animation timing
- Voice I/O with real microphones and speakers
- Any provider-specific behaviour that needs a paid key (⚙️ in the checklist)

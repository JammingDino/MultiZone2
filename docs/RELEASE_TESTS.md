# Running the checks that need a running app

[TEST_STRATEGY.md](TEST_STRATEGY.md) argues what each open 1.0.0 item would take
to close. This file is the operator's version: the commands, in order, for the
things a machine has to actually run.

Everything here needs the app running and, for most of it, the HTTP API on:
**Settings → Data → HTTP API**, note the port and token. Nothing here needs a
provider, a key, or a network connection.

> Set the token once and the commands below shorten:
> `$env:MULTIZONE_API_TOKEN = "<token>"`

---

## Already automatic

These run on every commit and push and need nothing from you:

```
npm run check       # typecheck + script tests            (~1s, on commit)
npm run check:push  # + cargo test --lib                   (~5s, on push)
npm run check:all   # full build + both suites             (before a release)
```

That covers 23 script tests — including the streaming-sequence checker and the
updater manifest rewrite — and 37 files of Rust tests.

---

## 1 · No dropped tokens under sustained use

The claim the 1.0.0 checklist makes, now falsifiable. Two terminals:

```powershell
node scripts/mock-provider.mjs
```

```powershell
node scripts/stream-soak.mjs --token $env:MULTIZONE_API_TOKEN
```

It creates its own provider, zone and chats, runs every scenario, and cleans up
after itself. Expect:

```
[PASS] quick — 2k tokens — all 2000 tokens arrived in order (1.2s, ~1600 tok/s)
[PASS] sustained — 100k tokens, no delay — all 100000 tokens arrived in order
[PASS] sustained — 20k with a 1.5s mid-stream stall — all 20000 tokens …
[PASS] concurrent 1/7 — 20k tokens — all 20000 tokens arrived in order
…
[PASS] truncated — a cut stream is detected, not silently accepted
no dropped tokens
```

A failure names the index: `FAIL sustained — 99640/100000 tokens, 360 missing
(first: 41220)`. That is a bug report, not an impression.

**The `truncated` scenario is the negative control and must pass.** It cuts the
provider off at token 400 of 5000; if the app reports a complete sequence from
it, the check is not checking and everything above it is meaningless.

Individual scenarios: `--scenario sustained`, `--scenario concurrent,truncated`.
Add `--keep` to leave the chats behind and read them.

**Also worth doing by hand, since it is the one thing the API path cannot see —
the UI under the same load.** Add the mock as a provider in Settings, point a
zone at model `mock-stream`, and send:

| Send this | Watch for |
| --- | --- |
| `tokens=100000 delay=0` | The thread staying responsive while it streams; scroll during it |
| `tokens=5000 delay=1 pause=2000` | The stall not being mistaken for the end of the turn |
| `tokens=50000 delay=0` then switch chats mid-stream | 🔁 the crossover regression — go back and check the answer is whole |
| `tokens=50000 delay=0` then press stop | Cancellation leaving a consistent partial message |
| `fail=500` | An honest error rather than a silent truncation presented as an answer |
| `tool=1` | The tool call's arguments building up on screen |

Leave one running 30 minutes and watch memory in Task Manager for the "sustained
use" half of the wording.

---

## 2 · Performance — the numbers that have never been taken

Seed a chat, then measure it. The seeder sends through the real engine, so a
2000-message chat takes a few minutes.

```powershell
node scripts/mock-provider.mjs                                   # if not already up
node scripts/seed-chat.mjs --token $env:MULTIZONE_API_TOKEN --messages 500
node scripts/seed-chat.mjs --token $env:MULTIZONE_API_TOKEN --messages 2000 --seed 2
```

**Startup.** In devtools console: `__mzPerf.enable()`, then relaunch. The marks
print as a table. Take the median of 10 cold launches (after a reboot) and 10
warm.

**Scroll.** Open a seeded chat, then in devtools:

```js
await __mzPerf.scroll()
```

Reports median, p95 and worst frame time.

**Write the thresholds down before you measure**, or the first numbers become
the target by default. The suggested ones, from TEST_STRATEGY.md:

| Measure | Threshold |
| --- | --- |
| Cold start → interactive | < 2500ms |
| p95 frame time, scrolling 500 messages | < 20ms |
| p95 frame time, scrolling 2000 messages | < 20ms |

**The decision this exists to inform:** the message list is not virtualised. If
500 is fine and 2000 is not, that is a known limit to state rather than a bug to
fix before a first release. If 500 stutters, virtualisation is release work.
Do not virtualise on suspicion — it interacts with scroll anchoring, streaming
autoscroll, find-in-page and export, and is a poor thing to add the week before
shipping.

Delete the "Mock stream (seed)" provider and zone in Settings when done.

---

## 3 · The updater's receiving half

The publishing half is proven — `updater/latest.json` carries real signatures
with rewritten URLs, and the rewrite has a fixture test. What nobody has watched
is an installed build finding an update and restarting into it.

**The cheap version, now that several releases have shipped:** install the
previous release, launch it, and let it find the current one. That is the whole
test, and it needs no special setup.

**The offline rehearsal**, if you would rather not depend on a publish:

1. `npx tauri signer generate -w scratch.key` — a throwaway keypair
2. Point a scratch `tauri.conf.json` at its public half and at
   `http://127.0.0.1:8000/latest.json`
3. Build `0.0.1`, install it
4. Build `0.0.2` with `--bundles nsis,updater`
5. `python -m http.server 8000` over a directory holding `latest.json` and the bundle
6. Launch 0.0.1 → check → download → install → restart → confirm the version

Then **corrupt one character of the signature and repeat.** An updater that
accepts a bad manifest is worse than one that never runs, and this is the only
step that proves it doesn't.

Also check, in the same pass: Settings → Data → *Check for updates
automatically*, switched off, means no request at launch. Watch it with Fiddler
or `netsh trace` if you want it proven rather than believed.

---

## 4 · Clean uninstall

Windows Sandbox or a VM snapshot. Never a machine you use — an existing install
poisons the baseline.

```powershell
.\scripts\uninstall-audit.ps1 -Phase before
# install MultiZone, launch it, make a chat, a zone, a knowledge base,
# let a tool edit a file (writes a checkpoint), download an update
.\scripts\uninstall-audit.ps1 -Phase after
# uninstall from Settings > Apps
.\scripts\uninstall-audit.ps1 -Phase diff
```

`survived.txt` lists everything named for MultiZone that outlived the uninstall.
Each entry is then a decision:

- **Should survive, but NSIS ought to ask:** the SQLite database and the
  checkpoint blob store. That is the user's data.
- **Must not survive:** registry keys, the WebView2 user-data folder, anything
  under Program Files.

---

## 5 · Cross-platform

Windows 11 is the only platform this release ships an installer for — see the
1.0.0 notes in [RELEASE_PLAN.md](RELEASE_PLAN.md). macOS and Linux are a
distribution project (code signing, notarisation, an Apple Developer account),
not a testing gap, and they move to 1.1.

Windows 11's manual pass is [TEST_CHECKLIST.md](TEST_CHECKLIST.md), and the
🖥️-marked items in it need a genuinely fresh install to mean anything.

---

## What stays manual, permanently

Restated from TEST_STRATEGY.md so it is not re-litigated each release:

- Touch and pen window dragging — no touchscreen in any harness
- SmartScreen behaviour on a genuinely fresh machine
- Anything about how something *looks* — theme transitions, the boot splash,
  entrance animation timing
- Voice I/O with real microphones and speakers
- Provider-specific behaviour that needs a paid key

# Pre-1.0 Hardening Pass — working log

A running record of the final tidy-up before 1.0. One section per item: what was
wrong, what changed, and what still needs a human to confirm. Written as the work
proceeded so the whole pass can be reviewed in one place rather than
reconstructed from commits.

Verification at the end of the pass: `npm run build` green, `cargo test --lib`
**116 passed / 0 failed**. Everything below is built and typechecked; items
marked **NEEDS RUNTIME CHECK** have not been exercised in the running app —
see [TEST_CHECKLIST.md](TEST_CHECKLIST.md), where each one has a 🔁 entry.

Version stamps moved `0.9.9 → 0.9.12` across `package.json`,
`src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`. `releaseBuild` was left
`false` — **nothing publishes until that is flipped deliberately**.

---

## Item index

| # | Item | Status |
| --- | --- | --- |
| 1 | Chat crossover bug | DONE — needs runtime check |
| 2 | Remove deprecated `web_search` / `extract` | DONE |
| 3 | Knowledge system-prompt block | DONE — needs runtime check |
| 4 | Sub-agent approvals never reach the user | DONE — needs runtime check |
| 5 | Version drift | DONE |
| 6 | GitHub auto-updater | DONE — needs two builds to verify |
| 7 | Formal pre-release test checklist | DONE |

Not attempted this pass, and still open for 1.0: message-list virtualization for
500+ message chats, measured startup/first-paint numbers, macOS and Linux
installers and smoke tests, clean-uninstall verification, and the first-run
demo of a leader run that [COMPETITORS.md](COMPETITORS.md) argues for.

---

## 1. Chat crossover — answers from the previous chat

**Symptom.** Switching between chats, a turn's answer would show under the wrong
chat's prompt. Going back and forth did not fix it; restarting the app did. This
is the "Chat history mix-ups" backlog entry, which had been open for want of a
reliable repro.

**Cause.** A four-link chain, all of it in the frontend:

1. [ChatPanel.tsx](../src/components/Chat/ChatPanel.tsx) mounted
   `<MessageThread chatId={...} />` with **no `key`**, so switching chats never
   remounted the thread.
2. [MessageThread.tsx](../src/components/Chat/MessageThread.tsx) keys bot turns
   `` `bot-${i}` `` — **by index**. Chat A's `bot-0` and chat B's `bot-0` are
   therefore the same React instance.
3. [Message.tsx](../src/components/Message/Message.tsx) keys text blocks
   `` `text-${i}` ``, so `TextBlockView` survives the switch too.
4. `useThrottledStreaming` held the rendered text in state and synced it inside
   an effect whose dependency array was **`[streaming]` alone**. With both the
   old and new chat idle, `streaming` never changed, the effect never re-ran, and
   the state kept the previous chat's answer. `latestRef.current` was updated on
   every render but nothing read it.

User messages are keyed by message id, which is why the *prompt* updated while
the answer under it did not — the mismatched-pairs symptom exactly.

**Fix.** The hook now returns `source` directly when idle, so the throttled copy
is only ever consulted mid-stream and cannot go stale. `MessageThread` is
additionally keyed by chat id, which guarantees a clean slate per chat and also
stops collapsed rails, open edit boxes and scroll position leaking between chats.
The inner index keys were left alone deliberately: a turn has no stable id until
it persists, and re-keying on persistence would remount every turn the moment its
stream ended.

**Reviewer note.** Two fixes for one bug is intentional — the hook fix is the
correctness fix, the `key` is the structural guarantee. Either alone would have
closed the reported symptom; only both close the class.

## 2. Deprecated search and page-reading tools removed

**Why.** Two tools answered "search the web" and two answered "read this page",
which confused users and models alike. `smart_search` / `smart_fetch` (keyless,
multi-engine, PDF-capable) supersede `web_search` / `extract_url` outright. The
half-measure from 0.9.x — hiding `web_search` in the picker but keeping it alive
— left the duplication in the model's tool list, which is where it actually cost
something.

**Removed.** `src-tauri/src/tools/web_search.rs` and `extract.rs` (deleted), their
`ToolId` variants, definitions, dispatch arms and `ALL_TOOLS` entries; the global
web-search provider config (`webSearchProvider` / `Endpoint` / `ApiKey`) and its
plumbing through `inject_global_tool_config`; and the "Legacy search provider"
block in Settings → Search.

**Kept, deliberately.**
- `ToolId::from_str` maps `web_search → SmartSearch` and `extract → SmartFetch`,
  so a zone whose `tools_enabled` predates the change keeps its capability rather
  than silently losing search. Covered by a new test,
  `retired_web_tool_ids_resolve_to_their_replacements`, which also asserts no
  definition offers the retired names.
- `dispatch` accepts the old function names too (they are arg-compatible), so a
  model reaching for an old name from a skill or its own priors gets the modern
  tool instead of an "unknown tool" error.
- The display names in `stepSummary.ts` / `exportTrace.ts` and the citation
  handling in `citations.ts` — **stored history still contains calls named
  `web_search`**, and old chats must keep rendering.

**Side effect.** This closes the "state not saving — search provider" backlog
item by deletion: the field that would not persist no longer exists. Zones that
still carried a `web_search` block in `tool_config` are stripped on load, so an
API key does not sit in a config the user can no longer see.

## 3. Knowledge tools were never used

**Symptom.** `search_local_files` existed, worked, and sat idle — models
preferred to list directories and read files by hand, so the embedding index went
unused.

**Cause.** The tool was appended to the tool array in `build_tools_for_zone` and
**mentioned nowhere else**. `build_system_snippets` had blocks for the zone
prompt, the agent loop, skills, project and tag context, the leader roster,
identity, memory and the compaction hint — and nothing for knowledge. From the
model's seat, `search_local_files` was one of five file-ish tools with no
indication that an index existed, what was in it, or when to prefer it. Reaching
for the deterministic tools it already understood was the rational move.

**Fix.** A `SnippetKind::Knowledge` block (`build_knowledge_block` in
[knowledge/mod.rs](../src-tauri/src/knowledge/mod.rs)), gated on exactly the same
condition as the tool — chat opted in, scope has a non-empty index — so the
prompt can never advertise a tool the turn does not offer, or stay silent about
one it does. It names the indexed scope and gives the routing rule: conceptual →
`search_local_files`, exact string → `search_file_text`, known path → `read_file`.

**Deliberately free of counts and timestamps.** This sits in the system prompt,
which precedes the entire history, and prefix caches match byte-exact. A document
count that ticked up on every re-index would invalidate the cache for the whole
conversation — the mistake `compact_hint` made before it was bucketed
(see [COMPETITORS.md](COMPETITORS.md)). The existing
`the_system_prompt_is_byte_stable_as_the_history_grows` test still passes.

It also shows up as a "Knowledge index" row in the context meter, so its cost is
visible rather than mysterious.

## 4. Sub-agent tool approvals never reached the user

**Symptom.** A background sub-agent needing tool approval would stall until the
~5-minute timeout auto-denied it, with no visible cause. Sharper since 0.9.10,
where a leader can fan out to five sub-agents at once.

**Cause — narrower than the backlog entry suggested.** 0.9.11 already fixed the
*rendering* half (approval banners no longer gated on `isSubchat`). What remained
was **discovery**: `ChatPanel` only ever rendered
`pendingApprovalByChat[activeChatId]`. The store had the data all along — the
stream listener routes every event by its own chat id regardless of what is on
screen — but if you were sitting in the leader chat watching the panel work,
which is exactly where you would be, nothing told you a sub-agent was waiting.

**Fix.** Two surfaces, no backend change:
- An amber banner above the composer listing approvals pending in *other* chats,
  naming each chat with a **Review** button that jumps to it.
- A pulsing shield marker on the sidebar row of any chat with a pending
  approval, so it is discoverable from anywhere rather than only from a sibling
  chat.

## 5. Version drift

`v0.9.9` was tagged and released on 2026-07-28, but the CI's post-build bump
never ran for it (the last bump commit is 0.9.1 — the release was made by hand).
Meanwhile 0.9.10 and 0.9.11 were written up in [RELEASE_PLAN.md](RELEASE_PLAN.md)
as complete. So two releases' worth of documented work would have shipped stamped
0.9.9 — harmless until an updater compares semver, which is now the case.

Stamps set to **0.9.12** in all three files. `releaseBuild` deliberately left
`false`.

## 6. GitHub auto-updater

The CI was already most of the way there — [release.yml](../.github/workflows/release.yml)
built MSI + NSIS and published a GitHub Release behind the `releaseBuild` flag.
Missing was everything that makes an *update* rather than a download.

**Added.** `tauri-plugin-updater` + `tauri-plugin-process` (Rust and JS sides);
`createUpdaterArtifacts: true` and a `plugins.updater` block pointing at
`releases/latest/download/latest.json`; the `updater:` / `process:` capability
permissions; `--bundles msi,nsis,updater` and the signing env vars in CI; and the
UI — [useUpdater.ts](../src/lib/useUpdater.ts) (check / download with progress /
install / relaunch) behind [UpdateSection.tsx](../src/components/Settings/UpdateSection.tsx)
in Settings → Data, which checks silently on mount.

Restart is never automatic: the app holds unsent composer text and in-flight
turns, and pulling the process out from under a running agent to save one click
is a bad trade.

### ⚠️ Action required before this works

A keypair was generated at `~/.tauri/multizone.key` (+ `.pub`). The public half
is already in `tauri.conf.json`. **Two repo secrets must be added by hand:**

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `~/.tauri/multizone.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | empty (the key was generated without one) |

Two things to know:

- **Back the private key up somewhere you will still have it in a year.** Lose it
  and you cannot sign updates; every existing install has the matching public key
  baked in, so the only recovery is shipping a new installer out-of-band and
  asking users to reinstall.
- **A build without those secrets is the dangerous failure.** It still produces
  working installers and a green run, but no `latest.json` — so new users are
  fine and existing installs simply stop seeing updates, silently. The checklist
  has an explicit item for confirming `latest.json` is in the published release.

The password being empty is the weaker of two options; it is what lets CI sign
unattended. If you would rather it were passworded, regenerate with `-p` and set
both secrets — nothing else changes.

## 7. Test checklist

[TEST_CHECKLIST.md](TEST_CHECKLIST.md) — twelve sections, ordered the way a
person actually exercises the app, with 🔁 markers on regressions that have
genuinely happened (including all four fixed above), ⚙️ on setup-dependent items,
and 🖥️ on the ones only meaningful on a fresh install. Sign-off table at the end.

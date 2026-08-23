# Competitive Analysis — MultiZone (August 2026)

A scan of tools that overlap MultiZone's scope: local-first LLM desktop apps, multi-agent chat tools, model-comparison tools, and agent harnesses. Used to identify gaps and differentiators. Prices approximate.

Rewritten at 0.9.9. The June 2026 revision listed RAG, MCP, memory, skills, compaction, subchats and multizone orchestration as "planned" — all are built, which changes the competitive picture materially: MultiZone is no longer chasing the RAG/MCP table stakes, and the interesting comparisons are now against agent *harnesses* rather than against chat frontends.

Legend: + strong · ~ partial · - absent

---

## The landscape

**Local desktop chat (original overlap, now mostly behind)**
Msty, Jan, LM Studio, Cherry Studio — polished desktop apps for chatting with local or cloud models, single-model focused. LM Studio has added MCP tool-calling and an OpenAI-compatible server on :1234. Msty remains the closest pure-chat feature competitor.

**Full-featured multi-model desktop clients (primary overlap)**
- **Askimo** — the closest direct competitor. Multi-provider (ChatGPT/Claude/Gemini/Ollama/Grok/LM Studio), local RAG over Lucene + jvector, global and per-project MCP servers, "directives" (persona system prompts), sandboxed Python/Bash/Node execution, keychain-stored keys, and "plans" — multi-step AI-generated workflows. Also runs Claude Code / Gemini CLI / Codex as agent skills. Lacks a leader/sub-agent architecture and inspectable agent transcripts.
- **Atomic Chat** — local-first, 1,000+ models with 3-bit TurboQuant compression, full MCP (Gmail/Slack/Telegram/Figma), OpenAI-compatible API on :1337. Local-model-inference focused rather than orchestration focused.
- **Chatbox AI** — broadest platform coverage (desktop + iOS + Android), "copilots" as lightweight personas. $3.5–33.3/mo.

**Routing / gateway layer**
**AIRouterDesktop** — classifies each prompt and dispatches to the best-suited model via three routing engines (heuristic, rule-based, hybrid LLM classifier), with an MCP tool loop capped at 8 iterations, a proxy gateway speaking OpenAI/Anthropic/Ollama/Kimi dialects, folder workspaces with persistent memory, web-crawler RAG over up to 50 URLs, and per-provider cost analytics. This is the only tool that directly competes with Smart chat, and its cost/analytics surface is ahead of ours.

**Self-hosted / web**
Open WebUI (MCP since v0.6.31, pipelines, RBAC, Python function tools), AnythingLLM. Browser-based, larger communities, weaker on multi-agent.

**Agent harnesses (the interesting comparison)**
- **Goose** — MCP-native, 70+ extensions, 15+ providers, minimal chat UX.
- **Reasonix** — DeepSeek-native terminal coding agent, ~9K stars, MIT. Its entire architecture is built around prefix-cache stability. See "Prompt-cache economics" below; this is the most directly actionable thing in this document.
- **Cursor / Windsurf** — coding IDEs with real multi-agent (Cursor runs up to 8 concurrent agents; Windsurf's Cascade does autonomous multi-file refactors and its Memories system learns the codebase). Different market, but they set user expectations for what "multi-agent" should feel like.
- **CrewAI, AutoGen, OpenAkita, LangChain** — developer frameworks, not desktop GUIs. Closest conceptually to our leader/sub-agent model, but no end-user product.

**Comparison-only tools**
PolyGPT (open source, drives free-tier web accounts, no API keys), Parallel AI, MultipleChat, Multiple.chat, Chat More LLM, Geekflare AI ($6–149/mo). All do one prompt → N columns. None preserve context across turns with tools running in each stream, which is what Perspective mode actually does.

**Research / document AI**
NotebookLM — source-grounded, inline citations, audio/video generation, deep research. Cloud-only. Still the citation-UX benchmark.

**Privacy-first**
Maivii AI, Maple AI (E2E encrypted, zero logging, auditable), PersonAi (Tauri + React + Rust, same stack as us).

---

## Feature comparison

| Feature | MultiZone 0.9.9 | Askimo | AIRouter | Msty | AnythingLLM | Open WebUI | Goose | NotebookLM | ChatGPT |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Local-first, data owned by user | + | + | + | + | + | + | + | - | - |
| Desktop native app | + | + | + | + | - | - | + | - | - |
| Multi-provider (OpenAI-compatible) | + | + | + | + | + | + | + | - | - |
| Per-zone system prompt / model / tools | + | ~ (directives) | ~ (workspaces) | ~ (personas) | ~ | ~ | - | - | ~ (custom GPTs) |
| Multi-model side-by-side, context-preserving | + (perspective) | - | - | ~ | - | ~ | - | - | - |
| Multi-agent orchestration (leader + sub-agents) | + | ~ (plans) | - | - | - | - | ~ (via MCP) | ~ (deep research) | ~ (operator) |
| Inspectable agent transcripts | + (subchats) | - | - | - | - | - | - | - | - |
| Concurrent multi-agent file editing | + (teamwork) | - | - | - | - | - | - | - | - |
| Prompt-based model routing | + (smart chat) | - | + (3 engines) | - | - | - | - | - | ~ |
| MCP support | + | + | + | - | - | + | + | - | - |
| Knowledge base / RAG | + | + | ~ (web crawl) | + | + | + | ~ | + | + |
| Inline source citations | + | - | - | - | ~ | ~ | - | + | ~ |
| Memory (AI-written, scoped) | + | ~ | ~ | - | - | + | - | - | + |
| Skills (on-demand knowledge packages) | + | + (agent skills) | - | - | - | - | - | - | - |
| Context compaction | + | ~ | - | - | - | - | ~ | - | + |
| Code execution / shell / WSL | + | + (sandboxed) | - | - | ~ | + | + | - | + |
| File system tool | + | + | + | - | + | - | + | - | - |
| Web search / crawl | + | + | + | + | + | + | + | - | + |
| PDF / image attachments + OCR fallback | + | ~ | ~ | + | + | + | + | + | + |
| Projects / folder organization | + | + | + | - | ~ | ~ | - | + | + |
| Local HTTP API | + | - | + (gateway) | - | + | + | - | - | - |
| Per-provider cost analytics | ~ | ~ | + | - | - | ~ | - | - | - |
| Explicit prompt-cache management | ~ (prefix-stable; no `cache_control`) | - | - | - | - | - | - | n/a | n/a |
| Mobile client | - | - | - | + | ~ | ~ | - | + | + |
| Open source | + | + | + | - | + | + | + | - | - |

---

## Where MultiZone is differentiated

**The zone model.** A named, fully configurable agent identity — prompt, model, temperature, tools, icon, color, memory scope — first-class in the UI. Askimo's directives are the nearest equivalent and carry no tool configuration.

**Multizone orchestration with inspectable subchats.** A Response Leader coordinating sub-agents over multi-turn subchats, every agent-to-agent conversation stored and visible in the sidebar. This is the strongest moat in the document. CrewAI/AutoGen do orchestration but are frameworks; Cursor/Windsurf do concurrent agents but only over code; every desktop chat competitor hides or lacks internal agent conversations entirely.

**Teamwork tool.** Concurrent multi-agent file editing with conflict handling. No competitor in this survey has an equivalent.

**Perspective mode.** N zones answering the same message with context preserved across turns and tools live in each stream. The comparison-tool category (PolyGPT, Parallel, MultipleChat) stops at one-shot columns.

**Local HTTP API used for internal orchestration.** AnythingLLM, Open WebUI and AIRouter all expose APIs; none use their own API as the substrate for agent delegation.

**Depth of the built toolset.** 25 tools including WSL, terminal, render_graph, smart_crawl, extract and ask_user. Only Goose and Askimo are in the same range, and both are thinner on the chat side.

---

## Prompt-cache economics — the Reasonix lesson

The most actionable finding in this survey. Reasonix reports a **99.82% cache hit rate over 435M tokens, taking a workload from ~$61 to ~$12** — a 5x cost reduction against generic harnesses hitting the same API, purely from prompt-prefix stability. DeepSeek charges roughly 1/10–1/50 for cached prefix tokens; OpenAI discounts `cached_tokens`; Anthropic caches only what you explicitly mark with `cache_control`.

Its architecture is three regions: an **immutable prefix** (system prompt + tool schemas + examples) assembled once per session and fingerprinted with SHA-256; an **append-only log** where messages and tool results are never rewritten or reordered; and a **volatile scratch** that is distilled before anything enters the log. Tool results over 3,000 tokens are compacted only at turn boundaries, never mid-turn. Memory writes mid-session are durable but deliberately do not update the current prefix snapshot — they land on the next session — specifically to avoid breaking the cache.

### Where MultiZone stands

*Revised after implementing the changes below — the first draft of this section got several things wrong, corrected here.*

The instrumentation was already in place: [types.rs:145-155](src-tauri/src/llm/types.rs#L145-L155) normalizes DeepSeek's `prompt_cache_hit_tokens` and OpenAI's `prompt_tokens_details.cached_tokens`, `cached_input_tokens` is persisted and aggregated per chat and per session in [usage.rs](src-tauri/src/commands/usage.rs), and both the context meter and settings display it. What was missing was the *rate* (now added) and any effort to earn hits.

The real problem was in the system prompt, and it was worse than the one I flagged first:

1. **`compact_hint` embedded a live token count** ("roughly 14 thousand tokens of history"). The system prompt is the front of the request and prefix caches match byte-exact, so a number that ticked up every turn invalidated the cache for the *entire conversation* — on precisely the long chats where caching is worth the most, and on every single turn. **Fixed**: bucketed to three urgency levels.
2. **Snippet ordering was only roughly stable→volatile.** **Fixed**: now strictly ordered, zone prompt → continuity → skills → project/tag context → leader → identity → memory → compact hint. This is damage limitation rather than a fix — because the system prompt precedes the entire message history, *any* change to it still costs the history behind it. What ordering buys is that when one volatile piece does change, the stable head of the prompt still hits.
3. **Historical image downgrade** ([messages.rs](src-tauri/src/commands/messages.rs#L2371)) — I called this the highest-value fix. It isn't, and it shouldn't be changed. `last_user_idx` moving does break the cache, but only back to the *previous user turn*, not across the whole history, and only when that turn carried an image. The alternative (full detail forever) grows prefill cost without limit. **Left as-is, with the trade-off documented in the code.**
4. **Memory snapshotting.** Reasonix defers mid-session memory writes to the next session to protect the prefix. **Deliberately not adopted**: an agent that records a preference and then ignores it for the rest of the session is a worse product than one that occasionally eats a cache miss. Writes are occasional, so the cost is per-write, not per-turn.
5. **`cache_control` breakpoints for Anthropic — still open, and the one real remaining gap.** Anthropic caches nothing unmarked, so Claude-backed zones pay full price for a system prompt that can run to thousands of tokens. Not done here because it is a feature, not a cleanup: the client is OpenAI-compatible ([ChatRequest](src-tauri/src/llm/types.rs#L87)), `cache_control` has to ride inside content parts, support is provider-specific (OpenRouter yes, Anthropic's own compat layer no), and local servers may reject the unknown field. It needs a per-provider opt-in, a migration, and 400-retry handling of the kind already used for `stream_options`.

Note also that **tool schemas can't be reordered into the prefix** — they're a separate `tools` request field, not part of the message array. They are byte-stable and cache fine on their own.

### Measured result

A/B over a 6-turn conversation with a ~2k-token system prompt and growing history, identical in every respect except the volatile tail. Each regime used a per-run nonce so the second run could not inherit the first run's cache.

| | DeepSeek old | DeepSeek new | oMLX old | oMLX new |
| --- | --- | --- | --- | --- |
| Prompt tokens sent | 23,619 | 23,565 | 22,356 | 22,302 |
| Served from cache | 8,832 | 17,536 | 4,096 | 12,288 |
| **Hit rate** | **37.4%** | **74.4%** | **18.3%** | **55.1%** |

`deepseek-chat` via the hosted API; `Ornith-1.0-35B-4bit` via a self-hosted oMLX server. Two independent stacks, +37.0 and +36.8 points respectively — a doubling on DeepSeek and a tripling on oMLX, worth roughly a 50% cut in input cost at DeepSeek's cached/uncached rates.

The per-turn breakdown shows the mechanism directly. On DeepSeek the new code's cached tokens climb monotonically (0 → 2,048 → 2,816 → 3,456 → 4,224 → 4,992) as history accumulates, which is what a healthy prefix cache looks like; the old code sat flat at 1,280 for three turns. oMLX caches in coarser 2,048-token blocks so its figures step rather than climb, but the shape is the same: the new code starts hitting from turn 2, the old code gets nothing until turn 6.

The clincher is an accident in the fixture. Integer flooring made turns 5 and 6 both render "roughly 4 thousand tokens", so the prefix happened not to change — and turn 6 is the *only* turn where the old regime matched the new one, on **both** providers (4,992 and 4,096 cached, identical in each pair). The old code earned cache hits solely when the rounded number stood still.

Incidental finding: oMLX reports `prompt_tokens_details.cached_tokens`, so the context meter's readout is trustworthy against local MLX servers too — I had expected it to report nothing.

Worth noting this is a differentiator, not just a saving: no competitor in this survey does explicit cache management, and a multi-agent product is exactly where it pays most — every sub-agent turn re-sends a large stable prefix.

---

## Other gaps

**Undo (Reasonix, Cursor, Antigravity) — the largest one.** Reasonix takes auto-checkpoints; Cursor and Antigravity make reverting a bad agent run a single click. We have `write_file`, `move_file` and `delete_file` and no way back from any of them — the approval prompt asks before the change and offers nothing after it. This is a capability gap, not a polish gap, and it makes every file tool we already ship more usable rather than adding a new one. Scheduled as **0.10.x**.

**Planning as a mode, not a tool (Reasonix `/apply` + plan mode, Askimo "plans").** Our `plan` tool is a checklist the model keeps for itself. What we lack is a mode where the model plans and is not yet permitted to act, a plan the *user* can edit before it runs, and live task state during execution. The Multizone leader has never had anywhere to hold a task, which is the sharpest version of this gap. Scheduled as **0.12.x**.

**Session replay and event log (Reasonix `replay`, `events`).** Everything needed is already in SQLite; none of it is exposed as a timeline. Cheap relative to its value for a multi-agent product, where "what did it actually do" is the hardest question to answer. Folded into **0.12.2**.

**Data charts (AIRouterDesktop, Claude).** `render_graph` draws diagrams and plots functions but cannot draw data, so models fall back to Mermaid approximations. Both comparisons make in-chat charting look like table stakes. Scheduled as **0.16.0**, before 1.0.

**Whole-file writes vs. an edit engine (Cursor, Antigravity).** They apply diff hunks validated against the file as it currently is; we rewrite a whole file from whatever the model remembers of it. Structural, and correctly scoped with the code interface in the post-1.0 backlog rather than pulled forward on its own.

**Hosted connectors (everyone).** Our MCP support speaks stdio and HTTP/SSE, but the HTTP transport sends no `Authorization` header and `McpServer` has nowhere to hold one — so every *remote* MCP server, which is where the ecosystem has moved, is unreachable. Atomic Chat ships Gmail/Slack/Telegram/Figma; Open WebUI and Askimo both take hosted servers. The stdio path already works for the same services, which makes this a one-column gap with a whole-ecosystem consequence rather than a missing capability. Scheduled **0.12.2**; signed-in OAuth connectors **1.2.x**. See [CONNECTIVITY.md](CONNECTIVITY.md).

**A connector catalog (Atomic Chat, Open WebUI, Msty).** Competitors ship a browsable list of ready-made connections; ours is a settings panel that asks for a command line. The zone library already solves exactly this problem for zones, so the machinery exists. Scheduled **0.11.2**.

**Cost analytics (AIRouter).** Per-provider monthly cost, token volume, routing decisions. We have the data; the presentation is thinner. Natural home for the cache-hit metric above.

**Mobile (Chatbox, Msty).** No client. Out of scope for a Tauri desktop app in the near term, but the local HTTP API makes a thin remote client plausible later.

**Sandboxed code execution (Askimo).** Our code_exec/shell/WSL tools are more capable but less contained. Askimo's sandboxing is a trust story we can't currently tell, and it matters for anyone running untrusted agent output.

**Shadow persona (Msty).** A background agent silently monitoring and correcting a conversation. Now cheap to build on top of the leader/sub-agent machinery — the pieces exist.

**Multimedia output (NotebookLM).** Audio/video summaries. Video is out of scope — a production pipeline, not a feature. Audio is *not*, and this entry undersold it: an audio overview is TTS over a corpus we already index, and we already ship TTS. Reconsidered as part of study mode, now in the backlog ([RELEASE_PLAN.md](RELEASE_PLAN.md#backlog--unscheduled)).

**Study tooling (NotebookLM).** The gap this analysis missed. NotebookLM's pull is not that it summarises — it is that it turns a pile of sources into study guides, briefings, FAQs, timelines, mind maps, flashcards and quizzes, all grounded in *your* sources and cited back to them. We have the corpus, the citations, the diagram renderer and the speech; what we lack is the grounded mode and any notion of retention. It is also the clearest case where local-first is the product argument rather than a principle: NotebookLM requires uploading the material, which rules it out for anything under NDA, unpublished, or personal. Scoped in the backlog.

**Discoverability of orchestration.** The strongest differentiators (multizone, subchats, teamwork) are also the least self-explanatory. Competitors with weaker features market them harder. The Team library helps; a first-run demo of a leader run would help more.

---

## Sources

- [Reasonix — cache-first agent field guide](https://agents.buttonscli.com/field-guide/reasonix)
- [DeepSeek-Reasonix (GitHub)](https://github.com/esengine/deepseek-reasonix)
- [Reasonix complete guide](https://www.aimadetools.com/blog/reasonix-complete-guide/)
- [Prompt Cache: Modular Attention Reuse (arXiv)](https://arxiv.org/pdf/2311.04934)
- [Askimo](https://github.com/askimo-ai/askimo)
- [AIRouterDesktop](https://github.com/topics/ai-router)
- [Open WebUI](https://docs.openwebui.com/)
- [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm)
- [LM Studio](https://lmstudio.ai/)
- [Msty features](https://msty.ai/features/)
- [Goose — Agentic AI Foundation](https://fast.io/resources/top-10-open-source-ai-agents/)
- [NotebookLM overview](https://www.digitalocean.com/resources/articles/what-is-notebooklm)
- [Best local LLM frontends 2026](https://www.promptquorum.com/local-llms/best-local-llm-frontends)

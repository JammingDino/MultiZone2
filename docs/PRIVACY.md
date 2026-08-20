# Privacy Statement — MultiZone

*Last reviewed: 2026-08-20. Applies from v1.0.0.*

MultiZone collects nothing. There is no account, no telemetry, no analytics, no
crash reporting and no cloud sync. Nobody — including the author of this app —
can see your chats, your files, your keys or the fact that you ran it.

This document exists because that claim is worth checking rather than trusting.
Everything below is verifiable in the source tree, and the sections that admit a
gap are the reason it is written as a statement rather than a slogan.

---

## Where your data lives

All of it is on your machine, in your OS application-data directory:

| What | Where |
| --- | --- |
| Chats, zones, projects, tags, skills, memory, settings, usage | `multizone.db` — a single local SQLite file |
| Attachments, exports, generated reports | The paths you chose, plus the app data directory |
| Knowledge-base indexes and embeddings | Local, alongside the database |
| OCR models | `<app data>/ocr_models/` |

Settings → Data shows the exact location, the size, and gives you a working
delete. Uninstalling and removing that directory removes everything; there is no
second copy anywhere.

**Provider API keys are stored in that same SQLite database in plain text.**
They are not encrypted and are not in your OS keychain. Anyone with read access
to your user profile can read them, and so can any process running as you. This
is a known limitation, not an oversight — it is scheduled to change, and until
it does, treat the database file with the same care as the keys themselves.

---

## What leaves the machine, and when

Nothing is sent anywhere as a background activity, with exactly one exception
named in the next section. Every other network request below happens because
you, or a model acting on a message you sent, asked for it.

| Path | What is sent | To whom |
| --- | --- | --- |
| **Sending a message to a cloud model** | The conversation, system prompt, attachments and tool results — everything in that turn's context | The provider you configured (OpenAI, Anthropic, …) |
| **Sending a message to a local model** | The same, over `localhost` | Nowhere — it stays on the machine |
| **Web search** (`smart_search`) | Your search query | DuckDuckGo, Bing, Brave, Yandex, Ecosia, Yahoo and Wikipedia, queried in parallel |
| **Page reading** (`smart_fetch`, `smart_crawl`) | An ordinary page request, with a browser-like fingerprint | The site being read |
| **API calls** (`http_request`) | Whatever the model was asked to send | The host in the request |
| **Remote MCP servers** | Tool arguments, plus any credential you configured for that server | The MCP server's operator |
| **Voice** (STT/TTS) | Recorded audio, or the text to be spoken | The provider you pointed it at — which can be a local one |
| **Embeddings** | The text being indexed | Local, unless you configured an API embedding provider |

Two consequences worth stating plainly, because they are easy to miss:

- **A cloud model sees your files when a tool reads them.** If a zone using a
  hosted model reads a file, that file's contents go to the provider as part of
  the next request. This is how tool use works everywhere; it is not specific to
  this app. Running a local model is the only configuration in which your files
  do not leave the machine.
- **A search query is a disclosure.** Seven engines receive it. If the query
  contains something from your documents, seven companies now have that text.

Anything that leaves the machine is marked as doing so in the interface. If you
run only local models with no web tools enabled, nothing leaves at all.

---

## The one thing that happens without being asked

**About 2.5 seconds after launch, the app checks whether a newer version
exists.** It fetches a static manifest from
`raw.githubusercontent.com/JammingDino/MultiZone2` — a plain GET with no
identifiers, no version reporting and no cookies. Nothing about you or your
machine is transmitted beyond what any HTTP request unavoidably reveals: your IP
address and a user agent, seen by GitHub, not by us. If the check fails or you
are offline it stays silent.

You can switch this off in Settings → Data. With it off, the app makes no
network request you did not initiate, and update checks happen only when you
press the button.

---

## What we do not do

- No telemetry, usage analytics or feature-flag service. Not opt-out, not
  opt-in — the code to send it does not exist, and the dependency list carries
  no analytics SDK.
- No crash or error reporting. Errors are shown to you and written locally.
- No account, login or licence check.
- No cloud sync or backup. There is no server to sync to.
- No advertising, and no data shared with, sold to, or brokered through anyone.
- No remote configuration. The app behaves the same whether or not it can reach
  the internet.

---

## Extensions, connectors and shared content

MultiZone can run code and connect to services you configure. Installing
something from outside this repository — an MCP server, a skill pack, a shared
zone package — means running someone else's instructions against your data.

- Extensions and connectors arrive **disabled**, and stay disabled until you
  explicitly enable them.
- Anything with network or filesystem reach declares it, and you approve that
  reach before it is granted rather than after it is used.
- What a third-party service does with what you send it is governed by that
  service's own policy, not this one.

---

## Children

The app is not directed at children and collects no information from anyone,
including them.

## Changes

This statement is versioned with the app and lives in the repository. Any change
to what leaves the machine changes this file in the same commit, and its history
is public.

## Contact

Questions or a correction: open an issue on the repository.

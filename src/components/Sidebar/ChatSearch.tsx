import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X, Loader2 } from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import type { SearchHit } from "@/lib/types";
import { CHROME_QUIET } from "@/lib/chrome";

/**
 * Cross-chat message search (0.15.0).
 *
 * Sub-agents, perspectives and branches multiply the number of conversations by
 * the size of the panel, and the sidebar only ever offered titles — most of
 * which the model wrote. This searches what was actually said.
 *
 * Results replace the chat list rather than opening over it: the question being
 * answered is "which chat was that in", and the answer belongs where the chats
 * normally are.
 */

/** The backend marks hits with STX/ETX; see `search.rs`. */
const OPEN = "\u0002";
const CLOSE = "\u0003";

/**
 * Splits a marked snippet into plain and highlighted runs. Control characters
 * rather than markup means message text can never inject anything — the parts
 * are rendered as React children, so the worst a crafted message can do is show
 * its own text.
 */
export function splitSnippet(snippet: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let rest = snippet;
  while (rest.length > 0) {
    const start = rest.indexOf(OPEN);
    if (start === -1) {
      out.push({ text: rest, hit: false });
      break;
    }
    if (start > 0) out.push({ text: rest.slice(0, start), hit: false });
    const end = rest.indexOf(CLOSE, start + 1);
    if (end === -1) {
      // Unterminated — treat the remainder as a hit rather than dropping it.
      out.push({ text: rest.slice(start + 1), hit: true });
      break;
    }
    out.push({ text: rest.slice(start + 1, end), hit: true });
    rest = rest.slice(end + 1);
  }
  return out.filter((r) => r.text.length > 0);
}

export function ChatSearch({ onActiveChange }: { onActiveChange: (active: boolean) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const jumpToMessage = useApp((s) => s.jumpToMessage);
  const chats = useApp((s) => s.chats);
  const inputRef = useRef<HTMLInputElement>(null);

  const active = query.trim().length > 0;

  // The palette's "Search messages" lands here. Skips the first render so the
  // box does not steal focus from the composer at launch.
  const focusNonce = useApp((s) => s.focusChatSearchNonce);
  const seenNonce = useRef(focusNonce);
  useEffect(() => {
    if (focusNonce === seenNonce.current) return;
    seenNonce.current = focusNonce;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusNonce]);
  useEffect(() => onActiveChange(active), [active, onActiveChange]);

  // Debounced so a fast typist runs one query per pause rather than one per
  // keystroke. `cancelled` guards against an older query landing after a newer
  // one — the results are ordered by relevance, not by when they were asked for.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setBusy(false);
      return;
    }
    let cancelled = false;
    setBusy(true);
    const t = window.setTimeout(() => {
      api
        .searchMessages(q)
        .then((r) => {
          if (!cancelled) setHits(r);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }, 140);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [query]);

  // A sub-agent or branch is shown under the conversation it belongs to, since
  // its own title is rarely one anybody chose.
  const parentTitle = useMemo(() => {
    const byId = new Map(chats.map((c) => [c.id, c.title]));
    return (hit: SearchHit) => (hit.parentChatId ? byId.get(hit.parentChatId) ?? null : null);
  }, [chats]);

  return (
    // When results are showing this becomes the sidebar's scrolling region, so
    // a hundred hits scroll inside the panel rather than growing it.
    <div className={`mx-2 mb-1 flex min-h-0 flex-col ${active ? "flex-1" : ""}`}>
      <div className="relative shrink-0">
        <Search
          size={13}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
        />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            }
          }}
          placeholder="Search messages"
          aria-label="Search messages across all chats"
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-panel-hover)] py-1.5 pl-7 pr-7 text-sm outline-none transition placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)]"
        />
        {busy ? (
          <Loader2
            size={13}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-[var(--color-text-muted)]"
          />
        ) : query ? (
          <button
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            className={`absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 ${CHROME_QUIET}`}
            title="Clear search"
            aria-label="Clear search"
          >
            <X size={12} />
          </button>
        ) : null}
      </div>

      {active && !busy && hits.length === 0 && (
        <p className="px-1 py-3 text-xs text-[var(--color-text-muted)]">
          Nothing matches “{query.trim()}”.
        </p>
      )}

      {active && hits.length > 0 && (
        <ul className="mt-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          {hits.map((hit) => {
            const under = parentTitle(hit);
            return (
              <li key={hit.messageId}>
                <button
                  onClick={() => jumpToMessage(hit.chatId, hit.messageId)}
                  className="w-full rounded-md px-2 py-1.5 text-left transition hover:bg-[var(--color-panel-hover)]"
                >
                  <div className="flex items-baseline gap-1.5">
                    <span className="truncate text-xs font-medium">{hit.chatTitle}</span>
                    {under && (
                      <span className="truncate text-[10px] text-[var(--color-text-muted)]">
                        in {under}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[var(--color-text-muted)]">
                    <span className="mr-1 uppercase tracking-wide opacity-70">
                      {hit.role === "user" ? "You" : "Reply"}
                    </span>
                    {splitSnippet(hit.snippet).map((run, i) =>
                      run.hit ? (
                        <mark
                          key={i}
                          className="rounded-sm bg-[color-mix(in_srgb,var(--color-accent)_30%,transparent)] px-0.5 text-[var(--color-text)]"
                        >
                          {run.text}
                        </mark>
                      ) : (
                        <span key={i}>{run.text}</span>
                      ),
                    )}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

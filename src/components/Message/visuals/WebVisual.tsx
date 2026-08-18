import { Globe, ExternalLink, FileText, AlertCircle } from "lucide-react";
import { Shaped } from "./Shaped";

/**
 * Families 6 and 7 — search results and fetched pages (0.13.3).
 *
 * `smart_search` reports which engines contributed and which failed, and until
 * now nobody ever saw it: a result merged from six engines and one merged from
 * a single engine that happened to answer looked identical. The engine strip is
 * the honest version — it is also the first thing to look at when results seem
 * thin.
 */

export function WebVisual({
  name,
  args,
  result,
}: {
  name: string;
  args: any;
  result: Record<string, unknown>;
}) {
  if (name === "smart_search") return <SearchResults args={args} result={result} />;
  return <Pages name={name} args={args} result={result} />;
}

function SearchResults({ args, result }: { args: any; result: Record<string, unknown> }) {
  const results = arr(result.results);
  const used = arr(result.engines_used).map(String);
  const failed = arr(result.engine_failures);

  return (
    <Frame
      title={str(result.query) || str(args?.query) || "search"}
      count={`${results.length} result${results.length === 1 ? "" : "s"}`}
    >
      {(used.length > 0 || failed.length > 0) && (
        <div className="flex flex-wrap items-center gap-1 border-b border-[var(--color-border)] px-2 py-1.5">
          {used.map((e) => (
            <span
              key={e}
              className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400"
            >
              {e}
            </span>
          ))}
          {failed.map((f: any, i) => (
            <span
              key={i}
              className="rounded bg-[var(--color-danger)]/10 px-1.5 py-0.5 text-[10px] text-[var(--color-danger)]"
              title={typeof f === "string" ? f : JSON.stringify(f)}
            >
              {engineName(f)} failed
            </span>
          ))}
        </div>
      )}

      {results.length === 0 && (
        <div className="px-2 py-1.5 text-[11px] text-[var(--color-text-muted)]">No results.</div>
      )}

      {results.map((r: any, i) => (
        <div key={i} className="border-b border-[var(--color-border)]/40 px-2 py-1.5 last:border-0">
          <div className="flex items-baseline gap-1.5">
            <span className="shrink-0 tabular-nums text-[10px] text-[var(--color-text-muted)]/70">
              {typeof r.ref === "number" ? r.ref : i + 1}
            </span>
            <Link url={str(r.url)} label={str(r.title) || str(r.url)} />
          </div>
          <div className="mt-0.5 pl-5 text-[10px] text-[var(--color-text-muted)]">
            {domain(str(r.url))}
            {arr(r.found_by).length > 0 && ` · ${arr(r.found_by).map(String).join(", ")}`}
          </div>
          {str(r.snippet) && (
            <div className="mt-0.5 line-clamp-2 pl-5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              {str(r.snippet)}
            </div>
          )}
        </div>
      ))}
    </Frame>
  );
}

function Pages({
  name,
  args,
  result,
}: {
  name: string;
  args: any;
  result: Record<string, unknown>;
}) {
  // smart_fetch returns `results`, smart_crawl returns `pages`.
  const pages = arr(result.results).length ? arr(result.results) : arr(result.pages);
  if (pages.length === 0) return <Shaped value={result} />;

  const facts = [
    typeof result.pages_read === "number" ? `${result.pages_read} read` : null,
    typeof result.pages_errored === "number" && result.pages_errored
      ? `${result.pages_errored} failed`
      : null,
    result.truncated === true ? "truncated" : null,
  ].filter(Boolean) as string[];

  return (
    <Frame
      title={str(result.seed) || str(args?.query) || (name === "smart_crawl" ? "crawl" : "fetch")}
      count={facts.length ? facts.join(" · ") : `${pages.length} page${pages.length === 1 ? "" : "s"}`}
    >
      {pages.map((p: any, i) => (
        <Page key={i} page={p} />
      ))}
      {str(result.note) && (
        <div className="border-t border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-muted)]">
          {str(result.note)}
        </div>
      )}
    </Frame>
  );
}

const PREVIEW_CHARS = 600;

function Page({ page }: { page: any }) {
  const content = str(page.content);
  const error = str(page.error);
  const words = content ? content.trim().split(/\s+/).length : 0;

  return (
    <div className="border-b border-[var(--color-border)]/40 px-2 py-1.5 last:border-0">
      <div className="flex items-center gap-1.5">
        {error ? (
          <AlertCircle size={11} className="shrink-0 text-[var(--color-danger)]" />
        ) : (
          <FileText size={11} className="shrink-0 text-[var(--color-text-muted)]" />
        )}
        <Link url={str(page.url)} label={str(page.title) || domain(str(page.url))} />
        {words > 0 && (
          <span className="ml-auto shrink-0 tabular-nums text-[10px] text-[var(--color-text-muted)]">
            {words.toLocaleString()} words
          </span>
        )}
      </div>
      {error ? (
        <div className="mt-0.5 pl-4 text-[11px] text-[var(--color-danger)]">{error}</div>
      ) : (
        content && (
          <div className="mt-0.5 line-clamp-4 whitespace-pre-wrap pl-4 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            {content.slice(0, PREVIEW_CHARS)}
          </div>
        )
      )}
    </div>
  );
}

function Frame({
  title,
  count,
  children,
}: {
  title: string;
  count: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-2 py-1.5 text-[11px]">
        <Globe size={12} className="shrink-0 text-[var(--color-text-muted)]" />
        <span className="min-w-0 truncate text-[var(--color-text)]" title={title}>
          {title}
        </span>
        <span className="ml-auto shrink-0 text-[10px] text-[var(--color-text-muted)]">{count}</span>
      </div>
      <div className="max-h-[320px] overflow-auto">{children}</div>
    </div>
  );
}

/**
 * Opens in the user's browser rather than in the app. A chat window is not a
 * place to navigate the web from, and the app has no back button.
 */
function Link({ url, label }: { url: string; label: string }) {
  if (!url) return <span className="min-w-0 truncate text-[11px]">{label}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="group flex min-w-0 items-center gap-1 text-[11px] text-[var(--color-text)] hover:underline"
      title={url}
    >
      <span className="min-w-0 truncate">{label}</span>
      <ExternalLink size={9} className="shrink-0 opacity-0 group-hover:opacity-60" />
    </a>
  );
}

function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A failure may arrive as a bare engine name or as `{engine, reason}`. */
function engineName(f: unknown): string {
  if (typeof f === "string") return f;
  if (f && typeof f === "object") {
    const o = f as Record<string, unknown>;
    return str(o.engine) || str(o.name) || "engine";
  }
  return "engine";
}

function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

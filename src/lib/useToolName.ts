import { useApp } from "@/store/app";
import type { McpServer } from "@/lib/types";

/** `mcp__<shortServerId>__<tool>` split into its parts; null for a built-in. */
export function parseMcpName(name: string): { shortId: string; tool: string } | null {
  const m = /^mcp__([0-9a-zA-Z]+)__(.+)$/.exec(name);
  return m ? { shortId: m[1], tool: m[2] } : null;
}

/** The server a short id (the first 8 hex of its UUID, see `mcpToolEnableId`) names. */
export function mcpServerName(servers: McpServer[], shortId: string): string | null {
  return servers.find((s) => s.id.replace(/-/g, "").slice(0, 8) === shortId)?.name ?? null;
}

/** `read_file` → "Read file". */
export function humanizeTool(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * How a tool is named on screen (0.18.1). An MCP tool reads as its own name
 * plus the server it came from — `mcp__3f9a01bc__list_issues` is an id for the
 * machine, "List issues · GitHub" is one for a person. The raw name is for
 * hovers and the Input tab.
 */
export function useToolName(name: string): { label: string; server: string | null } {
  const servers = useApp((s) => s.mcpServers);
  const mcp = parseMcpName(name);
  if (!mcp) return { label: humanizeTool(name), server: null };
  return { label: humanizeTool(mcp.tool), server: mcpServerName(servers, mcp.shortId) ?? "MCP" };
}

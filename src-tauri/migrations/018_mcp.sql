-- MCP (Model Context Protocol) — 0.4.2.
-- A first-class settings section, distinct from the per-zone tool_config JSON.
-- Users register external MCP servers (local stdio subprocess or remote SSE/HTTP);
-- on connect we fetch the server's tool list and store one row per tool. Each
-- tool carries a user-assigned danger level that drives the same approval
-- pipeline as built-in tools, and is enabled per-zone via the zone's
-- `tools_enabled` array (using the qualified id `mcp__<shortServerId>__<tool>`).

CREATE TABLE IF NOT EXISTS mcp_servers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    -- 'stdio' (spawn a local command) or 'sse' (connect to a remote URL).
    transport   TEXT NOT NULL DEFAULT 'stdio',
    -- stdio: the command line to run (e.g. "npx -y @modelcontextprotocol/server-filesystem .").
    command     TEXT,
    -- sse/http: the endpoint URL.
    url         TEXT,
    -- stdio: optional JSON object of environment variables for the child process.
    env         TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- One row per tool advertised by a server, captured at connect time. The danger
-- level (0 safe / 1 moderate / 2 dangerous) is user-editable and defaults to
-- moderate so a freshly-discovered tool requires approval until reviewed.
CREATE TABLE IF NOT EXISTS mcp_tools (
    id            TEXT PRIMARY KEY,
    server_id     TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    description   TEXT,
    input_schema  TEXT,
    danger_level  INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    UNIQUE (server_id, name)
);

CREATE INDEX IF NOT EXISTS idx_mcp_tools_server ON mcp_tools(server_id);

-- Connectors without a config file (0.11.2) — headers on the HTTP transport.
--
-- `HttpConn::send` sent `Content-Type`, `Accept` and `Mcp-Session-Id` and had
-- nowhere to put an `Authorization` header, which made every hosted remote MCP
-- server unreachable: a one-column gap with a whole-ecosystem consequence.
-- Stored like `env` — a JSON object of string values, applied per request.
--
-- `catalog_id` records which connector-catalog entry a server was installed
-- from (NULL for one typed in by hand), so the catalog can say "already
-- installed" and a diagnosis can name the credential page the entry points at.

ALTER TABLE mcp_servers ADD COLUMN headers TEXT;
ALTER TABLE mcp_servers ADD COLUMN catalog_id TEXT;

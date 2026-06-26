-- RAG / local document knowledge — 0.4.3.
--
-- Knowledge is project-scoped and sourced from the project's `directory`: one
-- index per project, built by walking that folder. The embedding provider+model
-- is chosen per project and LOCKED to the index — every chunk and every query
-- must share one vector space, so changing the model forces a full re-index.
-- Local embeddings are not special-cased: the user adds Ollama as a provider and
-- picks an embedding model (e.g. `nomic-embed-text`), exactly like any API model.
--
-- Retrieval is agentic: a read-only `search_knowledge` tool, offered to a chat
-- only when the chat's `knowledge_enabled` flag is on AND the project has a
-- non-empty index. Vectors are stored as raw f32 BLOBs and scored by brute-force
-- cosine in Rust (no native vector extension), which is ample at desktop scale.

-- Per-project embedding configuration. The model is bound to the index; the
-- stored dimension lets us validate query embeddings against indexed chunks and
-- detect a model change. `kb_indexed_at` is the last successful index time.
ALTER TABLE projects ADD COLUMN kb_provider_id     TEXT REFERENCES providers(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN kb_embedding_model TEXT;
ALTER TABLE projects ADD COLUMN kb_dimensions      INTEGER;
ALTER TABLE projects ADD COLUMN kb_indexed_at      INTEGER;

-- Per-chat opt-in. When on (and the project is indexed) the search_knowledge
-- tool is offered for that chat. Off by default so knowledge never silently
-- enters a conversation.
ALTER TABLE chats ADD COLUMN knowledge_enabled INTEGER NOT NULL DEFAULT 0;

-- One row per indexed source file. `path` is relative to the project directory;
-- `hash` is the content hash at index time so re-indexing can skip unchanged
-- files. `status` is 'indexed' | 'error'; `error` holds the message when failed.
CREATE TABLE IF NOT EXISTS kb_documents (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    title       TEXT NOT NULL,
    hash        TEXT NOT NULL,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'indexed',
    error       TEXT,
    indexed_at  INTEGER NOT NULL,
    UNIQUE (project_id, path)
);

CREATE INDEX IF NOT EXISTS idx_kb_documents_project ON kb_documents(project_id);

-- One row per chunk. `embedding` is a little-endian f32 array (dimensions floats)
-- stored as a BLOB; `ordinal` is the chunk's position within its document.
CREATE TABLE IF NOT EXISTS kb_chunks (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
    ordinal     INTEGER NOT NULL,
    text        TEXT NOT NULL,
    embedding   BLOB NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_project ON kb_chunks(project_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_document ON kb_chunks(document_id);

-- 0.9.13 — real token accounting, measured on the assembled request.
--
-- The context meter estimated the *conversation* from stored messages. That is a
-- snapshot: what the next request will carry. Providers bill the *cumulative*
-- total, and every step of an agentic turn re-sends the whole context, so a
-- session whose final context is 640k can be billed 32M. The two numbers were
-- being read as if they were the same one, which is why the meter looked fifty
-- times out against a DeepSeek invoice.
--
-- So both are recorded now, per chat, at the moment a request goes out:
--   * `last_*` — the size of the most recent request. The context-window number.
--   * the cumulative columns — every request added up. The invoice number.
--
-- Figures come from the provider's own `usage` block when it sends one
-- (`stream_options.include_usage`), which is exact, and from the local estimator
-- otherwise. `reported_requests` says how many of the total were exact.

CREATE TABLE IF NOT EXISTS chat_usage (
    chat_id             TEXT PRIMARY KEY,
    -- API calls made for this chat, not turns: one agentic turn is many.
    requests            INTEGER NOT NULL DEFAULT 0,
    -- How many of those came back with a provider `usage` block. The rest were
    -- estimated, so `requests > reported_requests` means the totals are mixed.
    reported_requests   INTEGER NOT NULL DEFAULT 0,
    -- Cumulative across every request.
    input_tokens        INTEGER NOT NULL DEFAULT 0,
    -- Of `input_tokens`, the part the provider served from its prompt cache.
    -- Typically ~90% on a long agentic turn and billed at a fraction of the
    -- rate, so a raw token count badly overstates what a session actually cost.
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,
    -- The most recent request's prompt size: what the context currently costs
    -- to send, measured rather than estimated. The one context figure in the app
    -- that isn't reconstructed from stored messages.
    last_input_tokens   INTEGER NOT NULL DEFAULT 0,
    last_request_at     INTEGER NOT NULL DEFAULT 0,
    updated_at          INTEGER NOT NULL
);

-- Chars-per-token, learned per model from the requests it has answered.
--
-- The estimator's ~4 chars/token is a prose rule of thumb, and these payloads
-- are not prose — they are JSON tool schemas, code, and file listings, which
-- tokenize denser. Rather than hard-coding a second guess, each request whose
-- provider reported real usage contributes its payload size, and the ratio of
-- the totals is used to correct the estimate for that model next time.
CREATE TABLE IF NOT EXISTS model_token_calibration (
    model         TEXT PRIMARY KEY,
    -- Running sums; the ratio is what matters, not either figure alone.
    payload_chars INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    samples       INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL
);

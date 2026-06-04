-- Controls whether thinking blocks emitted inline (e.g. <think>…</think>) by
-- models like Qwen QwQ are preserved when this assistant turn gets fed back
-- to the model as conversation history. Default 0 (= strip) keeps token usage
-- down on long multi-turn chats. Providers that split thinking into a
-- separate `reasoning_content` field are unaffected — we never echo that
-- field back regardless.
ALTER TABLE zones ADD COLUMN include_thinking_in_context INTEGER NOT NULL DEFAULT 0;

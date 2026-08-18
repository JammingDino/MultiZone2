//! Cross-chat message search (0.15.0).
//!
//! The index itself is maintained by triggers (migration 042); this module is
//! the query side — turning what a person typed into an FTS5 query that cannot
//! throw, and joining the hits back to the chats they came from.

use serde::Serialize;
use sqlx::SqlitePool;

/// How many hits a single search returns. Cross-chat search is a way to *find
/// the conversation*, not to read results in place, so a long tail is wasted
/// work — the user opens the chat and reads it there.
const LIMIT: i64 = 50;

/// One matching message, with enough of its chat to be worth showing.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub message_id: String,
    pub chat_id: String,
    pub chat_title: String,
    /// Null for a top-level chat; set for a sub-agent or a branch, so the UI
    /// can say which conversation this actually lives under.
    pub parent_chat_id: Option<String>,
    pub role: String,
    /// The matching text with STX/ETX around each hit. Control characters
    /// rather than markup because the snippet is rendered as text — a `<b>`
    /// here would either escape visibly or invite injection from message
    /// content.
    pub snippet: String,
    pub created_at: i64,
}

/// Turns a person's words into an FTS5 MATCH expression that is always valid.
///
/// FTS5's query language is a real grammar: bare `AND`, an unbalanced quote, a
/// stray `*` or a `-` at the front are all syntax errors, and a search box that
/// throws while you are still typing is worse than one that returns nothing.
/// Every token is quoted as a phrase (doubling any internal quote), which
/// strips the operators of their meaning, and the last token gets `*` so
/// results narrow as the user types rather than appearing only on the space.
pub fn to_match_query(input: &str) -> Option<String> {
    let tokens: Vec<&str> = input.split_whitespace().collect();
    if tokens.is_empty() {
        return None;
    }
    let last = tokens.len() - 1;
    let mut out = String::new();
    for (i, tok) in tokens.iter().enumerate() {
        // A token of only punctuation tokenizes to nothing, and `""` is itself
        // a syntax error, so drop it rather than emit an empty phrase.
        if !tok.chars().any(|c| c.is_alphanumeric()) {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push('"');
        out.push_str(&tok.replace('"', "\"\""));
        out.push('"');
        // Prefix-match the token still being typed, so results narrow with
        // each keystroke instead of only when the space is pressed.
        if i == last {
            out.push('*');
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

/// Searches every message of every chat. Ordered by relevance (bm25), which
/// for a short query is mostly "how rare are these words here" — a passing
/// mention loses to the chat that is about the thing.
pub async fn search_messages(db: &SqlitePool, query: &str) -> Result<Vec<SearchHit>, sqlx::Error> {
    let Some(match_query) = to_match_query(query) else {
        return Ok(Vec::new());
    };
    // The join to `messages` is load-bearing rather than decoration: it is what
    // makes an index entry that outlived its message — a cascade delete whose
    // trigger did not fire — invisible, instead of a hit on a chat that is gone.
    sqlx::query_as::<_, SearchHit>(
        r#"
        SELECT m.id             AS message_id,
               m.chat_id        AS chat_id,
               c.title          AS chat_title,
               c.parent_chat_id AS parent_chat_id,
               m.role           AS role,
               snippet(messages_fts, 0, char(2), char(3), '…', 12) AS snippet,
               m.created_at     AS created_at
          FROM messages_fts
          JOIN messages m ON m.rowid = messages_fts.rowid
          JOIN chats    c ON c.id    = m.chat_id
         WHERE messages_fts MATCH ?1
         ORDER BY bm25(messages_fts), m.created_at DESC
         LIMIT ?2
        "#,
    )
    .bind(&match_query)
    .bind(LIMIT)
    .fetch_all(db)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::db::MIGRATOR.run(&pool).await.unwrap();
        for (id, title) in [("c1", "Roofing quote"), ("c2", "Tax return")] {
            sqlx::query("INSERT INTO chats (id, title, created_at, updated_at) VALUES (?1,?2,0,0)")
                .bind(id)
                .bind(title)
                .execute(&pool)
                .await
                .unwrap();
        }
        pool
    }

    fn text(s: &str) -> String {
        json!([{ "type": "text", "text": s }]).to_string()
    }

    async fn add(pool: &SqlitePool, id: &str, chat: &str, role: &str, content: &str) {
        sqlx::query(
            "INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?1,?2,?3,?4,0)",
        )
        .bind(id)
        .bind(chat)
        .bind(role)
        .bind(content)
        .execute(pool)
        .await
        .unwrap();
    }

    /// The whole premise of doing this in the schema: the trigger has to reach
    /// into the content JSON, which means SQLite has to allow
    /// `json_each(new.content)` in a trigger body. If this passes, the index
    /// maintains itself from every write path there is.
    #[tokio::test]
    async fn a_message_is_searchable_as_soon_as_it_is_written() {
        let pool = pool().await;
        add(&pool, "m1", "c1", "user", &text("How much for a colorsteel roof?")).await;

        let hits = search_messages(&pool, "colorsteel").await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message_id, "m1");
        assert_eq!(hits[0].chat_title, "Roofing quote");
        assert!(
            hits[0].snippet.contains('\u{2}'),
            "the hit should be marked: {:?}",
            hits[0].snippet
        );
    }

    /// Only what the user can see in the transcript. `hidden_text` is context
    /// injected behind their back, and a tool result is not theirs at all.
    #[tokio::test]
    async fn hidden_parts_and_tool_rows_stay_out_of_the_index() {
        let pool = pool().await;
        add(
            &pool,
            "m1",
            "c1",
            "user",
            &json!([{ "type": "hidden_text", "text": "sarsaparilla" }]).to_string(),
        )
        .await;
        add(&pool, "m2", "c1", "tool", &text("sarsaparilla")).await;
        add(&pool, "m3", "c1", "assistant", &text("sarsaparilla is visible")).await;

        let hits = search_messages(&pool, "sarsaparilla").await.unwrap();
        assert_eq!(hits.len(), 1, "only the assistant's visible text");
        assert_eq!(hits[0].message_id, "m3");
    }

    /// Editing a message re-indexes it — the old words stop matching and the
    /// new ones start.
    #[tokio::test]
    async fn an_edit_moves_the_index_with_it() {
        let pool = pool().await;
        add(&pool, "m1", "c1", "user", &text("longrun spouting")).await;
        sqlx::query("UPDATE messages SET content = ?1 WHERE id = 'm1'")
            .bind(text("marley spouting"))
            .execute(&pool)
            .await
            .unwrap();

        assert!(search_messages(&pool, "longrun").await.unwrap().is_empty());
        assert_eq!(search_messages(&pool, "marley").await.unwrap().len(), 1);
    }

    /// Deleting a chat takes its messages with it by cascade. Whether or not
    /// the delete trigger fires on a cascade, the hit must not survive — which
    /// is what the join to `messages` guarantees.
    #[tokio::test]
    async fn a_deleted_chat_leaves_nothing_findable() {
        let pool = pool().await;
        sqlx::query("PRAGMA foreign_keys = ON").execute(&pool).await.unwrap();
        add(&pool, "m1", "c1", "user", &text("underlay")).await;
        assert_eq!(search_messages(&pool, "underlay").await.unwrap().len(), 1);

        sqlx::query("DELETE FROM chats WHERE id = 'c1'").execute(&pool).await.unwrap();
        assert!(search_messages(&pool, "underlay").await.unwrap().is_empty());
    }

    /// A search box is typed into one character at a time, so every prefix of
    /// every query has to be a legal FTS5 expression.
    #[tokio::test]
    async fn punctuation_and_operators_never_throw() {
        let pool = pool().await;
        add(&pool, "m1", "c1", "user", &text("the AND of it")).await;
        for q in ["AND", "\"", "-foo", "*", "a OR", "NOT NEAR(", "  ", "^", "c:\\path"] {
            search_messages(&pool, q)
                .await
                .unwrap_or_else(|e| panic!("{q:?} threw: {e}"));
        }
    }

    /// Results narrow while the word is still being typed.
    #[tokio::test]
    async fn the_last_word_matches_as_a_prefix() {
        let pool = pool().await;
        add(&pool, "m1", "c1", "user", &text("insulation batts")).await;
        assert_eq!(search_messages(&pool, "insul").await.unwrap().len(), 1);
        // ...but an earlier word is matched whole, or "in the" would hit
        // everything ever written.
        assert!(search_messages(&pool, "insul batts").await.unwrap().is_empty());
    }

    /// Every term has to appear — a second word narrows, it does not widen.
    #[tokio::test]
    async fn terms_are_required_not_optional() {
        let pool = pool().await;
        add(&pool, "m1", "c1", "user", &text("gutter cleaning")).await;
        add(&pool, "m2", "c2", "user", &text("gutter replacement")).await;
        assert_eq!(search_messages(&pool, "gutter").await.unwrap().len(), 2);
        assert_eq!(search_messages(&pool, "gutter cleaning").await.unwrap().len(), 1);
    }

    #[test]
    fn the_match_query_is_built_from_quoted_phrases() {
        assert_eq!(to_match_query("foo bar").unwrap(), "\"foo\" \"bar\"*");
        assert_eq!(to_match_query("say \"hi\"").unwrap(), "\"say\" \"\"\"hi\"\"\"*");
        assert_eq!(to_match_query("  "), None);
        assert_eq!(to_match_query("-"), None);
    }
}

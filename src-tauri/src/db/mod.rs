pub mod models;

use crate::error::{AppError, AppResult};
use sha2::{Digest, Sha384};
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::Path;
use std::time::Duration;

/// `pub(crate)` so tests elsewhere can build a migrated in-memory pool against
/// the real schema rather than a hand-written approximation of it.
pub(crate) static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

fn sha384(s: &str) -> Vec<u8> {
    Sha384::digest(s.as_bytes()).to_vec()
}

/// Repair migration checksums that differ from ours only in line endings.
///
/// `sqlx::migrate!` hashes each migration's raw bytes at compile time and
/// records that hash in `_sqlx_migrations` when the migration first runs. Git's
/// `core.autocrlf` means two machines can check the same commit out with
/// different line endings, so binaries built on different machines embed
/// different checksums for byte-identical SQL. The second binary then refuses
/// to open the first one's database and `init` fails with
/// `Migrate(VersionMismatch(v))` — which, happening inside Tauri's `setup()`,
/// looks to the user like the window opening and instantly closing.
///
/// `.gitattributes` pins `*.sql` to LF so builds agree from now on, but
/// databases created by earlier builds still carry the old checksums. For every
/// applied migration whose stored checksum disagrees with ours, we re-hash our
/// embedded SQL under both conventions. A match proves the SQL is identical
/// apart from line endings, so the stored value is safe to rewrite in place.
///
/// A checksum matching neither convention means the migration's content genuinely
/// changed after being applied. That is left untouched so `run()` still reports
/// it — silently accepting it would hide a real schema divergence.
async fn repair_line_ending_checksums(pool: &SqlitePool) -> AppResult<()> {
    // Absent on a fresh database, where there is nothing to repair.
    let table: Option<(String,)> =
        sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'")
            .fetch_optional(pool)
            .await?;
    if table.is_none() {
        return Ok(());
    }

    for m in MIGRATOR.iter() {
        let stored: Option<(Vec<u8>,)> =
            sqlx::query_as("SELECT checksum FROM _sqlx_migrations WHERE version = ?")
                .bind(m.version)
                .fetch_optional(pool)
                .await?;
        // Not applied yet: `run()` will apply it and record our checksum.
        let Some((stored,)) = stored else { continue };
        if stored == m.checksum.as_ref() {
            continue;
        }

        let lf = m.sql.replace("\r\n", "\n");
        let crlf = lf.replace('\n', "\r\n");
        if stored == sha384(&lf) || stored == sha384(&crlf) {
            sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
                .bind(m.checksum.as_ref())
                .bind(m.version)
                .execute(pool)
                .await?;
            tracing::warn!(
                "migration {} ({}): repaired a checksum that differed only in line endings",
                m.version,
                m.description
            );
        }
    }
    Ok(())
}

/// Refuse a database written by a newer build, in words that name the remedy.
///
/// sqlx already refuses it — `run()` reports `VersionMissing` for a migration
/// the database has applied and this binary has never heard of — but it says
/// "migration 37 was previously applied but is missing in the resolved
/// migrations", which describes sqlx's bookkeeping rather than the user's
/// situation. The situation is that they are holding an old copy.
///
/// Reachable in ordinary use now that the updater ships: a rollback, a machine
/// restored from a backup, a second install someone never updated, or simply
/// opening the older build still sitting in Downloads. Refusing is correct and
/// stays; only the sentence changes.
///
/// Checked before the migrator runs so the message is ours rather than
/// whichever migration sqlx happened to trip on first.
async fn check_not_from_newer_build(pool: &SqlitePool) -> AppResult<()> {
    // Absent on a fresh database, which is by definition not from the future.
    let table: Option<(String,)> =
        sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'")
            .fetch_optional(pool)
            .await?;
    if table.is_none() {
        return Ok(());
    }

    // MAX over an empty table is one NULL row, not zero rows.
    let applied: Option<i64> = sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations")
        .fetch_one(pool)
        .await?;
    let Some(applied) = applied else {
        return Ok(());
    };

    let ours = MIGRATOR.iter().map(|m| m.version).max().unwrap_or(0);
    if applied > ours {
        return Err(AppError::DatabaseFromNewerBuild {
            running: env!("CARGO_PKG_VERSION").to_string(),
            ours,
            applied,
        });
    }
    Ok(())
}

pub async fn init(app_data_dir: &Path) -> AppResult<SqlitePool> {
    let db_path = app_data_dir.join("multizone.db");

    // Use filename() directly to avoid Windows path issues with sqlite:// URL formatting.
    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        // WAL permits one writer at a time. With perspective zones now writing
        // concurrently with the primary turn, make a blocked writer wait for the
        // lock instead of failing immediately with SQLITE_BUSY.
        .busy_timeout(Duration::from_secs(10))
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await?;

    // Both run before the migrator: the first because it rejects the whole
    // database on the first checksum it disagrees with, the second so a
    // downgrade is reported in our words rather than sqlx's.
    repair_line_ending_checksums(&pool).await?;
    check_not_from_newer_build(&pool).await?;

    MIGRATOR.run(&pool).await?;

    Ok(pool)
}

#[cfg(test)]
mod tests {
    use crate::db::models::Chat;
    use sqlx::sqlite::SqlitePoolOptions;

    /// Regression guard for the send-breaking bug: every `SELECT ... FROM chats`
    /// that maps into the `Chat` struct must list ALL of the struct's columns,
    /// including the branching columns added in migration 013. The send path
    /// (`run_send`) does this query before persisting the user message, so a
    /// short column list silently broke message sending entirely.
    #[tokio::test]
    async fn chat_query_needs_all_struct_columns() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c1','t',0,0)")
            .execute(&pool)
            .await
            .unwrap();

        // The old list (missing parent_chat_id / branched_from_message_id) must
        // FAIL to decode into Chat — this is exactly what broke sending.
        let old_cols = "id, title, zone_id, project_id, project_context_enabled, perspective_mode, smart_routing, created_at, updated_at";
        let old = sqlx::query_as::<_, Chat>(&format!("SELECT {old_cols} FROM chats WHERE id='c1'"))
            .fetch_one(&pool)
            .await;
        assert!(old.is_err(), "short column list should fail to decode Chat");

        // The real constant the app queries with — NOT a copy of it. This test
        // previously re-typed the list here, so when a column was added to `Chat`
        // and to only one of the two CHAT_COLS constants that existed, the test
        // still passed while every send failed to decode a Chat row. Referencing
        // the shipped constant is the whole point of the guard.
        let new = sqlx::query_as::<_, Chat>(&format!(
            "SELECT {} FROM chats WHERE id='c1'",
            crate::commands::chats::CHAT_COLS
        ))
        .fetch_one(&pool)
        .await;
        assert!(new.is_ok(), "CHAT_COLS should decode Chat: {new:?}");
    }

    /// A database from a newer build is refused, and refused in words that name
    /// the remedy.
    ///
    /// The situation is reachable in ordinary use now that the updater ships —
    /// a rollback, a restored backup, an older copy still in Downloads — and it
    /// used to surface as "migration 37 was previously applied but is missing in
    /// the resolved migrations", which describes sqlx's bookkeeping rather than
    /// what the person should do.
    #[tokio::test]
    async fn a_database_from_a_newer_build_is_refused_by_name() {
        let pool = migrated_pool().await;
        let ours = super::MIGRATOR.iter().map(|m| m.version).max().unwrap();

        // Exactly what a newer build leaves behind: a migration row this binary
        // has never heard of.
        sqlx::query(
            "INSERT INTO _sqlx_migrations
               (version, description, installed_on, success, checksum, execution_time)
             VALUES (?1, 'from the future', CURRENT_TIMESTAMP, 1, X'00', 0)",
        )
        .bind(ours + 1)
        .execute(&pool)
        .await
        .unwrap();

        let err = super::check_not_from_newer_build(&pool)
            .await
            .expect_err("a newer database must be refused");

        let msg = err.to_string();
        assert!(
            msg.contains("older than the data on this machine"),
            "the message should name the cause, got: {msg}"
        );
        assert!(
            msg.contains("Install a newer MultiZone"),
            "the message should name the remedy, got: {msg}"
        );
        assert!(
            msg.contains("not been changed") || msg.contains("not been lost"),
            "the message should say the data is safe, got: {msg}"
        );
        assert!(
            !msg.contains("resolved migrations"),
            "sqlx's wording should not reach the user, got: {msg}"
        );
    }

    /// The guard must not fire on the ordinary cases, or it would refuse every
    /// launch: a database at our own revision, and a fresh one with no table.
    #[tokio::test]
    async fn an_ordinary_database_passes_the_downgrade_guard() {
        let pool = migrated_pool().await;
        assert!(super::check_not_from_newer_build(&pool).await.is_ok());

        let fresh = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        assert!(
            super::check_not_from_newer_build(&fresh).await.is_ok(),
            "a database with no _sqlx_migrations table is new, not from the future"
        );
    }

    async fn migrated_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        super::MIGRATOR.run(&pool).await.unwrap();
        pool
    }

    /// Rewrite migration 1's stored checksum to the value a build machine with
    /// the opposite line-ending convention would have written — exactly the
    /// state that made the installed app die during `setup()` with
    /// `Migrate(VersionMismatch(1))`.
    async fn drift_v1_checksum(pool: &sqlx::SqlitePool) {
        let m = super::MIGRATOR.iter().find(|m| m.version == 1).unwrap();
        let lf = m.sql.replace("\r\n", "\n");
        let flipped = if m.sql.contains("\r\n") {
            lf
        } else {
            lf.replace('\n', "\r\n")
        };
        let sum = super::sha384(&flipped);
        assert_ne!(
            sum,
            m.checksum.as_ref().to_vec(),
            "flipping line endings must change the checksum, or this test proves nothing"
        );
        sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = 1")
            .bind(sum)
            .execute(pool)
            .await
            .unwrap();
    }

    /// A database written by a build whose checkout used the other line-ending
    /// convention must be repaired in place rather than rejected.
    #[tokio::test]
    async fn repairs_line_ending_checksum_drift() {
        let pool = migrated_pool().await;
        drift_v1_checksum(&pool).await;

        assert!(
            super::MIGRATOR.run(&pool).await.is_err(),
            "drifted checksum should be rejected before repair"
        );

        super::repair_line_ending_checksums(&pool).await.unwrap();

        super::MIGRATOR
            .run(&pool)
            .await
            .expect("repaired database should migrate cleanly");
    }

    /// The repair must stay narrow: a migration whose SQL genuinely changed
    /// after being applied is a real schema divergence, and silently rewriting
    /// its checksum would hide it.
    #[tokio::test]
    async fn leaves_genuine_content_changes_alone() {
        let pool = migrated_pool().await;
        sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = 1")
            .bind(super::sha384("CREATE TABLE something_else (id TEXT);"))
            .execute(&pool)
            .await
            .unwrap();

        super::repair_line_ending_checksums(&pool).await.unwrap();

        assert!(
            super::MIGRATOR.run(&pool).await.is_err(),
            "a genuine content change must still be reported"
        );
    }
}

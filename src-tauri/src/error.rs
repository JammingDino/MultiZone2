use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),

    #[error("migration error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),

    /// The database was written by a newer build than this one.
    ///
    /// Its own variant because it is the one startup failure with an obvious
    /// user action, and sqlx's wording for it — "migration 37 was previously
    /// applied but is missing in the resolved migrations" — names neither the
    /// cause nor the remedy. Carries both revision numbers so the log keeps the
    /// detail the dialog leaves out.
    #[error(
        "This copy of MultiZone is older than the data on this machine.\n\n\
         You are running {running}, which understands database revisions up to \
         {ours}, but this machine's data is at revision {applied} — written by a \
         newer version.\n\n\
         Install a newer MultiZone to open it. Your data has not been changed \
         or lost: an older build refuses to open a newer database precisely so \
         that it cannot damage it."
    )]
    DatabaseFromNewerBuild {
        running: String,
        ours: i64,
        applied: i64,
    },

    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("base64 error: {0}")]
    Base64(#[from] base64::DecodeError),

    #[error("image error: {0}")]
    Image(#[from] image::ImageError),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid input: {0}")]
    Invalid(String),

    #[error("provider error: {0}")]
    Provider(String),

    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

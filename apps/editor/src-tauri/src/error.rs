use serde::{Serialize, Serializer};

/// Error returned by every command. Serializes to a plain, user-facing string,
/// so the frontend receives `Promise.reject("message")`.
#[derive(Debug)]
pub enum Error {
    /// The path is outside the imported folders and the app data dir.
    OutOfScope(String),
    Invalid(String),
    Io(String, std::io::Error),
    Tauri(tauri::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::OutOfScope(path) => write!(f, "Access denied: {path} is outside the imported folders"),
            Error::Invalid(msg) => f.write_str(msg),
            Error::Io(context, err) => write!(f, "{context}: {err}"),
            Error::Tauri(err) => write!(f, "{err}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<tauri::Error> for Error {
    fn from(err: tauri::Error) -> Self {
        Error::Tauri(err)
    }
}

impl From<photobook_develop::Error> for Error {
    fn from(err: photobook_develop::Error) -> Self {
        Error::Invalid(err.to_string())
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// `.ctx("reading x")` on io results.
pub trait IoContext<T> {
    fn ctx(self, context: impl Into<String>) -> Result<T>;
}

impl<T> IoContext<T> for std::io::Result<T> {
    fn ctx(self, context: impl Into<String>) -> Result<T> {
        self.map_err(|err| Error::Io(context.into(), err))
    }
}

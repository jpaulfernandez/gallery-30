//! The crate's error type. Messages are meant for the editor's error toasts, so they name the file or
//! the step that failed.

/// Everything that can go wrong while decoding, developing or encoding.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    /// libjpeg-turbo failed (corrupt file, CMYK or 12-bit JPEG, ...).
    #[error("JPEG: {0}")]
    Jpeg(#[from] turbojpeg::Error),
    /// The `image` crate failed (PNG decode).
    #[error("image: {0}")]
    Image(#[from] image::ImageError),
    /// An embedded ICC profile could not be parsed or used.
    #[error("ICC profile: {0}")]
    Icc(String),
    #[error("resize: {0}")]
    Resize(String),
    /// A file type this crate does not decode (HEIC goes through `sips` to JPEG first).
    #[error("unsupported file type: {0}")]
    Unsupported(String),
    #[error("{0}")]
    Invalid(String),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl From<fast_image_resize::ResizeError> for Error {
    fn from(err: fast_image_resize::ResizeError) -> Self {
        Error::Resize(err.to_string())
    }
}

impl From<fast_image_resize::InvalidPixelsSize> for Error {
    fn from(err: fast_image_resize::InvalidPixelsSize) -> Self {
        Error::Resize(err.to_string())
    }
}

impl From<moxcms::CmsError> for Error {
    fn from(err: moxcms::CmsError) -> Self {
        Error::Icc(err.to_string())
    }
}

//! Workflow plan 36 (platform budgets): the raw preview experiment. A custom URI scheme, `pbraw`, that answers a POST
//! with the Develop live preview as raw RGBA8 instead of the JPEG `render_develop_preview` returns, so the webview can
//! upload it straight into a WebGL texture (`src/components/develop/rawPreview.ts`) without a JPEG encode and a
//! WebKit decode.
//!
//! Debug builds only (registered in `lib.rs` under `cfg(debug_assertions)`), and only used when the webview's
//! `localStorage['photobook.rawPreview']` is `1` in a dev build; the default preview path does not change.
//!
//! Request: `POST pbraw://localhost/preview` (`http://pbraw.localhost/preview` on Windows) with a JSON body
//! `{ folder, relPath, hash, settings, job, outputProfile? }` sent as `text/plain` (no CORS preflight). Response:
//! `200` with a 16-byte little-endian header (`width`, `height`, `render ms`, `pack ms`, each `u32`) followed by
//! `width * height * 4` bytes; `204` when a newer job arrived first; `400` / `500` with the error as text.

use serde::Deserialize;
use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{Runtime, UriSchemeContext, UriSchemeResponder};

use photobook_develop::DevelopSettings;

use crate::commands::develop::raw_preview_frame;

/// The scheme name (`pbraw://localhost/...` on macOS and Linux).
pub const SCHEME: &str = "pbraw";

/// The only page allowed to read the responses: the dev server (`build.devUrl` in `tauri.conf.json`). The scheme is
/// registered in debug builds only, where the page is served from there.
const DEV_ORIGIN: &str = "http://localhost:1420";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPreviewRequest {
    folder: String,
    rel_path: String,
    hash: String,
    settings: DevelopSettings,
    job: u64,
    output_profile: Option<String>,
}

fn reply(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        // The dev page is served from the dev server, a different origin from the scheme.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, DEV_ORIGIN)
        .header(header::VARY, "Origin")
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "POST, OPTIONS")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "content-type")
        .header(header::CACHE_CONTROL, "no-store")
        .body(body)
        .expect("static response parts")
}

/// What a request asks for, before any rendering.
enum Parsed {
    /// A CORS preflight: answered with the headers alone.
    Preflight,
    Render(Box<RawPreviewRequest>),
    Reject(StatusCode, String),
}

fn parse(method: &Method, body: &[u8]) -> Parsed {
    if method == Method::OPTIONS {
        return Parsed::Preflight;
    }
    if method != Method::POST {
        return Parsed::Reject(StatusCode::METHOD_NOT_ALLOWED, "POST only".into());
    }
    match serde_json::from_slice::<RawPreviewRequest>(body) {
        Ok(r) => Parsed::Render(Box::new(r)),
        Err(err) => Parsed::Reject(StatusCode::BAD_REQUEST, err.to_string()),
    }
}

/// The `pbraw` handler: decodes the request, renders on the develop render permit and answers when done.
pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let parsed = match parse(request.method(), request.body()) {
        Parsed::Preflight => {
            responder.respond(reply(StatusCode::NO_CONTENT, "text/plain", Vec::new()));
            return;
        }
        Parsed::Reject(status, message) => {
            responder.respond(reply(status, "text/plain", message.into_bytes()));
            return;
        }
        Parsed::Render(r) => *r,
    };
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let RawPreviewRequest { folder, rel_path, hash, settings, job, output_profile } = parsed;
        let response = match raw_preview_frame(app, folder, rel_path, hash, settings, job, output_profile).await {
            Ok(Some(frame)) => {
                let mut body = Vec::with_capacity(16 + frame.rgba.len());
                for v in [frame.width, frame.height, frame.render_ms as u32, frame.pack_ms as u32] {
                    body.extend_from_slice(&v.to_le_bytes());
                }
                body.extend_from_slice(&frame.rgba);
                reply(StatusCode::OK, "application/octet-stream", body)
            }
            Ok(None) => reply(StatusCode::NO_CONTENT, "text/plain", Vec::new()),
            Err(err) => reply(StatusCode::INTERNAL_SERVER_ERROR, "text/plain", err.to_string().into_bytes()),
        };
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rejected(parsed: Parsed) -> Option<(StatusCode, String)> {
        match parsed {
            Parsed::Reject(status, message) => Some((status, message)),
            _ => None,
        }
    }

    #[test]
    fn preflight_and_wrong_methods() {
        assert!(matches!(parse(&Method::OPTIONS, b""), Parsed::Preflight));
        let (status, message) = rejected(parse(&Method::GET, b"{}")).expect("GET is rejected");
        assert_eq!((status, message.as_str()), (StatusCode::METHOD_NOT_ALLOWED, "POST only"));
    }

    #[test]
    fn bad_json_is_a_400() {
        let (status, _) = rejected(parse(&Method::POST, b"not json")).expect("rejected");
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, message) = rejected(parse(&Method::POST, br#"{"folder":"F"}"#)).expect("rejected");
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(message.contains("relPath"), "{message}");
    }

    #[test]
    fn a_full_request_parses() {
        let body = br#"{"folder":"F","relPath":"a.jpg","hash":"h","settings":{},"job":7,"outputProfile":"srgb"}"#;
        match parse(&Method::POST, body) {
            Parsed::Render(r) => {
                assert_eq!((r.folder.as_str(), r.rel_path.as_str(), r.job), ("F", "a.jpg", 7));
                assert_eq!(r.output_profile.as_deref(), Some("srgb"));
            }
            _ => panic!("expected a render request"),
        }
    }

    #[test]
    fn responses_allow_only_the_dev_origin() {
        let response = reply(StatusCode::OK, "application/octet-stream", vec![1, 2]);
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], DEV_ORIGIN);
        assert_eq!(response.body(), &vec![1, 2]);
    }
}

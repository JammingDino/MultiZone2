//! The `mzfile` URI scheme: local files served to the window by path (0.17.9).
//!
//! The workspace viewer shows an HTML file in an iframe. Handing the webview
//! the file's text as a `srcdoc` was enough to run its scripts, but a
//! `srcdoc` document has no URL, so a report that says `<img src="chart.png">`
//! or `<script src="app.js">` — anything next to the file — finds nothing.
//! Serving the file from a URL of its own fixes that the way a web server
//! does: the page's relative references resolve against the URL, and each one
//! comes back through here.
//!
//! On Windows and Android the webview presents this as
//! `http://mzfile.localhost/<path>`; elsewhere as `mzfile://localhost/<path>`.
//! The frontend builds the URL with the path's slashes kept as slashes
//! (`previewUrl` in `lib/tauri.ts`) — `convertFileSrc` would encode them, and
//! then `chart.png` next to `/C:/x/report.html` would resolve to `/chart.png`.
//!
//! The scheme's origin is its own, distinct from the app's, so a served page cannot reach the app's DOM or IPC — the
//! same isolation the sandboxed `srcdoc` had — and it is not registered for
//! the remote client, which is a browser on another machine and gets the
//! `srcdoc` fallback.
//!
//! Anything on disk can be asked for: the desktop UI already reads any file
//! the user points it at (`read_workspace_file`), and this serves the same
//! set to the same window.

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use percent_encoding::percent_decode_str;
use tauri::http::{header, Request, Response, StatusCode};

pub const SCHEME: &str = "mzfile";

/// The handler `register_uri_scheme_protocol` is given.
pub fn serve(request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let Some(path) = path_of(request.uri().path()) else {
        return status(StatusCode::BAD_REQUEST, "no path");
    };
    if !path.is_file() {
        return status(StatusCode::NOT_FOUND, "not a file");
    }
    match std::fs::read(&path) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type(&path))
            // The viewer's frame reloads the file after every save; a stale
            // copy from the webview's cache would make Save look like a no-op.
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Cow::Owned(bytes))
            .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR, "response")),
        Err(e) => status(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// The filesystem path a request URI names.
///
/// The URI path is `/` + the percent-encoded file path. On Windows that path
/// begins with a drive letter (`/C:/Users/...`), so the leading slash is
/// dropped; a POSIX path keeps it.
pub fn path_of(uri_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode_str(uri_path).decode_utf8().ok()?;
    let trimmed = decoded.trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let is_windows_drive = trimmed.len() >= 2
        && trimmed.as_bytes()[1] == b':'
        && trimmed.as_bytes()[0].is_ascii_alphabetic();
    Some(if is_windows_drive { PathBuf::from(trimmed) } else { PathBuf::from(format!("/{trimmed}")) })
}

/// The media type by extension — the handful a report is made of. Anything
/// else is a download-shaped octet stream, which the browser handles safely.
pub fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        "txt" | "md" | "csv" | "log" => "text/plain; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn status(code: StatusCode, why: &str) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(code)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Cow::Owned(why.as_bytes().to_vec()))
        .expect("a plain status response builds")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_windows_path_loses_the_leading_slash_and_a_posix_one_keeps_it() {
        assert_eq!(
            path_of("/C%3A%2FUsers%2Fme%2Freport.html"),
            Some(PathBuf::from("C:/Users/me/report.html")),
        );
        assert_eq!(path_of("/C:/Users/me/chart.png"), Some(PathBuf::from("C:/Users/me/chart.png")));
        assert_eq!(path_of("/home/me/report.html"), Some(PathBuf::from("/home/me/report.html")));
        assert_eq!(path_of("/"), None);
    }

    #[test]
    fn a_relative_reference_resolves_to_a_sibling() {
        // What the webview asks for after `<img src="chart.png">` inside
        // `http://mzfile.localhost/C:/Users/me/report.html`.
        assert_eq!(path_of("/C:/Users/me/chart.png"), Some(PathBuf::from("C:/Users/me/chart.png")));
        // A segment with a space arrives encoded.
        assert_eq!(path_of("/C:/My%20Docs/a.css"), Some(PathBuf::from("C:/My Docs/a.css")));
    }

    #[test]
    fn serves_a_file_and_refuses_what_is_not_one() {
        let dir = std::env::temp_dir().join(format!("mz-preview-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("report.html");
        std::fs::write(&file, "<h1>hi</h1>").unwrap();

        let url_path = format!(
            "/{}",
            file.to_string_lossy().replace('\\', "/").split('/').map(|s| s.replace(' ', "%20")).collect::<Vec<_>>().join("/")
        );
        let req = Request::builder().uri(format!("http://mzfile.localhost{url_path}")).body(Vec::new()).unwrap();
        let res = serve(req);
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[header::CONTENT_TYPE], "text/html; charset=utf-8");
        assert_eq!(&res.body()[..], b"<h1>hi</h1>");

        let dir_path = url_path.rsplit_once('/').unwrap().0.to_string();
        let req = Request::builder().uri(format!("http://mzfile.localhost{dir_path}")).body(Vec::new()).unwrap();
        assert_eq!(serve(req).status(), StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn media_types_follow_the_extension() {
        assert_eq!(content_type(Path::new("a.html")), "text/html; charset=utf-8");
        assert_eq!(content_type(Path::new("a.PNG")), "image/png");
        assert_eq!(content_type(Path::new("a.bin")), "application/octet-stream");
    }
}

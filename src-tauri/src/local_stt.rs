//! Dictation on this computer (0.18) — whisper.cpp, fetched and run by the app.
//!
//! Dictation has always needed a provider with an `/audio/transcriptions`
//! endpoint, which meant either a cloud account or setting up a local server by
//! hand. Speech recognition is the one kind of model every machine can run, so
//! this does the setup: one click downloads whisper.cpp's own server and a
//! model, and dictation then talks to it like any other provider.
//!
//! - **The engine** is whisper.cpp's prebuilt `whisper-server`, pinned to one
//!   release and verified against the SHA-256 GitHub publishes for it. It is
//!   started with `--inference-path /v1/audio/transcriptions`, which makes it
//!   answer the exact OpenAI request `stt_api` already sends — no second client.
//!   Prebuilt binaries exist for Windows x64 and Linux; elsewhere (macOS) a
//!   `whisper-server` on PATH is used, e.g. from `brew install whisper-cpp`.
//! - **Models** come from the whisper.cpp model repository, pinned to a commit
//!   and verified by hash, so a file that changes upstream is refused rather
//!   than run.
//! - **The GPU** (Windows + NVIDIA): whisper.cpp's CUDA 12.4 package, which
//!   bundles cuBLAS and the CUDA runtime so only a driver is needed. Measured
//!   on an RTX 4070 Ti SUPER with Large v3 Turbo and an 11 s clip: ~16 s on the
//!   CPU build, ~0.13 s on this one. It is 675 MB, so it is offered rather
//!   than forced, and it runs on the CPU (`-ng`, or by itself when CUDA cannot
//!   start) — one download covers both, and a machine whose driver is too old
//!   gets the CPU speed rather than an error. The CUDA 11.8 package is smaller
//!   but does not bundle cuBLAS, so its GPU backend silently fails to load
//!   without a CUDA toolkit installed; it is deliberately not used.
//! - **Running** is lazy: the server starts on the first transcription, and
//!   stops after ten idle minutes and when the app quits, so a model is not
//!   holding memory for a feature that was used once.
//!
//! Selected in settings as the dictation provider [`PROVIDER_ID`], which has no
//! row in `providers` — `commands::voice::stt_config` resolves it here.

use crate::error::{AppError, AppResult};
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// The `sttProviderId` that means "the server this module runs".
pub const PROVIDER_ID: &str = "__local__";

const WHISPER_RELEASE: &str = "v1.9.2";
/// The model repository commit the hashes below were taken from.
const MODELS_COMMIT: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";

pub struct Model {
    pub id: &'static str,
    pub label: &'static str,
    pub size: u64,
    sha256: &'static str,
    /// Trained on many languages; the `.en` models are English-only but more
    /// accurate at the same size.
    pub multilingual: bool,
    pub note: &'static str,
}

pub const MODELS: &[Model] = &[
    Model { id: "tiny.en", label: "Tiny (English)", size: 77_704_715, sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f", multilingual: false, note: "Fastest; fine for short notes on a slow machine." },
    Model { id: "base.en", label: "Base (English)", size: 147_964_211, sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002", multilingual: false, note: "Recommended. Fast on any machine, good accuracy." },
    Model { id: "base", label: "Base (multilingual)", size: 147_951_465, sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe", multilingual: true, note: "Base, for languages other than English." },
    Model { id: "small.en", label: "Small (English)", size: 487_614_201, sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d", multilingual: false, note: "Noticeably more accurate; a second or two per sentence on a laptop." },
    Model { id: "small", label: "Small (multilingual)", size: 487_601_967, sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b", multilingual: true, note: "Small, for languages other than English." },
    Model { id: "large-v3-turbo-q5_0", label: "Large v3 Turbo (multilingual)", size: 574_041_195, sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2", multilingual: true, note: "Best accuracy, every language. Instant on a GPU; slow on most CPUs." },
];

pub fn model(id: &str) -> Option<&'static Model> {
    MODELS.iter().find(|m| m.id == id)
}

/// The prebuilt engine for this platform: release asset, its SHA-256, and the
/// server's path inside the archive.
fn engine_asset() -> Option<(&'static str, &'static str, &'static str)> {
    if cfg!(all(windows, target_arch = "x86_64")) {
        Some(("whisper-bin-x64.zip", "49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a", "Release/whisper-server.exe"))
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some(("whisper-bin-ubuntu-x64.tar.gz", "46811a3ecf584307480a220b9ef5ff81b7b22dc41577cbc274ce3afc61f753b1", "whisper-bin-ubuntu-x64/whisper-server"))
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some(("whisper-bin-ubuntu-arm64.tar.gz", "7e26fa6a36d9174d5c0bf033ccbc026c3b5e569e2ee787058241346ef5392719", "whisper-bin-ubuntu-arm64/whisper-server"))
    } else {
        None
    }
}

fn root(data_dir: &Path) -> PathBuf {
    data_dir.join("whisper")
}

fn model_path(data_dir: &Path, id: &str) -> PathBuf {
    root(data_dir).join("models").join(format!("ggml-{id}.bin"))
}

/// The CUDA build: asset, SHA-256, server path, download size.
fn cuda_asset() -> Option<(&'static str, &'static str, &'static str, u64)> {
    cfg!(all(windows, target_arch = "x86_64")).then_some((
        "whisper-cublas-12.4.0-bin-x64.zip",
        "443110ddaad70d4290ab2e77179e31cf712035bbc4fad56bb4519a90c917b39c",
        "Release/whisper-server.exe",
        670_611_449,
    ))
}

fn cuda_server(data_dir: &Path) -> Option<PathBuf> {
    let (_, _, rel, _) = cuda_asset()?;
    let p = root(data_dir).join(format!("{WHISPER_RELEASE}-cuda")).join(rel);
    p.is_file().then_some(p)
}

fn cpu_server(data_dir: &Path) -> Option<PathBuf> {
    let (_, _, rel) = engine_asset()?;
    let p = root(data_dir).join(WHISPER_RELEASE).join(rel);
    p.is_file().then_some(p)
}

/// The NVIDIA GPU's name, when there is one. `nvcuda.dll` is what the driver
/// installs and what the CUDA build needs; `nvidia-smi` comes with it.
async fn nvidia_gpu() -> Option<String> {
    static GPU: tokio::sync::OnceCell<Option<String>> = tokio::sync::OnceCell::const_new();
    GPU.get_or_init(|| async {
        if !cfg!(windows) {
            return None;
        }
        let sys = PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())).join("System32");
        if !sys.join("nvcuda.dll").is_file() {
            return None;
        }
        let mut cmd = tokio::process::Command::new(sys.join("nvidia-smi.exe"));
        cmd.args(["--query-gpu=name", "--format=csv,noheader"]);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let name = cmd
            .output()
            .await
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
            .filter(|s| !s.is_empty());
        Some(name.unwrap_or_else(|| "NVIDIA GPU".into()))
    })
    .await
    .clone()
}

/// The server to run: the downloaded CUDA build if there is one (it runs on
/// the CPU too), then the CPU build, then one already on PATH.
fn server_path(data_dir: &Path) -> Option<PathBuf> {
    if let Some(p) = cuda_server(data_dir).or_else(|| cpu_server(data_dir)) {
        return Some(p);
    }
    if engine_asset().is_some() {
        return None;
    }
    let exe = if cfg!(windows) { "whisper-server.exe" } else { "whisper-server" };
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).map(|d| d.join(exe)).find(|p| p.is_file()))
        .flatten()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelView {
    id: &'static str,
    label: &'static str,
    size_bytes: u64,
    multilingual: bool,
    note: &'static str,
    installed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The engine can be downloaded here, or is already on PATH.
    supported: bool,
    engine_installed: bool,
    models: Vec<ModelView>,
    /// The model the server is running right now, if it is.
    running_model: Option<String>,
    installing: bool,
    /// The NVIDIA GPU found, when the GPU build can be offered for it.
    gpu: Option<String>,
    gpu_engine_installed: bool,
    gpu_engine_size: u64,
    /// Whether the running server actually got the GPU.
    running_on_gpu: Option<bool>,
}

pub async fn status(data_dir: &Path) -> Status {
    let engine_installed = server_path(data_dir).is_some();
    let gpu = match cuda_asset() {
        Some(_) => nvidia_gpu().await,
        None => None,
    };
    let running = SERVER.lock().ok().and_then(|s| s.as_ref().map(|s| (s.model.clone(), s.on_gpu)));
    Status {
        supported: engine_asset().is_some() || engine_installed,
        engine_installed,
        gpu,
        gpu_engine_installed: cuda_server(data_dir).is_some(),
        gpu_engine_size: cuda_asset().map_or(0, |a| a.3),
        running_on_gpu: running.as_ref().map(|r| r.1),
        models: MODELS
            .iter()
            .map(|m| ModelView {
                id: m.id,
                label: m.label,
                size_bytes: m.size,
                multilingual: m.multilingual,
                note: m.note,
                installed: model_path(data_dir, m.id).is_file(),
            })
            .collect(),
        running_model: running.map(|r| r.0),
        installing: INSTALLING.load(Ordering::Relaxed),
    }
}

static INSTALLING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

pub fn cancel_install() {
    CANCEL.store(true, Ordering::Relaxed);
}

/// Progress of an install, as the `local-stt-progress` event carries it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    stage: &'a str,
    received: u64,
    total: u64,
}

/// Download (if needed) the engine and `model_id`. Returns once both are on
/// disk and verified. One install at a time.
pub async fn install(app: &AppHandle, http: &reqwest::Client, data_dir: &Path, model_id: &str, gpu: bool) -> AppResult<()> {
    let m = model(model_id).ok_or_else(|| AppError::Invalid(format!("unknown model {model_id}")))?;
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err(AppError::Other("a download is already running".into()));
    }
    CANCEL.store(false, Ordering::Relaxed);
    let result = install_inner(app, http, data_dir, m, gpu).await;
    INSTALLING.store(false, Ordering::SeqCst);
    let _ = app.emit("local-stt-progress", Progress { stage: "done", received: 0, total: 0 });
    result
}

async fn install_inner(app: &AppHandle, http: &reqwest::Client, data_dir: &Path, m: &Model, gpu: bool) -> AppResult<()> {
    if let (true, Some((asset, sha, _, _)), None) = (gpu, cuda_asset(), cuda_server(data_dir)) {
        let dir = root(data_dir).join(format!("{WHISPER_RELEASE}-cuda"));
        std::fs::create_dir_all(&dir)?;
        let archive = dir.join(asset);
        let url = format!("https://github.com/ggml-org/whisper.cpp/releases/download/{WHISPER_RELEASE}/{asset}");
        download(app, http, &url, &archive, sha, None, "gpu").await?;
        extract(&archive, &dir).await?;
        let _ = std::fs::remove_file(&archive);
        if cuda_server(data_dir).is_none() {
            return Err(AppError::Other("the whisper.cpp GPU download did not contain its server".into()));
        }
    }
    if server_path(data_dir).is_none() {
        let Some((asset, sha, _)) = engine_asset() else {
            return Err(AppError::Other(
                "There is no prebuilt whisper.cpp server for this platform. Install one so \
                 `whisper-server` is on PATH (on macOS: brew install whisper-cpp), then try again."
                    .into(),
            ));
        };
        let dir = root(data_dir).join(WHISPER_RELEASE);
        std::fs::create_dir_all(&dir)?;
        let archive = dir.join(asset);
        let url = format!("https://github.com/ggml-org/whisper.cpp/releases/download/{WHISPER_RELEASE}/{asset}");
        download(app, http, &url, &archive, sha, None, "engine").await?;
        extract(&archive, &dir).await?;
        let _ = std::fs::remove_file(&archive);
        if server_path(data_dir).is_none() {
            return Err(AppError::Other("the whisper.cpp download did not contain its server".into()));
        }
    }
    let path = model_path(data_dir, m.id);
    if !path.is_file() {
        std::fs::create_dir_all(path.parent().unwrap_or(data_dir))?;
        let url = format!(
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/{MODELS_COMMIT}/ggml-{}.bin",
            m.id
        );
        download(app, http, &url, &path, m.sha256, Some(m.size), "model").await?;
    }
    Ok(())
}

/// Stream `url` to `dest`, verifying its SHA-256 on the way. Written to a
/// `.part` file and renamed only once verified, so a half-download or a
/// tampered file never sits where a finished one would.
async fn download(
    app: &AppHandle,
    http: &reqwest::Client,
    url: &str,
    dest: &Path,
    sha256: &str,
    size: Option<u64>,
    stage: &str,
) -> AppResult<()> {
    use tokio::io::AsyncWriteExt;
    let res = http.get(url).send().await?;
    if !res.status().is_success() {
        return Err(AppError::Other(format!("download of {url} failed: {}", res.status())));
    }
    let total = res.content_length().or(size).unwrap_or(0);
    let part = dest.with_extension("part");
    let mut file = tokio::fs::File::create(&part).await?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut last_emit = Instant::now();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if CANCEL.load(Ordering::Relaxed) {
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            return Err(AppError::Other("download cancelled".into()));
        }
        let chunk = chunk?;
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        received += chunk.len() as u64;
        if last_emit.elapsed() > Duration::from_millis(200) {
            last_emit = Instant::now();
            let _ = app.emit("local-stt-progress", Progress { stage, received, total });
        }
    }
    file.flush().await?;
    drop(file);
    let got = format!("{:x}", hasher.finalize());
    if got != sha256 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(AppError::Other(format!(
            "the download of {url} did not match its published checksum, so it was discarded"
        )));
    }
    tokio::fs::rename(&part, dest).await?;
    Ok(())
}

/// Unpack with the system `tar`: bsdtar ships with Windows 10+ and reads zip as
/// well as tar.gz, which saves carrying an archive library for one download.
async fn extract(archive: &Path, into: &Path) -> AppResult<()> {
    let tar = if cfg!(windows) {
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        PathBuf::from(sys).join("System32").join("tar.exe")
    } else {
        PathBuf::from("tar")
    };
    let mut cmd = tokio::process::Command::new(tar);
    cmd.arg("-xf").arg(archive).arg("-C").arg(into);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let out = cmd.output().await.map_err(|e| AppError::Other(format!("could not run tar to unpack whisper.cpp: {e}")))?;
    if !out.status.success() {
        return Err(AppError::Other(format!(
            "unpacking whisper.cpp failed: {}",
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    Ok(())
}

pub fn remove_model(data_dir: &Path, id: &str) -> AppResult<()> {
    if model(id).is_none() {
        return Err(AppError::Invalid(format!("unknown model {id}")));
    }
    let running = SERVER.lock().ok().and_then(|s| s.as_ref().map(|s| s.model.clone()));
    if running.as_deref() == Some(id) {
        shutdown();
    }
    let p = model_path(data_dir, id);
    if p.exists() {
        std::fs::remove_file(p)?;
    }
    Ok(())
}

struct Server {
    child: std::process::Child,
    port: u16,
    model: String,
    /// Asked to use the GPU. A change restarts the server.
    gpu: bool,
    /// Whether it actually got one, from its own startup log.
    on_gpu: bool,
    last_used: Instant,
}

static SERVER: Mutex<Option<Server>> = Mutex::new(None);
/// Held for the whole of a start. Dictation's live partials and its final
/// transcript can both arrive before the first server is up, and two starts
/// would leave one server running untracked.
static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Stop after this long without a transcription. Restarting costs about a
/// second; holding a model costs its size in memory for as long as it runs.
const IDLE: Duration = Duration::from_secs(10 * 60);

/// The base URL of a server running `model_id`, starting one if needed.
pub async fn ensure_running(data_dir: &Path, model_id: &str, gpu: bool) -> AppResult<String> {
    let _starting = STARTING.lock().await;
    {
        let mut guard = SERVER.lock().map_err(|_| AppError::Other("whisper server state poisoned".into()))?;
        if let Some(s) = guard.as_mut() {
            let alive = matches!(s.child.try_wait(), Ok(None));
            if alive && s.model == model_id && s.gpu == gpu {
                s.last_used = Instant::now();
                return Ok(format!("http://127.0.0.1:{}/v1", s.port));
            }
        }
        if let Some(mut old) = guard.take() {
            let _ = old.child.kill();
        }
    }

    let exe = server_path(data_dir).ok_or_else(|| {
        AppError::Invalid("Local dictation is not installed — set it up in Settings → Dictation.".into())
    })?;
    let m = model(model_id).ok_or_else(|| AppError::Invalid(format!("unknown local model {model_id}")))?;
    let weights = model_path(data_dir, m.id);
    if !weights.is_file() {
        return Err(AppError::Invalid(format!(
            "The {} model is not downloaded — download it in Settings → Dictation.",
            m.label
        )));
    }

    let port = std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 9) - 1;
    let log = std::fs::File::create(root(data_dir).join("server.log"))?;
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("-m").arg(&weights)
        .args(["--host", "127.0.0.1", "--port", &port.to_string()])
        .args(["--inference-path", "/v1/audio/transcriptions"])
        .args(["-l", if m.multilingual { "auto" } else { "en" }])
        .args(["-t", &threads.to_string()])
        .args(if gpu { &[][..] } else { &["-ng"][..] })
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
        // The Linux build keeps its shared libraries beside the binary.
        #[cfg(target_os = "linux")]
        cmd.env("LD_LIBRARY_PATH", dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755));
    }
    let mut child = cmd.spawn().map_err(|e| AppError::Other(format!("could not start whisper-server: {e}")))?;

    // Up when it accepts a connection; a model loads in well under a second
    // from a warm disk, a large one from a cold disk takes longer.
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            let tail = std::fs::read_to_string(root(data_dir).join("server.log")).unwrap_or_default();
            let tail: String = tail.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            return Err(AppError::Other(format!("whisper-server exited ({status}):\n{tail}")));
        }
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            break;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            return Err(AppError::Other("whisper-server did not start within a minute".into()));
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    let on_gpu = gpu
        && std::fs::read_to_string(root(data_dir).join("server.log"))
            .map(|l| l.contains("found GPU device"))
            .unwrap_or(false);
    if let Ok(mut guard) = SERVER.lock() {
        *guard = Some(Server { child, port, model: model_id.to_string(), gpu, on_gpu, last_used: Instant::now() });
    }
    tokio::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let Ok(mut guard) = SERVER.lock() else { return };
            match guard.as_ref() {
                Some(s) if s.last_used.elapsed() < IDLE => {}
                Some(_) => {
                    if let Some(mut s) = guard.take() {
                        let _ = s.child.kill();
                    }
                    return;
                }
                None => return,
            }
        }
    });
    Ok(format!("http://127.0.0.1:{port}/v1"))
}

/// Stop the server. Called on quit — a child is not taken down with its
/// parent on Windows.
pub fn shutdown() {
    if let Ok(mut guard) = SERVER.lock() {
        if let Some(mut s) = guard.take() {
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End to end against a real whisper.cpp: start the server the way
    /// dictation does and transcribe a sample through `stt_api`. Needs a data
    /// dir laid out as an install leaves it, plus `jfk.wav` from whisper.cpp's
    /// samples at its root:
    /// `MULTIZONE_WHISPER_TEST_DIR=<dir> cargo test --lib local_stt -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn a_real_server_transcribes_through_the_dictation_path() {
        let dir = PathBuf::from(std::env::var("MULTIZONE_WHISPER_TEST_DIR").expect("set MULTIZONE_WHISPER_TEST_DIR"));
        let gpu = std::env::var("MULTIZONE_WHISPER_TEST_GPU").is_ok();
        if gpu {
            assert!(nvidia_gpu().await.is_some(), "an NVIDIA GPU is detected");
        }
        let url = ensure_running(&dir, "tiny.en", gpu).await.unwrap();
        let again = ensure_running(&dir, "tiny.en", gpu).await.unwrap();
        assert_eq!(url, again, "a running server is reused");
        let wav = std::fs::read(dir.join("jfk.wav")).unwrap();
        let out = crate::stt_api::transcribe_via_provider(
            &reqwest::Client::new(), &url, None, "tiny.en", wav, "dictation.wav", None, false,
        )
        .await
        .unwrap();
        let on_gpu = SERVER.lock().unwrap().as_ref().map(|s| s.on_gpu);
        shutdown();
        assert_eq!(on_gpu, Some(gpu), "the server reports where it is running");
        assert!(out.text.to_lowercase().contains("ask not what your country"), "{}", out.text);
        assert!(!out.text.contains('\n'), "segments are joined into one line: {:?}", out.text);
    }

    #[test]
    fn every_model_has_a_full_sha256() {
        for m in MODELS {
            assert_eq!(m.sha256.len(), 64, "{}", m.id);
        }
    }
}

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use byok_grid_connector_runner::{
    ConnectorRunner, MAX_INVOCATION_BYTES, RegistryTrustPolicy, RunnerLimits, unix_timestamp,
    verify_request_signature,
};
use serde_json::json;
use std::env;
use std::future::Future;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::trace::TraceLayer;
use tracing::info;

#[derive(Clone)]
struct AppState {
    runner: ConnectorRunner,
    shared_secret: Arc<Vec<u8>>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "byok_grid_connector_runner=info,tower_http=info".into()),
        )
        .init();
    let registry_path = required_env("CONNECTOR_RUNNER_REGISTRY_PATH")?;
    let shared_secret = required_env("CONNECTOR_RUNNER_SHARED_SECRET")?.into_bytes();
    if shared_secret.len() < 32 {
        anyhow::bail!("CONNECTOR_RUNNER_SHARED_SECRET must contain at least 32 bytes");
    }
    let listen = env::var("CONNECTOR_RUNNER_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:4319".into())
        .parse::<SocketAddr>()?;
    let fuel = optional_number("CONNECTOR_RUNNER_FUEL", 10_000_000)?;
    let memory_bytes = optional_number("CONNECTOR_RUNNER_MEMORY_BYTES", 16 * 1_048_576)?;
    let trust_policy = RegistryTrustPolicy::from_json(
        &env::var("CONNECTOR_RUNNER_TRUST_KEYS").unwrap_or_else(|_| "{}".into()),
        optional_boolean("CONNECTOR_RUNNER_ALLOW_UNSIGNED_REGISTRY", false)?,
        env::var("CONNECTOR_RUNNER_REGISTRY_SIGNATURE_PATH")
            .ok()
            .filter(|value| !value.is_empty())
            .map(PathBuf::from),
    )?;
    let state = AppState {
        runner: ConnectorRunner::from_registry_path(
            registry_path,
            RunnerLimits { fuel, memory_bytes },
            &trust_policy,
        )?,
        shared_secret: Arc::new(shared_secret),
    };
    let app = Router::new()
        .route("/health", get(|| async { Json(json!({ "status": "ok" })) }))
        .route("/v1/execute", post(execute))
        .layer(DefaultBodyLimit::max(MAX_INVOCATION_BYTES))
        .layer(TraceLayer::new_for_http())
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(listen).await?;
    let shutdown = shutdown_signal()?;
    info!(%listen, "connector runner listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}

async fn execute(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    verify_request_signature(
        state.shared_secret.as_slice(),
        &headers,
        &body,
        unix_timestamp().map_err(ApiError::internal)?,
    )
    .map_err(|_| ApiError::unauthorized())?;
    let runner = state.runner.clone();
    let output = tokio::task::spawn_blocking(move || runner.execute(&body))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::invalid_execution)?;
    Ok(([("content-type", "application/json")], output).into_response())
}

struct ApiError {
    code: &'static str,
    message: &'static str,
    status: StatusCode,
}

impl ApiError {
    fn unauthorized() -> Self {
        Self {
            code: "unauthorized",
            message: "The connector runner request is unauthorized.",
            status: StatusCode::UNAUTHORIZED,
        }
    }

    fn invalid_execution(_error: anyhow::Error) -> Self {
        Self {
            code: "invalid_execution",
            message: "The connector invocation could not be executed.",
            status: StatusCode::UNPROCESSABLE_ENTITY,
        }
    }

    fn internal<E>(_error: E) -> Self {
        Self {
            code: "internal",
            message: "The connector runner failed unexpectedly.",
            status: StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({ "error": { "code": self.code, "message": self.message } })),
        )
            .into_response()
    }
}

fn required_env(name: &str) -> anyhow::Result<String> {
    env::var(name).map_err(|_| anyhow::anyhow!("{name} is required"))
}

fn optional_number<T>(name: &str, default: T) -> anyhow::Result<T>
where
    T: std::str::FromStr,
    T::Err: std::error::Error + Send + Sync + 'static,
{
    match env::var(name) {
        Ok(value) => Ok(value.parse::<T>()?),
        Err(_) => Ok(default),
    }
}

fn optional_boolean(name: &str, default: bool) -> anyhow::Result<bool> {
    match env::var(name) {
        Ok(value) if value == "true" => Ok(true),
        Ok(value) if value == "false" => Ok(false),
        Ok(_) => anyhow::bail!("{name} must be true or false"),
        Err(_) => Ok(default),
    }
}

#[cfg(unix)]
fn shutdown_signal() -> anyhow::Result<impl Future<Output = ()>> {
    use tokio::signal::unix::{SignalKind, signal};

    // Construct both streams before accepting traffic. Tokio keeps the
    // process-wide handlers installed after registration, so a setup failure
    // must stop startup rather than leave SIGTERM behavior ambiguous.
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    Ok(async move {
        tokio::select! {
            _ = interrupt.recv() => {
                info!(signal = "SIGINT", "connector runner received shutdown signal");
            }
            _ = terminate.recv() => {
                info!(signal = "SIGTERM", "connector runner received shutdown signal");
            }
        }
    })
}

#[cfg(not(unix))]
fn shutdown_signal() -> anyhow::Result<impl Future<Output = ()>> {
    Ok(async {
        match tokio::signal::ctrl_c().await {
            Ok(()) => info!(
                signal = "CTRL_C",
                "connector runner received shutdown signal"
            ),
            Err(error) => {
                tracing::error!(error = %error, "connector runner signal listener failed")
            }
        }
    })
}

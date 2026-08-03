#![cfg(unix)]

use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

const SHARED_SECRET: &str = "connector-runner-signal-test-secret";
const TRUST_KEYS: &str = r#"{"byok_grid_reference_2026":"d30d04cc80d66bff277650ce03561ed543a321921199f48de5c20355bb213e86"}"#;

#[test]
fn exits_cleanly_when_kubernetes_sends_sigterm() {
    let manifest_directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let reference_directory = manifest_directory.join("../../examples/connectors/reference");
    let port = available_port();
    let mut child = Command::new(env!("CARGO_BIN_EXE_byok-grid-connector-runner"))
        .env("CONNECTOR_RUNNER_LISTEN", format!("127.0.0.1:{port}"))
        .env(
            "CONNECTOR_RUNNER_REGISTRY_PATH",
            reference_directory.join("registry.json"),
        )
        .env(
            "CONNECTOR_RUNNER_REGISTRY_SIGNATURE_PATH",
            reference_directory.join("registry.json.sig.json"),
        )
        .env("CONNECTOR_RUNNER_SHARED_SECRET", SHARED_SECRET)
        .env("CONNECTOR_RUNNER_TRUST_KEYS", TRUST_KEYS)
        .env("RUST_LOG", "byok_grid_connector_runner=info")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("connector runner binary should start");

    let status = exercise_sigterm(&mut child, port);
    if status.is_err() {
        child.kill().ok();
    }
    let output = child
        .wait_with_output()
        .expect("connector runner output should be collected");
    let logs = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let status = status.unwrap_or_else(|message| panic!("{message}\n{logs}"));

    assert!(
        status.success(),
        "SIGTERM was not graceful: {status}\n{logs}"
    );
    assert!(
        logs.contains("connector runner received shutdown signal") && logs.contains("SIGTERM"),
        "the graceful SIGTERM marker was absent\n{logs}"
    );
    println!(
        "{{\"exitCode\":0,\"marker\":\"BYOK_GRID_CONNECTOR_RUNNER_SIGTERM_DRILL_PASSED\",\"signal\":\"SIGTERM\"}}"
    );
}

fn exercise_sigterm(child: &mut Child, port: u16) -> Result<ExitStatus, String> {
    let startup_deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < startup_deadline {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return Err(format!(
                "connector runner exited before readiness: {status}"
            ));
        }
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        sleep(Duration::from_millis(25));
    }
    if TcpStream::connect(("127.0.0.1", port)).is_err() {
        return Err("connector runner did not listen within 10 seconds".into());
    }

    // SAFETY: the PID comes from the live Child owned by this test, SIGTERM is
    // a valid signal, and a failed syscall is checked immediately.
    let result = unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
    if result != 0 {
        return Err(format!(
            "SIGTERM delivery failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    let shutdown_deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < shutdown_deadline {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return Ok(status);
        }
        sleep(Duration::from_millis(25));
    }
    Err("connector runner did not drain within 10 seconds".into())
}

fn available_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test port should bind");
    listener
        .local_addr()
        .expect("test listener should have an address")
        .port()
}

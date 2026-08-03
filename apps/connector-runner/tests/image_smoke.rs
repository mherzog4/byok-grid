use std::process::Command;

#[test]
fn emits_the_side_effect_free_release_image_marker() {
    let output = Command::new(env!("CARGO_BIN_EXE_byok-grid-connector-runner"))
        .arg("--image-smoke")
        .env_clear()
        .output()
        .expect("connector runner smoke process should start");

    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).expect("smoke output should be UTF-8"),
        "{\"marker\":\"BYOK_GRID_IMAGE_SMOKE_READY\",\"target\":\"connector-runner\"}\n"
    );
    assert!(output.stderr.is_empty());
}

use anyhow::{Context, Result, anyhow, bail};
use ed25519_dalek::{Signature, VerifyingKey};
use hmac::{Hmac, Mac};
use http::HeaderMap;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use wasmtime::{Config, Engine, Instance, Module, Store, StoreLimits, StoreLimitsBuilder};

pub const SANDBOX_PROTOCOL_VERSION: &str = "1.0";
pub const MAX_INVOCATION_BYTES: usize = 1_048_576;
pub const MAX_RESULT_BYTES: usize = 1_048_576;
pub const REGISTRY_SIGNATURE_CONTEXT: &[u8] = b"BYOK_GRID_CONNECTOR_REGISTRY_V1\0";

#[derive(Clone, Debug)]
pub struct RegistryTrustPolicy {
    pub allow_unsigned: bool,
    pub public_keys: HashMap<String, [u8; 32]>,
    pub signature_path: Option<PathBuf>,
}

impl RegistryTrustPolicy {
    pub fn from_json(
        raw_public_keys: &str,
        allow_unsigned: bool,
        signature_path: Option<PathBuf>,
    ) -> Result<Self> {
        let encoded_keys: HashMap<String, String> = serde_json::from_str(raw_public_keys)
            .context("connector trust keys are invalid JSON")?;
        if encoded_keys.len() > 32 {
            bail!("at most 32 connector publisher keys can be trusted");
        }
        let mut public_keys = HashMap::with_capacity(encoded_keys.len());
        for (key_id, encoded_key) in encoded_keys {
            if !valid_identifier(&key_id) {
                bail!("connector trust keys contain an invalid key ID");
            }
            let public_key = decode_lower_hex::<32>(&encoded_key)
                .context("connector trust keys contain an invalid public key")?;
            VerifyingKey::from_bytes(&public_key)
                .context("connector trust keys contain an invalid Ed25519 public key")?;
            public_keys.insert(key_id, public_key);
        }
        Ok(Self {
            allow_unsigned,
            public_keys,
            signature_path,
        })
    }
}

#[derive(Clone, Debug)]
pub struct RunnerLimits {
    pub fuel: u64,
    pub memory_bytes: usize,
}

impl Default for RunnerLimits {
    fn default() -> Self {
        Self {
            fuel: 10_000_000,
            memory_bytes: 16 * 1_048_576,
        }
    }
}

#[derive(Clone)]
pub struct ConnectorRunner {
    engine: Engine,
    limits: RunnerLimits,
    modules: Arc<HashMap<ConnectorKey, Module>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RegistryFile {
    pub connectors: Vec<RegistryEntry>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub artifact: RegistryArtifact,
    #[serde(default = "default_catalog")]
    pub catalog: bool,
    pub manifest: RegistryManifestIdentity,
}

fn default_catalog() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RegistryArtifact {
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryManifestIdentity {
    pub id: String,
    pub version: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistrySignatureFile {
    signatures: Vec<RegistrySignatureEntry>,
    version: u8,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RegistrySignatureEntry {
    key_id: String,
    signature: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InvocationEnvelope {
    action_id: String,
    connector_id: String,
    connector_version: String,
    continuation: Value,
    credential: Value,
    input: Value,
    protocol_version: String,
    run_id: String,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ConnectorKey {
    id: String,
    version: String,
}

struct StoreData {
    limits: StoreLimits,
}

impl ConnectorRunner {
    pub fn from_registry_path(
        path: impl AsRef<Path>,
        limits: RunnerLimits,
        trust_policy: &RegistryTrustPolicy,
    ) -> Result<Self> {
        let path = path.as_ref();
        let bytes = fs::read(path)
            .with_context(|| format!("could not read connector registry {}", path.display()))?;
        verify_registry_signature(path, &bytes, trust_policy)?;
        let registry: RegistryFile = serde_json::from_slice(&bytes)
            .with_context(|| format!("invalid connector registry {}", path.display()))?;
        let base = path.parent().unwrap_or_else(|| Path::new("."));
        Self::from_registry(base, registry, limits)
    }

    pub fn from_registry(
        base: impl AsRef<Path>,
        registry: RegistryFile,
        limits: RunnerLimits,
    ) -> Result<Self> {
        validate_limits(&limits)?;
        let mut config = Config::new();
        config.consume_fuel(true);
        config.wasm_multi_memory(false);
        let engine = Engine::new(&config)?;
        let mut modules = HashMap::new();

        for entry in registry.connectors {
            validate_registry_entry(&entry)?;
            let artifact_path = base.as_ref().join(&entry.artifact.path);
            let artifact = fs::read(&artifact_path).with_context(|| {
                format!(
                    "could not read connector artifact {}",
                    artifact_path.display()
                )
            })?;
            let actual_digest = hex::encode(Sha256::digest(&artifact));
            if actual_digest != entry.artifact.sha256 {
                bail!(
                    "connector artifact digest mismatch for {}@{}",
                    entry.manifest.id,
                    entry.manifest.version
                );
            }
            let wasm = wat::parse_bytes(&artifact).with_context(|| {
                format!("invalid WebAssembly artifact {}", artifact_path.display())
            })?;
            let module = Module::new(&engine, &wasm)?;
            if module.imports().next().is_some() {
                bail!(
                    "connector {}@{} imports host capabilities",
                    entry.manifest.id,
                    entry.manifest.version
                );
            }
            let key = ConnectorKey {
                id: entry.manifest.id,
                version: entry.manifest.version,
            };
            if modules.insert(key, module).is_some() {
                bail!("connector registry repeats an ID and version");
            }
        }
        if modules.is_empty() {
            bail!("connector registry must contain at least one artifact");
        }
        Ok(Self {
            engine,
            limits,
            modules: Arc::new(modules),
        })
    }

    pub fn execute(&self, request: &[u8]) -> Result<Vec<u8>> {
        if request.len() > MAX_INVOCATION_BYTES {
            bail!("connector invocation exceeds the input limit");
        }
        let invocation: InvocationEnvelope =
            serde_json::from_slice(request).context("connector invocation is invalid JSON")?;
        validate_invocation(&invocation)?;
        let key = ConnectorKey {
            id: invocation.connector_id,
            version: invocation.connector_version,
        };
        let module = self
            .modules
            .get(&key)
            .ok_or_else(|| anyhow!("connector artifact is not installed"))?;
        let store_limits = StoreLimitsBuilder::new()
            .memory_size(self.limits.memory_bytes)
            .instances(1)
            .memories(1)
            .tables(1)
            .build();
        let mut store = Store::new(
            &self.engine,
            StoreData {
                limits: store_limits,
            },
        );
        store.limiter(|data| &mut data.limits);
        store.set_fuel(self.limits.fuel)?;
        let instance = Instance::new(&mut store, module, &[])?;
        let memory = instance
            .get_memory(&mut store, "memory")
            .ok_or_else(|| anyhow!("connector must export memory"))?;
        let allocate = instance
            .get_typed_func::<i32, i32>(&mut store, "alloc")
            .map_err(|error| anyhow!("connector must export alloc(i32) -> i32: {error}"))?;
        let execute = instance
            .get_typed_func::<(i32, i32), i64>(&mut store, "execute")
            .map_err(|error| anyhow!("connector must export execute(i32, i32) -> i64: {error}"))?;
        let input_length = i32::try_from(request.len()).context("invocation is too large")?;
        let input_pointer = allocate.call(&mut store, input_length)?;
        if input_pointer < 0 {
            bail!("connector returned an invalid allocation");
        }
        memory.write(&mut store, input_pointer as usize, request)?;
        let packed = execute.call(&mut store, (input_pointer, input_length))? as u64;
        let output_pointer = usize::try_from(packed >> 32)?;
        let output_length = usize::try_from(packed & u64::from(u32::MAX))?;
        if output_length > MAX_RESULT_BYTES {
            bail!("connector result exceeds the output limit");
        }
        let mut output = vec![0; output_length];
        memory.read(&store, output_pointer, &mut output)?;
        validate_result(&output)?;
        Ok(output)
    }
}

fn verify_registry_signature(
    registry_path: &Path,
    registry_bytes: &[u8],
    trust_policy: &RegistryTrustPolicy,
) -> Result<()> {
    if trust_policy.public_keys.is_empty() {
        if trust_policy.allow_unsigned {
            return Ok(());
        }
        bail!("a connector registry requires at least one trusted publisher key");
    }
    let signature_path = trust_policy
        .signature_path
        .clone()
        .unwrap_or_else(|| appended_signature_path(registry_path));
    let signature_bytes =
        fs::read(&signature_path).context("the connector registry signature file is invalid")?;
    let signature_file: RegistrySignatureFile = serde_json::from_slice(&signature_bytes)
        .context("the connector registry signature file is invalid")?;
    if signature_file.version != 1
        || signature_file.signatures.is_empty()
        || signature_file.signatures.len() > 32
    {
        bail!("the connector registry signature file is invalid");
    }
    let mut key_ids = HashSet::with_capacity(signature_file.signatures.len());
    let mut signed_bytes =
        Vec::with_capacity(REGISTRY_SIGNATURE_CONTEXT.len() + registry_bytes.len());
    signed_bytes.extend_from_slice(REGISTRY_SIGNATURE_CONTEXT);
    signed_bytes.extend_from_slice(registry_bytes);
    let mut valid = false;
    for entry in signature_file.signatures {
        if !valid_identifier(&entry.key_id) || !key_ids.insert(entry.key_id.clone()) {
            bail!("the connector registry signature file is invalid");
        }
        let signature = decode_lower_hex::<64>(&entry.signature)
            .context("the connector registry signature file is invalid")?;
        let Some(public_key) = trust_policy.public_keys.get(&entry.key_id) else {
            continue;
        };
        let verifying_key = VerifyingKey::from_bytes(public_key)
            .context("the connector registry trust policy is invalid")?;
        if verifying_key
            .verify_strict(&signed_bytes, &Signature::from_bytes(&signature))
            .is_ok()
        {
            valid = true;
        }
    }
    if !valid {
        bail!("the connector registry has no valid signature from a trusted publisher");
    }
    Ok(())
}

fn appended_signature_path(registry_path: &Path) -> PathBuf {
    let mut value = registry_path.as_os_str().to_os_string();
    value.push(".sig.json");
    PathBuf::from(value)
}

fn decode_lower_hex<const N: usize>(value: &str) -> Result<[u8; N]> {
    if value.len() != N * 2
        || value != value.to_ascii_lowercase()
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        bail!("value is not canonical lowercase hex");
    }
    hex::decode(value)?
        .try_into()
        .map_err(|_| anyhow!("value has the wrong byte length"))
}

pub fn sign_request(secret: &[u8], timestamp: i64, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(b"v1:");
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b":");
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

pub fn verify_request_signature(
    secret: &[u8],
    headers: &HeaderMap,
    body: &[u8],
    now: i64,
) -> Result<()> {
    let timestamp = headers
        .get("x-byok-grid-timestamp")
        .context("missing request timestamp")?
        .to_str()?
        .parse::<i64>()
        .context("invalid request timestamp")?;
    if now.abs_diff(timestamp) > 60 {
        bail!("request timestamp is outside the allowed window");
    }
    let signature = headers
        .get("x-byok-grid-signature")
        .context("missing request signature")?
        .to_str()?;
    let signature = hex::decode(signature).context("invalid request signature")?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret)?;
    mac.update(b"v1:");
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b":");
    mac.update(body);
    mac.verify_slice(&signature)
        .map_err(|_| anyhow!("invalid request signature"))
}

pub fn unix_timestamp() -> Result<i64> {
    Ok(i64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
    )?)
}

fn validate_limits(limits: &RunnerLimits) -> Result<()> {
    if limits.fuel < 10_000 || limits.fuel > 1_000_000_000 {
        bail!("connector fuel limit is outside the supported range");
    }
    if limits.memory_bytes < 1_048_576 || limits.memory_bytes > 256 * 1_048_576 {
        bail!("connector memory limit is outside the supported range");
    }
    Ok(())
}

fn validate_registry_entry(entry: &RegistryEntry) -> Result<()> {
    if entry.artifact.path.as_os_str().is_empty()
        || entry
            .artifact
            .path
            .components()
            .any(|component| !matches!(component, Component::CurDir | Component::Normal(_)))
    {
        bail!("connector artifact path must stay inside the registry directory");
    }
    if !valid_identifier(&entry.manifest.id) {
        bail!("connector registry contains an invalid ID");
    }
    if !valid_semantic_version(&entry.manifest.version) {
        bail!("connector registry contains an invalid version");
    }
    if entry.artifact.sha256.len() != 64
        || !entry
            .artifact
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || entry.artifact.sha256 != entry.artifact.sha256.to_ascii_lowercase()
    {
        bail!("connector registry contains an invalid artifact digest");
    }
    Ok(())
}

fn validate_invocation(invocation: &InvocationEnvelope) -> Result<()> {
    if invocation.protocol_version != SANDBOX_PROTOCOL_VERSION {
        bail!("unsupported connector sandbox protocol");
    }
    if !valid_identifier(&invocation.connector_id)
        || !valid_identifier(&invocation.action_id)
        || !valid_semantic_version(&invocation.connector_version)
    {
        bail!("connector invocation contains an invalid identifier");
    }
    if !valid_uuid(&invocation.run_id) {
        bail!("connector invocation contains an invalid run ID");
    }
    if !invocation.credential.is_object()
        || !(invocation.continuation.is_null() || invocation.continuation.is_object())
    {
        bail!("connector invocation contains invalid capability data");
    }
    let _ = &invocation.input;
    Ok(())
}

fn validate_result(output: &[u8]) -> Result<()> {
    let result: Value =
        serde_json::from_slice(output).context("connector returned invalid JSON")?;
    let object = result
        .as_object()
        .context("connector result must be an object")?;
    if object.len() != 2
        || object.get("protocolVersion").and_then(Value::as_str) != Some(SANDBOX_PROTOCOL_VERSION)
    {
        bail!("connector result has an invalid protocol envelope");
    }
    let step = object
        .get("step")
        .and_then(Value::as_object)
        .context("connector result must contain a step")?;
    match step.get("kind").and_then(Value::as_str) {
        Some("complete") if step.len() == 2 && step.contains_key("output") => Ok(()),
        Some("failure")
            if step.len() == 4
                && step
                    .get("message")
                    .and_then(Value::as_str)
                    .is_some_and(|message| !message.is_empty() && message.len() <= 2_048)
                && step.get("retryable").is_some_and(Value::is_boolean)
                && step
                    .get("code")
                    .and_then(Value::as_str)
                    .is_some_and(|code| {
                        [
                            "authentication",
                            "invalid_input",
                            "policy",
                            "rate_limited",
                            "response_too_large",
                            "transient",
                            "upstream",
                        ]
                        .contains(&code)
                    }) =>
        {
            Ok(())
        }
        Some("http_request") => validate_http_step(step),
        _ => bail!("connector returned an invalid step"),
    }
}

fn validate_http_step(step: &serde_json::Map<String, Value>) -> Result<()> {
    if step.len() != 3 || !step.contains_key("state") {
        bail!("connector returned an invalid HTTP step");
    }
    let request = step
        .get("request")
        .and_then(Value::as_object)
        .context("connector HTTP step must contain a request")?;
    if request.len() != 4 {
        bail!("connector HTTP request has unknown fields");
    }
    let url = request
        .get("url")
        .and_then(Value::as_str)
        .context("connector HTTP request must contain a URL")?;
    if !url.starts_with("https://") || url.len() > 8_192 {
        bail!("connector HTTP request URL is not allowed");
    }
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .context("connector HTTP request must contain a method")?;
    if !["DELETE", "GET", "PATCH", "POST", "PUT"].contains(&method) {
        bail!("connector HTTP request method is not allowed");
    }
    let headers = request
        .get("headers")
        .and_then(Value::as_object)
        .context("connector HTTP request headers must be an object")?;
    if headers.len() > 128
        || headers.iter().any(|(name, value)| {
            name.is_empty()
                || name.len() > 256
                || value.as_str().is_none_or(|value| value.len() > 8_192)
        })
        || !(request.get("bodyBase64").is_some_and(Value::is_null)
            || request
                .get("bodyBase64")
                .and_then(Value::as_str)
                .is_some_and(|body| body.len() <= 1_500_000))
    {
        bail!("connector HTTP request has an invalid body or headers");
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_-".contains(&byte))
}

fn valid_semantic_version(value: &str) -> bool {
    let core = value.split_once('-').map_or(value, |(core, _)| core);
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && (part == &"0" || !part.starts_with('0'))
                && part.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use http::HeaderValue;
    use tempfile::TempDir;

    const INVOCATION: &str = r#"{"actionId":"lookup","connectorId":"reference","connectorVersion":"1.0.0","continuation":null,"credential":{},"input":{"domain":"example.com"},"protocolVersion":"1.0","runId":"10000000-0000-4000-8000-000000000001"}"#;

    #[test]
    fn executes_a_capability_free_digest_pinned_module() {
        let output = r#"{"protocolVersion":"1.0","step":{"kind":"complete","output":{"value":"sandboxed"}}}"#;
        let fixture = fixture_module(output, "reference", "1.0.0");
        let runner = ConnectorRunner::from_registry(
            fixture.directory.path(),
            fixture.registry,
            RunnerLimits::default(),
        )
        .unwrap();
        let result = runner.execute(INVOCATION.as_bytes()).unwrap();
        assert_eq!(String::from_utf8(result).unwrap(), output);
    }

    #[test]
    fn executes_the_documented_reference_registry() {
        let registry_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/connectors/reference/registry.json");
        let trust = RegistryTrustPolicy::from_json(
            r#"{"byok_grid_reference_2026":"d30d04cc80d66bff277650ce03561ed543a321921199f48de5c20355bb213e86"}"#,
            false,
            None,
        )
        .unwrap();
        let runner =
            ConnectorRunner::from_registry_path(registry_path, RunnerLimits::default(), &trust)
                .unwrap();
        let invocation = INVOCATION
            .replace("reference", "community_reference")
            .replace("\"lookup\"", "\"verify_isolation\"");
        let output = runner.execute(invocation.as_bytes()).unwrap();
        let value: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(value["step"]["output"]["isolation"], "no-host-imports");
    }

    #[test]
    fn authenticates_exact_registry_bytes_and_rejects_tampering() {
        let directory = TempDir::new().unwrap();
        let registry_path = directory.path().join("registry.json");
        let signature_path = appended_signature_path(&registry_path);
        let registry_bytes = b"{\"connectors\":[]}\n";
        fs::write(&registry_path, registry_bytes).unwrap();
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let mut signed_bytes = REGISTRY_SIGNATURE_CONTEXT.to_vec();
        signed_bytes.extend_from_slice(registry_bytes);
        let signature = signing_key.sign(&signed_bytes);
        fs::write(
            &signature_path,
            serde_json::to_vec(&serde_json::json!({
                "signatures": [{
                    "keyId": "test_publisher",
                    "signature": hex::encode(signature.to_bytes()),
                }],
                "version": 1,
            }))
            .unwrap(),
        )
        .unwrap();
        let trust = RegistryTrustPolicy::from_json(
            &serde_json::json!({
                "test_publisher": hex::encode(signing_key.verifying_key().to_bytes()),
            })
            .to_string(),
            false,
            None,
        )
        .unwrap();

        verify_registry_signature(&registry_path, registry_bytes, &trust).unwrap();
        let error = verify_registry_signature(&registry_path, b"{\"connectors\":[ ]}\n", &trust)
            .unwrap_err();
        assert!(error.to_string().contains("no valid signature"));

        let unsigned = RegistryTrustPolicy::from_json("{}", true, None).unwrap();
        verify_registry_signature(&registry_path, b"changed", &unsigned).unwrap();
        let secure_default = RegistryTrustPolicy::from_json("{}", false, None).unwrap();
        assert!(
            verify_registry_signature(&registry_path, registry_bytes, &secure_default)
                .unwrap_err()
                .to_string()
                .contains("trusted publisher key")
        );
    }

    #[test]
    fn rejects_imported_capabilities_and_digest_changes() {
        let directory = TempDir::new().unwrap();
        let artifact_path = directory.path().join("unsafe.wat");
        let artifact = br#"(module (import "env" "fetch" (func)) (memory (export "memory") 1) (func (export "alloc") (param i32) (result i32) i32.const 0) (func (export "execute") (param i32 i32) (result i64) i64.const 0))"#;
        fs::write(&artifact_path, artifact).unwrap();
        let entry = RegistryEntry {
            artifact: RegistryArtifact {
                path: PathBuf::from("unsafe.wat"),
                sha256: hex::encode(Sha256::digest(artifact)),
            },
            catalog: true,
            manifest: RegistryManifestIdentity {
                id: "reference".into(),
                version: "1.0.0".into(),
            },
        };
        let error = ConnectorRunner::from_registry(
            directory.path(),
            RegistryFile {
                connectors: vec![entry.clone()],
            },
            RunnerLimits::default(),
        )
        .err()
        .unwrap();
        assert!(error.to_string().contains("imports host capabilities"));

        let changed = RegistryEntry {
            artifact: RegistryArtifact {
                sha256: "0".repeat(64),
                ..entry.artifact.clone()
            },
            ..entry
        };
        let error = ConnectorRunner::from_registry(
            directory.path(),
            RegistryFile {
                connectors: vec![changed],
            },
            RunnerLimits::default(),
        )
        .err()
        .unwrap();
        assert!(error.to_string().contains("digest mismatch"));
    }

    #[test]
    fn fuel_stops_non_terminating_guest_code() {
        let directory = TempDir::new().unwrap();
        let artifact = br#"(module (memory (export "memory") 1) (func (export "alloc") (param i32) (result i32) i32.const 0) (func (export "execute") (param i32 i32) (result i64) (loop $forever br $forever) i64.const 0))"#;
        fs::write(directory.path().join("loop.wat"), artifact).unwrap();
        let runner = ConnectorRunner::from_registry(
            directory.path(),
            RegistryFile {
                connectors: vec![RegistryEntry {
                    artifact: RegistryArtifact {
                        path: PathBuf::from("loop.wat"),
                        sha256: hex::encode(Sha256::digest(artifact)),
                    },
                    catalog: true,
                    manifest: RegistryManifestIdentity {
                        id: "reference".into(),
                        version: "1.0.0".into(),
                    },
                }],
            },
            RunnerLimits {
                fuel: 10_000,
                memory_bytes: 1_048_576,
            },
        )
        .unwrap();
        let error = runner.execute(INVOCATION.as_bytes()).unwrap_err();
        assert!(format!("{error:#}").contains("fuel"));
    }

    #[test]
    fn memory_limit_rejects_an_oversized_guest() {
        let directory = TempDir::new().unwrap();
        let artifact = br#"(module (memory (export "memory") 32) (func (export "alloc") (param i32) (result i32) i32.const 0) (func (export "execute") (param i32 i32) (result i64) i64.const 0))"#;
        fs::write(directory.path().join("oversized.wat"), artifact).unwrap();
        let runner = ConnectorRunner::from_registry(
            directory.path(),
            RegistryFile {
                connectors: vec![RegistryEntry {
                    artifact: RegistryArtifact {
                        path: PathBuf::from("oversized.wat"),
                        sha256: hex::encode(Sha256::digest(artifact)),
                    },
                    catalog: true,
                    manifest: RegistryManifestIdentity {
                        id: "reference".into(),
                        version: "1.0.0".into(),
                    },
                }],
            },
            RunnerLimits {
                fuel: 10_000,
                memory_bytes: 1_048_576,
            },
        )
        .unwrap();
        let error = runner.execute(INVOCATION.as_bytes()).unwrap_err();
        assert!(format!("{error:#}").contains("memory"));
    }

    #[test]
    fn invocation_requires_a_real_uuid_shape() {
        let fixture = fixture_module(
            r#"{"protocolVersion":"1.0","step":{"kind":"complete","output":null}}"#,
            "reference",
            "1.0.0",
        );
        let runner = ConnectorRunner::from_registry(
            fixture.directory.path(),
            fixture.registry,
            RunnerLimits::default(),
        )
        .unwrap();
        let malformed = INVOCATION.replace(
            "10000000-0000-4000-8000-000000000001",
            "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
        );
        assert!(runner.execute(malformed.as_bytes()).is_err());
    }

    #[test]
    fn authenticates_requests_without_timing_sensitive_comparison() {
        let secret = b"a deployment secret with at least 32 bytes";
        assert_eq!(
            sign_request(secret, 123, b"{}"),
            "8d524e1773cbf6e03b66b2a33258d328a59322fbb4ec279f689b7466a9b99b83"
        );
        let timestamp = 1_785_565_000;
        let body = INVOCATION.as_bytes();
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-byok-grid-timestamp",
            HeaderValue::from_str(&timestamp.to_string()).unwrap(),
        );
        headers.insert(
            "x-byok-grid-signature",
            HeaderValue::from_str(&sign_request(secret, timestamp, body)).unwrap(),
        );
        verify_request_signature(secret, &headers, body, timestamp).unwrap();
        assert!(verify_request_signature(secret, &headers, b"changed", timestamp).is_err());
        assert!(verify_request_signature(secret, &headers, body, timestamp + 61).is_err());
    }

    struct FixtureModule {
        directory: TempDir,
        registry: RegistryFile,
    }

    fn fixture_module(output: &str, connector_id: &str, version: &str) -> FixtureModule {
        let directory = TempDir::new().unwrap();
        let pointer = 4_096_u64;
        let packed = (pointer << 32) | output.len() as u64;
        let escaped = output.replace('\\', "\\\\").replace('"', "\\\"");
        let artifact = format!(
            r#"(module
              (memory (export "memory") 1)
              (func (export "alloc") (param i32) (result i32) i32.const 0)
              (func (export "execute") (param i32 i32) (result i64) i64.const {packed})
              (data (i32.const {pointer}) "{escaped}"))"#
        );
        fs::write(directory.path().join("reference.wat"), artifact.as_bytes()).unwrap();
        FixtureModule {
            registry: RegistryFile {
                connectors: vec![RegistryEntry {
                    artifact: RegistryArtifact {
                        path: PathBuf::from("reference.wat"),
                        sha256: hex::encode(Sha256::digest(artifact.as_bytes())),
                    },
                    catalog: true,
                    manifest: RegistryManifestIdentity {
                        id: connector_id.into(),
                        version: version.into(),
                    },
                }],
            },
            directory,
        }
    }
}

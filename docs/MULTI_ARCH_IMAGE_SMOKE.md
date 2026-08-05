# Verify release images on both architectures

Every release image must execute on both platforms advertised by its OCI image
index. The release workflow runs the immutable digest for every target on
`linux/amd64` and `linux/arm64` before any version image tag is published.

## Release contract

Each of the seven images accepts one internal, side-effect-free argument:

```text
--image-smoke
```

The image must load its packaged runtime or application module graph and emit
exactly this two-field JSON object with its own target:

```json
{ "marker": "BYOK_GRID_IMAGE_SMOKE_READY", "target": "web" }
```

The target must be one of the exact entries in `release-images.json`. Smoke mode
does not read deployment secrets, open listeners, create a database, contact a
provider, or mutate storage. Normal startup remains fail closed and retains all
of its configuration checks.

The release job runs each immutable digest with:

- the explicit `linux/amd64` or `linux/arm64` platform;
- `--pull=always` so the platform manifest is resolved from the registry;
- no network;
- a read-only root filesystem;
- every Linux capability dropped;
- no-new-privileges;
- at most 64 processes; and
- a hard 30-second deadline.

The TypeScript worker-runtime images set `TSX_DISABLE_CACHE=1`. This prevents
their runtime loader from creating its default cache under `/tmp`, so the
packaged entrypoints work with a completely read-only root even when they are
run outside the supplied Helm chart. The chart still mounts an ephemeral
`/tmp` for application libraries and diagnostics that legitimately require
temporary storage.

QEMU is installed on the `amd64` GitHub runner so the `arm64` entrypoint and
native executables actually run. A dependency-free host parser accepts at most
4 KiB, requires the exact two-field response, checks the target against the
closed release matrix, and binds it to the expected platform and digest. It
emits:

```json
{
  "digest": "sha256:<digest>",
  "marker": "BYOK_GRID_RELEASE_IMAGE_SMOKE_VERIFIED",
  "platform": "linux/amd64",
  "target": "web"
}
```

Each image job uploads `release-smoke-<target>` containing exactly two JSONL
records. The image matrix does not finish—and version tags cannot publish—if
either architecture times out, exits unsuccessfully, emits malformed output,
or resolves to the wrong target contract.

The publish job downloads all seven artifacts into a closed directory. The
atomic release packager rejects missing or unexpected files, non-regular or
oversized input, malformed or expanded objects, duplicate/missing platforms,
unknown targets, and any digest mismatch. It writes the fourteen canonical
records to `IMAGE_SMOKE.jsonl`; that release asset is covered by `SHA256SUMS`
and the release-file attestation, so it remains auditable after the temporary
workflow artifacts expire.

## Independent release verification

The CI run is emulated architecture evidence, not native-hardware evidence.
Before stable promotion, use one native Linux `amd64` Docker server and one
native Linux `arm64` Docker server. Download the release's `IMAGE_DIGESTS.txt`
and `IMAGE_SMOKE.jsonl`, then check out the exact candidate source with no
tracked or untracked changes. Keep downloaded inputs and outputs outside the
checkout so clean-source verification remains meaningful. On each host, run
the collector with a different output path:

```text
npm run release:collect-native-smoke -- \
  --version 0.1.0-rc.2 \
  --candidate <40-character-candidate-commit> \
  --digest-manifest /path/to/IMAGE_DIGESTS.txt \
  --output native-amd64.json
```

The collector first requires the clean Git `HEAD` to equal the claimed
candidate. It refuses non-Linux hosts, unsupported CPU architectures, and a
Docker server whose reported OS/architecture differs from the Node.js host.
It then runs all seven exact digest references with the release workflow's
fixed network, filesystem, privilege, process, pull, platform, and timeout
boundary. Docker's server version, OS, and architecture come from structured
`docker version --format` fields. The output is a canonical, exclusively
created mode-`0600` record with no hostname, credentials, raw provider output,
or image stderr.

The equivalent single-image operation performed by the collector is:

```text
docker run --rm --pull=always \
  --platform linux/arm64 \
  --network=none \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=64 \
  ghcr.io/mherzog4/byok-grid-web@sha256:<digest> \
  --image-smoke
```

The collector verifies this output in memory without placing it in a command
argument. For isolated diagnosis, a shell with pipeline failure propagation may
run the image command above directly into:

```text
node scripts/verify-release-image-smoke.mjs \
  web linux/arm64 sha256:<digest>
```

After both hosts finish within one 24-hour collection window, combine and
verify their canonical records against the attested release manifest:

```text
npm run release:verify-native-smoke -- \
  --version 0.1.0-rc.2 \
  --candidate <40-character-candidate-commit> \
  --digest-manifest /path/to/IMAGE_DIGESTS.txt \
  --release-smoke /path/to/IMAGE_SMOKE.jsonl \
  --amd64-evidence /path/to/native-amd64.json \
  --arm64-evidence /path/to/native-arm64.json \
  --output native-multi-architecture.json
```

The offline verifier requires exactly one matching native record per platform,
all seven digest-bound targets on both hosts, canonical target order, matching
candidate/version/manifest identity, matching Docker architecture, no future
timestamps, and the exact same fourteen records as the checksummed release
asset. It emits `BYOK_GRID_NATIVE_MULTI_ARCH_IMAGE_SMOKE_VERIFIED` only after
the closed set passes.

Retain both native-host records, the combined record, Docker server versions,
the attested `IMAGE_SMOKE.jsonl` asset, the release digest manifest, and the
workflow URL. The stable `multi-architecture-smoke` evidence record hashes the
combined artifact and must carry both
`BYOK_GRID_NATIVE_MULTI_ARCH_IMAGE_SMOKE_VERIFIED` and
`BYOK_GRID_RELEASE_IMAGE_SMOKE_VERIFIED`.

## Boundary

Image smoke proves that the selected platform manifest can start its packaged
entrypoint/runtime under a restrictive container boundary. It does not prove
database connectivity, authenticated Hatchet registration, ingress behavior,
provider credentials, migration safety, or sustained capacity. Those remain
separate deployment, recovery, drain, and capacity gates.

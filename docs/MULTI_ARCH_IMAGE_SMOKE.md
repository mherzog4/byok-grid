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

## Independent release verification

The CI run is emulated architecture evidence, not native-hardware evidence.
Before stable promotion, boot the published manifest-list digest once on a
native `amd64` host and once on a native `arm64` host using the same isolation
flags. Pipe the exact image output into the verifier from the matching release
source:

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

Verify the output without placing it in a command argument. In a shell with
pipeline failure propagation enabled, run the image command above directly into:

```text
node scripts/verify-release-image-smoke.mjs \
  web linux/arm64 sha256:<digest>
```

Retain the two native-host verifier records, host architecture/runtime details,
the seven workflow JSONL artifacts, the release digest manifest, and the
workflow URL. The stable `multi-architecture-smoke` evidence record must carry
the `BYOK_GRID_RELEASE_IMAGE_SMOKE_VERIFIED` marker and hash the retained bundle.

## Boundary

Image smoke proves that the selected platform manifest can start its packaged
entrypoint/runtime under a restrictive container boundary. It does not prove
database connectivity, authenticated Hatchet registration, ingress behavior,
provider credentials, migration safety, or sustained capacity. Those remain
separate deployment, recovery, drain, and capacity gates.

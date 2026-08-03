# BYOK Grid Airbyte destination

This is an Apache-2.0, language-agnostic Airbyte destination executable for
BYOK Grid's push-ingestion API. It is distributed separately from the AGPL
application and does not embed, link, or ship the Airbyte platform.

The adapter implements Airbyte's `spec`, `check`, and `write` commands over
newline-delimited protocol messages. Each Airbyte stream maps to a separate
table-scoped BYOK Grid endpoint. Records are batched, accepted with stable HTTP
idempotency, and polled until grid application succeeds before the corresponding
Airbyte `STATE` message is acknowledged.

The package license notice is in `LICENSE`; the full Apache License 2.0 text is
committed at `../connector-sdk/LICENSE` and copied into the destination image.

## Build and inspect

```bash
docker build --target airbyte-destination \
  -t byok-grid/airbyte-destination:0.1.0 .

docker run --rm byok-grid/airbyte-destination:0.1.0 spec
```

## Configuration

Create one push endpoint per Airbyte stream in BYOK Grid. The bearer tokens are
shown once and must be stored in Airbyte's secret configuration.

```json
{
  "routes": [
    {
      "namespace": "crm",
      "stream": "companies",
      "endpoint_url": "https://grid.example.com/api/ingest/ENDPOINT_UUID",
      "bearer_token": "bg_ingest_REDACTED"
    }
  ],
  "batch_maximum_records": 500,
  "batch_maximum_bytes": 4194304,
  "application_timeout_seconds": 600
}
```

HTTPS is mandatory by default. A trusted local deployment can explicitly set
`"allow_insecure_http": true`; never use this on an untrusted network.

The configured Airbyte catalog may use `append` or `append_dedup`. BYOK Grid
does not advertise `overwrite`, because push endpoints preserve records missing
from a delivery and do not implement truncate or delete propagation.
Fields omitted from an individual record are also preserved; explicit null or
an empty string clears a mapped cell.

## Data mapping

- Top-level strings, booleans, finite numbers, and null are sent as grid scalar
  values.
- Nested objects and arrays are converted to canonical JSON strings so common
  Airbyte records remain ingestible by a flat grid.
- Integers outside JavaScript's safe range fail closed. Sources should emit
  those identifiers or measurements as strings to prevent silent precision
  loss. Precision-sensitive decimals should also be emitted as strings because
  the Airbyte JSON protocol and this Node.js adapter use binary floating point.
- The endpoint's configured record-key field must be present and scalar in
  every record.
- Each stream is limited to the server's 100-field, 1,000-record, and 5 MiB
  boundaries; the adapter defaults below those ceilings.

## Check and write locally

```bash
docker run --rm \
  -v "$PWD/config.json:/config.json:ro" \
  byok-grid/airbyte-destination:0.1.0 \
  check --config /config.json

docker run --rm -i \
  -v "$PWD/config.json:/config.json:ro" \
  -v "$PWD/catalog.json:/catalog.json:ro" \
  byok-grid/airbyte-destination:0.1.0 \
  write --config /config.json --catalog /catalog.json < messages.jsonl
```

The `check` command performs authenticated, read-only capability checks. The
configured batch limits must fit every endpoint's advertised server limits. The
`write` command never prints endpoint tokens, configuration, record bodies, or
HTTP response bodies. Redirects are denied so a configured token cannot be
forwarded to another origin.

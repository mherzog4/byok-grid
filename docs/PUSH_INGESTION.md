# Push ingestion guide

Push endpoints let a user-owned Airbyte deployment, another ELT tool, or a
small script upsert records into one BYOK Grid table without database access.
They are an optional interoperability boundary, not a required runtime service.

## Create an endpoint

Workspace owners and admins can create an endpoint in the **Push ingestion**
panel. Choose a field that is stable and unique within every delivery, such as
`company_id`. Copy the endpoint URL and bearer token immediately. BYOK Grid
stores only a one-way token digest and cannot reveal the token again.

## Send records

```bash
curl -X POST 'https://grid.example.com/api/ingest/ENDPOINT_UUID' \
  -H 'Authorization: Bearer bg_ingest_REDACTED' \
  -H 'Idempotency-Key: source-job-2026-08-01-slice-0001' \
  -H 'Content-Type: application/json' \
  --data '{"records":[{"company_id":"company-1","name":"Acme","active":true}]}'
```

The response is `202 Accepted`:

```json
{
  "id": "BATCH_UUID",
  "status": "queued",
  "recordCount": 1,
  "createdRowCount": 0,
  "updatedRowCount": 0,
  "errorMessage": null,
  "replayed": false
}
```

The `Location` response header points to a bearer-authenticated status route.
Poll that URL until the batch is `succeeded` or `failed`. Retrying the exact
request with the same idempotency key returns the original batch with
`replayed: true`. Reusing the key with different request bytes returns `409`.

## Contract and limits

- Requests contain `{"records": [...]}` with 1–1,000 records and are at most
  5 MiB.
- Records are flat JSON objects. Values may be strings, finite numbers,
  booleans, or null; nested objects and arrays are rejected.
- A delivery exposes at most 100 fields. New fields create or reuse input
  columns under the same collision policy as CSV and scheduled sources.
- Record keys are trimmed strings up to 500 characters and must be unique
  inside a delivery.
- Missing remote records are preserved. The endpoint is upsert-only and does
  not infer deletions.
- Within a delivered record, omitted known fields preserve the old value.
  Explicit null or an empty string clears the mapped cell, so a delivery can
  express PATCH-like updates without pretending to be a complete snapshot.

## Airbyte adapter shape

The repository includes a separately licensed, optional destination image in
`packages/airbyte-destination`. Build it with:

```bash
docker build --target airbyte-destination \
  -t byok-grid/airbyte-destination:0.1.0 .
```

Its `spec`, `check`, and `write` commands implement the Airbyte Docker protocol.
Each configured stream maps to its own table endpoint. Nested values become
canonical JSON strings, and `STATE` is emitted only after every preceding grid
batch reports `succeeded`. See the package README for configuration and local
command examples.

Keep the Airbyte-specific component thin and outside the core deployment:

1. Buffer a bounded group of destination records.
2. Convert Airbyte values to the flat scalar envelope above.
3. Derive a stable idempotency key from the sync job, stream, and slice.
4. POST the exact same bytes again when retrying that key.
5. Treat `202` as durable acceptance and poll `Location` if the sync must wait
   for grid application.

The adapter should store only the endpoint URL and table-scoped token. Do not
give it SQLite/libSQL credentials, the workspace encryption key, or enrichment
provider credentials.

## Operations and security

Terminate TLS before the Next.js service and never put tokens in URLs or logs.
Revoke an endpoint immediately if its token is exposed; in-flight accepted
batches remain auditable, while new deliveries and status reads are rejected.
Monitor queued/failed batch counts in SQLite. The optional ClickHouse
projector consumes aggregate completion events, but it must not become the
batch-status authority.

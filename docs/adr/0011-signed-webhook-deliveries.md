# ADR 0011: Durable signed webhook row deliveries

- Status: Accepted
- Date: 2026-07-31

## Context

An enrichment table is only one part of a data workflow. Completed records must
reach CRMs, automation tools, and customer-controlled services without requiring
those systems to poll the grid database. A direct request from the browser would
lose deliveries on navigation, expose credentials, and make retries depend on a
mutable row.

Airbyte's source and destination catalog is useful for bulk synchronization, but
it is not the default runtime for an operator-approved single-row action. The
core project needs a small outbound contract that works in every self-hosted
deployment and can later sit beneath provider-specific writeback adapters.

## Decision

Webhook destinations belong to one workspace table and reference a
workspace-encrypted signing credential. Creating a destination validates a
credential-free HTTPS URL; the worker repeats that validation and uses the same
DNS-pinned egress policy as connectors and scheduled sources.

Queueing a row creates an immutable versioned payload snapshot, a delivery
record, and a transactional-outbox event in one PostgreSQL transaction. A
client-generated UUID is both the delivery identity and command idempotency key.
Reusing it for the same destination and row returns the existing delivery;
reusing it for another target fails.

Hatchet executes `execute-webhook-delivery` with delivery-ID idempotency, a
30-second request deadline, exponential backoff, and up to five attempts. A
successful response is any HTTP 2xx. HTTP 408, 425, 429, and 5xx responses retry;
redirects and other 3xx/4xx responses fail permanently. Pausing a destination
blocks new commands but does not revoke a previously committed delivery.

The exact compact JSON body is signed as:

```text
HMAC-SHA256(secret, timestamp + "." + delivery_id + "." + body)
```

Receivers get these headers:

- `Idempotency-Key` and `X-BYOK-Grid-Delivery`: delivery UUID;
- `X-BYOK-Grid-Event`: `row.delivered`;
- `X-BYOK-Grid-Timestamp`: Unix timestamp in seconds; and
- `X-BYOK-Grid-Signature`: lowercase hexadecimal digest prefixed by `v1=`.

Receivers should reject stale timestamps, compare signatures in constant time,
and persist delivery IDs before applying side effects. A retry has the same body
and delivery ID but a fresh timestamp and signature. Response bodies are neither
read nor retained. Only status codes and sanitized internal errors enter the
delivery audit record.

The first UI deliberately queues individual rows. Automatic delivery is a
separate, explicit destination setting whose readiness, version-coalescing, and
loop boundaries are defined in ADR 0012; configuring a destination defaults to
manual and does not start unannounced traffic.

## Consequences

- The default outbound path uses Next.js, PostgreSQL, Hatchet, and the existing
  TypeScript worker; Airbyte is not required.
- Every attempt is auditable without retaining receiver response data or placing
  secrets in an outbox or Hatchet payload.
- Payloads are limited to 500 columns and 512 KiB. Each cell retains its tagged
  value and execution status so receivers do not have to infer types.
- Provider-specific CRM writebacks can reuse the durable command and audit model
  while replacing the generic HTTP adapter with fixed schemas and host policies.
- ClickHouse may later receive append-only delivery metrics, but PostgreSQL owns
  destination configuration and delivery state.

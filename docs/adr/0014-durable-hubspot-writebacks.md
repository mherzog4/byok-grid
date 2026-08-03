# ADR 0014: Durable fixed-host CRM writebacks

- Status: Accepted
- Date: 2026-07-31

## Context

A Clay-like grid must return enriched values to a system of record. Generic
webhooks already provide a receiver-owned outbound contract, but CRM writeback
needs provider authentication, record identity, field mapping, provider-specific
payloads, and an auditable retry result. Allowing arbitrary URLs and bodies
would turn every workspace into an unreviewed connector implementation.

## Decision

The first writeback adapter updates one HubSpot contact. A destination belongs
to one workspace table and stores:

- a workspace-encrypted HubSpot private-app credential reference;
- one text or number column containing the HubSpot contact record ID; and
- one to 50 unique grid-column-to-HubSpot-property mappings.

Property names are restricted to bounded lowercase internal names. JSON cells
cannot be mapped. Empty cells serialize as the empty string, which HubSpot
documents as the property-clearing value. Text, number, boolean, and timestamp
cells serialize as strings.

Queueing a row freezes its version, record ID, and mapped property values in a
bounded immutable payload. The delivery record and transactional-outbox event
commit together. A client-generated delivery UUID is the command identity and
Hatchet idempotency key; replaying the same UUID for the same target returns the
existing command, while reusing it for another row or destination fails.

The worker decrypts the credential just in time and executes only:

```text
PATCH https://api.hubapi.com/crm/objects/2026-03/contacts/{recordId}
{"properties": {...}}
```

The connector pins `api.hubapi.com`, rejects redirects, bounds the response,
and sends bearer authentication plus the delivery UUID as `Idempotency-Key`.
Authentication and validation failures are permanent. Network failures, HTTP
429, and 5xx responses retry up to three times with durable attempt state.
Only the status code and sanitized error are retained; HubSpot response bodies
and credentials do not enter SQLite run history, outbox payloads, or
Hatchet inputs.

Writeback initially shipped as manual-only. Only input cells (`idle`) and successfully
settled computed cells may be mapped into a delivery; queued, running, stale,
failed, and cancelled cells block queueing. HubSpot cannot receive the local
cell status beside each property, so exporting a failed cell's last visible
value would hide an important loss of provenance. ADR 0027 adds opt-in
conditional row-settlement triggers, semantic loop suppression, and a bounded
event fan-out while preserving this readiness rule.

## Delivery semantics

The update body contains only scalar assignments, so replaying it converges on
the same property values. Nevertheless, no external PATCH can provide a local
exactly-once guarantee after an ambiguous timeout. Operators must expect a
request to be repeated and should monitor the provider's audit history. The
delivery UUID remains stable across retries even if HubSpot does not honor the
idempotency header for this endpoint.

## Adapter boundary

New CRM writebacks must reuse the destination, immutable command, audit, and
outbox model while defining a fixed host, credential schema, payload schema,
property semantics, and retry classification. Workspace-controlled executable
packages or arbitrary request bodies are not accepted in the in-process worker.

Airbyte may later serve as an optional, user-owned bulk destination adapter; it
does not replace low-latency row commands. ClickHouse may receive append-only
writeback metrics, but SQLite owns configuration and current delivery state.

## Consequences

- The default installation gains a real CRM writeback without adding runtime
  application infrastructure beyond Next.js, SQLite/libSQL, Hatchet, and the
  Node worker. Hatchet may privately use PostgreSQL.
- Provider tokens remain in the existing envelope-encrypted BYOK vault.
- Workspace-scoped SQLite repositories isolate destinations and delivery audit
  records.
- Companies, deals, custom objects, OAuth refresh, batch updates, and
  reconciliation remain explicit future adapters or policies.

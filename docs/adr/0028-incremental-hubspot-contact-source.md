# ADR 0028: Incremental HubSpot contact source

## Status

Accepted.

## Context

A useful Clay-like workflow must acquire CRM records before enriching and
writing them back. The generic HTTPS source can read snapshots, but asking each
self-hoster to reconstruct HubSpot search filters, nested response flattening,
cursor paging, and incremental state would make correctness depend on mutable
workspace configuration. Making Airbyte mandatory for one common CRM would add
a second control plane to the default installation.

HubSpot exposes stable contact IDs, selected properties, modification-time
filters, sorting, and opaque cursor pagination. Search indexing is not the same
as the transactional write path, so a run must avoid querying right up to its
observation time.

## Decision

`hubspot_contacts` is a trusted source adapter executed by the existing Hatchet
source task. A workspace supplies an envelope-encrypted HubSpot private-app
token, selected internal property names, an initial timestamp, schedule, and
run limits. It cannot configure the provider host, method, path, headers,
filter operator, sort, page size, or record identity.

Each run freezes a half-open modification window `[start, end)`. The first start
is the authored initial timestamp; later starts use the last completed
watermark. End is five minutes before the worker observes the run, providing a
bounded indexing-safety lag. The fixed request filters `hs_lastmodifieddate`
with `GTE start` and `LT end`, sorts ascending by that property, requests 100
contacts, and calls only `api.hubapi.com` through guarded worker egress.

HubSpot's `paging.next.after` remains per-run state. It is encrypted with the
workspace key, authenticated to the run ID, and committed atomically with each
applied page. The frozen start and end timestamps are stored on the run, so a
retry cannot move the query window. The source watermark advances to the run's
end only when a response has no next cursor and the terminal page transaction
commits. A failed, partial, page-limited, or record-limited run leaves the old
watermark intact; a new run safely replays the same stable contact identities.

The adapter flattens the contact ID, requested scalar properties, provider
creation/update timestamps, and archived flag into source fields. The HubSpot
contact ID is the immutable source record key. PostgreSQL's existing source
identity mapping, field mapping, formula recomputation, row settlement, and RLS
remain unchanged.

Incremental search is not a full contact snapshot. Missing-record mode is
therefore forced to `preserve`, and absent contacts never imply deletion.
Provider deletion or archival ingestion requires a separately designed feed or
reconciliation adapter with explicit completeness evidence.

## Consequences

- The default Next.js/PostgreSQL/Hatchet stack now supports a native CRM
  acquisition → enrichment → conditional writeback loop.
- Airbyte remains optional for its broader catalog and does not become a
  prerequisite for HubSpot contacts.
- Cursor recovery and incremental progress are independently inspectable; one
  cannot accidentally substitute for the other.
- Records changed during the safety-lag interval appear in a later run rather
  than risking an indexing race in the current one.
- A private app needs the HubSpot contacts read scope. OAuth installation,
  provider deletion feeds, associations, custom objects, and property metadata
  discovery remain future provider adapters.

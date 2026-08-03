# ADR 0044: Rotate deployment master keys through an overlapped keyring

- Status: Accepted
- Date: 2026-08-03

## Context

ADR 0002 stores a master-key identifier with every wrapped workspace data key,
but the runtime previously accepted only one master key. Changing the deployment
key therefore made existing workspace credentials and encrypted source cursors
unreadable. Re-encrypting every credential would unnecessarily expose provider
secret plaintext, create a long transaction, and miss in-flight cursor state.

A rolling deployment also creates a compatibility window: old replicas know the
old current key while new replicas know the new current key. Rewrapping before
both generations can read both IDs can break live jobs.

## Decision

The deployment configures one current master key and an optional bounded JSON
map of up to eight additional decrypt-only keys. New workspaces always use the
current key. Web and worker processes select the unwrapping key from the
authenticated envelope ID and fail closed when it is unavailable.

The SQLite maintenance command has separate `plan` and `apply` modes. Plan
authenticates every workspace key without mutation. Apply requires the expected
current key ID, repeats the full inspection, and rewraps only workspace data
keys in batches of 100 immediate transactions. It validates the relational and
envelope key IDs, uses conditional updates, verifies zero pending rows, and
emits only aggregate counts and the current key ID.

Operators first deploy both keys with the old key current, then roll both keys
with the new key current, drain old replicas, plan, apply, verify canaries, and
finally remove the old runtime key. Old key material remains in the backup-key
archive until every backup that needs it expires.

## Consequences

- Provider credentials and cursors are not decrypted or rewritten during
  deployment-key rotation.
- Interrupted rotation is resumable while the overlap keyring remains present.
- Additional keys expand the live secret set temporarily and must be removed
  after successful verification, subject to separate backup recovery retention.
- Key IDs are operational metadata and explicit apply confirmation; key values
  remain secret environment data and never appear in CLI output.
- PostgreSQL compatibility workers can read an overlap keyring, while the
  supported SQLite-first maintenance command owns rewrapping.

## Verification

Security unit tests cover bounded parsing, ambiguity rejection, overlap reads,
unavailable keys, and cryptographic rewrap. SQLite integration tests freeze
credential ciphertext, create credentials during overlap, rotate the workspace
key, decrypt both old and new credentials, prove idempotency, and reject missing
keys or inconsistent IDs. A child-process test exercises the real CLI plan,
wrong confirmation, apply, markers, counts, and output redaction. Compose and
Helm contract tests require the optional Secret on web and worker workloads.

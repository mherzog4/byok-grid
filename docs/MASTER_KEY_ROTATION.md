# Deployment master-key rotation

BYOK Grid envelope-encrypts one random data key per workspace. Credentials and
source cursors are encrypted by that workspace key; the deployment master key
wraps only the workspace key. Rotation therefore rewraps one small envelope per
workspace and does not decrypt or rewrite provider secrets, cursor plaintext,
workflow inputs, or cell data.

## Configuration contract

Every web and workflow-worker replica must receive the same three values:

- `BYOK_GRID_MASTER_KEY_ID`: the ID used for newly created workspace keys;
- `BYOK_GRID_MASTER_KEY`: its canonical base64-encoded 32-byte key; and
- `BYOK_GRID_ADDITIONAL_MASTER_KEYS`: an optional JSON object mapping old or
  staged key IDs to canonical base64-encoded 32-byte keys.

The additional set is decrypt-only and limited to eight keys and 4 KiB. The
current ID cannot be repeated, and one key value cannot appear under multiple
IDs. IDs contain 1 to 128 non-control characters without surrounding
whitespace. Keep the JSON and all key values in the deployment Secret, never a
ConfigMap, image, command argument, issue, or log.

## Zero-downtime sequence

Assume `old-v1` is current and `new-v2` is the replacement. Generate `new-v2`
in the secret manager; do not derive it from `old-v1`.

1. Create and independently verify a database backup. Preserve `old-v1` in the
   backup-key archive for at least as long as any backup wrapped by it can be
   restored.
2. Keep `old-v1` current and add `new-v2` to
   `BYOK_GRID_ADDITIONAL_MASTER_KEYS`. Roll every web and worker replica. Prove
   readiness and a credential-backed provider canary. At this point old and new
   application versions can both read `old-v1` workspaces.
3. Set `new-v2` as the current ID and key, and move `old-v1` into the additional
   JSON object. Roll every replica again and wait for the old replica set to
   drain. During this rollout, both generations can read both key IDs; new
   workspaces may safely be created by either generation.
4. Run the read-only plan. It authenticates every workspace-key envelope and
   stops if a required key is absent or the relational and envelope IDs differ:

   ```text
   npm run db:master-key:plan
   ```

   Compose operators use the same maintenance image and shared SQLite volume:

   ```text
   docker compose --profile maintenance run --rm sqlite-maintenance \
     master-key-rotation plan
   ```

5. Review the plan's `currentKeyId`, `total`, and `pending` counts. Apply only
   after the current ID is exactly the intended replacement:

   ```text
   npm run db:master-key:apply -- new-v2
   ```

   ```text
   docker compose --profile maintenance run --rm sqlite-maintenance \
     master-key-rotation apply new-v2
   ```

   The current ID is a confirmation, not key material. Keys stay in environment
   variables supplied by the secret manager.

6. Rerun the plan and require `pending: 0`. Exercise credential creation,
   enrichment, source, webhook, and writeback canaries before closing the
   change window.
7. Remove `old-v1` from the live additional set and roll every replica. Keep its
   material in the protected backup-key archive until every pre-rotation backup
   has expired or been re-encrypted and restore-tested. Only then destroy it.

For Kubernetes, run the digest-pinned maintenance image as a short-lived,
operator-owned Job with the same SQLite/libSQL Secret, current master-key ID,
current key, and additional-key Secret entries as the web and worker. Use
`master-key-rotation plan`, then replace the args with
`master-key-rotation apply new-v2` after review. The Job must use the same
provider-specific egress policy as migration and backup jobs; do not weaken the
runtime default-deny policy globally.

## Failure and recovery behavior

Plan never writes. Apply first performs the same complete inspection, then
rewraps at most 100 workspaces per immediate transaction. Each row is updated
only while its old key ID still matches. If a process, network, or database
failure interrupts apply, the database can contain a safe mixture of old and
new envelopes because every live process still has both keys. Rerun plan and
apply; completed rows are skipped.

Do not remove an old runtime key while `pending` is nonzero. Do not edit
`workspace_keys` directly, rotate by rewriting credentials, or restore a
pre-rotation backup without its matching archived key. If authentication of an
envelope fails, stop, preserve the database, confirm secret-manager versions
and key IDs, and restore only through the tested backup procedure.

The local integration suite proves overlap reads, ciphertext preservation,
bounded idempotent rewrap, unavailable-key rejection, identifier mismatch
rejection, explicit apply confirmation, and CLI output redaction. A production
deployment must still rehearse this procedure against its chosen remote libSQL
provider, replica topology, secret manager, and backup retention policy.

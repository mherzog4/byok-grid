# Remote libSQL production drill

Run this gate against a newly migrated, isolated preproduction database from
the chosen remote libSQL provider. Never point it at a database containing
customer or operator data. The command enforces `libsql://`, requires an auth
token and an explicit confirmation phrase, verifies the current migration
count, and refuses any application rows before creating its probe.

The drill proves three separate properties:

1. a writer commits a unique challenge and is then forcibly terminated with
   `SIGKILL`;
2. a fresh Node.js process observes that committed challenge through an
   independent libSQL client; and
3. an independently restored database contains the same challenge, migration
   ledger, and complete SQLite schema fingerprint.

It does not invoke a provider backup API because backup creation, retention,
encryption, and restore are provider-owned controls. The two phases leave that
operation explicit and auditable.

## 1. Prepare and prove process-loss durability

Apply the candidate's SQLite migrations to the isolated database using the
normal migration job. Then run:

```text
BYOK_GRID_REMOTE_DRILL_CONFIRM=isolated-preproduction-database \
SQLITE_DATABASE_URL=libsql://candidate.example.net \
SQLITE_AUTH_TOKEN=REPLACE_WITH_SECRET \
npm run drill:remote-libsql -- prepare
```

Supply secrets through an ephemeral secret manager session rather than shell
history or a checked-in `.env` file. An optional
`BYOK_GRID_REMOTE_DRILL_TIMEOUT_SECONDS` may be set from 5 through 120; the
default is 30 seconds per child process.

The command first emits `BYOK_GRID_REMOTE_LIBSQL_IDENTITY_CREATED` with the
UUIDv4 `runId`, non-secret `challengeSha256`, and UTC time. Save it immediately;
it permits exact cleanup if the coordinator host itself fails. It is not a pass
record and does not authorize a snapshot.

A passing command then emits `BYOK_GRID_REMOTE_LIBSQL_PREPARED` with the same
identity, independent-observer evidence, writer exit signal `SIGKILL`, and a UTC
preparation timestamp. Only this second marker authorizes the provider snapshot.
The probe remains in the isolated database so the snapshot can capture it.

## 2. Create and restore the provider backup

Using the provider's authenticated administrative plane:

1. create a named backup or point-in-time recovery checkpoint after the prepare
   marker;
2. wait until the provider reports the backup durable;
3. restore it to a second isolated database with a different `libsql://` URL;
4. issue a separate least-privilege auth token for the restored database; and
5. retain provider operation IDs and UTC timestamps without copying tokens into
   release evidence.

Do not continue if the restored URL aliases the original database.

## 3. Verify the restore and clean both probes

Use the saved run ID and challenge exactly as emitted by `prepare`:

```text
BYOK_GRID_REMOTE_DRILL_CONFIRM=isolated-preproduction-database \
SQLITE_DATABASE_URL=libsql://candidate.example.net \
SQLITE_AUTH_TOKEN=REPLACE_WITH_LIVE_SECRET \
BYOK_GRID_RESTORE_DATABASE_URL=libsql://restored.example.net \
BYOK_GRID_RESTORE_AUTH_TOKEN=REPLACE_WITH_RESTORE_SECRET \
npm run drill:remote-libsql -- verify RUN_ID CHALLENGE_SHA256
```

Verification requires both databases to contain no application data beyond the
drill probe, checks the exact probe identity, compares current migration counts
and SHA-256 fingerprints of the migration ledger, full non-internal
`sqlite_schema`, and every non-internal table's row count, then drops the probe
table from the restored database followed by the original. Success emits
`BYOK_GRID_REMOTE_LIBSQL_RESTORE_VERIFIED` with only the run ID, migration
count, non-secret fingerprints, cleanup status, and UTC verification timestamp.

If the provider backup or restore is abandoned after `prepare`, remove the
original probe with:

```text
BYOK_GRID_REMOTE_DRILL_CONFIRM=isolated-preproduction-database \
SQLITE_DATABASE_URL=libsql://candidate.example.net \
SQLITE_AUTH_TOKEN=REPLACE_WITH_SECRET \
npm run drill:remote-libsql -- cleanup RUN_ID CHALLENGE_SHA256
```

Cleanup verifies the exact saved identity before dropping anything. If
automatic rollback after a failed prepare cannot remove the probe, the command
prints a structured `BYOK_GRID_REMOTE_LIBSQL_CLEANUP_REQUIRED` record containing
the non-secret identity needed for this command.

If `verify` fails after cleaning only one database, point the cleanup command at
the database that still contains the probe. Do not treat a fingerprint match as
passing evidence until the restore-verified marker confirms cleanup completed.

## Evidence and limitations

Retain the prepare and verified marker lines, provider backup and restore IDs,
database regions, provider/server versions, UTC timestamps, image digests,
observed duration, and operator identity. Destroy the isolated databases,
tokens, and test backup according to the provider's audited process after the
evidence is accepted.

This drill proves remote visibility, committed-write survival after abrupt
client loss, and one provider restore. It does not establish application
capacity, steady-state failover time, regional disaster recovery, backup
retention, encryption posture, or an RPO/RTO guarantee. Measure and approve
those separately before stable promotion.

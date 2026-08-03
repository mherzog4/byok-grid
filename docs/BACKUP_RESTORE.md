# SQLite backup and restore

BYOK Grid treats a restore drill—not the existence of a copied file—as proof of
recoverability. Local SQLite deployments use the repository backup CLI. Remote
`libsql://` deployments must use their libSQL service's snapshot/export system
and exercise an equivalent isolated restore.

## Local online backup

Set `SQLITE_DATABASE_URL` to the same absolute `file:` URL used by the running
application, then choose a new output path:

```text
SQLITE_DATABASE_URL=file:/srv/byok-grid/data/byok-grid.sqlite \
  npm run db:backup -- /srv/byok-grid/backups/byok-grid-2026-08-03.sqlite
```

The command uses SQLite's online `VACUUM INTO` snapshot rather than copying the
main file. It refuses to overwrite a file, writes through a private temporary
file, checks database and foreign-key integrity, verifies the BYOK Grid schema
and migration history, applies mode `0600`, and atomically renames the verified
artifact. Its JSON output includes the SHA-256 digest, size, migration count,
and verification time. Persist that metadata beside the encrypted backup.

For the Compose deployment, mount a host backup directory and run the same
maintenance image against the shared SQLite volume:

```text
BACKUP_HOST_PATH=/absolute/private/backup/path \
  docker compose --profile maintenance run --rm sqlite-maintenance \
  backup /backups/byok-grid-2026-08-03.sqlite
```

Do not use `cp` against the live main database, and do not treat a `.sqlite-wal`
or `.sqlite-shm` file as an independent backup.

## Verification and safe restore

Verify a retained artifact without changing application state:

```text
npm run db:backup:verify -- /srv/byok-grid/backups/byok-grid-2026-08-03.sqlite
```

Restore always creates a new file and refuses overwrite:

```text
npm run db:restore -- \
  /srv/byok-grid/backups/byok-grid-2026-08-03.sqlite \
  /srv/byok-grid/restores/byok-grid-restored.sqlite
```

This copy is verified again and must have the exact digest of the source backup.
Use this production recovery sequence:

1. Stop the web, workflow worker, projector, and migration processes.
2. Restore to a new path on the same class of durable storage.
3. Start an isolated web/worker deployment against the restored file with
   outbound provider egress disabled.
4. Verify sign-in, workspace/table counts, recent workflow history, credential
   decryption with the separately restored master key, and `/api/health`.
5. Point `SQLITE_DATABASE_URL` at the restored file and start one migration job
   before application processes.
6. Retain the previous database and its WAL/SHM sidecars until recovery has been
   accepted; do not merge old sidecars into the restored database.

## Production policy

- Encrypt backups before they leave the host and keep at least one copy in a
  separate failure domain with immutable or write-once retention.
- Back up `BYOK_GRID_MASTER_KEY` and its key ID through a separate secret-manager
  recovery process. Database backups contain encrypted credentials but not the
  key needed to decrypt them.
- Define recovery point and recovery time objectives, schedule backups more
  frequently than the recovery point objective, and alert on missed jobs.
- Run a restore drill after schema changes and at least quarterly. Record the
  backup digest, release version, duration, and operator approval.
- Test remote libSQL provider exports by restoring into an isolated database;
  provider snapshot existence alone is insufficient evidence.

The CLI intentionally does not delete, rotate, upload, or overwrite backups.
Those retention and storage actions remain explicit operator policy.

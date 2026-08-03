# Verify a production deployment

After installing a digest-pinned release behind its real TLS ingress, run the
repository's read-only public verifier against the canonical origin:

```text
npm run release:verify-deployment -- https://grid.example.com
```

Supply only an HTTPS origin: no path, query, fragment, or embedded credentials.
The command makes four bounded `GET` requests with redirect following disabled
and a ten-second timeout per request. It checks:

- `/api/live` returns the exact process-liveness JSON contract;
- `/api/health` returns the exact ready configuration and SQLite contract;
- two `/sign-in` responses use distinct CSP nonces;
- every rendered script carries the nonce declared by its response;
- every response has a unique application-generated UUIDv4 `X-Request-ID`;
- HSTS, no-referrer, anti-framing, MIME-sniffing, browser-capability, CSP, and
  `Cache-Control: no-store` policies survive the ingress; and
- the framework-identifying `X-Powered-By` header remains absent.

The verifier reads at most 64 KiB from each API response and two MiB from each
HTML response. It never authenticates, provisions an account, writes product
data, triggers a workflow, or contacts a configured connector. A successful
run emits one JSON line containing:

```text
"marker":"BYOK_GRID_PUBLIC_DEPLOYMENT_VERIFIED"
```

The success line includes the canonical origin and a UTC verification
timestamp. Save it with the release version, installed image digests, ingress
identity, and operator. A failure prints a bounded
contract error without response bodies, URLs containing secrets, cookies,
credentials, tenant identifiers, or provider details.

## What this does not prove

This command proves the public web boundary and application readiness at one
instant. It does not prove image provenance, network-policy enforcement,
provider egress, Hatchet execution, SMTP delivery, backup/restore, load
capacity, alert delivery, multi-replica libSQL behavior, or rollback. Complete
those independent gates in
[`docs/PRODUCTION_READINESS.md`](PRODUCTION_READINESS.md) before stable
promotion.

The local compiled-standalone signup drill reuses the same verifier through a
loopback transport and emits `BYOK_GRID_PUBLIC_CONTRACT_DRILL_PASSED`. That
regression evidence proves the packaged application contract, but only the
command against the canonical HTTPS origin proves that the real ingress
preserves it.

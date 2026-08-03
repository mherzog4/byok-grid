# ADR 0041: Make authentication proxy trust explicit

- Status: Accepted
- Date: 2026-08-03

## Context

Better Auth rate limits authentication endpoints by client IP. A public BYOK
Grid deployment normally runs behind one or more reverse proxies, but forwarded
IP headers are supplied by the request and are not intrinsically trustworthy.
Accepting an arbitrary single-value `X-Forwarded-For` lets a directly connected
client rotate its rate-limit identity. Trusting every proxy range has the same
effect, while ignoring all forwarded addresses can place every user into one
shared bucket.

Next.js does not expose a portable peer socket address at the Route Handler
boundary. Client identity must therefore be a joint application and deployment
contract: the application defines which forwarded chain entries may be skipped,
and the network ensures all requests pass through the header-sanitizing proxy.

## Decision

BYOK Grid ignores all client-IP headers by default. Better Auth consequently
uses its fail-closed shared per-path rate-limit key when the production runtime
cannot derive an address. `BYOK_GRID_AUTH_TRUSTED_PROXY_CIDRS` is the only
opt-in to `X-Forwarded-For` processing. It accepts at most 64 unique IP addresses
or CIDRs, rejects malformed entries and trust-all `/0` ranges at startup, and is
rendered from `app.auth.trustedProxyCidrs` by the Helm chart.

When configured, Better Auth walks the chain from right to left, skips the
trusted proxy entries, and selects the first untrusted address. Forwarded host
and protocol trust remains disabled; `BETTER_AUTH_URL` is still the fixed
canonical origin.

Operators must enable proxy-aware identity only after proving that the ingress
overwrites or predictably appends `X-Forwarded-For` and that NetworkPolicy,
firewall, or equivalent routing prevents direct application access. Edge rate
limits remain mandatory because the application limiter does not cover
connection exhaustion, every product route, or attacks distributed across many
legitimate client addresses.

## Consequences

- Evaluation and unconfigured installations cannot bypass auth limits by
  rotating a forged client-IP header, but concurrent users share conservative
  authentication buckets.
- Multi-user operators must inspect their real proxy chain and configure a
  narrow trust boundary before admitting production traffic.
- Changes to load balancers, CDNs, ingress controllers, or network topology
  require the header-chain drill to be repeated.
- Invalid trust configuration stops readiness instead of degrading to a warning
  or silently accepting a partial list.

## Verification

Unit tests cover default behavior and IP/CIDR validation. SQLite-backed Better
Auth integration tests prove the shared bucket resists forged rotation, trusted
chains ignore spoofed left hops, and distinct real clients receive distinct
buckets. Helm verification covers empty and configured rendering plus `/0`
rejection. The compiled standalone drill sends four failed sign-ins with four
forged addresses and requires the fourth response to be `429`; its failed-start
case also requires redacted rejection of a `/0` trust boundary.

# Verify the production ingress and proxy boundary

This drill proves that the canonical TLS ingress preserves BYOK Grid's public
contract, the application and edge enforce distinguishable request limits, two
independent client networks see those controls, and the web origin is not
directly reachable. Run it only against an isolated or controlled production
candidate. It intentionally makes bounded invalid sign-in requests and safe
`GET /sign-in` requests; it never creates an account, sends email, authenticates,
or touches workspace data.

## Edge contract

Configure the real ingress, CDN, or load balancer before probing:

- strip any inbound `X-BYOK-Grid-Rate-Limit-Layer` request header;
- preserve the same response header when BYOK Grid returns it;
- set `X-BYOK-Grid-Rate-Limit-Layer: edge` only on edge-generated `429`
  responses;
- include an integer-seconds `Retry-After` header on those edge responses;
- apply a bounded unauthenticated limit to `GET /sign-in` whose threshold is
  below the probe ceiling but allows at least one request during the probe; and
- keep the edge limit for `/api/auth/*` above four requests so the application
  layer, rather than the edge, produces the fourth sign-in response.

The application marks its own Better Auth `429` response with
`X-BYOK-Grid-Rate-Limit-Layer: application` and preserves Better Auth's
`X-Retry-After` interval. Layer provenance prevents one `429` from being counted
as proof of both controls.

## Proxy and direct-access record

Capture the real `X-Forwarded-For` behavior in restricted edge logs. Verify
whether the edge overwrites the inbound value or predictably appends to it, then
configure only the observed proxy IP addresses or narrow CIDRs in
`app.auth.trustedProxyCidrs`. Attempt the known web origin from the external
probe networks and retain the connection denial or non-routing result. Also
retain the ingress/firewall policy and its applied-state evidence.

Do not publish raw client or proxy addresses. Hash the canonical observed chain
and the canonical trusted-proxy configuration separately with SHA-256. Store the
complete evidence in restricted operator storage and expose only a
credential-free HTTPS review reference plus its artifact digest.

## Run from two client networks

Choose two genuinely independent egress networks, such as a fixed office link
and a mobile provider. Synchronize both host clocks, generate one shared random
challenge, and start the two commands together. Use the same challenge but a
different opaque network label on each host. Both values are hashed before
output and are never printed. Requiring both clients to independently consume
the three-request application allowance inside the same ten-second window
with completion timestamps no more than five seconds apart detects an accidental
shared fallback bucket before that ten-second bucket can reset.

On each network, from a trusted shell with Node.js 24 or newer:

```text
export BYOK_GRID_CANDIDATE_COMMIT=<40-character-candidate-SHA>
export BYOK_GRID_INGRESS_NETWORK_ID=<opaque-network-label>
export BYOK_GRID_INGRESS_PROBE_CHALLENGE=<same-random-16-to-128-character-value>
export BYOK_GRID_EDGE_RATE_LIMIT_MAX_ATTEMPTS=<2-to-100>
export BYOK_GRID_INGRESS_PROBE_CONFIRM=controlled-production-candidate

npm run drill:ingress-client -- https://grid.example.com \
  > ingress-client-<network>.json
```

The command first repeats the read-only public deployment verifier. It then
makes exactly four invalid sign-in attempts using a random address under the
reserved `.example` domain: three must return `401`, followed by an
application-provenance `429`. Finally it makes at most the declared number of
safe sign-in page requests and requires an allowed response before an
edge-provenance `429`.

Success emits one line with marker:

```text
"marker":"BYOK_GRID_INGRESS_CLIENT_PROBE_VERIFIED"
```

The output contains only the candidate, canonical public origin, hashed network
and challenge identities, counts, bounded retry intervals, public marker, and
UTC timestamps. It contains no passwords, generated email address, IP address,
response body, cookie, forwarded chain, or provider error.

If a probe fails after consuming the ten-second application window, wait for
that window to expire before correcting the edge configuration and trying
again. Do not raise the application's fixed sign-in limit merely to make the
drill pass.

## Assemble the boundary manifest

Copy [`ingress-boundary.template.json`](ingress-boundary.template.json), then
replace its deliberately invalid placeholders and embed the exact two client
JSON records in ascending `networkIdSha256` order. The resulting manifest has
this closed shape:

```json
{
  "candidateCommit": "<40-character-candidate-SHA>",
  "clientProbes": [
    "<first complete client probe object>",
    "<second complete client probe object>"
  ],
  "origin": "https://grid.example.com",
  "proxyBoundary": {
    "artifactSha256": "<SHA-256 of retained proxy/direct-access evidence>",
    "directAccessDenied": true,
    "forwardedForMode": "overwrite",
    "observedChainSha256": "<SHA-256 of canonical observed chain>",
    "reference": "https://evidence.example.com/releases/<version>/proxy-boundary",
    "trustedProxyCidrsSha256": "<SHA-256 of canonical configured CIDRs>",
    "verifiedAt": "<canonical-millisecond-UTC-timestamp>"
  },
  "schemaVersion": 1
}
```

Use `append` instead of `overwrite` only when that is the observed, reviewed
edge behavior. The two application-limit completion timestamps must be no more
than five seconds apart, and both client probes plus the proxy record must
remain inside one 24-hour window. Verify the manifest:

```text
npm run release:verify-ingress-boundary -- \
  /path/to/ingress-boundary.json \
  <40-character-candidate-SHA>
```

Success emits `BYOK_GRID_INGRESS_BOUNDARY_VERIFIED`. Retain that output together
with `BYOK_GRID_PUBLIC_DEPLOYMENT_VERIFIED`. Stable production evidence requires
both exact markers; neither may substitute for the other.

## Failure handling

A failed application layer usually means the edge intercepted `/api/auth/*`,
the real proxy address is not trusted, or unrelated traffic already occupied
the ten-second bucket. A failed edge layer means the edge limit is missing, its
threshold is outside the declared ceiling, or its generated response lacks the
required provenance and retry headers. A direct-access failure means the origin
is still routable outside the intended ingress path.

Do not weaken a limit, broaden a trusted CIDR, or expose the web Service to make
the test pass. Correct the topology, preserve the failed record privately, and
repeat both client probes so the final evidence remains one coherent window.

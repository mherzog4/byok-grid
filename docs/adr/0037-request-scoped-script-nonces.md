# ADR 0037: Use request-scoped nonces for application scripts

- Status: accepted
- Date: 2026-08-03
- Supersedes: none
- Extends: ADR 0035

## Context

BYOK Grid renders authenticated data, credentials metadata, and workflow state
through Next.js. A static CSP that permits inline scripts leaves a broader script
execution surface than the application needs. Next.js emits framework bootstrap
scripts in server-rendered HTML, so removing inline-script permission requires a
trusted value shared by the response header and those generated tags.

Open-source operators may place the application behind different proxies and
CDNs. The policy therefore needs an explicit caching contract that remains safe
outside the reference Compose and Kubernetes topologies.

## Decision

The Next.js Proxy generates a cryptographically random, base64-encoded nonce for
every matched application request. It forwards the nonce and CSP to the Next.js
renderer and applies the same CSP to the response, including responses rejected
early by the API mutation-origin boundary.

Production `script-src` requires the nonce and uses `strict-dynamic`. It does not
permit `unsafe-inline` or `unsafe-eval`. Development may add `unsafe-eval` for
framework tooling. The root layout waits for a request connection, making all
application HTML dynamically rendered so Next.js can apply the request nonce to
its generated scripts.

Static framework assets bypass nonce generation and retain immutable caching.
Nonce-bearing HTML must not be cached for reuse across requests, and external
proxies must preserve the CSP without rewriting, merging, or stripping it.

The current virtualized grid and visual workflow editor calculate element styles
at runtime. `style-src` therefore retains `unsafe-inline`; this decision does not
extend that permission to scripts.

## Consequences

- An injected inline script without the response nonce is blocked by the browser.
- A nonce trusted by one response cannot authorize a script in another response.
- Application pages give up static optimization, ISR, and shared HTML caching.
- Static JavaScript and other immutable assets remain cacheable.
- Reverse-proxy configuration becomes part of the nonce security boundary.
- Removing inline style permission requires a separate design for dynamic grid
  and canvas positioning.

## Verification

Unit contracts require unique base64 nonces and reject production script
policies containing `unsafe-inline` or `unsafe-eval`. Proxy tests cover page,
accepted API, rejected API, and exact `/api` responses. The compiled standalone
workflow E2E parses the CSP header, compares nonces across responses, and requires
every rendered script tag to carry the exact nonce for its response.

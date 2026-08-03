# ADR 0008: BYOK AI enrichment through the Responses API

- Status: Accepted
- Date: 2026-07-31

## Context

AI-assisted research is central to a Clay-like workspace, but a default model
gateway would make the project a credential custodian, pricing intermediary,
and data processor. A row-level AI call is also a metered side effect: a worker
can lose the response after the provider has already consumed tokens.

## Decision

The first AI action uses OpenAI's Responses API with a workspace-owned project
API key. The built-in connector is trusted TypeScript, may reach only
`api.openai.com`, and sends `store: false`. Its column definition binds the
row-specific prompt to a grid column and stores model, optional instructions,
and maximum output tokens as validated literals. The default model is
`gpt-5.6-luna`, chosen for high-volume enrichment; users may enter another
model available to their OpenAI project.

Queueing freezes the prompt and literal settings in the run record. The API key
is represented only by an encrypted credential ID until the worker decrypts it
immediately before execution. The full validated result stores model, response
ID, text, and token usage for provenance. Only the text projection is written
to the visible grid cell.

The run UUID is sent as `X-Client-Request-Id` for provider-side tracing. It is
not treated as an idempotency key. Authentication and invalid-input failures do
not retry; rate limits, timeouts, conflicts, transport errors, and server
failures may retry through Hatchet. Therefore execution is at least once and
an ambiguous failure can incur duplicate model cost.

No live provider call is required in the test suite. Connector tests use a
mocked bounded fetch implementation and prove request shape, response parsing,
error classification, and secret placement. Database tests prove that literal
and column bindings freeze correctly and that provider keys do not enter runs.

## Consequences

- Self-hosters own provider billing, rate limits, model access, and compliance.
- `store: false` reduces stored provider state but does not guarantee zero
  retention; deployments must assess current provider terms independently.
- Token usage is available in run provenance. Aggregated budgets, preflight
  estimates, and spend circuit breakers remain follow-up work.
- Exactly-once billing is impossible without a provider-supported idempotency
  contract or reconciliation endpoint. The UI must eventually expose this
  retry-cost risk and offer per-workspace controls.
- Additional model providers should implement the same connector contract
  rather than adding a platform-owned proxy to the core application.

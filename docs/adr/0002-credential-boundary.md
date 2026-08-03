# ADR 0002: Workspace-scoped envelope encryption

- Status: Accepted
- Date: 2026-07-31

## Decision

Each workspace receives a random 256-bit data-encryption key. That key is
wrapped by the deployment master key and stored separately from encrypted
credentials. Each credential is encrypted with AES-256-GCM using a unique
nonce and authenticated context containing its workspace and credential IDs.

Only workers may request decrypted credentials. API responses expose credential
metadata and a stable identifier, never ciphertext or plaintext. Durable job
payloads contain the credential identifier only.

The local deployment reads a base64 master key from the environment. Production
deployments should use the same interface with a cloud KMS or Vault adapter.

## Required invariants

- Swapping encrypted values between workspaces or credential IDs must fail
  authentication.
- Logs and traces must redact credential-shaped values.
- Revoked credentials cannot start new work.
- Key identifiers are stored with ciphertext so master keys can be rotated.
- Decrypted material is not cached beyond one connector invocation.

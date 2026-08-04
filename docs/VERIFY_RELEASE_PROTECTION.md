# Verify release tag and registry protection

Run this read-only verifier after an RC has been published and the downloaded
release bundle has passed `release:verify-bundle`. It creates the structured
evidence required by the stable `release-tag-protection` gate. It never creates,
moves, deletes, or overwrites a Git tag, GitHub Release, package version, or
container tag.

## Inputs and credentials

Use the exact candidate SHA and the checksummed `IMAGE_DIGESTS.txt` downloaded
from that immutable GitHub Release. Set these environment variables through the
operator's secret manager or a private shell session:

- `BYOK_GRID_GITHUB_TOKEN`: a token allowed to read repository rulesets,
  immutable-release state, Git references and tag objects, releases, and the
  public owner identity;
- `BYOK_GRID_GHCR_ACTOR`: the GitHub login associated with the package token;
  and
- `BYOK_GRID_GHCR_TOKEN`: a token with `read:packages` for the seven GHCR
  repositories.

Do not place tokens in command arguments, retained evidence, issue comments, or
workflow logs. The verifier bounds every provider response and reports only
repository-defined errors.

Choose a new output path outside the source checkout. The command creates it
once with mode `0600` and refuses to replace an existing path:

```text
npm run release:verify-protection -- \
  --version 0.1.0-rc.1 \
  --candidate REPLACE_WITH_40_CHARACTER_CANDIDATE_SHA \
  --digest-manifest /path/to/downloaded-release/IMAGE_DIGESTS.txt \
  --owner mherzog4 \
  --repository mherzog4/byok-grid \
  --output /private/evidence/v0.1.0-rc.1-release-protection.json
```

## Fail-closed checks

The verifier discovers the complete active repository tag-ruleset inventory
and requires exactly:

1. one active `refs/tags/v*` mutation ruleset with deletion, update, and
   non-fast-forward protections, no bypass actors, and no current-user bypass;
2. one active `refs/tags/v*` creation ruleset whose sole bypass is the exact
   repository-owner user;
3. repository-level immutable GitHub Releases enabled;
4. an immutable, non-draft GitHub Release with the expected prerelease state;
5. a signed annotated Git tag that GitHub reports as valid and that peels to
   the exact candidate commit; and
6. the exact seven canonical release images, with every GHCR version tag
   resolving to the digest in `IMAGE_DIGESTS.txt`; and
7. anonymous GHCR access to every version tag and immutable digest, with both
   references returning that same recorded digest.

Success writes and prints one bounded record containing
`BYOK_GRID_RELEASE_TAG_PROTECTION_VERIFIED`, the candidate and version, both
ruleset IDs, the immutable release ID, signed tag-object SHA, repository
identity, SHA-256 of `IMAGE_DIGESTS.txt`, the seven-image count, and
`publicImagesVerified: true`. Hash the exact output file, retain it in the
controlled evidence store, and use that digest and immutable HTTPS reference
for the stable production manifest. The record's digest-manifest hash must
equal `candidate.digestManifestSha256` in that manifest.

The result is a point-in-time readback. GitHub immutable releases and the
repository tag rules protect the Git release identity. GHCR version tags remain
pointers unless GitHub exposes and enforces a separate registry immutability
control, so `IMAGE_DIGESTS.txt` and digest-pinned deployment remain
authoritative. Anonymous access is checked without either package credential;
the authenticated token cannot make a private package satisfy the public gate.

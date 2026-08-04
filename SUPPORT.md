# Support

BYOK Grid is an early release candidate maintained as an open-source project.
Community support is best effort; there is no guaranteed response time, service
level agreement, hosted support contract, or promise that a particular provider
or deployment topology is supported.

## Ask for help

Use the repository's **Question or support request** issue form for installation,
configuration, and usage questions. Before opening an issue:

1. Search existing issues and the documentation.
2. Include the exact BYOK Grid version or commit.
3. Identify the deployment profile: local development, Compose evaluation, or
   digest-pinned Kubernetes with remote libSQL.
4. Include the smallest reproducible configuration with every credential,
   token, cookie, private URL, customer value, and provider response redacted.

The auth-disabled local Hatchet and Compose application profile are evaluation
paths, not production support claims. Production questions should include the
relevant evidence from the deployment, recovery, worker-drain, and capacity
runbooks without including secrets.

## Report defects and request features

Use the structured **Bug report** form for reproducible defects and the
**Feature request** form for product proposals. A bug report should distinguish
an application defect from an unavailable provider, invalid deployment secret,
or unsupported topology. Feature proposals should describe the user problem and
their effect on the SQLite-first, BYOK, tenant-isolation, and connector-sandbox
boundaries.

## Security and conduct reports

Do not disclose suspected vulnerabilities in an issue, pull request, discussion,
or log excerpt. Follow [SECURITY.md](SECURITY.md) and use GitHub's private
security-reporting flow.

Do not report harassment or other conduct incidents publicly. Follow
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and use its private enforcement contact.

## Maintainer expectations

Maintainers may close reports that lack reproduction details, contain no
actionable project issue, request support for an explicitly unsupported
topology, or belong with an upstream provider. Closing an issue is not a support
or stability judgment. Supported versions and production claims are governed by
[SECURITY.md](SECURITY.md), the
[production-readiness ledger](docs/PRODUCTION_READINESS.md), and published
release notes.

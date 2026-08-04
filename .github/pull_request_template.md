## Summary

<!-- Explain the user or operator problem and the resulting behavior. -->

## Related issue

<!-- Use "Closes #123" when this change fully resolves an issue. -->

## Change surface

- [ ] Product behavior
- [ ] Database schema or migration
- [ ] Workflow execution or connector behavior
- [ ] Authentication, authorization, secrets, or network boundary
- [ ] Deployment, image, or GitHub Actions
- [ ] Documentation or contributor experience only

## Verification

<!-- List the exact commands and manual checks run. Do not write only "tests pass." -->

- [ ] Formatting, linting, and type checks pass for the affected workspaces.
- [ ] Relevant unit and SQLite integration tests pass.
- [ ] A regression test fails without the fix when this corrects a defect.
- [ ] Production build, Helm, container, or release checks were run when affected.
- [ ] No credential, token, cookie, private URL, tenant data, or generated local state is included.

## Production and compatibility review

<!-- Explain each checked item or write "Not applicable" with a reason. -->

- [ ] Tenant and workspace scoping remains explicit and adversarially tested.
- [ ] SQLite/libSQL remains authoritative; optional systems cannot block core writes.
- [ ] Migrations are backward-compatible with the previous application image.
- [ ] Retries, idempotency, cancellation, and ambiguous external outcomes are addressed.
- [ ] BYOK credentials remain encrypted, server-side, and absent from logs and payload history.
- [ ] New egress, provider cost, retention, backup, rollback, and observability effects are documented.
- [ ] User-facing or architectural changes include the appropriate documentation or ADR.

## Release impact

<!-- State whether this requires a new RC, image rebuild, migration, runbook rerun, or production-evidence reset. -->

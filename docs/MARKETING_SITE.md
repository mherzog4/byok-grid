# Marketing site

The public BYOK Grid marketing site lives in `apps/marketing`. It is a separate
static-first Next.js application with no database, authentication, email,
analytics SDK, cookies, or access to the self-hosted product's secrets.

## Local development

From the repository root:

```text
npm run dev:marketing
```

Open <http://localhost:3001>. Validate the production output with:

```text
npm run build:marketing
npm run lint --workspace=@byok-grid/marketing
npm run typecheck --workspace=@byok-grid/marketing
```

## Vercel project

Import `mherzog4/byok-grid` as a new Vercel project and set **Root Directory**
to `apps/marketing`. Vercel detects the Next.js and Turborepo configuration,
uses the repository lockfile, and isolates this app's preview and production
deployments from the self-hosted product app.

The site requires no user-managed environment variables. Vercel supplies
`NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL`; the app uses it for canonical,
sitemap, and Open Graph URLs and falls back to `byok-grid.vercel.app` for local
production builds.

Use Vercel's ordinary Git integration:

- pull requests create marketing-site preview deployments;
- a protected `main` build creates the production deployment;
- configure a custom domain on the marketing project only;
- do not attach the SQLite database, BYOK master key, Hatchet credentials, or
  connector keys to this project.

The local-first application remains self-hosted. The marketing project must
never proxy product API routes.

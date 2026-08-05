import { documentationUrl, licenseUrl, repositoryUrl } from '@/lib/site';

const rows = [
  {
    company: 'Northstar',
    domain: 'northstar.dev',
    fit: 'High fit',
    fitTone: 'positive',
    person: 'Maya Chen',
  },
  {
    company: 'Paper Street',
    domain: 'paperstreet.co',
    fit: 'Review',
    fitTone: 'warning',
    person: 'Jon Bell',
  },
  {
    company: 'Acme Systems',
    domain: 'acme.io',
    fit: 'Running',
    fitTone: 'running',
    person: '—',
  },
  {
    company: 'Globex',
    domain: 'globex.com',
    fit: 'Low fit',
    fitTone: 'muted',
    person: 'Priya Rao',
  },
] as const;

const features = [
  {
    index: '01',
    title: 'A grid that remembers the work',
    body: 'Edit typed cells, run enrichments by row or column, and keep the input, provider, result, and execution state together.',
    tag: 'Collaborative tables',
  },
  {
    index: '02',
    title: 'Workflows you can see',
    body: 'Connect typed nodes, publish immutable versions, branch on results, and inspect every durable run without hiding logic in a black box.',
    tag: 'Visual orchestration',
  },
  {
    index: '03',
    title: 'Provider keys stay yours',
    body: 'Credentials are encrypted per workspace, resolved just in time by Node.js workers, and constrained to each connector’s known hosts.',
    tag: 'BYOK execution',
  },
] as const;

const coreStack = [
  ['Interface', 'Next.js'],
  ['Source of truth', 'SQLite'],
  ['Workflow runtime', 'Node.js'],
  ['License', 'AGPL-3.0'],
] as const;

export default function Home() {
  return (
    <main>
      <header className="site-header shell">
        <a className="brand" href="#top" aria-label="BYOK Grid home">
          <span className="brand-mark" aria-hidden="true">
            B
          </span>
          <span>BYOK Grid</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#product">Product</a>
          <a href="#open-source">Open source</a>
          <a href={documentationUrl}>Docs</a>
        </nav>
        <a className="header-cta" href={repositoryUrl}>
          View on GitHub <span aria-hidden="true">↗</span>
        </a>
      </header>

      <section className="hero shell" id="top">
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="status-dot" /> Open source · Bring your own keys
          </p>
          <h1>
            Enrich data.
            <br />
            <span>Own the workflow.</span>
          </h1>
          <p className="hero-lede">
            A forkable enrichment grid with visual node workflows. Run APIs,
            formulas, and LLMs using provider keys you control—on infrastructure
            you control.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href={repositoryUrl}>
              Clone on GitHub <span aria-hidden="true">↗</span>
            </a>
            <a className="button button-secondary" href="#quick-start">
              See how it works <span aria-hidden="true">↓</span>
            </a>
          </div>
          <p className="hero-note">No per-row markup. No locked-in API keys.</p>
        </div>

        <ProductPreview />
      </section>

      <section className="stack-strip" aria-label="Core technology">
        <div className="shell stack-grid">
          {coreStack.map(([label, value]) => (
            <div className="stack-item" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="section shell" id="product">
        <SectionHeading
          eyebrow="The product"
          title="The table and the workflow belong together."
          body="Start with rows. Add enrichment columns. Turn repeatable logic into a workflow you can inspect, version, and fork."
        />
        <div className="feature-grid">
          {features.map((feature) => (
            <article className="feature-card" key={feature.index}>
              <div className="feature-index">{feature.index}</div>
              <span className="feature-tag">{feature.tag}</span>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section shell fork-section" id="open-source">
        <div className="fork-copy">
          <p className="eyebrow">Fork-first by design</p>
          <h2>Your deployment is the product—not our hosted account.</h2>
          <p>
            The useful path starts with a local SQLite file and ordinary npm
            commands. Add durable scheduling or external analytics only when
            your deployment actually needs them.
          </p>
          <a className="text-link" href={licenseUrl}>
            Read the open-source license <span aria-hidden="true">↗</span>
          </a>
        </div>
        <div className="boundary-list">
          <BoundaryRow
            value="Required"
            title="Next.js + SQLite + Node workers"
            detail="The complete core path for grid authoring, BYOK connectors, and visual workflows."
          />
          <BoundaryRow
            value="Optional"
            title="Hatchet, Airbyte, ClickHouse"
            detail="Adapters and operational upgrades—not prerequisites for cloning or evaluating the product."
          />
          <BoundaryRow
            value="Yours"
            title="Data, keys, connectors, deployment"
            detail="Fork the code, define provider actions, and choose the infrastructure that fits."
          />
        </div>
      </section>

      <section className="section shell quick-start" id="quick-start">
        <div>
          <p className="eyebrow">Local in minutes</p>
          <h2>Clone it. Add one local key. Start building.</h2>
          <p>
            Docker is optional for the first run. The web app, grid, and visual
            workflow authoring use the local SQLite database. No account or
            sign-in flow stands between you and the workspace.
          </p>
        </div>
        <div className="terminal" aria-label="Local setup commands">
          <div className="terminal-bar">
            <span />
            <span />
            <span />
            <p>terminal</p>
          </div>
          <pre>
            <code>
              <span className="prompt">$</span> git clone{' '}
              https://github.com/mherzog4/byok-grid.git{`\n`}
              <span className="prompt">$</span> cd byok-grid{`\n`}
              <span className="prompt">$</span> cp .env.example .env{`\n`}
              <span className="prompt">$</span> npm install{`\n`}
              <span className="prompt">$</span> npm run db:migrate &amp;&amp;
              npm run dev
            </code>
          </pre>
          <a href={documentationUrl}>Open the complete setup guide →</a>
        </div>
      </section>

      <section className="final-cta shell">
        <div>
          <p className="eyebrow">Build in the open</p>
          <h2>Bring the keys. Keep the workflow.</h2>
        </div>
        <a className="button button-primary" href={repositoryUrl}>
          Explore the repository <span aria-hidden="true">↗</span>
        </a>
      </section>

      <footer className="site-footer shell">
        <a className="brand footer-brand" href="#top">
          <span className="brand-mark" aria-hidden="true">
            B
          </span>
          <span>BYOK Grid</span>
        </a>
        <p>Open-source enrichment workflows. Built to be forked.</p>
        <div>
          <a href={repositoryUrl}>GitHub</a>
          <a href={documentationUrl}>Docs</a>
          <a href={licenseUrl}>License</a>
        </div>
      </footer>
    </main>
  );
}

function ProductPreview() {
  return (
    <div className="product-preview" aria-label="BYOK Grid product preview">
      <div className="window-bar">
        <div className="window-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <span className="window-title">Companies / Qualified accounts</span>
        <span className="live-pill">Live</span>
      </div>
      <div className="preview-tabs">
        <span className="active">Grid</span>
        <span>Workflow</span>
        <button type="button">Run 24 rows</button>
      </div>
      <div className="preview-grid">
        <div
          className="preview-table"
          role="table"
          aria-label="Enrichment grid"
        >
          <div className="preview-row preview-head" role="row">
            <span role="columnheader">Company</span>
            <span role="columnheader">Domain</span>
            <span role="columnheader">ICP score</span>
            <span role="columnheader">Contact</span>
          </div>
          {rows.map((row) => (
            <div className="preview-row" role="row" key={row.domain}>
              <strong role="cell">{row.company}</strong>
              <span role="cell">{row.domain}</span>
              <span role="cell">
                <em className={`result-pill ${row.fitTone}`}>{row.fit}</em>
              </span>
              <span role="cell">{row.person}</span>
            </div>
          ))}
          <div className="preview-row add-row" role="row">
            <span role="cell">＋ Add row</span>
          </div>
        </div>
        <div className="workflow-peek" aria-label="Workflow nodes">
          <p>Published workflow</p>
          <div className="workflow-canvas">
            <div className="node node-input">
              <span>01</span>
              <strong>New row</strong>
              <small>Table trigger</small>
            </div>
            <div className="connector connector-one" />
            <div className="node node-enrich">
              <span>02</span>
              <strong>Enrich company</strong>
              <small>HTTPS · your key</small>
            </div>
            <div className="connector connector-two" />
            <div className="node node-score">
              <span>03</span>
              <strong>Score fit</strong>
              <small>OpenAI · your key</small>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionHeading({
  body,
  eyebrow,
  title,
}: {
  body: string;
  eyebrow: string;
  title: string;
}) {
  return (
    <div className="section-heading">
      <p className="eyebrow">{eyebrow}</p>
      <div>
        <h2>{title}</h2>
        <p>{body}</p>
      </div>
    </div>
  );
}

function BoundaryRow({
  detail,
  title,
  value,
}: {
  detail: string;
  title: string;
  value: string;
}) {
  return (
    <article>
      <span>{value}</span>
      <div>
        <h3>{title}</h3>
        <p>{detail}</p>
      </div>
    </article>
  );
}

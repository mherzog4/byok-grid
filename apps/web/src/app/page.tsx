const boundaries = [
  {
    label: 'Control plane',
    value: 'Next.js',
    detail: 'UI, authentication, and short-lived mutations',
  },
  {
    label: 'Source of truth',
    value: 'SQLite / libSQL',
    detail: 'Portable typed cells, credentials, runs, and outbox events',
  },
  {
    label: 'Durable work',
    value: 'Hatchet',
    detail: 'Retries, backoff, rate limits, and worker routing',
  },
  {
    label: 'Execution',
    value: 'BYOK workers',
    detail: 'Just-in-time secret resolution and isolated connectors',
  },
];

const sampleRows = [
  ['Acme', 'acme.example', 'Ready', '—'],
  ['Northstar', 'northstar.example', 'Running', 'HTTP API'],
  ['Paper Street', 'paper.example', 'Succeeded', 'Firmographics'],
  ['Globex', 'globex.example', 'Waiting', '—'],
];

export default function Home() {
  return (
    <main>
      <header className="topbar">
        <div className="brand-mark">B</div>
        <div>
          <p className="eyebrow">WORKING CODENAME</p>
          <h1>BYOK Grid</h1>
        </div>
        <div className="topbar-actions">
          <span className="open-badge">AGPL · OPEN SOURCE</span>
          <Link className="text-action" href="/sign-in">
            Open app →
          </Link>
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">ARCHITECTURE SLICE 01</p>
          <h2>Bring your keys. Keep the workflow.</h2>
          <p className="lede">
            A transparent enrichment grid where every cell preserves its input,
            provider, status, cost estimate, and execution history.
          </p>
        </div>
        <div className="hero-status">
          <span className="pulse" /> Foundation in progress
        </div>
      </section>

      <section className="boundary-grid" aria-label="System boundaries">
        {boundaries.map((boundary) => (
          <article key={boundary.label} className="boundary-card">
            <p>{boundary.label}</p>
            <strong>{boundary.value}</strong>
            <span>{boundary.detail}</span>
          </article>
        ))}
      </section>

      <section className="workspace-preview">
        <div className="preview-heading">
          <div>
            <p className="eyebrow">PRODUCT SURFACE</p>
            <h3>Companies</h3>
          </div>
          <button type="button" disabled>
            Run enrichment
          </button>
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Company</th>
                <th>Domain</th>
                <th>Run state</th>
                <th>Provider</th>
              </tr>
            </thead>
            <tbody>
              {sampleRows.map((row, index) => (
                <tr key={row[1]}>
                  <td>{index + 1}</td>
                  {row.map((cell, cellIndex) => (
                    <td key={`${row[1]}-${cellIndex}`}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="preview-note">
          This shell will be replaced by the virtualized editable grid after the
          persistence and authorization path is connected.
        </p>
      </section>
    </main>
  );
}
import Link from 'next/link';

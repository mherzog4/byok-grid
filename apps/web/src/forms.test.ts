import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('client form fallbacks', () => {
  it('never serializes form fields into the URL before hydration', () => {
    const appRoot = path.join(import.meta.dirname, 'app');
    const sourceFiles = readdirSync(appRoot, { recursive: true })
      .filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.endsWith('.tsx')
      )
      .map((entry) => path.join(appRoot, entry));

    for (const sourceFile of sourceFiles) {
      const source = readFileSync(sourceFile, 'utf8');
      const forms = source.match(/<form\b[^>]*>/g) ?? [];
      for (const form of forms) expect(form).toContain('method="post"');
    }
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ReleaseNotesError,
  verifyReleaseNotes,
} from './verify-release-notes-lib.mjs';

const version = '0.1.0-rc.1';

function validNotes(overrides = {}) {
  const title = overrides.title ?? `# BYOK Grid ${version}`;
  const marker = overrides.marker ?? `<!-- release-version: ${version} -->`;
  const headings =
    overrides.headings ??
    [
      '## Release status',
      '## Highlights',
      '## Verify this release',
      '## Known limits and production gates',
      '## Licensing',
    ].join('\n\nBody\n\n');
  return `${title}\n\n${marker}\n\n${headings}\n`;
}

test('accepts version-bound curated release notes', () => {
  assert.doesNotThrow(() => verifyReleaseNotes(validNotes(), version));
});

test('rejects notes for a different release', () => {
  assert.throws(
    () =>
      verifyReleaseNotes(
        validNotes({ marker: '<!-- release-version: 0.1.0-rc.2 -->' }),
        version
      ),
    ReleaseNotesError
  );
});

test('rejects duplicate release-version markers', () => {
  const duplicate = validNotes().replace(
    '<!-- release-version: 0.1.0-rc.1 -->',
    '<!-- release-version: 0.1.0-rc.1 -->\n<!-- release-version: 0.1.0-rc.1 -->'
  );
  assert.throws(() => verifyReleaseNotes(duplicate, version), /exactly one/u);
});

test('rejects a missing release-status section', () => {
  assert.throws(
    () =>
      verifyReleaseNotes(
        validNotes({
          headings: [
            '## Highlights',
            '## Verify this release',
            '## Known limits and production gates',
            '## Licensing',
          ].join('\n\nBody\n\n'),
        }),
        version
      ),
    /Release status/u
  );
});

test('rejects release notes without a final newline', () => {
  assert.throws(
    () => verifyReleaseNotes(validNotes().trimEnd(), version),
    /end with a newline/u
  );
});

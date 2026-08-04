import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolve } from 'node:path';
import {
  requiredCommunityFiles,
  verifyCommunityDirectory,
  verifyCommunitySources,
} from './verify-community-health.mjs';

async function repositorySources() {
  return Object.fromEntries(
    await Promise.all(
      requiredCommunityFiles.map(async (filename) => [
        filename,
        await readFile(resolve(import.meta.dirname, '..', filename), 'utf8'),
      ])
    )
  );
}

test('accepts the repository community-health contract', async () => {
  const result = await verifyCommunityDirectory(
    resolve(import.meta.dirname, '..')
  );
  assert.deepEqual(result, { formCount: 3, issues: [] });
});

test('rejects a missing required community file', async () => {
  const sources = await repositorySources();
  delete sources['SUPPORT.md'];
  assert.match(
    verifyCommunitySources(sources).issues.join('\n'),
    /SUPPORT\.md: required community file/u
  );
});

test('rejects public blank issues and a removed private security link', async () => {
  const sources = await repositorySources();
  sources['.github/ISSUE_TEMPLATE/config.yml'] = sources[
    '.github/ISSUE_TEMPLATE/config.yml'
  ]
    .replace('blank_issues_enabled: false', 'blank_issues_enabled: true')
    .replace(
      'https://github.com/mherzog4/byok-grid/security/advisories/new',
      'https://github.com/mherzog4/byok-grid/issues/new'
    );
  const issues = verifyCommunitySources(sources).issues.join('\n');
  assert.match(issues, /closed blank-issue policy/u);
  assert.match(issues, /private security-reporting link/u);
});

test('rejects duplicate or incomplete issue-form fields', async () => {
  const sources = await repositorySources();
  sources['.github/ISSUE_TEMPLATE/bug_report.yml'] = sources[
    '.github/ISSUE_TEMPLATE/bug_report.yml'
  ].replace('id: environment', 'id: version');
  const issues = verifyCommunitySources(sources).issues.join('\n');
  assert.match(issues, /field IDs must be unique/u);
  assert.match(issues, /field IDs must be exactly/u);
});

test('rejects a required issue-form field made optional', async () => {
  const sources = await repositorySources();
  sources['.github/ISSUE_TEMPLATE/bug_report.yml'] = sources[
    '.github/ISSUE_TEMPLATE/bug_report.yml'
  ].replace(
    /(    id: version[\s\S]*?    validations:\n      required:) true/u,
    '$1 false'
  );
  assert.match(
    verifyCommunitySources(sources).issues.join('\n'),
    /field version must remain required/u
  );
});

test('rejects unresolved placeholders and unlinked conduct acknowledgement', async () => {
  const sources = await repositorySources();
  sources['CODE_OF_CONDUCT.md'] = sources['CODE_OF_CONDUCT.md'].replace(
    'mailto:matthewherzog4@gmail.com',
    '[INSERT CONTACT METHOD]'
  );
  sources['.github/ISSUE_TEMPLATE/question.yml'] = sources[
    '.github/ISSUE_TEMPLATE/question.yml'
  ].replace(
    'I agree to follow [the Code of Conduct](https://github.com/mherzog4/byok-grid/blob/main/CODE_OF_CONDUCT.md).',
    'I agree to follow the Code of Conduct.'
  );
  const issues = verifyCommunitySources(sources).issues.join('\n');
  assert.match(issues, /unresolved template placeholder/u);
  assert.match(issues, /private enforcement contact/u);
  assert.match(issues, /linked Code of Conduct acknowledgement/u);
});

test('the verifier has no runtime package imports', async () => {
  const source = await readFile(
    resolve(import.meta.dirname, 'verify-community-health.mjs'),
    'utf8'
  );
  assert.doesNotMatch(source, /from ['"](?!node:|\.\/)/u);
});

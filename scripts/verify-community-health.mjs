import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const requiredCommunityFiles = [
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/ISSUE_TEMPLATE/question.yml',
  '.github/pull_request_template.md',
  'CODE_OF_CONDUCT.md',
  'README.md',
  'SECURITY.md',
  'SUPPORT.md',
];

const forms = {
  '.github/ISSUE_TEMPLATE/bug_report.yml': [
    'version',
    'deployment',
    'database',
    'summary',
    'reproduce',
    'expected',
    'actual',
    'evidence',
    'environment',
    'checks',
  ],
  '.github/ISSUE_TEMPLATE/feature_request.yml': [
    'problem',
    'outcome',
    'alternatives',
    'area',
    'boundaries',
    'checks',
  ],
  '.github/ISSUE_TEMPLATE/question.yml': [
    'goal',
    'attempted',
    'version',
    'deployment',
    'safe_context',
    'checks',
  ],
};

const requiredFormFields = {
  '.github/ISSUE_TEMPLATE/bug_report.yml': [
    'version',
    'deployment',
    'database',
    'summary',
    'reproduce',
    'expected',
    'actual',
    'environment',
  ],
  '.github/ISSUE_TEMPLATE/feature_request.yml': [
    'problem',
    'outcome',
    'alternatives',
    'area',
    'boundaries',
  ],
  '.github/ISSUE_TEMPLATE/question.yml': [
    'goal',
    'attempted',
    'version',
    'deployment',
  ],
};

export function verifyCommunitySources(sources) {
  const issues = [];

  for (const filename of requiredCommunityFiles) {
    const source = sources[filename];
    if (typeof source !== 'string' || source.length === 0) {
      issues.push(`${filename}: required community file is missing or empty.`);
      continue;
    }
    if (!source.endsWith('\n')) {
      issues.push(`${filename}: file must end with a newline.`);
    }
    if (/\[(?:INSERT|TODO)[^\]]*\]|example\.com/iu.test(source)) {
      issues.push(`${filename}: unresolved template placeholder is forbidden.`);
    }
  }

  for (const [filename, expectedIds] of Object.entries(forms)) {
    const source = sources[filename];
    if (typeof source !== 'string' || source.length === 0) continue;
    requirePattern(issues, filename, source, /^name:\s+\S.+$/mu, 'name');
    requirePattern(
      issues,
      filename,
      source,
      /^description:\s+\S.+$/mu,
      'description'
    );
    requirePattern(issues, filename, source, /^body:\s*$/mu, 'body');
    requirePattern(
      issues,
      filename,
      source,
      /^\s+- label: I removed .*secrets\./mu,
      'secret-redaction acknowledgement'
    );
    requirePattern(
      issues,
      filename,
      source,
      /I agree to follow \[the Code of Conduct\]\(https:\/\/github\.com\/mherzog4\/byok-grid\/blob\/main\/CODE_OF_CONDUCT\.md\)\./u,
      'linked Code of Conduct acknowledgement'
    );

    const ids = Array.from(
      source.matchAll(/^\s+id:\s+([a-z0-9_]+)\s*$/gmu),
      (match) => match[1]
    );
    if (new Set(ids).size !== ids.length) {
      issues.push(`${filename}: issue-form field IDs must be unique.`);
    }
    if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) {
      issues.push(
        `${filename}: field IDs must be exactly ${expectedIds.join(', ')}.`
      );
    }
    for (const id of requiredFormFields[filename] ?? []) {
      if (!fieldRequiresInput(source, id)) {
        issues.push(`${filename}: field ${id} must remain required.`);
      }
    }
  }

  const config = sources['.github/ISSUE_TEMPLATE/config.yml'] ?? '';
  requirePattern(
    issues,
    '.github/ISSUE_TEMPLATE/config.yml',
    config,
    /^blank_issues_enabled:\s+false$/mu,
    'closed blank-issue policy'
  );
  requireText(
    issues,
    '.github/ISSUE_TEMPLATE/config.yml',
    config,
    'https://github.com/mherzog4/byok-grid/security/advisories/new',
    'private security-reporting link'
  );
  requireText(
    issues,
    '.github/ISSUE_TEMPLATE/config.yml',
    config,
    'https://github.com/mherzog4/byok-grid/blob/main/SUPPORT.md',
    'support-policy link'
  );

  const bug = sources['.github/ISSUE_TEMPLATE/bug_report.yml'] ?? '';
  requireText(
    issues,
    '.github/ISSUE_TEMPLATE/bug_report.yml',
    bug,
    'This is not a suspected security vulnerability.',
    'public security-report rejection'
  );

  const question = sources['.github/ISSUE_TEMPLATE/question.yml'] ?? '';
  requireText(
    issues,
    '.github/ISSUE_TEMPLATE/question.yml',
    question,
    'This is not a suspected security vulnerability or a private conduct report.',
    'private-report rejection'
  );

  const pullRequest = sources['.github/pull_request_template.md'] ?? '';
  for (const heading of [
    '## Verification',
    '## Production and compatibility review',
    '## Release impact',
  ]) {
    requireText(
      issues,
      '.github/pull_request_template.md',
      pullRequest,
      heading,
      `${heading} section`
    );
  }

  const codeOfConduct = sources['CODE_OF_CONDUCT.md'] ?? '';
  requireText(
    issues,
    'CODE_OF_CONDUCT.md',
    codeOfConduct,
    'Contributor Covenant',
    'recognized Contributor Covenant attribution'
  );
  requireText(
    issues,
    'CODE_OF_CONDUCT.md',
    codeOfConduct,
    'mailto:matthewherzog4@gmail.com',
    'private enforcement contact'
  );

  const readme = sources['README.md'] ?? '';
  for (const link of [
    '[CONTRIBUTING.md](CONTRIBUTING.md)',
    '[support policy](SUPPORT.md)',
    '[Code of Conduct](CODE_OF_CONDUCT.md)',
    '[SECURITY.md](SECURITY.md)',
  ]) {
    requireText(issues, 'README.md', readme, link, `${link} community link`);
  }

  const support = sources['SUPPORT.md'] ?? '';
  for (const link of [
    '[SECURITY.md](SECURITY.md)',
    '[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)',
    '[production-readiness ledger](docs/PRODUCTION_READINESS.md)',
  ]) {
    requireText(issues, 'SUPPORT.md', support, link, `${link} policy link`);
  }

  return { formCount: Object.keys(forms).length, issues };
}

export async function verifyCommunityDirectory(root = repositoryRoot) {
  const sources = {};
  for (const filename of requiredCommunityFiles) {
    try {
      sources[filename] = await readFile(resolve(root, filename), 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return verifyCommunitySources(sources);
}

function requirePattern(issues, filename, source, pattern, description) {
  if (!pattern.test(source)) {
    issues.push(`${filename}: missing ${description}.`);
  }
}

function requireText(issues, filename, source, expected, description) {
  if (!source.includes(expected)) {
    issues.push(`${filename}: missing ${description}.`);
  }
}

function fieldRequiresInput(source, id) {
  const match = new RegExp(`^    id: ${id}$`, 'mu').exec(source);
  if (!match || match.index === undefined) return false;
  const remainder = source.slice(match.index + match[0].length);
  const nextFieldIndex = remainder.search(/^  - type:/mu);
  const block =
    nextFieldIndex === -1 ? remainder : remainder.slice(0, nextFieldIndex);
  return /^      required:\s+true$/mu.test(block);
}

async function main() {
  const root = process.argv[2] ? resolve(process.argv[2]) : repositoryRoot;
  const result = await verifyCommunityDirectory(root);
  if (result.issues.length > 0) {
    for (const issue of result.issues) console.error(issue);
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify({
      forms: result.formCount,
      marker: 'BYOK_GRID_COMMUNITY_HEALTH_VERIFIED',
    })
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}

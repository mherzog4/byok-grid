import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import {
  ProductionEvidenceError,
  assertStablePromotionPaths,
  verifyProductionEvidenceFile,
} from './verify-production-evidence-lib.mjs';
import {
  ReleaseNotesError,
  verifyReleaseNotes,
} from './verify-release-notes-lib.mjs';

const releaseImages = readJson('release-images.json');
const rootPackage = readJson('package.json');

if (process.argv[2] === '--matrix') {
  process.stdout.write(JSON.stringify({ include: releaseImages.images }));
  process.exit(0);
}

const requestedVersion = (process.argv[2] ?? rootPackage.version).replace(
  /^v/,
  ''
);
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/;

if (!semverPattern.test(requestedVersion)) {
  fail('Pass a release version such as 0.1.0-rc.1 or v0.1.0.');
}

const lockfile = readJson('package-lock.json');
const chart = readFileSync('deploy/helm/byok-grid/Chart.yaml', 'utf8');
const values = readFileSync('deploy/helm/byok-grid/values.yaml', 'utf8');
const dockerfile = readFileSync('Dockerfile', 'utf8');
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const compose = readFileSync('docker-compose.yml', 'utf8');
const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8');
const releaseNotesPath = `docs/releases/v${requestedVersion}.md`;
let releaseNotes;
try {
  releaseNotes = readFileSync(releaseNotesPath, 'utf8');
} catch {
  fail(`Curated release notes are required at ${releaseNotesPath}.`);
}
const workflowSources = readdirSync('.github/workflows')
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => ({
    name,
    source: readFileSync(`.github/workflows/${name}`, 'utf8'),
  }));
const chartVersion = yamlScalar(chart, 'version');
const appVersion = yamlScalar(chart, 'appVersion');
const prereleaseAnnotation = yamlScalar(chart, 'artifacthub.io/prerelease');
const expectedPrerelease = requestedVersion.includes('-') ? 'true' : 'false';

assertEqual('package.json version', rootPackage.version, requestedVersion);
assertEqual('package-lock.json version', lockfile.version, requestedVersion);
assertEqual(
  'package-lock.json root package version',
  lockfile.packages?.['']?.version,
  requestedVersion
);
assertEqual('Helm chart version', chartVersion, requestedVersion);
assertEqual('Helm appVersion', appVersion, requestedVersion);
assertEqual(
  'Artifact Hub prerelease annotation',
  prereleaseAnnotation,
  expectedPrerelease
);

try {
  verifyReleaseNotes(releaseNotes, requestedVersion);
} catch (error) {
  if (error instanceof ReleaseNotesError) fail(error.message);
  throw error;
}

if (expectedPrerelease === 'false') {
  verifyStableProductionEvidence(requestedVersion);
}

if (releaseImages.schemaVersion !== 1 || !Array.isArray(releaseImages.images)) {
  fail('release-images.json must contain schemaVersion 1 and an images array.');
}

const targets = new Set();
const images = new Set();
for (const entry of releaseImages.images) {
  if (
    !entry ||
    typeof entry.target !== 'string' ||
    typeof entry.image !== 'string' ||
    !/^[a-z0-9][a-z0-9-]*$/.test(entry.target) ||
    !/^byok-grid-[a-z0-9-]+$/.test(entry.image)
  ) {
    fail('Every release image needs a safe target and byok-grid-* image name.');
  }
  if (targets.has(entry.target) || images.has(entry.image)) {
    fail(`Duplicate release image entry for ${entry.target}/${entry.image}.`);
  }
  targets.add(entry.target);
  images.add(entry.image);

  const stagePattern = new RegExp(
    `\\bAS\\s+${escapeRegex(entry.target)}\\b`,
    'i'
  );
  if (!stagePattern.test(dockerfile)) {
    fail(`Dockerfile does not define release target ${entry.target}.`);
  }

  if (!values.includes(`repository: ghcr.io/mherzog4/${entry.image}`)) {
    if (!['maintenance', 'airbyte-destination'].includes(entry.target)) {
      fail(`Helm defaults do not reference official image ${entry.image}.`);
    }
  }
}

if (!/aquasecurity\/trivy-action@[0-9a-f]{40}/.test(releaseWorkflow)) {
  fail('The release image scanner must be pinned to a full commit SHA.');
}

if (
  !releaseWorkflow.includes(
    'image-ref: ${{ env.IMAGE }}@${{ steps.build.outputs.digest }}'
  )
) {
  fail('The release scanner must inspect the immutable build digest.');
}

for (const smokeContract of [
  'set -euo pipefail',
  'for platform in linux/amd64 linux/arm64',
  'timeout --signal=KILL 30s docker run --rm --pull=always',
  '--platform "$platform"',
  '--network=none',
  '--read-only',
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges',
  '--pids-limit=64',
  '--image-smoke',
  'scripts/verify-release-image-smoke.mjs',
  'release-smoke-${{ matrix.target }}',
]) {
  if (!releaseWorkflow.includes(smokeContract)) {
    fail('Every release image must retain isolated multi-architecture smoke.');
  }
}

if (releaseWorkflow.includes('smoke_output=')) {
  fail('Release image output must stream directly into the bounded verifier.');
}

if (
  !/FROM \$\{NODE_IMAGE\} AS worker-runtime[\s\S]*?ENV TSX_DISABLE_CACHE=1/u.test(
    dockerfile
  )
) {
  fail('The TypeScript worker images must not require a writable cache path.');
}

if (releaseWorkflow.includes('type=raw,value=${{ env.VERSION }}')) {
  fail('Version image tags must not be published before every scan passes.');
}

if (
  rootPackage.scripts?.['release:publish-image-tags'] !==
  'node scripts/publish-release-image-tags.mjs'
) {
  fail('The release image tag publisher must remain a public command.');
}

for (const imagePublicationContract of [
  'npm run release:publish-image-tags --',
  'BYOK_GRID_GHCR_ACTOR: ${{ github.actor }}',
  'BYOK_GRID_GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
  '--digests-dir release-digests',
  "--owner '${{ github.repository_owner }}'",
]) {
  if (!releaseWorkflow.includes(imagePublicationContract)) {
    fail('Release image version tags must use the conflict-safe publisher.');
  }
}

const publishImagesJob = releaseWorkflow.match(
  /^  publish_images:\n(?<source>[\s\S]*?)(?=^  publish:)/mu
)?.groups?.source;
if (
  !publishImagesJob ||
  publishImagesJob.includes('docker buildx imagetools create') ||
  !publishImagesJob.includes('persist-credentials: false') ||
  !publishImagesJob.includes('node-version: 24')
) {
  fail('The release image publication job must retain its hardened contract.');
}

if (!releaseWorkflow.includes('needs: [verify, images, publish_images]')) {
  fail('Release files must wait for verified image version tags.');
}

if (
  !releaseWorkflow.includes(
    '--notes-file "docs/releases/v$VERSION.md" --title "BYOK Grid $VERSION"'
  ) ||
  releaseWorkflow.includes('--generate-notes')
) {
  fail('The release must publish its reviewed, version-bound notes file.');
}

if (!releaseWorkflow.includes('npm run release:package --')) {
  fail('The release must use the tested atomic artifact packager.');
}

if (
  rootPackage.scripts?.['release:verify-bundle'] !==
  'node scripts/verify-release-bundle.mjs'
) {
  fail('The release bundle verifier must remain a public repository command.');
}
if (
  rootPackage.scripts?.['release:verify-published'] !==
  'node scripts/verify-published-release.mjs'
) {
  fail(
    'The published release verifier must remain a public repository command.'
  );
}

const packageIndex = releaseWorkflow.indexOf('npm run release:package --');
const bundleVerificationIndex = releaseWorkflow.indexOf(
  'npm run release:verify-bundle --'
);
const releaseAttestationIndex = releaseWorkflow.indexOf(
  '- name: Attest release files'
);
const releasePublicationIndex = releaseWorkflow.indexOf(
  '- name: Publish GitHub Release'
);
const publishedVerificationIndex = releaseWorkflow.indexOf(
  'npm run release:verify-published --'
);
if (
  bundleVerificationIndex <= packageIndex ||
  releaseAttestationIndex <= bundleVerificationIndex ||
  releasePublicationIndex <= releaseAttestationIndex ||
  publishedVerificationIndex <= releasePublicationIndex ||
  !releaseWorkflow.includes('--directory dist/release')
) {
  fail(
    'Release files must be verified before attestation and after publication.'
  );
}

for (const publishedReleaseContract of [
  'repos/$GITHUB_REPOSITORY/releases/tags/v$VERSION',
  'X-GitHub-Api-Version: 2026-03-10',
  '--release-json dist/github-release.json',
  '--notes-file "docs/releases/v$VERSION.md"',
]) {
  if (!releaseWorkflow.includes(publishedReleaseContract)) {
    fail('The release workflow must read back the immutable GitHub Release.');
  }
}

for (const evidencePackagingContract of [
  'pattern: release-smoke-*',
  'path: release-smoke',
  '--smoke-dir release-smoke',
]) {
  if (!releaseWorkflow.includes(evidencePackagingContract)) {
    fail('Release packaging must retain validated image smoke evidence.');
  }
}

if (
  releaseWorkflow.includes('helm package deploy/helm/byok-grid') ||
  releaseWorkflow.includes('sha256sum ./*')
) {
  fail('Release packaging must not drift into untested inline workflow logic.');
}

if (!values.match(/^\s+digest: ''$/m)) {
  fail('Helm image values must expose an immutable digest override.');
}

for (const workflow of workflowSources) {
  for (const match of workflow.source.matchAll(/^\s*uses:\s*([^\s#]+)/gm)) {
    const reference = match[1];
    if (!reference.startsWith('./') && !/@[0-9a-f]{40}$/.test(reference)) {
      fail(
        `Workflow action ${reference} in ${workflow.name} must be pinned to a full commit SHA.`
      );
    }
  }
}

const imageDigestPattern = /@sha256:[0-9a-f]{64}$/;
const dockerfileFrontend = dockerfile.match(/^# syntax=(\S+)$/m)?.[1];
if (!dockerfileFrontend || !imageDigestPattern.test(dockerfileFrontend)) {
  fail('The Dockerfile frontend must be pinned by SHA-256 digest.');
}

const dockerBaseImages = Array.from(
  dockerfile.matchAll(/^ARG\s+(?:NODE|RUST|DEBIAN)_IMAGE=(\S+)$/gm),
  (match) => match[1]
);
if (
  dockerBaseImages.length !== 3 ||
  dockerBaseImages.some((reference) => !imageDigestPattern.test(reference))
) {
  fail('Every release Dockerfile base image must be pinned by SHA-256 digest.');
}

for (const [label, source] of [
  ['CI workflow', ciWorkflow],
  ['release workflow', releaseWorkflow],
]) {
  const postgres = source.match(/^\s*image:\s*(postgres:\S+)$/m)?.[1];
  if (!postgres || !imageDigestPattern.test(postgres)) {
    fail(`${label} PostgreSQL service image must be pinned by SHA-256 digest.`);
  }
}

const composeImages = Array.from(
  compose.matchAll(/^\s*image:\s*(\S+)$/gm),
  (match) => match[1]
);
if (
  composeImages.length === 0 ||
  composeImages.some((reference) => !imageDigestPattern.test(reference))
) {
  fail('Every Compose image must be pinned by SHA-256 digest.');
}

console.log(
  `Release version ${requestedVersion} and ${targets.size} images verified.`
);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function yamlScalar(source, key) {
  const escapedKey = escapeRegex(key);
  const match = source.match(
    new RegExp(`^\\s*${escapedKey}:\\s*['\"]?([^'\"\\s]+)['\"]?\\s*$`, 'm')
  );
  return match?.[1];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    fail(
      `${label} is ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}.`
    );
  }
}

function fail(message) {
  console.error(`Release verification failed: ${message}`);
  process.exit(1);
}

function currentCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    fail('The stable release commit could not be resolved.');
  }
}

function verifyStableProductionEvidence(version) {
  try {
    const verified = verifyProductionEvidenceFile(
      `docs/evidence/${version}-production.json`,
      { expectedReleaseVersion: version }
    );
    const releaseCommit = currentCommit();
    execFileSync(
      'git',
      ['merge-base', '--is-ancestor', verified.candidateCommit, releaseCommit],
      { stdio: 'ignore' }
    );
    const changedPaths = execFileSync(
      'git',
      [
        'diff',
        '--name-only',
        '--no-renames',
        verified.candidateCommit,
        releaseCommit,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
      .split('\n')
      .filter(Boolean);
    assertStablePromotionPaths(changedPaths, version);
  } catch (error) {
    if (error instanceof ProductionEvidenceError) fail(error.message);
    fail(
      'The observed candidate must be an available ancestor of the stable release.'
    );
  }
}

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  createGitHubApiReader,
  readLiveReleaseProtectionState,
  releaseProtectionRecordsFromManifest,
  RELEASE_PROTECTION_MARKER,
  verifyReleaseProtection,
  writeReleaseProtectionEvidence,
} from './verify-release-protection-lib.mjs';

const VERSION = '0.1.0-rc.1';
const CANDIDATE = 'a'.repeat(40);
const TAG_SHA = 'b'.repeat(40);
const REPOSITORY = 'mherzog4/byok-grid';
const OWNER_ID = 68_869_045;
const IMAGES = [
  'byok-grid-web',
  'byok-grid-workflow-worker',
  'byok-grid-migration',
  'byok-grid-maintenance',
  'byok-grid-connector-runner',
  'byok-grid-airbyte-destination',
  'byok-grid-analytics-projector',
];

describe('release protection verification', () => {
  it('binds active tag rules, immutable releases, a signed tag, and seven GHCR digests', async () => {
    const input = validInput();
    const result = await verifyReleaseProtection(input);

    assert.deepEqual(result, {
      candidate: CANDIDATE,
      creationRulesetId: 20348193,
      digestManifestSha256: input.digestManifestSha256,
      images: 7,
      immutableRelease: true,
      marker: RELEASE_PROTECTION_MARKER,
      mutationRulesetId: 20346817,
      publicImagesVerified: true,
      releaseId: 123,
      repository: REPOSITORY,
      signedTagVerified: true,
      tagObjectSha: TAG_SHA,
      version: VERSION,
    });
  });

  it('requires one exact no-bypass mutation ruleset', async () => {
    const missingRule = validInput();
    missingRule.rulesets[0].rules = [{ type: 'deletion' }, { type: 'update' }];
    await assert.rejects(
      verifyReleaseProtection(missingRule),
      /Exactly one no-bypass release tag mutation ruleset/u
    );

    const bypassed = validInput();
    bypassed.rulesets[0].bypass_actors = [
      { actor_id: OWNER_ID, actor_type: 'User', bypass_mode: 'always' },
    ];
    await assert.rejects(
      verifyReleaseProtection(bypassed),
      /Exactly one no-bypass release tag mutation ruleset/u
    );
  });

  it('requires release tag creation to be owner-only', async () => {
    const wrongActor = validInput();
    wrongActor.rulesets[1].bypass_actors[0].actor_id = OWNER_ID + 1;
    await assert.rejects(
      verifyReleaseProtection(wrongActor),
      /Exactly one owner-only release tag creation ruleset/u
    );

    const broadBypass = validInput();
    broadBypass.rulesets[1].bypass_actors.push({
      actor_id: 1,
      actor_type: 'OrganizationAdmin',
      bypass_mode: 'always',
    });
    await assert.rejects(
      verifyReleaseProtection(broadBypass),
      /Exactly one owner-only release tag creation ruleset/u
    );
  });

  it('rejects lightweight, unsigned, and candidate-drifted release tags', async () => {
    const lightweight = validInput();
    lightweight.tagReference.object.type = 'commit';
    await assert.rejects(
      verifyReleaseProtection(lightweight),
      /not a signed annotated tag/u
    );

    const unsigned = validInput();
    unsigned.annotatedTag.verification.verified = false;
    await assert.rejects(
      verifyReleaseProtection(unsigned),
      /signature or candidate binding is invalid/u
    );

    const drifted = validInput();
    drifted.annotatedTag.object.sha = 'c'.repeat(40);
    await assert.rejects(
      verifyReleaseProtection(drifted),
      /signature or candidate binding is invalid/u
    );
  });

  it('requires both repository and published-release immutability', async () => {
    const disabled = validInput();
    disabled.immutableReleases.enabled = false;
    await assert.rejects(
      verifyReleaseProtection(disabled),
      /immutable GitHub Releases must be enabled/u
    );

    const mutable = validInput();
    mutable.release.immutable = false;
    await assert.rejects(
      verifyReleaseProtection(mutable),
      /immutable GitHub Release state is invalid/u
    );
  });

  it('rejects missing, duplicate, absent, and digest-drifted image tags', async () => {
    const incomplete = validInput();
    incomplete.records.pop();
    await assert.rejects(
      verifyReleaseProtection(incomplete),
      /exact seven-image inventory/u
    );

    const duplicate = validInput();
    duplicate.records[6] = { ...duplicate.records[0] };
    await assert.rejects(verifyReleaseProtection(duplicate), /must be unique/u);

    const absent = validInput();
    absent.inspectTag = async () => ({ status: 'absent' });
    await assert.rejects(
      verifyReleaseProtection(absent),
      /does not match its immutable digest/u
    );

    const drifted = validInput();
    drifted.inspectTag = async () => ({
      digest: `sha256:${'f'.repeat(64)}`,
      status: 'present',
    });
    await assert.rejects(
      verifyReleaseProtection(drifted),
      /does not match its immutable digest/u
    );

    const privateImages = validInput();
    privateImages.inspectPublicTag = async () => ({ status: 'absent' });
    await assert.rejects(
      verifyReleaseProtection(privateImages),
      /not anonymously readable/u
    );
  });

  it('reconstructs the exact seven-image inventory from canonical release assets', () => {
    const expected = validInput().records;
    const source = `${expected
      .map((record) => record.source)
      .sort()
      .join('\n')}\n`;
    const releaseConfig = {
      images: expected.map(({ image, target }) => ({ image, target })),
      schemaVersion: 1,
    };
    const parsed = releaseProtectionRecordsFromManifest({
      owner: 'mherzog4',
      releaseConfig,
      source,
      version: VERSION,
    });
    assert.deepEqual(parsed.records, expected);
    assert.equal(
      parsed.digestManifestSha256,
      createHash('sha256').update(source).digest('hex')
    );

    assert.throws(
      () =>
        releaseProtectionRecordsFromManifest({
          owner: 'another-owner',
          releaseConfig,
          source,
          version: VERSION,
        }),
      /does not match the release owner/u
    );
    assert.throws(
      () =>
        releaseProtectionRecordsFromManifest({
          owner: 'mherzog4',
          releaseConfig,
          source: `${expected.map((record) => record.source).join('\n')}\n`,
          version: VERSION,
        }),
      /canonical sorted release set/u
    );
  });

  it('uses bounded versioned GitHub reads without exposing credentials', async () => {
    const token = 'github-secret-never-log';
    const calls = [];
    const read = createGitHubApiReader({
      fetchImplementation: async (url, options) => {
        calls.push({ options, url });
        return new Response('{"enabled":true}', {
          headers: { 'content-type': 'application/json' },
          status: 200,
        });
      },
      token,
    });
    assert.deepEqual(await read('/example'), { enabled: true });
    assert.equal(calls[0].url, 'https://api.github.com/example');
    assert.equal(calls[0].options.redirect, 'error');
    assert.equal(calls[0].options.headers.authorization, `Bearer ${token}`);
    assert.equal(
      calls[0].options.headers['x-github-api-version'],
      '2026-03-10'
    );

    const failed = createGitHubApiReader({
      fetchImplementation: async () => {
        throw new Error(`provider leaked ${token}`);
      },
      token,
    });
    await assert.rejects(failed('/example'), (error) => {
      assert.doesNotMatch(error.message, new RegExp(token, 'u'));
      return true;
    });

    const paginated = createGitHubApiReader({
      fetchImplementation: async () =>
        new Response('[]', {
          headers: {
            link: '<https://api.github.com/example?page=2>; rel="next"',
          },
          status: 200,
        }),
      token,
    });
    await assert.rejects(
      paginated('/example'),
      /exceeded the bounded inventory/u
    );
  });

  it('collects only active tag rules and peels the annotated tag object', async () => {
    const input = validInput();
    const paths = [];
    const responses = new Map([
      ['/users/mherzog4', input.ownerAccount],
      [
        '/repos/mherzog4/byok-grid/rulesets?includes_parents=true&per_page=100',
        [
          rulesetSummary(input.rulesets[0]),
          rulesetSummary(input.rulesets[1]),
          {
            enforcement: 'active',
            id: 1,
            target: 'branch',
          },
        ],
      ],
      ['/repos/mherzog4/byok-grid/immutable-releases', input.immutableReleases],
      [
        '/repos/mherzog4/byok-grid/git/ref/tags/v0.1.0-rc.1',
        input.tagReference,
      ],
      ['/repos/mherzog4/byok-grid/releases/tags/v0.1.0-rc.1', input.release],
      ['/repos/mherzog4/byok-grid/rulesets/20346817', input.rulesets[0]],
      ['/repos/mherzog4/byok-grid/rulesets/20348193', input.rulesets[1]],
      [`/repos/mherzog4/byok-grid/git/tags/${TAG_SHA}`, input.annotatedTag],
    ]);
    const state = await readLiveReleaseProtectionState({
      readGitHub: async (path) => {
        paths.push(path);
        if (!responses.has(path)) throw new Error(`unexpected ${path}`);
        return structuredClone(responses.get(path));
      },
      repository: REPOSITORY,
      version: VERSION,
    });

    assert.equal(state.rulesets.length, 2);
    assert.ok(paths.includes(`/repos/mherzog4/byok-grid/git/tags/${TAG_SHA}`));
    assert.equal(
      paths.some((path) => path.includes('/rulesets/1')),
      false
    );
  });

  it('writes canonical private evidence once and refuses overwrite', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'byok-grid-protection-'));
    const path = join(directory, 'protection.json');
    const result = await verifyReleaseProtection(validInput());
    writeReleaseProtectionEvidence(path, result);

    assert.equal(readFileSync(path, 'utf8'), `${JSON.stringify(result)}\n`);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.throws(
      () => writeReleaseProtectionEvidence(path, result),
      /could not be written exclusively/u
    );
  });

  it('fails before network access without credentials and leaves no partial evidence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'byok-grid-protection-cli-'));
    const input = validInput();
    const manifest = join(directory, 'IMAGE_DIGESTS.txt');
    const output = join(directory, 'protection.json');
    writeFileSync(
      manifest,
      `${input.records
        .map((record) => record.source)
        .sort()
        .join('\n')}\n`
    );
    const githubSecret = 'github-cli-secret-never-log';
    const ghcrSecret = 'ghcr-cli-secret-never-log';
    const result = spawnSync(
      process.execPath,
      [
        'scripts/verify-release-protection.mjs',
        '--version',
        VERSION,
        '--candidate',
        CANDIDATE,
        '--digest-manifest',
        manifest,
        '--owner',
        'mherzog4',
        '--repository',
        REPOSITORY,
        '--output',
        output,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          BYOK_GRID_GHCR_ACTOR: githubSecret,
          BYOK_GRID_GHCR_TOKEN: ghcrSecret,
          BYOK_GRID_GITHUB_TOKEN: '',
        },
      }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /GitHub API credential is required/u);
    assert.doesNotMatch(result.stderr, new RegExp(githubSecret, 'u'));
    assert.doesNotMatch(result.stderr, new RegExp(ghcrSecret, 'u'));
    assert.equal(existsSync(output), false);
  });
});

function validInput() {
  const records = IMAGES.map((image, index) => {
    const digest = `sha256:${String(index + 1).repeat(64)}`;
    const repository = `ghcr.io/mherzog4/${image}`;
    return {
      destination: `${repository}:${VERSION}`,
      digest,
      image,
      repository,
      source: `${repository}@${digest}`,
      target: image.slice('byok-grid-'.length),
      version: VERSION,
    };
  });
  return {
    annotatedTag: {
      object: { sha: CANDIDATE, type: 'commit' },
      sha: TAG_SHA,
      tag: `v${VERSION}`,
      url: `https://api.github.com/repos/${REPOSITORY}/git/tags/${TAG_SHA}`,
      verification: { reason: 'valid', verified: true },
    },
    candidate: CANDIDATE,
    digestManifestSha256: createHash('sha256')
      .update(
        `${records
          .map((record) => record.source)
          .sort()
          .join('\n')}\n`
      )
      .digest('hex'),
    immutableReleases: { enabled: true, enforced_by_owner: false },
    inspectPublicTag: async (record) => ({
      digest: record.digest,
      status: 'present',
    }),
    inspectTag: async (record) => ({
      digest: record.digest,
      status: 'present',
    }),
    ownerAccount: { id: OWNER_ID, login: 'mherzog4', type: 'User' },
    records,
    release: {
      draft: false,
      html_url: `https://github.com/${REPOSITORY}/releases/tag/v${VERSION}`,
      id: 123,
      immutable: true,
      prerelease: true,
      tag_name: `v${VERSION}`,
    },
    repository: REPOSITORY,
    rulesets: [mutationRuleset(), creationRuleset()],
    tagReference: {
      object: { sha: TAG_SHA, type: 'tag' },
      ref: `refs/tags/v${VERSION}`,
      url: `https://api.github.com/repos/${REPOSITORY}/git/refs/tags/v${VERSION}`,
    },
    version: VERSION,
  };
}

function mutationRuleset() {
  return baseRuleset({
    bypass_actors: [],
    current_user_can_bypass: 'never',
    id: 20346817,
    rules: [
      { type: 'deletion' },
      { type: 'update' },
      { type: 'non_fast_forward' },
    ],
  });
}

function creationRuleset() {
  return baseRuleset({
    bypass_actors: [
      { actor_id: OWNER_ID, actor_type: 'User', bypass_mode: 'always' },
    ],
    current_user_can_bypass: 'always',
    id: 20348193,
    rules: [{ type: 'creation' }],
  });
}

function baseRuleset({ bypass_actors, current_user_can_bypass, id, rules }) {
  return {
    _links: {
      html: { href: `https://github.com/${REPOSITORY}/rules/${id}` },
    },
    bypass_actors,
    conditions: {
      ref_name: { exclude: [], include: ['refs/tags/v*'] },
    },
    current_user_can_bypass,
    enforcement: 'active',
    id,
    rules,
    source: REPOSITORY,
    source_type: 'Repository',
    target: 'tag',
  };
}

function rulesetSummary(ruleset) {
  return {
    enforcement: ruleset.enforcement,
    id: ruleset.id,
    target: ruleset.target,
  };
}

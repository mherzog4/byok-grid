import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  verifyWorkflowDirectory,
  verifyWorkflowSource,
} from './verify-workflows.mjs';

const sha = 'a'.repeat(40);
const validWorkflow = `name: Test
on: push
permissions:
  contents: read
concurrency:
  group: test
jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Checkout
        uses: actions/checkout@${sha}
        with:
          persist-credentials: false
      - uses: owner/action/subpath@${sha} # v1
`;

test('accepts the repository workflow policy fixtures', async () => {
  const result = await verifyWorkflowDirectory(
    resolve(import.meta.dirname, '../.github/workflows')
  );
  assert.deepEqual(result.issues, []);
  assert.ok(result.workflowCount >= 3);
  assert.ok(result.actionCount > 0);
});

test('accepts full pins and credential-free checkout', () => {
  assert.deepEqual(verifyWorkflowSource(validWorkflow).issues, []);
});

test('rejects mutable action references', () => {
  const result = verifyWorkflowSource(
    validWorkflow.replace(`owner/action/subpath@${sha}`, 'owner/action@v1')
  );
  assert.match(result.issues.join('\n'), /full immutable commit/u);
});

test('rejects checkout credential persistence', () => {
  const result = verifyWorkflowSource(
    validWorkflow.replace('persist-credentials: false', 'fetch-depth: 1')
  );
  assert.match(result.issues.join('\n'), /persist-credentials: false/u);
});

test('rejects privileged trigger handoffs', () => {
  for (const trigger of ['pull_request_target', 'workflow_run']) {
    const result = verifyWorkflowSource(
      validWorkflow.replace('on: push', `on:\n  ${trigger}:`)
    );
    assert.match(result.issues.join('\n'), new RegExp(trigger, 'u'));
  }
});

test('requires concurrency, job timeouts, and permission boundaries', () => {
  const result = verifyWorkflowSource(
    validWorkflow
      .replace('permissions:\n  contents: read\n', '')
      .replace('concurrency:\n  group: test\n', '')
      .replace('    timeout-minutes: 10\n', '')
  );
  const issues = result.issues.join('\n');
  assert.match(issues, /concurrency policy/u);
  assert.match(issues, /positive timeout-minutes/u);
  assert.match(issues, /explicit permissions/u);
});

test('rejects job-wide GitHub token exposure', () => {
  const result = verifyWorkflowSource(
    validWorkflow.replace(
      '    steps:',
      '    env:\n      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n    steps:'
    )
  );
  assert.match(result.issues.join('\n'), /scope GitHub tokens to the step/u);
});

test('rejects unsupported manual CodeQL builds for Rust matrix entries', () => {
  const workflow = `${validWorkflow}
  codeql:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      matrix:
        include:
          - language: javascript-typescript
            build-mode: manual
          - language: rust
            build-mode: manual
    steps:
      - run: true
`;
  const result = verifyWorkflowSource(workflow);
  assert.match(result.issues.join('\n'), /Rust must use build-mode none/u);
});

test('accepts no-build CodeQL mode for Rust matrix entries', () => {
  const workflow = `${validWorkflow}
  codeql:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      matrix:
        include:
          - language: javascript-typescript
            build-mode: none
          - language: rust
            build-mode: none
    steps:
      - run: true
`;
  assert.deepEqual(verifyWorkflowSource(workflow).issues, []);
});

test('the verifier contains no runtime package imports', async () => {
  const source = await readFile(
    resolve(import.meta.dirname, 'verify-workflows.mjs'),
    'utf8'
  );
  assert.doesNotMatch(source, /from ['"](?!node:|\.\/)/u);
});

test('the command exits nonzero when a workflow violates policy', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'byok-grid-workflow-policy-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  await writeFile(
    join(directory, 'unsafe.yml'),
    validWorkflow.replace(`owner/action/subpath@${sha}`, 'owner/action@main')
  );

  const result = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, 'verify-workflows.mjs'), directory],
    { encoding: 'utf8' }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /full immutable commit/u);
  assert.doesNotMatch(result.stdout, /BYOK_GRID_WORKFLOW_POLICY_VERIFIED/u);
});

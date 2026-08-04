#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONNECTOR_SDK_PACKAGE_MARKER =
  'BYOK_GRID_CONNECTOR_SDK_PACKAGE_VERIFIED';

const EXPECTED_FILES = Object.freeze([
  'LICENSE',
  'README.md',
  'dist/index.d.ts',
  'dist/index.d.ts.map',
  'dist/index.js',
  'dist/index.js.map',
  'package.json',
]);

export function verifyConnectorSdkPackResult(value, expected) {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error('npm pack must return exactly one package record.');
  }
  const record = object(value[0], 'npm pack record');
  if (
    record.name !== expected.name ||
    record.version !== expected.version ||
    record.id !== `${expected.name}@${expected.version}` ||
    record.filename !== 'byok-grid-connector-sdk-' + expected.version + '.tgz'
  ) {
    throw new Error('npm pack returned an unexpected package identity.');
  }
  if (
    !Number.isSafeInteger(record.size) ||
    record.size <= 0 ||
    !Number.isSafeInteger(record.unpackedSize) ||
    record.unpackedSize <= 0 ||
    record.entryCount !== EXPECTED_FILES.length ||
    !Array.isArray(record.bundled) ||
    record.bundled.length !== 0
  ) {
    throw new Error('npm pack returned invalid package metadata.');
  }
  if (!Array.isArray(record.files)) {
    throw new Error('npm pack returned no package file inventory.');
  }
  const paths = record.files.map((rawFile) => {
    const file = object(rawFile, 'npm pack file');
    if (
      typeof file.path !== 'string' ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      file.mode !== 420
    ) {
      throw new Error('npm pack returned invalid package file metadata.');
    }
    return file.path;
  });
  if (
    paths.length !== EXPECTED_FILES.length ||
    paths.some((path, index) => path !== EXPECTED_FILES[index])
  ) {
    throw new Error('The connector SDK package file inventory drifted.');
  }
  return {
    files: paths.length,
    marker: CONNECTOR_SDK_PACKAGE_MARKER,
    name: record.name,
    version: record.version,
  };
}

export function verifyConnectorSdkPackage(options = {}) {
  const root = resolve(options.rootDirectory ?? process.cwd());
  const manifest = JSON.parse(
    readFileSync(join(root, 'packages/connector-sdk/package.json'), 'utf8')
  );
  const cache = mkdtempSync(join(tmpdir(), 'byok-grid-sdk-npm-cache-'));
  const runCommand = options.runCommand ?? runNpmPack;
  try {
    const result = runCommand(
      [
        '--silent',
        '--cache',
        cache,
        'pack',
        '--dry-run',
        '--json',
        '--workspace=@byok-grid/connector-sdk',
      ],
      root
    );
    if (result.status !== 0 || typeof result.stdout !== 'string') {
      throw new Error('npm could not assemble the connector SDK package.');
    }
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error('npm pack returned malformed JSON.');
    }
    return verifyConnectorSdkPackResult(parsed, {
      name: manifest.name,
      version: manifest.version,
    });
  } finally {
    rmSync(cache, { force: true, recursive: true });
  }
}

function runNpmPack(args, cwd) {
  return spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`The ${name} is malformed.`);
  }
  return value;
}

function main() {
  try {
    process.stdout.write(`${JSON.stringify(verifyConnectorSdkPackage())}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Connector SDK package verification failed.'}\n`
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main();
}

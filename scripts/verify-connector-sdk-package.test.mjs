import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  CONNECTOR_SDK_PACKAGE_MARKER,
  verifyConnectorSdkPackResult,
  verifyConnectorSdkPackage,
} from './verify-connector-sdk-package.mjs';

describe('connector SDK package verifier', () => {
  it('accepts only the exact public package identity and file inventory', () => {
    assert.deepEqual(
      verifyConnectorSdkPackResult(packResult(), {
        name: '@byok-grid/connector-sdk',
        version: '0.2.0',
      }),
      {
        files: 7,
        marker: CONNECTOR_SDK_PACKAGE_MARKER,
        name: '@byok-grid/connector-sdk',
        version: '0.2.0',
      }
    );

    const unexpected = packResult();
    unexpected[0].files.push({ mode: 420, path: '.env', size: 10 });
    assert.throws(
      () =>
        verifyConnectorSdkPackResult(unexpected, {
          name: '@byok-grid/connector-sdk',
          version: '0.2.0',
        }),
      /file inventory drifted/u
    );
  });

  it('uses and removes a private npm cache on success', () => {
    let cache;
    const result = verifyConnectorSdkPackage({
      runCommand(args) {
        cache = args[args.indexOf('--cache') + 1];
        assert.equal(existsSync(cache), true);
        assert.match(cache, /byok-grid-sdk-npm-cache-/u);
        return { status: 0, stdout: JSON.stringify(packResult()) };
      },
    });
    assert.equal(result.marker, CONNECTOR_SDK_PACKAGE_MARKER);
    assert.equal(existsSync(cache), false);
  });

  it('removes the private npm cache after a bounded failure', () => {
    let cache;
    assert.throws(
      () =>
        verifyConnectorSdkPackage({
          runCommand(args) {
            cache = args[args.indexOf('--cache') + 1];
            return { status: 1, stdout: '' };
          },
        }),
      /could not assemble/u
    );
    assert.equal(existsSync(cache), false);
  });
});

function packResult() {
  const paths = [
    'LICENSE',
    'README.md',
    'dist/index.d.ts',
    'dist/index.d.ts.map',
    'dist/index.js',
    'dist/index.js.map',
    'package.json',
  ];
  return [
    {
      bundled: [],
      entryCount: paths.length,
      filename: 'byok-grid-connector-sdk-0.2.0.tgz',
      files: paths.map((path) => ({ mode: 420, path, size: 10 })),
      id: '@byok-grid/connector-sdk@0.2.0',
      name: '@byok-grid/connector-sdk',
      size: 100,
      unpackedSize: 200,
      version: '0.2.0',
    },
  ];
}

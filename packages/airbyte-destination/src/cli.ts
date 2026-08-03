#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import {
  AirbyteDestinationConfigurationError,
  parseConfiguredCatalog,
  parseDestinationConfig,
} from './config.js';
import { AirbyteDestinationWriter, checkAllEndpoints } from './destination.js';
import { destinationSpecification } from './spec.js';
import type { DestinationRuntime } from './types.js';

export interface CliDependencies {
  inputLines: AsyncIterable<string>;
  readJson(path: string): Promise<unknown>;
  runtime: DestinationRuntime;
}

export async function main(
  args = process.argv.slice(2),
  dependencies: Partial<CliDependencies> = {}
): Promise<number> {
  const runtime = dependencies.runtime ?? defaultRuntime();
  const readJsonFile = dependencies.readJson ?? readJson;
  const command = args[0]?.replace(/^--/, '');
  if (command === 'image-smoke') {
    runtime.emit(
      JSON.stringify({
        marker: 'BYOK_GRID_IMAGE_SMOKE_READY',
        target: 'airbyte-destination',
      })
    );
    return 0;
  }
  if (command === 'spec') {
    runtime.emit(JSON.stringify(destinationSpecification));
    return 0;
  }
  const configPath = option(args, '--config');
  if (command === 'check') {
    if (!configPath) return usageFailure(runtime, 'check requires --config.');
    try {
      const config = parseDestinationConfig(await readJsonFile(configPath));
      await checkAllEndpoints(config, runtime);
      emitProtocol(runtime, {
        connectionStatus: { status: 'SUCCEEDED' },
        type: 'CONNECTION_STATUS',
      });
      return 0;
    } catch (error) {
      emitProtocol(runtime, {
        connectionStatus: {
          message: safeMessage(error),
          status: 'FAILED',
        },
        type: 'CONNECTION_STATUS',
      });
      return 0;
    }
  }
  if (command === 'write') {
    const catalogPath = option(args, '--catalog');
    if (!configPath || !catalogPath) {
      return usageFailure(runtime, 'write requires --config and --catalog.');
    }
    try {
      const config = parseDestinationConfig(await readJsonFile(configPath));
      const catalog = parseConfiguredCatalog(
        await readJsonFile(catalogPath),
        config
      );
      const capabilities = await checkAllEndpoints(config, runtime);
      const writer = new AirbyteDestinationWriter({
        capabilities,
        catalog,
        config,
        runtime,
      });
      const input =
        dependencies.inputLines ??
        createInterface({ crlfDelay: Infinity, input: process.stdin });
      for await (const line of input) await writer.acceptLine(line);
      await writer.finish();
      return 0;
    } catch (error) {
      emitProtocol(runtime, {
        log: { level: 'FATAL', message: safeMessage(error) },
        type: 'LOG',
      });
      return 1;
    }
  }
  return usageFailure(runtime, 'Expected spec, check, or write.');
}

function defaultRuntime(): DestinationRuntime {
  return {
    emit: (line) => process.stdout.write(`${line}\n`),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    randomId: () => randomUUID(),
    sleep: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}

async function readJson(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new AirbyteDestinationConfigurationError(
      `Configuration file “${path.slice(0, 200)}” is not valid JSON.`
    );
  }
}

function option(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : null;
}

function emitProtocol(runtime: DestinationRuntime, message: unknown): void {
  runtime.emit(JSON.stringify(message));
}

function usageFailure(runtime: DestinationRuntime, message: string): number {
  emitProtocol(runtime, { log: { level: 'FATAL', message }, type: 'LOG' });
  return 1;
}

function safeMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : 'The destination failed.';
  return message.replace(/[\r\n\t]/g, ' ').slice(0, 500);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main();
}

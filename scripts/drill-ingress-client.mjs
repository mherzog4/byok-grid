import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ingressClientProbeConfig,
  runIngressClientProbe,
} from './drill-ingress-client-lib.mjs';

async function main() {
  try {
    const config = ingressClientProbeConfig(process.argv, process.env);
    process.stdout.write(
      `${JSON.stringify(await runIngressClientProbe(config))}\n`
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Ingress client probe failed.'}\n`
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}

import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import {
  Agent,
  fetch as undiciFetch,
  interceptors,
  type RequestInit as UndiciRequestInit,
} from 'undici';
import { ConnectorError } from '@byok-grid/connector-sdk';

const blockedAddresses = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:2::', 48],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, 'ipv6');
}

export function isBlockedEgressAddress(
  address: string,
  family: 4 | 6
): boolean {
  return blockedAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export const guardedEgressDispatcher = new Agent().compose(
  interceptors.dns({
    maxTTL: 10_000,
    lookup(origin, _options, callback) {
      lookup(
        origin.hostname,
        { all: true, verbatim: true },
        (error, addresses) => {
          if (error) {
            callback(error, []);
            return;
          }
          const records = addresses.map((address) => ({
            address: address.address,
            family: address.family as 4 | 6,
            ttl: 10_000,
          }));
          if (
            records.length === 0 ||
            records.some((record) =>
              isBlockedEgressAddress(record.address, record.family)
            )
          ) {
            callback(egressDeniedError(), []);
            return;
          }
          callback(null, records);
        }
      );
    },
  })
);

export const guardedEgressFetch: typeof globalThis.fetch = async (
  input,
  init
) => {
  const url =
    input instanceof URL
      ? input
      : new URL(typeof input === 'string' ? input : input.url);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  if (
    (family === 4 || family === 6) &&
    isBlockedEgressAddress(hostname, family)
  ) {
    throw new ConnectorError(
      'policy',
      'Connector requests cannot target private or reserved networks.',
      false
    );
  }

  try {
    const undiciInit: UndiciRequestInit = {
      ...(init as unknown as UndiciRequestInit),
      dispatcher: guardedEgressDispatcher,
    };
    return (await undiciFetch(url, undiciInit)) as unknown as Response;
  } catch (error) {
    if (errorChainHasCode(error, 'EACCES')) {
      throw new ConnectorError(
        'policy',
        'Connector requests cannot target private or reserved networks.',
        false,
        { cause: error }
      );
    }
    throw error;
  }
};

function errorChainHasCode(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== 'object') return false;
    if ((current as NodeJS.ErrnoException).code === code) return true;
    current = (current as Error).cause;
  }
  return false;
}

function egressDeniedError(): NodeJS.ErrnoException {
  return Object.assign(new Error('Egress destination denied by policy.'), {
    code: 'EACCES',
  });
}

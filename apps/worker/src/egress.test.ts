import { describe, expect, it } from 'vitest';
import { egressFetch, isBlockedEgressAddress } from './egress';

describe('worker egress policy', () => {
  it.each([
    ['127.0.0.1', 4],
    ['169.254.169.254', 4],
    ['10.10.10.10', 4],
    ['192.168.1.1', 4],
    ['::1', 6],
    ['fd00::1', 6],
    ['fe80::1', 6],
    ['::ffff:127.0.0.1', 6],
  ] as const)('blocks %s', (address, family) => {
    expect(isBlockedEgressAddress(address, family)).toBe(true);
  });

  it.each([
    ['8.8.8.8', 4],
    ['1.1.1.1', 4],
    ['2606:4700:4700::1111', 6],
    ['::ffff:8.8.8.8', 6],
  ] as const)('allows public address %s', (address, family) => {
    expect(isBlockedEgressAddress(address, family)).toBe(false);
  });

  it('rejects a private IP literal before opening a connection', async () => {
    await expect(
      egressFetch('https://127.0.0.1/private')
    ).rejects.toMatchObject({ code: 'policy', retryable: false });
  });

  it('rejects a hostname that resolves to a private address', async () => {
    await expect(
      egressFetch('https://localhost/private')
    ).rejects.toMatchObject({ code: 'policy', retryable: false });
  });
});

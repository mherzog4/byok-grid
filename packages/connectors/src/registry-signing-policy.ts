export function formatRegistryPublisherFingerprint(
  publicKeyHex: string
): string {
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex)) {
    throw new TypeError('Publisher public key must be 32-byte lowercase hex.');
  }
  // TODO(contributor): choose the operator-facing fingerprint convention.
  return publicKeyHex.match(/.{8}/g)!.join(':');
}

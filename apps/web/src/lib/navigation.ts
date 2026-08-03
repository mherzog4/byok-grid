export function safeInternalPath(
  value: string | null | undefined,
  fallback = '/app'
): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) {
    return fallback;
  }
  if (value.includes('\\') || /[\u0000-\u001F\u007F]/.test(value)) {
    return fallback;
  }
  const base = new URL('http://byok-grid.local');
  const target = new URL(value, base);
  if (target.origin !== base.origin) return fallback;
  return `${target.pathname}${target.search}${target.hash}`;
}

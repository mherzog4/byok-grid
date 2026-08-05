export const repositoryUrl = 'https://github.com/mherzog4/byok-grid';
export const documentationUrl = `${repositoryUrl}#local-development`;
export const licenseUrl = `${repositoryUrl}/blob/main/LICENSE`;

export function siteUrl(): URL {
  const configured =
    process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (!configured) return new URL('https://byok-grid.vercel.app');
  return new URL(
    configured.startsWith('http://') || configured.startsWith('https://')
      ? configured
      : `https://${configured}`
  );
}

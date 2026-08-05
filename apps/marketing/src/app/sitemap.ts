import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      changeFrequency: 'weekly',
      lastModified: new Date('2026-08-05T00:00:00Z'),
      priority: 1,
      url: siteUrl().toString(),
    },
  ];
}

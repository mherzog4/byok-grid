import { describe, expect, it } from 'vitest';
import { AnalyticsProjectorHealthServer } from './health-server';

describe('analytics projector health server', () => {
  it('separates process liveness from initialized readiness', async () => {
    let port = 0;
    const server = new AnalyticsProjectorHealthServer({
      host: '127.0.0.1',
      onListening: (address) => {
        port = address.port;
      },
      port: 0,
    });

    await server.listen();
    const url = (path: string) => `http://127.0.0.1:${port}${path}`;
    try {
      const live = await fetch(url('/live'));
      expect(live.status).toBe(200);
      expect(live.headers.get('cache-control')).toBe('no-store');
      await expect(live.json()).resolves.toEqual({ status: 'live' });

      const initializing = await fetch(url('/ready'));
      expect(initializing.status).toBe(503);
      await expect(initializing.json()).resolves.toEqual({
        status: 'not_ready',
      });

      server.setReady(true);
      const ready = await fetch(url('/ready'));
      expect(ready.status).toBe(200);
      await expect(ready.json()).resolves.toEqual({ status: 'ready' });

      expect((await fetch(url('/live'), { method: 'POST' })).status).toBe(404);
      expect((await fetch(url('/unknown'))).status).toBe(404);
    } finally {
      await server.close();
    }

    await expect(fetch(url('/live'))).rejects.toThrow();
  });
});

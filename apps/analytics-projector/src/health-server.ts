import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const REQUEST_TIMEOUT_MILLISECONDS = 5_000;

export interface AnalyticsProjectorHealthServerOptions {
  host?: string;
  onListening?: (address: AddressInfo) => void;
  port: number;
}

export class AnalyticsProjectorHealthServer {
  readonly #host: string;
  readonly #onListening: ((address: AddressInfo) => void) | undefined;
  readonly #port: number;
  #ready = false;
  #server: Server | undefined;

  constructor(options: AnalyticsProjectorHealthServerOptions) {
    this.#host = options.host ?? '0.0.0.0';
    this.#onListening = options.onListening;
    this.#port = options.port;
  }

  async listen(): Promise<void> {
    if (this.#server)
      throw new Error('Analytics health server already started.');
    const server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      if (request.method !== 'GET') {
        writeJson(response, 404, { status: 'not_found' });
        return;
      }
      if (request.url === '/live') {
        writeJson(response, 200, { status: 'live' });
        return;
      }
      if (request.url === '/ready') {
        writeJson(response, this.#ready ? 200 : 503, {
          status: this.#ready ? 'ready' : 'not_ready',
        });
        return;
      }
      writeJson(response, 404, { status: 'not_found' });
    });
    configureServerLimits(server);
    this.#server = server;

    try {
      await listen(server, this.#port, this.#host);
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Analytics health server has no TCP address.');
      }
      this.#onListening?.(address);
    } catch (error) {
      this.#server = undefined;
      await closeServer(server);
      throw error;
    }
  }

  setReady(ready: boolean): void {
    this.#ready = ready;
  }

  async close(): Promise<void> {
    this.#ready = false;
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await closeServer(server);
  }
}

function configureServerLimits(server: Server): void {
  server.headersTimeout = REQUEST_TIMEOUT_MILLISECONDS;
  server.keepAliveTimeout = REQUEST_TIMEOUT_MILLISECONDS;
  server.requestTimeout = REQUEST_TIMEOUT_MILLISECONDS;
  server.maxRequestsPerSocket = 100;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    server.once('error', fail);
    server.listen(port, host, () => {
      server.removeListener('error', fail);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, string>>
): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

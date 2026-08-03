import { describe, expect, it } from 'vitest';
import { parseConfiguredCatalog, parseDestinationConfig } from './config.js';

const token = `bg_ingest_${'a'.repeat(43)}`;
const endpointOne =
  'https://grid.example.test/api/ingest/11111111-1111-4111-8111-111111111111';

describe('Airbyte destination configuration', () => {
  it('parses bounded routes and catalog append modes', () => {
    const config = parseDestinationConfig({
      routes: [
        {
          bearer_token: token,
          endpoint_url: endpointOne,
          namespace: 'crm',
          stream: 'companies',
        },
      ],
    });
    expect(config).toMatchObject({
      allowInsecureHttp: false,
      applicationTimeoutSeconds: 600,
      batchMaximumRecords: 500,
      routes: [{ namespace: 'crm', stream: 'companies' }],
    });
    expect(
      parseConfiguredCatalog(
        {
          streams: [
            {
              destination_sync_mode: 'append_dedup',
              stream: { name: 'companies', namespace: 'crm' },
            },
          ],
        },
        config
      )
    ).toEqual({
      streams: [
        {
          destination_sync_mode: 'append_dedup',
          stream: { name: 'companies', namespace: 'crm' },
        },
      ],
    });
  });

  it('rejects insecure, duplicate, unrouted, and overwrite configurations', () => {
    expect(() =>
      parseDestinationConfig({
        routes: [
          {
            bearer_token: token,
            endpoint_url: endpointOne.replace('https:', 'http:'),
            stream: 'companies',
          },
        ],
      })
    ).toThrow(/HTTPS/i);
    expect(() =>
      parseDestinationConfig({
        routes: [
          {
            bearer_token: token,
            endpoint_url: endpointOne,
            stream: 'companies',
          },
          {
            bearer_token: token,
            endpoint_url: endpointOne,
            stream: 'contacts',
          },
        ],
      })
    ).toThrow(/separate/i);
    const config = parseDestinationConfig({
      routes: [
        {
          bearer_token: token,
          endpoint_url: endpointOne,
          stream: 'companies',
        },
      ],
    });
    expect(() =>
      parseConfiguredCatalog(
        {
          streams: [
            {
              destination_sync_mode: 'overwrite',
              stream: { name: 'companies' },
            },
          ],
        },
        config
      )
    ).toThrow(/does not support/i);
    expect(() =>
      parseConfiguredCatalog(
        { streams: [{ stream: { name: 'companies' } }] },
        config
      )
    ).toThrow(/must select append or append_dedup/i);
    expect(() =>
      parseConfiguredCatalog(
        {
          streams: [
            {
              destination_sync_mode: 'append',
              stream: { name: 'contacts' },
            },
          ],
        },
        config
      )
    ).toThrow(/No BYOK Grid endpoint/i);
  });
});

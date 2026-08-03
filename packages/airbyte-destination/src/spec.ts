export const destinationSpecification = {
  type: 'SPEC',
  spec: {
    documentationUrl:
      'https://github.com/byok-grid/byok-grid/blob/main/docs/PUSH_INGESTION.md',
    connectionSpecification: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        routes: {
          description:
            'Map each configured Airbyte stream to a separate BYOK Grid table ingestion endpoint.',
          items: {
            additionalProperties: false,
            properties: {
              bearer_token: {
                airbyte_secret: true,
                description:
                  'The one-time token shown when the endpoint was created.',
                title: 'Bearer token',
                type: 'string',
              },
              endpoint_url: {
                description:
                  'Full /api/ingest/<UUID> URL for the target table.',
                title: 'Endpoint URL',
                type: 'string',
              },
              namespace: {
                description:
                  'Optional Airbyte namespace. Leave unset for unnamespaced streams.',
                title: 'Namespace',
                type: 'string',
              },
              stream: { title: 'Stream', type: 'string' },
            },
            required: ['stream', 'endpoint_url', 'bearer_token'],
            type: 'object',
          },
          maxItems: 50,
          minItems: 1,
          title: 'Stream routes',
          type: 'array',
        },
        allow_insecure_http: {
          default: false,
          description:
            'Development only. Permit plaintext HTTP to a trusted internal BYOK Grid service.',
          title: 'Allow insecure HTTP',
          type: 'boolean',
        },
        application_timeout_seconds: {
          default: 600,
          maximum: 1800,
          minimum: 30,
          title: 'Application timeout (seconds)',
          type: 'integer',
        },
        batch_maximum_bytes: {
          default: 4_194_304,
          maximum: 4_718_592,
          minimum: 65_536,
          title: 'Maximum batch bytes',
          type: 'integer',
        },
        batch_maximum_records: {
          default: 500,
          maximum: 1000,
          minimum: 1,
          title: 'Maximum batch records',
          type: 'integer',
        },
      },
      required: ['routes'],
      title: 'BYOK Grid destination',
      type: 'object',
    },
    supported_destination_sync_modes: ['append', 'append_dedup'],
    supportsIncremental: true,
  },
} as const;

import { describe, expect, it } from 'vitest';
import { connectorActionColumnConfigurationSchema } from './index';

const columnId = '11111111-1111-4111-8111-111111111111';
const credentialId = '22222222-2222-4222-8222-222222222222';

describe('connector action configuration', () => {
  it('accepts a versioned provider action with column bindings', () => {
    expect(
      connectorActionColumnConfigurationSchema.parse({
        actionId: 'domain_search',
        connectorId: 'hunter',
        credentialId,
        inputBindings: { domain: { columnId, kind: 'column' } },
        kind: 'connector_action',
        protocolVersion: '1.0',
      })
    ).toMatchObject({ connectorId: 'hunter', runMode: 'manual' });
  });

  it('accepts opt-in dependency-driven execution', () => {
    expect(
      connectorActionColumnConfigurationSchema.parse({
        actionId: 'domain_search',
        connectorId: 'hunter',
        credentialId,
        inputBindings: { domain: { columnId, kind: 'column' } },
        kind: 'connector_action',
        protocolVersion: '1.0',
        runMode: 'on_change',
      }).runMode
    ).toBe('on_change');
  });

  it('accepts bounded literal bindings in protocol 1.1', () => {
    expect(
      connectorActionColumnConfigurationSchema.parse({
        actionId: 'generate_text',
        connectorId: 'openai',
        credentialId,
        inputBindings: {
          model: { kind: 'literal', value: 'gpt-5.6-luna' },
          prompt: { columnId, kind: 'column' },
        },
        kind: 'connector_action',
        outputValueType: 'text',
        protocolVersion: '1.1',
      })
    ).toMatchObject({ outputValueType: 'text' });

    expect(() =>
      connectorActionColumnConfigurationSchema.parse({
        actionId: 'generate_text',
        connectorId: 'openai',
        credentialId,
        inputBindings: {
          model: { kind: 'literal', value: 'gpt-5.6-luna' },
        },
        kind: 'connector_action',
        protocolVersion: '1.0',
      })
    ).toThrow(/protocol 1.1/);
  });

  it('rejects empty or unknown input bindings', () => {
    expect(() =>
      connectorActionColumnConfigurationSchema.parse({
        actionId: 'domain_search',
        connectorId: 'hunter',
        credentialId,
        inputBindings: {},
        kind: 'connector_action',
        protocolVersion: '1.0',
      })
    ).toThrow();
    expect(() =>
      connectorActionColumnConfigurationSchema.parse({
        actionId: 'domain_search',
        connectorId: 'hunter',
        credentialId,
        inputBindings: {
          domain: { columnId, kind: 'column', secret: 'not-allowed' },
        },
        kind: 'connector_action',
        protocolVersion: '1.0',
      })
    ).toThrow();
  });
});

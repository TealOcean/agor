import { describe, expect, it } from 'vitest';
import {
  apiTypeForNpm,
  CUSTOM_PROVIDER_NPM,
  CustomProviderSchema,
  customProviderValidationMessage,
  normalizeCustomProviderBaseURL,
} from './custom-provider-schema.js';

const valid = {
  id: 'omlx',
  name: 'oMLX (Mac Studio)',
  apiType: 'chat-completions',
  baseURL: 'http://192.168.1.175:8000/v1',
  models: [{ id: 'mlx-community/Qwen3-Coder-30B' }],
};

describe('custom provider schema', () => {
  it('accepts a valid provider, including model IDs with slashes', () => {
    expect(CustomProviderSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    ['http://host:8000/v1/', 'http://host:8000/v1'],
    ['https://host/v1///', 'https://host/v1'],
    ['  http://host:8000/v1  ', 'http://host:8000/v1'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeCustomProviderBaseURL(input)).toBe(expected);
  });

  it.each([
    ['ftp://host/v1', /http or https/],
    ['http://user:pw@host/v1', /credentials/],
    ['http://host/v1?x=1', /query/],
    ['http://host/v1#frag', /query/],
    ['not a url', /valid URL/],
  ])('rejects base URL %s', (input, message) => {
    expect(() => normalizeCustomProviderBaseURL(input)).toThrow(message);
  });

  it.each(['', 'Omlx', '-omlx', 'om lx', 'a'.repeat(65)])('rejects ID %j', (id) => {
    expect(CustomProviderSchema.safeParse({ ...valid, id }).success).toBe(false);
  });

  it('rejects duplicate and empty model lists with a readable message', () => {
    const duplicate = CustomProviderSchema.safeParse({
      ...valid,
      models: [{ id: 'a' }, { id: 'a' }],
    });
    expect(duplicate.success).toBe(false);
    if (!duplicate.success) {
      expect(customProviderValidationMessage(duplicate.error)).toMatch(/models: .*duplicate/i);
    }
    expect(CustomProviderSchema.safeParse({ ...valid, models: [] }).success).toBe(false);
  });

  it('maps API types to npm packages and back', () => {
    expect(CUSTOM_PROVIDER_NPM).toEqual({
      'chat-completions': '@ai-sdk/openai-compatible',
      responses: '@ai-sdk/openai',
    });
    expect(apiTypeForNpm('@ai-sdk/openai')).toBe('responses');
    expect(apiTypeForNpm('@ai-sdk/openai-compatible')).toBe('chat-completions');
    expect(apiTypeForNpm('@ai-sdk/anthropic')).toBeUndefined();
    expect(apiTypeForNpm(undefined)).toBeUndefined();
  });
});

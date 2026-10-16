import type { OpenCodeCustomProvider } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleOpenCodeAuth, type OpenCodeAuthPayload } from './auth-handler.js';
import { CustomProviderError } from './custom-providers.js';

const fs = vi.hoisted(() => ({ readAuthFile: vi.fn() }));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: fs.readAuthFile };
});

const sdk = vi.hoisted(() => ({ clients: [] as unknown[] }));
vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: vi.fn(() => sdk.clients.shift()),
}));

const DATA_HOME = '/home/alice/.local/share/agor/opencode/opaque';
const omlx: OpenCodeCustomProvider = {
  id: 'omlx',
  name: 'oMLX',
  apiType: 'chat-completions',
  baseURL: 'http://192.168.1.175:8000/v1',
  models: [{ id: 'mlx-community/Qwen3-Coder-30B' }],
};

const store = {
  read: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  probe: vi.fn(),
};
const runtime = {
  ensureOpenCodeDataHome: vi.fn(async () => undefined),
  verifyOpenCodeAuthFileBoundary: vi.fn(async () => undefined),
  startManagedOpenCodeServer: vi.fn(),
  customProviders: store,
};

function fakeClient(providerIds: string[] = ['openai']) {
  return {
    auth: {
      set: vi.fn(async () => ({ data: true })),
      remove: vi.fn(async () => ({ data: true })),
    },
    provider: {
      list: vi.fn(async () => ({
        data: { all: providerIds.map((id) => ({ id, name: id })), connected: [], default: {} },
      })),
      auth: vi.fn(async () => ({ data: {} })),
    },
    config: {
      providers: vi.fn(async () => ({ data: { providers: [], default: {} } })),
      get: vi.fn(async () => ({ data: {} })),
    },
    instance: { dispose: vi.fn(async () => ({ data: true })) },
  };
}

function run(params: OpenCodeAuthPayload['params']) {
  return handleOpenCodeAuth(
    { command: 'opencode.auth', dataHome: DATA_HOME, params },
    {},
    runtime as never
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AGOR_MANAGED_AGENTIC_TOOLS', '0');
  sdk.clients = [];
  fs.readAuthFile.mockResolvedValue('{}');
  store.read.mockResolvedValue([omlx]);
  store.save.mockResolvedValue(undefined);
  store.remove.mockResolvedValue(undefined);
  runtime.startManagedOpenCodeServer.mockResolvedValue({
    baseUrl: 'http://127.0.0.1:1234',
    authorization: 'Basic synthetic',
    sanitizer: { text: (value: string) => value, error: (value: unknown) => value as Error },
    close: vi.fn(async () => undefined),
  });
});

describe('custom provider executor operations', () => {
  it('saves the definition, then the key, and returns discovery with custom providers', async () => {
    const client = fakeClient();
    sdk.clients.push(client);
    fs.readAuthFile.mockResolvedValue(JSON.stringify({ omlx: { type: 'api', key: 'sk-secret' } }));

    const result = await run({
      operation: 'save-custom-provider',
      create: true,
      provider: omlx,
      apiKey: 'sk-secret',
    });

    expect(store.save).toHaveBeenCalledWith(DATA_HOME, omlx, { create: true });
    expect(client.auth.set).toHaveBeenCalledWith({
      providerID: 'omlx',
      auth: { type: 'api', key: 'sk-secret' },
    });
    expect(store.save.mock.invocationCallOrder[0]).toBeLessThan(
      client.auth.set.mock.invocationCallOrder[0]
    );
    expect(result).toMatchObject({
      success: true,
      data: { customProviders: [{ ...omlx, credentialPresence: 'present' }] },
    });
    expect(JSON.stringify(result)).not.toContain('sk-secret');
  });

  it('rejects an ID OpenCode already has before writing anything', async () => {
    sdk.clients.push(fakeClient(['openai', 'lmstudio']));
    const result = await run({
      operation: 'save-custom-provider',
      create: true,
      provider: { ...omlx, id: 'lmstudio' },
    });
    expect(result).toEqual({
      success: false,
      error: {
        code: 'CUSTOM_PROVIDER_ID_TAKEN',
        message: 'OpenCode already has a provider with ID lmstudio.',
      },
    });
    expect(store.save).not.toHaveBeenCalled();
  });

  it('keeps the definition and reports KEY_NOT_SAVED when the key cannot be stored', async () => {
    const client = fakeClient();
    client.auth.set.mockRejectedValue(new Error('boom sk-secret'));
    sdk.clients.push(client);
    const result = await run({
      operation: 'save-custom-provider',
      create: true,
      provider: omlx,
      apiKey: 'sk-secret',
    });
    expect(store.save).toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: {
        code: 'CUSTOM_PROVIDER_KEY_NOT_SAVED',
        message: "Saved, but the API key couldn't be stored. Try again.",
      },
    });
  });

  it('writes nothing when the OpenCode server cannot start', async () => {
    runtime.startManagedOpenCodeServer.mockRejectedValue(new Error('spawn failed'));
    const result = await run({ operation: 'save-custom-provider', create: true, provider: omlx });
    expect(store.save).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, error: { code: 'OPENCODE_AUTH_FAILED' } });
  });

  it('clears a saved key on edit when asked', async () => {
    const client = fakeClient(['openai', 'omlx']);
    sdk.clients.push(client);
    await run({
      operation: 'save-custom-provider',
      create: false,
      provider: omlx,
      clearApiKey: true,
    });
    // Only the discovery snapshot lists providers; the create-only ID check is skipped.
    expect(client.provider.list).toHaveBeenCalledTimes(1);
    expect(client.auth.remove).toHaveBeenCalledWith({ providerID: 'omlx' });
  });

  it('passes store errors through as structured failures', async () => {
    sdk.clients.push(fakeClient());
    store.save.mockRejectedValue(
      new CustomProviderError(
        'CUSTOM_PROVIDER_CONFIG_UNREADABLE',
        "opencode.json isn't plain JSON; fix or remove it."
      )
    );
    const result = await run({ operation: 'save-custom-provider', create: true, provider: omlx });
    expect(result).toMatchObject({
      success: false,
      error: { code: 'CUSTOM_PROVIDER_CONFIG_UNREADABLE' },
    });
  });

  it('removes the definition and its saved key', async () => {
    const client = fakeClient(['openai', 'omlx']);
    sdk.clients.push(client);
    fs.readAuthFile.mockResolvedValue(JSON.stringify({ omlx: { type: 'api', key: 'k' } }));
    store.read.mockResolvedValue([]);
    const result = await run({ operation: 'remove-custom-provider', providerId: 'omlx' });
    expect(store.remove).toHaveBeenCalledWith(DATA_HOME, 'omlx');
    expect(client.auth.remove).toHaveBeenCalledWith({ providerID: 'omlx' });
    expect(result).toMatchObject({ success: true, data: { customProviders: [] } });
  });

  it('probes with the saved key when none is supplied, without returning it', async () => {
    fs.readAuthFile.mockResolvedValue(JSON.stringify({ omlx: { type: 'api', key: 'sk-saved' } }));
    store.probe.mockResolvedValue(['a', 'b']);
    const result = await run({
      operation: 'probe-custom-provider-models',
      baseURL: omlx.baseURL,
      providerId: 'omlx',
    });
    expect(store.probe).toHaveBeenCalledWith(omlx.baseURL, 'sk-saved');
    expect(result).toEqual({ success: true, data: { models: ['a', 'b'] } });
  });

  it('never sends a built-in provider key to a probe URL', async () => {
    fs.readAuthFile.mockResolvedValue(
      JSON.stringify({ openai: { type: 'api', key: 'sk-openai' } })
    );
    store.probe.mockResolvedValue([]);
    await run({
      operation: 'probe-custom-provider-models',
      baseURL: 'https://attacker.example/v1',
      providerId: 'openai',
    });
    expect(store.probe).toHaveBeenCalledWith('https://attacker.example/v1', undefined);
  });

  it('does not send a saved custom key to a different origin', async () => {
    fs.readAuthFile.mockResolvedValue(JSON.stringify({ omlx: { type: 'api', key: 'sk-saved' } }));
    store.probe.mockResolvedValue([]);
    await run({
      operation: 'probe-custom-provider-models',
      baseURL: 'https://attacker.example/v1',
      providerId: 'omlx',
    });
    expect(store.probe).toHaveBeenCalledWith('https://attacker.example/v1', undefined);
  });

  it('redacts the key from probe error messages', async () => {
    store.probe.mockRejectedValue(
      new CustomProviderError('CUSTOM_PROVIDER_UNREACHABLE', "Couldn't reach http://h (sk-typed).")
    );
    const result = await run({
      operation: 'probe-custom-provider-models',
      baseURL: 'http://h',
      apiKey: 'sk-typed',
    });
    expect(result).toMatchObject({
      success: false,
      error: { code: 'CUSTOM_PROVIDER_UNREACHABLE' },
    });
    expect(JSON.stringify(result)).not.toContain('sk-typed');
  });

  it('adds supported custom providers and their models to the model catalog', async () => {
    store.read.mockResolvedValue([
      omlx,
      { id: 'claude-proxy', name: 'Claude proxy', npm: '@ai-sdk/anthropic', unsupported: true },
    ]);
    const result = await run({ operation: 'read-model-catalog' });
    expect(runtime.startManagedOpenCodeServer).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      data: {
        providers: expect.arrayContaining([
          {
            id: 'omlx',
            name: 'oMLX',
            availableForSelection: true,
            models: [
              {
                id: 'mlx-community/Qwen3-Coder-30B',
                name: 'mlx-community/Qwen3-Coder-30B',
                status: 'active',
              },
            ],
          },
        ]),
      },
    });
    const ids = (result as { data: { providers: Array<{ id: string }> } }).data.providers.map(
      (provider) => provider.id
    );
    expect(ids).not.toContain('claude-proxy');
  });

  it('falls back to the curated catalog when opencode.json is unreadable', async () => {
    store.read.mockRejectedValue(new CustomProviderError('CUSTOM_PROVIDER_CONFIG_UNREADABLE', 'x'));
    const result = await run({ operation: 'read-model-catalog' });
    expect(result).toMatchObject({
      success: true,
      data: { providers: expect.arrayContaining([expect.objectContaining({ id: 'openai' })]) },
    });
  });

  it('reports an unreadable opencode.json in discovery instead of failing', async () => {
    sdk.clients.push(fakeClient());
    store.read.mockRejectedValue(
      new CustomProviderError(
        'CUSTOM_PROVIDER_CONFIG_UNREADABLE',
        "opencode.json isn't plain JSON; fix or remove it."
      )
    );
    const result = await run({ operation: 'discover' });
    expect(result).toMatchObject({
      success: true,
      data: { customProvidersError: "opencode.json isn't plain JSON; fix or remove it." },
    });
  });
});

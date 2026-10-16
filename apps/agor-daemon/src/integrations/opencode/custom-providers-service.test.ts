import { isTenantAgenticToolEnabled, loadConfigSync } from '@agor/core/config';
import { runWithTenantContext, UsersRepository } from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodeCustomProvidersService } from './custom-providers-service';

const containment = vi.hoisted(() => ({ release: vi.fn(), reserve: vi.fn(), verify: vi.fn() }));
vi.mock('../../executor-tracking.js', () => ({
  releaseExecutorContainmentFenceIntent: containment.release,
  reserveExecutorContainmentFence: containment.reserve,
  verifyExecutorContainmentFence: containment.verify,
}));
vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/config')>('@agor/core/config');
  return { ...actual, isTenantAgenticToolEnabled: vi.fn(), loadConfigSync: vi.fn() };
});
vi.mock('@agor/core/db', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/db')>('@agor/core/db');
  return { ...actual, UsersRepository: vi.fn() };
});
const capabilities = vi.hoisted(() => ({ override: undefined as unknown }));
vi.mock('@agor/agentic-tool-opencode/daemon', async () => {
  const actual = await vi.importActual<typeof import('@agor/agentic-tool-opencode/daemon')>(
    '@agor/agentic-tool-opencode/daemon'
  );
  return {
    ...actual,
    resolveOpenCodeCapabilities: (
      config: Parameters<typeof actual.resolveOpenCodeCapabilities>[0]
    ) => capabilities.override ?? actual.resolveOpenCodeCapabilities(config),
  };
});

const runCommand = vi.hoisted(() => vi.fn());
vi.mock('../../utils/spawn-executor.js', () => ({
  requestExecutor: runCommand,
  startContainedExecutorCommand: (payload: unknown, options: unknown) => ({
    result: runCommand(payload, options),
    verifyAbsence: vi.fn(async () => true),
    retainContainmentFence: vi.fn(async () => undefined),
  }),
}));

const db = { run: vi.fn() } as never;
const params = {
  user: { user_id: 'same-user', email: 'u@example.com', role: 'member' },
} as never;
const discovery = {
  runtime: 'available',
  runtimeVersion: '1.18.31',
  providers: [],
  customProviders: [],
};
const provider = {
  id: 'omlx',
  name: 'oMLX',
  apiType: 'chat-completions',
  baseURL: 'http://192.168.1.175:8000/v1/',
  models: [{ id: 'gemma' }],
};

function service() {
  return createOpenCodeCustomProvidersService(db, loadConfigSync());
}

function sentRequest() {
  const [payload] = runCommand.mock.calls[0] ?? [];
  return (payload as { params: { request: Record<string, unknown> } }).params.request;
}

beforeEach(() => {
  vi.clearAllMocks();
  capabilities.override = undefined;
  containment.release.mockResolvedValue(undefined);
  containment.reserve.mockResolvedValue('intent');
  containment.verify.mockResolvedValue(true);
  vi.mocked(isTenantAgenticToolEnabled).mockResolvedValue(true);
  vi.mocked(loadConfigSync).mockReturnValue({ execution: { unix_user_mode: 'simple' } } as never);
  vi.mocked(UsersRepository).mockImplementation(function repository() {
    return { findById: vi.fn(async () => ({ unix_username: 'alice' })) };
  } as never);
  runCommand.mockResolvedValue({ success: true, data: discovery });
});

describe('OpenCode custom providers service', () => {
  it('requires an authenticated caller', async () => {
    await runWithTenantContext('tenant-a', async () => {
      await expect(service().create({ provider } as never)).rejects.toThrow(/sign in/i);
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('refuses hosted workspaces', async () => {
    capabilities.override = { mode: 'managed-projection' };
    await runWithTenantContext('tenant-a', async () => {
      await expect(service().create({ provider } as never, params)).rejects.toThrow(
        /hosted workspaces/
      );
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('validates and normalizes before calling the executor', async () => {
    const result = await runWithTenantContext('tenant-a', () =>
      service().create({ provider, apiKey: ' sk ' } as never, params)
    );
    expect(sentRequest()).toEqual({
      operation: 'save-custom-provider',
      create: true,
      provider: { ...provider, baseURL: 'http://192.168.1.175:8000/v1' },
      apiKey: 'sk',
    });
    expect(result).toMatchObject({
      customProviders: [],
      isolation: { mode: 'simple', boundary: 'logical' },
    });
  });

  it('rejects invalid input with a field message and no executor call', async () => {
    await runWithTenantContext('tenant-a', async () => {
      await expect(
        service().create({ provider: { ...provider, id: 'Bad ID' } } as never, params)
      ).rejects.toMatchObject({
        message: expect.stringMatching(/^id: /),
        data: { code: 'CUSTOM_PROVIDER_INVALID' },
      });
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('patches with the ID from the path and supports clearing the key', async () => {
    const { id: _id, ...fields } = provider;
    await runWithTenantContext('tenant-a', () =>
      service().patch('omlx', { provider: fields, clearApiKey: true } as never, params)
    );
    expect(sentRequest()).toMatchObject({
      operation: 'save-custom-provider',
      create: false,
      provider: { id: 'omlx' },
      clearApiKey: true,
    });
  });

  it('removes by ID', async () => {
    await runWithTenantContext('tenant-a', () => service().remove('omlx', params));
    expect(sentRequest()).toEqual({ operation: 'remove-custom-provider', providerId: 'omlx' });
  });

  it('probes and returns models', async () => {
    runCommand.mockResolvedValue({ success: true, data: { models: ['a'] } });
    const result = await runWithTenantContext('tenant-a', () =>
      service().create({ probe: { baseURL: 'http://h/v1/', providerId: 'omlx' } } as never, params)
    );
    expect(sentRequest()).toEqual({
      operation: 'probe-custom-provider-models',
      baseURL: 'http://h/v1',
      providerId: 'omlx',
    });
    expect(result).toEqual({ models: ['a'] });
  });

  it('serializes save and remove through the mutation slot, but not probes', async () => {
    const { id: _id, ...fields } = provider;
    await runWithTenantContext('tenant-a', async () => {
      await service().create({ provider } as never, params);
      await service().patch('omlx', { provider: fields } as never, params);
      await service().remove('omlx', params);
    });
    expect(containment.reserve).toHaveBeenCalledTimes(3);

    containment.reserve.mockClear();
    runCommand.mockResolvedValue({ success: true, data: { models: [] } });
    await runWithTenantContext('tenant-a', () =>
      service().create({ probe: { baseURL: 'http://h/v1' } } as never, params)
    );
    expect(containment.reserve).not.toHaveBeenCalled();
  });

  it('turns CUSTOM_PROVIDER_* executor errors into BadRequest with the message and code', async () => {
    runCommand.mockResolvedValue({
      success: false,
      error: {
        code: 'CUSTOM_PROVIDER_UNAUTHORIZED',
        message: 'The endpoint rejected the API key (401).',
      },
    });
    await runWithTenantContext('tenant-a', async () => {
      await expect(
        service().create({ probe: { baseURL: 'http://h/v1' } } as never, params)
      ).rejects.toMatchObject({
        message: 'The endpoint rejected the API key (401).',
        data: { code: 'CUSTOM_PROVIDER_UNAUTHORIZED' },
      });
    });
  });

  it('keeps unknown executor errors generic', async () => {
    runCommand.mockResolvedValue({
      success: false,
      error: { code: 'OPENCODE_AUTH_FAILED', message: 'x' },
    });
    await runWithTenantContext('tenant-a', async () => {
      await expect(service().remove('omlx', params)).rejects.toThrow(
        'OpenCode provider operation failed. Try again.'
      );
    });
  });
});

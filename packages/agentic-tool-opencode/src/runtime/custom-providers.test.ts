import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenCodeCustomProvider } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CustomProviderError,
  customProviderConfigPath,
  readCustomProviders,
  removeCustomProvider,
  saveCustomProvider,
} from './custom-providers.js';
import { ensureOpenCodeDataHome } from './managed-server.js';

let root: string;
let dataHome: string;

const omlx: OpenCodeCustomProvider = {
  id: 'omlx',
  name: 'oMLX (Mac Studio)',
  apiType: 'chat-completions',
  baseURL: 'http://192.168.1.175:8000/v1',
  models: [{ id: 'mlx-community/Qwen3-Coder-30B' }, { id: 'gemma', name: 'Gemma 4' }],
};

async function writeConfig(value: unknown) {
  const path = customProviderConfigPath(dataHome);
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), {
    mode: 0o600,
  });
}

async function readConfig() {
  return JSON.parse(await readFile(customProviderConfigPath(dataHome), 'utf8'));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agor-custom-providers-'));
  dataHome = join(root, 'home', '.local', 'share', 'agor', 'opencode', 'namespace');
  await mkdir(join(root, 'home'), { mode: 0o700 });
  await ensureOpenCodeDataHome(dataHome);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('custom provider store', () => {
  it('returns no providers when opencode.json does not exist', async () => {
    expect(await readCustomProviders(dataHome)).toEqual([]);
  });

  it('round-trips a provider, including slash model IDs, with private permissions', async () => {
    await saveCustomProvider(dataHome, omlx, { create: true });

    expect(await readCustomProviders(dataHome)).toEqual([omlx]);
    expect(await readConfig()).toEqual({
      provider: {
        omlx: {
          npm: '@ai-sdk/openai-compatible',
          name: 'oMLX (Mac Studio)',
          options: { baseURL: 'http://192.168.1.175:8000/v1' },
          models: {
            'mlx-community/Qwen3-Coder-30B': { name: 'mlx-community/Qwen3-Coder-30B' },
            gemma: { name: 'Gemma 4' },
          },
        },
      },
    });
    const file = await lstat(customProviderConfigPath(dataHome));
    expect(file.mode & 0o777).toBe(0o600);
    const dir = await lstat(join(customProviderConfigPath(dataHome), '..'));
    expect(dir.mode & 0o777).toBe(0o700);
  });

  it('maps the responses API type to @ai-sdk/openai', async () => {
    await saveCustomProvider(dataHome, { ...omlx, apiType: 'responses' }, { create: true });
    expect((await readConfig()).provider.omlx.npm).toBe('@ai-sdk/openai');
    expect((await readCustomProviders(dataHome))[0]).toMatchObject({ apiType: 'responses' });
  });

  it('keeps unrelated keys and hand-added fields when editing', async () => {
    await writeConfig({
      $schema: 'https://opencode.ai/config.json',
      theme: 'dark',
      provider: {
        omlx: {
          npm: '@ai-sdk/openai-compatible',
          name: 'old',
          options: { baseURL: 'http://old/v1', headers: { 'X-Test': '1' } },
          models: { gemma: { name: 'Gemma', limit: { context: 32768, output: 4096 } } },
        },
      },
    });

    await saveCustomProvider(dataHome, omlx, { create: false });

    const config = await readConfig();
    expect(config.$schema).toBe('https://opencode.ai/config.json');
    expect(config.theme).toBe('dark');
    expect(config.provider.omlx.options).toEqual({
      baseURL: 'http://192.168.1.175:8000/v1',
      headers: { 'X-Test': '1' },
    });
    expect(config.provider.omlx.models.gemma).toEqual({
      name: 'Gemma 4',
      limit: { context: 32768, output: 4096 },
    });
  });

  it('reports other npm packages as unsupported and refuses to edit them', async () => {
    await writeConfig({
      provider: { claude: { npm: '@ai-sdk/anthropic', name: 'Claude', options: {} } },
    });

    expect(await readCustomProviders(dataHome)).toEqual([
      { id: 'claude', name: 'Claude', npm: '@ai-sdk/anthropic', unsupported: true },
    ]);
    await expect(
      saveCustomProvider(dataHome, { ...omlx, id: 'claude' }, { create: false })
    ).rejects.toMatchObject({ code: 'CUSTOM_PROVIDER_INVALID' });
  });

  it('rejects creating an existing ID and editing or removing a missing one', async () => {
    await saveCustomProvider(dataHome, omlx, { create: true });
    await expect(saveCustomProvider(dataHome, omlx, { create: true })).rejects.toMatchObject({
      code: 'CUSTOM_PROVIDER_ID_TAKEN',
    });
    await expect(
      saveCustomProvider(dataHome, { ...omlx, id: 'other' }, { create: false })
    ).rejects.toMatchObject({ code: 'CUSTOM_PROVIDER_NOT_FOUND' });
    await expect(removeCustomProvider(dataHome, 'other')).rejects.toMatchObject({
      code: 'CUSTOM_PROVIDER_NOT_FOUND',
    });
  });

  it('removes only the named provider', async () => {
    await saveCustomProvider(dataHome, omlx, { create: true });
    await saveCustomProvider(dataHome, { ...omlx, id: 'lab' }, { create: true });
    await removeCustomProvider(dataHome, 'omlx');
    expect((await readCustomProviders(dataHome)).map((entry) => entry.id)).toEqual(['lab']);
  });

  it('never overwrites a file that is not plain JSON', async () => {
    await writeConfig('{ // comment\n "provider": {} }');
    await expect(readCustomProviders(dataHome)).rejects.toBeInstanceOf(CustomProviderError);
    await expect(saveCustomProvider(dataHome, omlx, { create: true })).rejects.toMatchObject({
      code: 'CUSTOM_PROVIDER_CONFIG_UNREADABLE',
    });
    expect(await readFile(customProviderConfigPath(dataHome), 'utf8')).toContain('// comment');
  });

  it('refuses a symlinked opencode.json', async () => {
    const target = join(root, 'elsewhere.json');
    await writeFile(target, '{}');
    await mkdir(join(customProviderConfigPath(dataHome), '..'), { recursive: true, mode: 0o700 });
    await symlink(target, customProviderConfigPath(dataHome));
    await expect(readCustomProviders(dataHome)).rejects.toMatchObject({
      code: 'CUSTOM_PROVIDER_CONFIG_UNREADABLE',
    });
  });
});

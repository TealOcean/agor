import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  OpenCodeCustomProvider,
  OpenCodeCustomProviderEntry,
  OpenCodeCustomProviderErrorCode,
} from '@agor/core/types';
import {
  apiTypeForNpm,
  CUSTOM_PROVIDER_MESSAGES,
  CUSTOM_PROVIDER_NPM,
} from '../shared/custom-provider-schema.js';
import { ensureOpenCodeConfigDirectory } from './managed-server.js';

export class CustomProviderError extends Error {
  constructor(
    readonly code: OpenCodeCustomProviderErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'CustomProviderError';
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unreadable(): CustomProviderError {
  return new CustomProviderError(
    'CUSTOM_PROVIDER_CONFIG_UNREADABLE',
    CUSTOM_PROVIDER_MESSAGES.configUnreadable
  );
}

export function customProviderConfigPath(dataHome: string): string {
  return join(dataHome, 'xdg-config', 'opencode', 'opencode.json');
}

async function readConfigDocument(dataHome: string): Promise<JsonRecord> {
  const path = customProviderConfigPath(dataHome);
  try {
    const entry = await lstat(path);
    if (!entry.isFile()) throw unreadable();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw unreadable();
  }
  if (!isRecord(parsed) || (parsed.provider !== undefined && !isRecord(parsed.provider))) {
    throw unreadable();
  }
  return parsed;
}

async function writeConfigDocument(dataHome: string, document: JsonRecord): Promise<void> {
  const directory = await ensureOpenCodeConfigDirectory(dataHome);
  const target = join(directory, 'opencode.json');
  const temporary = join(directory, `opencode.json.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function toEntry(id: string, raw: unknown): OpenCodeCustomProviderEntry {
  const record = isRecord(raw) ? raw : {};
  const name = typeof record.name === 'string' && record.name ? record.name : id;
  const apiType = apiTypeForNpm(record.npm);
  const options = isRecord(record.options) ? record.options : {};
  const baseURL = typeof options.baseURL === 'string' ? options.baseURL : undefined;
  if (!apiType || !baseURL) {
    return { id, name, npm: typeof record.npm === 'string' ? record.npm : '', unsupported: true };
  }
  const models = isRecord(record.models)
    ? Object.entries(record.models).map(([modelId, model]) => {
        const modelName = isRecord(model) && typeof model.name === 'string' ? model.name : '';
        return modelName && modelName !== modelId
          ? { id: modelId, name: modelName }
          : { id: modelId };
      })
    : [];
  return { id, name, apiType, baseURL, models };
}

export async function readCustomProviders(
  dataHome: string
): Promise<OpenCodeCustomProviderEntry[]> {
  const document = await readConfigDocument(dataHome);
  const providers = isRecord(document.provider) ? document.provider : {};
  return Object.entries(providers)
    .map(([id, raw]) => toEntry(id, raw))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function saveCustomProvider(
  dataHome: string,
  provider: OpenCodeCustomProvider,
  options: { create: boolean }
): Promise<void> {
  const document = await readConfigDocument(dataHome);
  const providers: JsonRecord = isRecord(document.provider) ? { ...document.provider } : {};
  const existing = providers[provider.id];
  if (options.create && existing !== undefined) {
    throw new CustomProviderError(
      'CUSTOM_PROVIDER_ID_TAKEN',
      CUSTOM_PROVIDER_MESSAGES.idTaken(provider.id)
    );
  }
  if (!options.create && existing === undefined) {
    throw new CustomProviderError(
      'CUSTOM_PROVIDER_NOT_FOUND',
      CUSTOM_PROVIDER_MESSAGES.notFound(provider.id)
    );
  }
  if (!options.create && 'unsupported' in toEntry(provider.id, existing)) {
    throw new CustomProviderError(
      'CUSTOM_PROVIDER_INVALID',
      CUSTOM_PROVIDER_MESSAGES.unsupportedEdit
    );
  }
  const previous = isRecord(existing) ? existing : {};
  const previousOptions = isRecord(previous.options) ? previous.options : {};
  const previousModels = isRecord(previous.models) ? previous.models : {};
  providers[provider.id] = {
    ...previous,
    npm: CUSTOM_PROVIDER_NPM[provider.apiType],
    name: provider.name,
    options: { ...previousOptions, baseURL: provider.baseURL },
    models: Object.fromEntries(
      provider.models.map((model) => {
        const before = previousModels[model.id];
        return [model.id, { ...(isRecord(before) ? before : {}), name: model.name ?? model.id }];
      })
    ),
  };
  await writeConfigDocument(dataHome, { ...document, provider: providers });
}

export async function removeCustomProvider(dataHome: string, id: string): Promise<void> {
  const document = await readConfigDocument(dataHome);
  const providers: JsonRecord = isRecord(document.provider) ? { ...document.provider } : {};
  if (providers[id] === undefined) {
    throw new CustomProviderError(
      'CUSTOM_PROVIDER_NOT_FOUND',
      CUSTOM_PROVIDER_MESSAGES.notFound(id)
    );
  }
  delete providers[id];
  await writeConfigDocument(dataHome, { ...document, provider: providers });
}

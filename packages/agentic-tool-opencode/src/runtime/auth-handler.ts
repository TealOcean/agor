import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  OpenCodeCustomProviderEntry,
  OpenCodeCustomProviderErrorCode,
  OpenCodeModelCatalog,
  OpenCodeModelPair,
  OpenCodeOAuthAuthorization,
  OpenCodeProviderAuthMethod,
  OpenCodeProviderConnection,
  OpenCodeProviderDiscovery,
} from '@agor/core/types';
import type { createOpencodeClient } from '@opencode-ai/sdk/v2';
import {
  CUSTOM_PROVIDER_MESSAGES,
  isSupportedCustomProvider,
} from '../shared/custom-provider-schema.js';
import { createOpenCodeKnownModelCatalog } from '../shared/known-models.js';
import type { OpenCodeAuthPayload } from './auth-payload.js';
import { probeOpenAICompatibleModels } from './custom-provider-probe.js';
import {
  CustomProviderError,
  readCustomProviders,
  removeCustomProvider,
  saveCustomProvider,
} from './custom-providers.js';
import {
  createOpenCodeSanitizer,
  ensureOpenCodeDataHome as defaultEnsureOpenCodeDataHome,
  startManagedOpenCodeServer as defaultStartManagedOpenCodeServer,
  verifyOpenCodeAuthFileBoundary as defaultVerifyOpenCodeAuthFileBoundary,
  OPENCODE_VERSION,
} from './managed-server.js';
import { loadOpenCodeSdkV2 } from './sdk-loader.js';

export type { OpenCodeAuthPayload } from './auth-payload.js';

export interface OpenCodeCommandOptions {
  dryRun?: boolean;
}

export interface OpenCodeCustomProviderRuntime {
  read: typeof readCustomProviders;
  save: typeof saveCustomProvider;
  remove: typeof removeCustomProvider;
  probe: typeof probeOpenAICompatibleModels;
}

const DEFAULT_CUSTOM_PROVIDER_RUNTIME: OpenCodeCustomProviderRuntime = {
  read: readCustomProviders,
  save: saveCustomProvider,
  remove: removeCustomProvider,
  probe: probeOpenAICompatibleModels,
};

export interface OpenCodeAuthRuntimeDependencies {
  ensureOpenCodeDataHome: typeof defaultEnsureOpenCodeDataHome;
  startManagedOpenCodeServer: typeof defaultStartManagedOpenCodeServer;
  verifyOpenCodeAuthFileBoundary: typeof defaultVerifyOpenCodeAuthFileBoundary;
  /** Fork: custom provider store; defaults to the real file store and probe. */
  customProviders?: OpenCodeCustomProviderRuntime;
}

const DEFAULT_AUTH_RUNTIME: OpenCodeAuthRuntimeDependencies = {
  ensureOpenCodeDataHome: defaultEnsureOpenCodeDataHome,
  startManagedOpenCodeServer: defaultStartManagedOpenCodeServer,
  verifyOpenCodeAuthFileBoundary: defaultVerifyOpenCodeAuthFileBoundary,
};

type V2Client = ReturnType<typeof createOpencodeClient>;
type ProviderAuthMethods = NonNullable<Awaited<ReturnType<V2Client['provider']['auth']>>['data']>;
type ProviderAuthPrompt = NonNullable<ProviderAuthMethods[string][number]['prompts']>[number];

function safeAuthPrompt(prompt: ProviderAuthPrompt) {
  const condition = prompt.when ? { when: prompt.when } : {};
  if (prompt.type === 'select') {
    return {
      type: prompt.type,
      key: prompt.key,
      message: prompt.message,
      options: prompt.options.map(({ label, value, hint }) => ({
        label,
        value,
        ...(hint ? { hint } : {}),
      })),
      ...condition,
    };
  }
  return {
    type: prompt.type,
    key: prompt.key,
    message: prompt.message,
    ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
    ...condition,
  };
}

function safeMethods(
  methods: Awaited<ReturnType<V2Client['provider']['auth']>>['data'] | undefined,
  providerId: string
): OpenCodeProviderAuthMethod[] {
  return (methods?.[providerId] ?? []).map((method, index) => ({
    index,
    type: method.type,
    label: method.label,
    ...(method.prompts
      ? {
          prompts: method.prompts.map(safeAuthPrompt),
        }
      : {}),
  }));
}

function credentialPresence(
  providerIds: Set<string> | null,
  providerId: string
): OpenCodeProviderConnection['credentialPresence'] {
  if (providerIds === null) return 'unknown';
  return providerIds.has(providerId) ? 'present' : 'absent';
}

async function withFreshClient<T>(
  dataHome: string,
  secrets: readonly unknown[],
  work: (client: V2Client) => Promise<T>,
  directory = dataHome,
  runtime = DEFAULT_AUTH_RUNTIME
): Promise<T> {
  await runtime.ensureOpenCodeDataHome(dataHome);
  await runtime.verifyOpenCodeAuthFileBoundary(dataHome, { allowMissing: true });
  const server = await runtime.startManagedOpenCodeServer({
    directory,
    dataHome,
    secrets: [...secrets, directory],
  });
  const { createOpencodeClient } = await loadOpenCodeSdkV2();
  const client = createOpencodeClient({
    baseUrl: server.baseUrl,
    directory,
    headers: { Authorization: server.authorization },
  });
  let result: T | undefined;
  const failures: Array<{ phase: string; error: unknown }> = [];
  try {
    result = await work(client);
  } catch (error) {
    failures.push({ phase: 'operation', error });
  }
  try {
    await client.instance.dispose({ directory });
  } catch (error) {
    failures.push({ phase: 'instance disposal', error });
  } finally {
    try {
      await server.close();
    } catch (error) {
      failures.push({ phase: 'managed child close', error });
    }
  }
  if (failures.length > 0) {
    const cause = failures.reduceRight<Error | undefined>((next, failure) => {
      const message =
        failure.error instanceof Error ? failure.error.message : String(failure.error);
      return new Error(`${failure.phase} failed: ${message}`, next ? { cause: next } : undefined);
    }, undefined);
    throw server.sanitizer.error(
      new Error('OpenCode provider runtime operation failed', { cause })
    );
  }
  return result as T;
}

async function savedCredentialProviderIds(dataHome: string): Promise<Set<string> | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(dataHome, 'opencode', 'auth.json'), 'utf8')
    ) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return new Set(Object.keys(parsed));
  } catch {
    return null;
  }
}

function customProviderRuntime(runtime: OpenCodeAuthRuntimeDependencies) {
  return runtime.customProviders ?? DEFAULT_CUSTOM_PROVIDER_RUNTIME;
}

type CustomProviderFailure = { code: OpenCodeCustomProviderErrorCode; message: string };
type CustomProviderOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; failure: CustomProviderFailure };

function customProviderFailure(
  failure: CustomProviderFailure,
  secrets: readonly unknown[]
): { success: false; error: CustomProviderFailure } {
  return {
    success: false,
    error: { code: failure.code, message: createOpenCodeSanitizer(secrets).text(failure.message) },
  };
}

async function readCustomProvidersSafely(
  dataHome: string,
  runtime: OpenCodeAuthRuntimeDependencies
): Promise<{ entries: OpenCodeCustomProviderEntry[]; error?: string }> {
  try {
    return { entries: await customProviderRuntime(runtime).read(dataHome) };
  } catch (error) {
    if (error instanceof CustomProviderError) return { entries: [], error: error.message };
    throw error;
  }
}

async function savedApiKey(dataHome: string, providerId: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(join(dataHome, 'opencode', 'auth.json'), 'utf8')
    ) as Record<string, { type?: unknown; key?: unknown } | undefined>;
    const entry = parsed?.[providerId];
    return entry?.type === 'api' && typeof entry.key === 'string' ? entry.key : undefined;
  } catch {
    return undefined;
  }
}

async function discoverModels(
  dataHome: string,
  runtime = DEFAULT_AUTH_RUNTIME
): Promise<OpenCodeModelCatalog> {
  await runtime.ensureOpenCodeDataHome(dataHome);
  await runtime.verifyOpenCodeAuthFileBoundary(dataHome, { allowMissing: true });
  const catalog = createOpenCodeKnownModelCatalog(await savedCredentialProviderIds(dataHome));
  const custom = await readCustomProvidersSafely(dataHome, runtime);
  if (custom.error) console.warn(`[OpenCode] Custom providers unavailable: ${custom.error}`);
  const supported = custom.entries.filter(isSupportedCustomProvider);
  const customIds = new Set(supported.map((provider) => provider.id));
  return {
    runtimeVersion: OPENCODE_VERSION,
    ...catalog,
    providers: [
      ...catalog.providers.filter((provider) => !customIds.has(provider.id)),
      ...supported.map((provider) => ({
        id: provider.id,
        name: provider.name,
        availableForSelection: true,
        models: provider.models.map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
          status: 'active' as const,
        })),
      })),
    ],
  };
}

function configuredPair(model: string | undefined): OpenCodeModelPair | undefined {
  if (!model) return undefined;
  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) return undefined;
  return {
    providerId: model.slice(0, separator),
    modelId: model.slice(separator + 1),
  };
}

async function readConfigurationSnapshot(
  client: V2Client,
  dataHome: string,
  directory: string,
  runtime: OpenCodeAuthRuntimeDependencies = DEFAULT_AUTH_RUNTIME
): Promise<OpenCodeProviderDiscovery> {
  const [modelsResponse, configResponse, providerResponse, authResponse, credentialProviderIds] =
    await Promise.all([
      client.config.providers({ directory }),
      client.config.get({ directory }),
      client.provider.list({ directory }),
      client.provider.auth({ directory }),
      savedCredentialProviderIds(dataHome),
    ]);
  if (
    modelsResponse.error ||
    !modelsResponse.data ||
    configResponse.error ||
    !configResponse.data ||
    providerResponse.error ||
    !providerResponse.data ||
    authResponse.error
  ) {
    throw new Error('OpenCode provider configuration discovery failed');
  }

  const modelProviders = new Map(
    modelsResponse.data.providers.map((provider) => [provider.id, provider] as const)
  );
  const runtimeProviders = new Map(
    providerResponse.data.all.map((provider) => [provider.id, provider] as const)
  );
  const providerIds = new Set([
    ...runtimeProviders.keys(),
    ...modelProviders.keys(),
    ...Object.keys(authResponse.data ?? {}),
    ...(credentialProviderIds ?? []),
  ]);
  const runtimeAvailable = new Set(providerResponse.data.connected);
  const providers = [...providerIds]
    .map((providerId): OpenCodeProviderConnection => {
      const modelProvider = modelProviders.get(providerId);
      const runtimeProvider = runtimeProviders.get(providerId);
      return {
        id: providerId,
        name: modelProvider?.name ?? runtimeProvider?.name ?? providerId,
        runtimeAvailable: runtimeAvailable.has(providerId),
        credentialPresence: credentialPresence(credentialProviderIds, providerId),
        authMethods: safeMethods(authResponse.data, providerId),
        ...(modelsResponse.data.default[providerId]
          ? { suggestedModel: modelsResponse.data.default[providerId] }
          : {}),
        models: modelProvider
          ? Object.values(modelProvider.models)
              .map((model) => ({
                id: model.id,
                name: model.name,
                status: model.status,
              }))
              .sort((left, right) => left.id.localeCompare(right.id))
          : [],
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const suggestedProvider = [
    ...providers.filter(
      (provider) => provider.runtimeAvailable && provider.credentialPresence === 'present'
    ),
    ...providers.filter(
      (provider) => provider.runtimeAvailable && provider.credentialPresence !== 'present'
    ),
  ].find(
    (provider) =>
      provider.suggestedModel &&
      provider.models.some(
        (model) => model.id === provider.suggestedModel && model.status === 'active'
      )
  );
  const projectConfigured = configuredPair(configResponse.data.model);
  const suggestedSelection =
    suggestedProvider?.suggestedModel === undefined
      ? undefined
      : {
          providerId: suggestedProvider.id,
          modelId: suggestedProvider.suggestedModel,
        };

  const custom = await readCustomProvidersSafely(dataHome, runtime);
  return {
    runtime: 'available',
    runtimeVersion: OPENCODE_VERSION,
    ...(projectConfigured ? { projectConfigured } : {}),
    ...(suggestedSelection ? { suggestedSelection } : {}),
    providers,
    customProviders: custom.entries.map((entry) => ({
      ...entry,
      credentialPresence: credentialPresence(credentialProviderIds, entry.id),
    })),
    ...(custom.error ? { customProvidersError: custom.error } : {}),
  };
}

async function discover(
  dataHome: string,
  directory = dataHome,
  runtime = DEFAULT_AUTH_RUNTIME
): Promise<OpenCodeProviderDiscovery> {
  return withFreshClient(
    dataHome,
    [],
    (client) => readConfigurationSnapshot(client, dataHome, directory, runtime),
    directory,
    runtime
  );
}

type SaveCustomProviderParams = Extract<
  OpenCodeAuthPayload['params'],
  { operation: 'save-custom-provider' }
>;
type RemoveCustomProviderParams = Extract<
  OpenCodeAuthPayload['params'],
  { operation: 'remove-custom-provider' }
>;
type ProbeCustomProviderParams = Extract<
  OpenCodeAuthPayload['params'],
  { operation: 'probe-custom-provider-models' }
>;

async function saveCustomProviderOperation(
  dataHome: string,
  params: SaveCustomProviderParams,
  runtime: OpenCodeAuthRuntimeDependencies
) {
  const { create, provider, apiKey, clearApiKey } = params;
  const secrets = [apiKey ?? ''];
  if (apiKey && clearApiKey) {
    return customProviderFailure(
      {
        code: 'CUSTOM_PROVIDER_INVALID',
        message: 'Choose either a new API key or Clear key, not both.',
      },
      secrets
    );
  }
  const store = customProviderRuntime(runtime);
  const outcome = await withFreshClient<CustomProviderOutcome<OpenCodeProviderDiscovery>>(
    dataHome,
    secrets,
    async (client) => {
      if (create) {
        const listed = await client.provider.list({ directory: dataHome });
        if (listed.error || !listed.data) throw new Error('OpenCode provider list unavailable');
        if (listed.data.all.some((existing) => existing.id === provider.id)) {
          return {
            ok: false,
            failure: {
              code: 'CUSTOM_PROVIDER_ID_TAKEN',
              message: CUSTOM_PROVIDER_MESSAGES.idTaken(provider.id),
            },
          };
        }
      }
      try {
        await store.save(dataHome, provider, { create });
      } catch (error) {
        if (error instanceof CustomProviderError) {
          return { ok: false, failure: { code: error.code, message: error.message } };
        }
        throw error;
      }
      if (apiKey || clearApiKey) {
        try {
          const response = apiKey
            ? await client.auth.set({
                providerID: provider.id,
                auth: { type: 'api', key: apiKey },
              })
            : await client.auth.remove({ providerID: provider.id });
          if (response.error || response.data !== true) {
            throw new Error('auth mutation rejected');
          }
          await runtime.verifyOpenCodeAuthFileBoundary(dataHome, { allowMissing: !apiKey });
        } catch {
          return {
            ok: false,
            failure: {
              code: 'CUSTOM_PROVIDER_KEY_NOT_SAVED',
              message: CUSTOM_PROVIDER_MESSAGES.keyNotSaved,
            },
          };
        }
      }
      return {
        ok: true,
        value: await readConfigurationSnapshot(client, dataHome, dataHome, runtime),
      };
    },
    dataHome,
    runtime
  );
  return outcome.ok
    ? { success: true, data: outcome.value }
    : customProviderFailure(outcome.failure, secrets);
}

async function removeCustomProviderOperation(
  dataHome: string,
  params: RemoveCustomProviderParams,
  runtime: OpenCodeAuthRuntimeDependencies
) {
  const { providerId } = params;
  const store = customProviderRuntime(runtime);
  const outcome = await withFreshClient<CustomProviderOutcome<OpenCodeProviderDiscovery>>(
    dataHome,
    [],
    async (client) => {
      try {
        await store.remove(dataHome, providerId);
      } catch (error) {
        if (error instanceof CustomProviderError) {
          return { ok: false, failure: { code: error.code, message: error.message } };
        }
        throw error;
      }
      if ((await savedCredentialProviderIds(dataHome))?.has(providerId)) {
        // A key left behind is harmless and stays removable from the provider list.
        await client.auth.remove({ providerID: providerId }).catch(() => undefined);
      }
      return {
        ok: true,
        value: await readConfigurationSnapshot(client, dataHome, dataHome, runtime),
      };
    },
    dataHome,
    runtime
  );
  return outcome.ok
    ? { success: true, data: outcome.value }
    : customProviderFailure(outcome.failure, []);
}

function urlOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/** A saved key only goes back to its own custom provider's origin, never to an arbitrary URL. */
async function probeMayUseSavedKey(
  dataHome: string,
  providerId: string,
  baseURL: string,
  runtime: OpenCodeAuthRuntimeDependencies
): Promise<boolean> {
  const { entries } = await readCustomProvidersSafely(dataHome, runtime);
  const provider = entries
    .filter(isSupportedCustomProvider)
    .find((entry) => entry.id === providerId);
  const origin = urlOrigin(baseURL);
  return Boolean(provider && origin && urlOrigin(provider.baseURL) === origin);
}

async function probeCustomProviderOperation(
  dataHome: string,
  params: ProbeCustomProviderParams,
  runtime: OpenCodeAuthRuntimeDependencies
) {
  const { baseURL, providerId } = params;
  let apiKey = params.apiKey;
  if (
    !apiKey &&
    providerId &&
    (await probeMayUseSavedKey(dataHome, providerId, baseURL, runtime))
  ) {
    await runtime.verifyOpenCodeAuthFileBoundary(dataHome, { allowMissing: true });
    apiKey = await savedApiKey(dataHome, providerId);
  }
  try {
    const models = await customProviderRuntime(runtime).probe(baseURL, apiKey);
    return { success: true, data: { models } };
  } catch (error) {
    if (error instanceof CustomProviderError) {
      return customProviderFailure({ code: error.code, message: error.message }, [apiKey ?? '']);
    }
    throw error;
  }
}

export async function handleOpenCodeAuth(
  payload: OpenCodeAuthPayload,
  options: OpenCodeCommandOptions,
  runtime = DEFAULT_AUTH_RUNTIME
) {
  if (options.dryRun) {
    return {
      success: true,
      data: { dryRun: true, operation: payload.params.operation },
    };
  }

  try {
    if (payload.params.operation === 'discover') {
      return {
        success: true,
        data: await discover(
          payload.dataHome,
          payload.params.directory ?? payload.dataHome,
          runtime
        ),
      };
    }

    if (payload.params.operation === 'read-model-catalog') {
      return { success: true, data: await discoverModels(payload.dataHome, runtime) };
    }

    if (payload.params.operation === 'save-custom-provider') {
      return await saveCustomProviderOperation(payload.dataHome, payload.params, runtime);
    }
    if (payload.params.operation === 'remove-custom-provider') {
      return await removeCustomProviderOperation(payload.dataHome, payload.params, runtime);
    }
    if (payload.params.operation === 'probe-custom-provider-models') {
      return await probeCustomProviderOperation(payload.dataHome, payload.params, runtime);
    }

    if (payload.params.operation === 'connect-oauth') {
      return {
        success: false,
        error: {
          code: 'OPENCODE_OAUTH_PROTOCOL_REQUIRED',
          message: 'OpenCode OAuth requires the bounded authorization protocol.',
        },
      };
    }

    const { providerId } = payload.params;
    const apiKey =
      payload.params.operation === 'connect-api-key' ? payload.params.apiKey : undefined;
    const metadata =
      payload.params.operation === 'connect-api-key' ? payload.params.metadata : undefined;
    const discovery = await withFreshClient(
      payload.dataHome,
      [apiKey ?? '', metadata],
      async (client) => {
        if (payload.params.operation === 'disconnect') {
          const savedProviders = await savedCredentialProviderIds(payload.dataHome);
          if (!savedProviders?.has(providerId)) {
            throw new Error('No saved OpenCode credential exists for that provider');
          }
        }
        const response =
          payload.params.operation === 'connect-api-key'
            ? await client.auth.set({
                providerID: providerId,
                auth: {
                  type: 'api',
                  key: payload.params.apiKey,
                  ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
                },
              })
            : await client.auth.remove({ providerID: providerId });
        if (response.error || response.data !== true) {
          throw new Error('OpenCode rejected the provider credential mutation');
        }
        await runtime.verifyOpenCodeAuthFileBoundary(payload.dataHome, {
          allowMissing: payload.params.operation === 'disconnect',
        });
        return readConfigurationSnapshot(client, payload.dataHome, payload.dataHome, runtime);
      },
      payload.dataHome,
      runtime
    );

    return { success: true, data: discovery };
  } catch {
    return {
      success: false,
      error: {
        code: 'OPENCODE_AUTH_FAILED',
        message: 'OpenCode provider operation failed without exposing credential details.',
      },
    };
  }
}

export type OpenCodeOAuthExecutorEvent =
  | { type: 'authorized'; authorization: OpenCodeOAuthAuthorization }
  | { type: 'callback-started' };

export type OpenCodeOAuthPayload = Omit<OpenCodeAuthPayload, 'params'> & {
  params: Extract<OpenCodeAuthPayload['params'], { operation: 'connect-oauth' }>;
};

const LOOPBACK_OAUTH_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

export function validateOpenCodeOAuthAuthorizationUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('OpenCode returned an invalid OAuth authorization URL');
  }
  if (url.username || url.password) {
    throw new Error('OpenCode returned an OAuth authorization URL with embedded credentials');
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && LOOPBACK_OAUTH_HOSTS.has(url.hostname))
  ) {
    throw new Error('OpenCode returned an unsafe OAuth authorization URL');
  }
  return url.href;
}

export async function handleOpenCodeOAuth(
  payload: OpenCodeOAuthPayload,
  options: OpenCodeCommandOptions,
  emit: (event: OpenCodeOAuthExecutorEvent) => void,
  readCode?: () => Promise<string>,
  runtime = DEFAULT_AUTH_RUNTIME
) {
  if (options.dryRun) {
    return {
      success: true,
      data: { dryRun: true, operation: payload.params.operation },
    };
  }

  const { providerId, method, inputs } = payload.params;
  try {
    const discovery = await withFreshClient(
      payload.dataHome,
      Object.values(inputs ?? {}),
      async (client) => {
        const response = await client.provider.oauth.authorize({
          providerID: providerId,
          method,
          ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
          directory: payload.dataHome,
        });
        if (response.error || !response.data) {
          throw new Error('OpenCode rejected OAuth authorization');
        }
        const authorization: OpenCodeOAuthAuthorization = {
          url: validateOpenCodeOAuthAuthorizationUrl(response.data.url),
          method: response.data.method,
          instructions: response.data.instructions,
        };
        emit({ type: 'authorized', authorization });
        const code = authorization.method === 'code' ? (await readCode?.())?.trim() : undefined;
        if (authorization.method === 'code' && !code) {
          throw new Error('OpenCode OAuth code was not supplied');
        }
        emit({ type: 'callback-started' });
        const callback = await client.provider.oauth.callback({
          providerID: providerId,
          method,
          ...(code ? { code } : {}),
          directory: payload.dataHome,
        });
        if (callback.error || callback.data !== true) {
          throw new Error('OpenCode rejected OAuth callback');
        }
        await runtime.verifyOpenCodeAuthFileBoundary(payload.dataHome);
        return readConfigurationSnapshot(client, payload.dataHome, payload.dataHome, runtime);
      },
      payload.dataHome,
      runtime
    );
    return { success: true, data: discovery };
  } catch {
    return {
      success: false,
      error: {
        code: 'OPENCODE_AUTH_FAILED',
        message: 'OpenCode provider operation failed without exposing credential details.',
      },
    };
  }
}

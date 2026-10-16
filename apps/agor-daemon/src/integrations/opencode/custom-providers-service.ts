import {
  CUSTOM_PROVIDER_MESSAGES,
  CustomProviderBaseURLSchema,
  CustomProviderPatchSchema,
  CustomProviderSchema,
  customProviderValidationMessage,
} from '@agor/agentic-tool-opencode';
import { resolveOpenCodeCapabilities } from '@agor/agentic-tool-opencode/daemon';
import type { AgorConfig } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  DeepReadonly,
  OpenCodeCustomProvider,
  OpenCodeCustomProviderProbeResult,
  OpenCodeProviderDiscovery,
  OpenCodeProviderSettings,
} from '@agor/core/types';
import { z } from 'zod';
import {
  type AuthenticatedOpenCodeSubjectContext,
  resolveAuthenticatedOpenCodeSubjectContext,
} from './credential-namespace.js';
import { startOpenCodeExecutorInvocation } from './executor-command.js';
import {
  blockOpenCodeNativeStateNamespace,
  inOpenCodeNativeStateMutationSlot,
  type OpenCodeNativeStateMutationFence,
} from './native-state-coordinator.js';

const OptionalKey = z.string().trim().min(1).optional();
const CreateSchema = z.strictObject({ provider: CustomProviderSchema, apiKey: OptionalKey });
const PatchSchema = z.strictObject({
  provider: CustomProviderPatchSchema,
  apiKey: OptionalKey,
  clearApiKey: z.boolean().optional(),
});
const ProbeSchema = z.strictObject({
  probe: z.strictObject({
    baseURL: CustomProviderBaseURLSchema,
    apiKey: OptionalKey,
    providerId: z.string().trim().min(1).max(64).optional(),
  }),
});

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new BadRequest(customProviderValidationMessage(result.error), {
      code: 'CUSTOM_PROVIDER_INVALID',
    });
  }
  return result.data;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** Fork: manages OpenAI-compatible OpenCode providers in the caller's native data home. */
export class OpenCodeCustomProvidersService {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly config: DeepReadonly<AgorConfig>
  ) {}

  private async context(
    params?: AuthenticatedParams
  ): Promise<AuthenticatedOpenCodeSubjectContext> {
    const capabilities = resolveOpenCodeCapabilities(this.config);
    if (capabilities.mode === 'unsupported') throw new BadRequest(capabilities.reason.message);
    if (capabilities.mode === 'managed-projection') {
      throw new BadRequest(CUSTOM_PROVIDER_MESSAGES.hosted);
    }
    return resolveAuthenticatedOpenCodeSubjectContext(this.db, this.config, params);
  }

  private async run<T>(
    context: AuthenticatedOpenCodeSubjectContext,
    request: Record<string, unknown>,
    fence?: OpenCodeNativeStateMutationFence
  ): Promise<T> {
    const handle = startOpenCodeExecutorInvocation(context.dataHome, request, {
      env: context.executorEnv,
      logPrefix: '[OpenCode Custom Providers]',
    });
    if (fence) await fence.attach(handle);
    const result = await handle.result;
    if (!fence && result.error?.code === 'EXECUTOR_CLEANUP_UNVERIFIED') {
      await blockOpenCodeNativeStateNamespace(context.namespaceKey, handle);
    }
    if (!result.success || !result.data) {
      const code = result.error?.code;
      if (
        typeof code === 'string' &&
        code.startsWith('CUSTOM_PROVIDER_') &&
        result.error?.message
      ) {
        throw new BadRequest(result.error.message, { code });
      }
      throw new BadRequest('OpenCode provider operation failed. Try again.');
    }
    return result.data as T;
  }

  private settings(
    context: AuthenticatedOpenCodeSubjectContext,
    discovery: OpenCodeProviderDiscovery
  ): OpenCodeProviderSettings {
    return { ...discovery, isolation: { mode: context.mode, boundary: 'logical' } };
  }

  private async save(
    request: {
      provider: OpenCodeCustomProvider;
      create: boolean;
      apiKey?: string;
      clearApiKey?: boolean;
    },
    params?: AuthenticatedParams
  ): Promise<OpenCodeProviderSettings> {
    const context = await this.context(params);
    const discovery = await inOpenCodeNativeStateMutationSlot(context.namespaceKey, (fence) =>
      this.run<OpenCodeProviderDiscovery>(
        context,
        withoutUndefined({ operation: 'save-custom-provider', ...request }),
        fence
      )
    );
    return this.settings(context, discovery);
  }

  async create(
    data: unknown,
    params?: AuthenticatedParams
  ): Promise<OpenCodeProviderSettings | OpenCodeCustomProviderProbeResult> {
    if (data && typeof data === 'object' && 'probe' in data) {
      const { probe } = parse(ProbeSchema, data);
      const context = await this.context(params);
      return this.run<OpenCodeCustomProviderProbeResult>(
        context,
        withoutUndefined({ operation: 'probe-custom-provider-models', ...probe })
      );
    }
    const { provider, apiKey } = parse(CreateSchema, data);
    return this.save(
      { provider: provider as OpenCodeCustomProvider, create: true, apiKey },
      params
    );
  }

  async patch(
    id: string,
    data: unknown,
    params?: AuthenticatedParams
  ): Promise<OpenCodeProviderSettings> {
    const { provider, apiKey, clearApiKey } = parse(PatchSchema, data);
    const full = parse(CustomProviderSchema, { ...provider, id });
    return this.save(
      { provider: full as OpenCodeCustomProvider, create: false, apiKey, clearApiKey },
      params
    );
  }

  async remove(id: string, params?: AuthenticatedParams): Promise<OpenCodeProviderSettings> {
    const providerId = id?.trim();
    if (!providerId) {
      throw new BadRequest('Provider is required.', { code: 'CUSTOM_PROVIDER_INVALID' });
    }
    const context = await this.context(params);
    const discovery = await inOpenCodeNativeStateMutationSlot(context.namespaceKey, (fence) =>
      this.run<OpenCodeProviderDiscovery>(
        context,
        { operation: 'remove-custom-provider', providerId },
        fence
      )
    );
    return this.settings(context, discovery);
  }
}

export function createOpenCodeCustomProvidersService(
  db: TenantScopeAwareDatabase,
  config: DeepReadonly<AgorConfig>
) {
  return new OpenCodeCustomProvidersService(db, config);
}

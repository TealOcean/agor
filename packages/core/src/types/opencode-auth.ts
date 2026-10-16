import type {
  OpenCodeCatalogModel,
  OpenCodeModelPair,
  OpenCodeUnsupportedReason,
} from './opencode-models';

export type OpenCodeProviderAuthPrompt =
  | {
      type: 'text';
      key: string;
      message: string;
      placeholder?: string;
      when?: OpenCodeProviderAuthPromptCondition;
    }
  | {
      type: 'select';
      key: string;
      message: string;
      options: Array<{ label: string; value: string; hint?: string }>;
      when?: OpenCodeProviderAuthPromptCondition;
    };

export type OpenCodeProviderAuthPromptCondition = {
  key: string;
  op: 'eq' | 'neq';
  value: string;
};

export interface OpenCodeProviderAuthMethod {
  /** Stable index in the native OpenCode auth-method array. */
  index: number;
  type: 'api' | 'oauth';
  label: string;
  prompts?: OpenCodeProviderAuthPrompt[];
}

export type OpenCodeOAuthAuthorization = {
  url: string;
  method: 'auto' | 'code';
  instructions: string;
};

export type OpenCodeOAuthAttemptPhase =
  | 'authorizing'
  | 'awaiting_callback'
  | 'completing'
  | 'configured'
  | 'cancelled'
  | 'expired'
  | 'failed';

export interface OpenCodeOAuthAttempt {
  attemptId: string;
  providerId: string;
  phase: OpenCodeOAuthAttemptPhase;
  authorization?: OpenCodeOAuthAuthorization;
  expiresAt: string;
  settings?: OpenCodeProviderSettings;
}

export type OpenCodeOAuthConnectRequest = {
  operation: 'connect-oauth';
  providerId: string;
  method: number;
  inputs?: Record<string, string>;
};

export type OpenCodeOAuthAttemptPatch = { cancel: true } | { code: string };

export type OpenCodeCredentialPresence = 'present' | 'absent' | 'unknown';

export interface OpenCodeProviderConnection {
  id: string;
  name: string;
  runtimeAvailable: boolean;
  credentialPresence: OpenCodeCredentialPresence;
  authMethods: OpenCodeProviderAuthMethod[];
  suggestedModel?: string;
  models: OpenCodeCatalogModel[];
}

export interface OpenCodeProviderDiscovery {
  runtime: 'available';
  runtimeVersion: string;
  projectConfigured?: OpenCodeModelPair;
  suggestedSelection?: OpenCodeModelPair;
  providers: OpenCodeProviderConnection[];
  /** Providers defined in the global opencode.json (fork: custom providers). */
  customProviders?: OpenCodeCustomProviderListing[];
  /** Set when opencode.json could not be read; custom providers are then unknown. */
  customProvidersError?: string;
}

export type OpenCodeCredentialIsolation =
  | {
      // Local native-file authority in the daemon-owned credential home.
      mode: 'simple' | 'sandbox';
      boundary: 'logical';
    }
  | {
      // Hosted keys are stored encrypted per user and delivered only to that user's executor run.
      mode: 'managed-projection';
      boundary: 'executor-run';
    };

/** Settings response for a deployment that cannot run OpenCode at all. */
export interface OpenCodeUnsupportedSettings {
  runtime: 'unsupported';
  runtimeVersion: string;
  unsupported: OpenCodeUnsupportedReason;
  providers: [];
}

export type OpenCodeProviderSettings =
  | (OpenCodeProviderDiscovery & { isolation: OpenCodeCredentialIsolation })
  | OpenCodeUnsupportedSettings;

export type OpenCodeCustomProviderApiType = 'chat-completions' | 'responses';

export interface OpenCodeCustomProviderModel {
  id: string;
  /** Display name; omitted when it equals the ID. */
  name?: string;
}

/** An OpenAI-compatible provider defined in OpenCode's global config by Agor. */
export interface OpenCodeCustomProvider {
  id: string;
  name: string;
  apiType: OpenCodeCustomProviderApiType;
  baseURL: string;
  models: OpenCodeCustomProviderModel[];
}

/** A config-file provider Agor cannot edit (other npm package or missing base URL). */
export interface OpenCodeUnsupportedCustomProvider {
  id: string;
  name: string;
  npm: string;
  unsupported: true;
}

export type OpenCodeCustomProviderEntry =
  | OpenCodeCustomProvider
  | OpenCodeUnsupportedCustomProvider;

export type OpenCodeCustomProviderListing = OpenCodeCustomProviderEntry & {
  credentialPresence: OpenCodeCredentialPresence;
};

export type OpenCodeCustomProviderErrorCode =
  | 'CUSTOM_PROVIDER_INVALID'
  | 'CUSTOM_PROVIDER_ID_TAKEN'
  | 'CUSTOM_PROVIDER_NOT_FOUND'
  | 'CUSTOM_PROVIDER_CONFIG_UNREADABLE'
  | 'CUSTOM_PROVIDER_KEY_NOT_SAVED'
  | 'CUSTOM_PROVIDER_UNREACHABLE'
  | 'CUSTOM_PROVIDER_TIMEOUT'
  | 'CUSTOM_PROVIDER_UNAUTHORIZED'
  | 'CUSTOM_PROVIDER_NO_MODEL_LIST'
  | 'CUSTOM_PROVIDER_BAD_RESPONSE'
  | 'CUSTOM_PROVIDER_REDIRECT';

export interface OpenCodeCustomProviderProbeRequest {
  probe: { baseURL: string; apiKey?: string; providerId?: string };
}

export interface OpenCodeCustomProviderProbeResult {
  models: string[];
}

export interface OpenCodeCustomProviderCreateRequest {
  provider: OpenCodeCustomProvider;
  apiKey?: string;
}

export interface OpenCodeCustomProviderPatchRequest {
  provider: Omit<OpenCodeCustomProvider, 'id'>;
  apiKey?: string;
  clearApiKey?: boolean;
}

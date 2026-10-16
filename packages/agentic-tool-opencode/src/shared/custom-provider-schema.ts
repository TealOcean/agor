import type {
  OpenCodeCustomProvider,
  OpenCodeCustomProviderApiType,
  OpenCodeCustomProviderEntry,
} from '@agor/core/types';
import { z } from 'zod';

export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const CUSTOM_PROVIDER_NPM = {
  'chat-completions': '@ai-sdk/openai-compatible',
  responses: '@ai-sdk/openai',
} as const satisfies Record<OpenCodeCustomProviderApiType, string>;

/** Fixed user-facing messages for custom provider failures. */
export const CUSTOM_PROVIDER_MESSAGES = {
  idTaken: (id: string) => `OpenCode already has a provider with ID ${id}.`,
  notFound: (id: string) => `No custom provider with ID ${id}.`,
  configUnreadable: "opencode.json isn't plain JSON; fix or remove it.",
  keyNotSaved: "Saved, but the API key couldn't be stored. Try again.",
  unreachable: (baseURL: string, reason: string) => `Couldn't reach ${baseURL} (${reason}).`,
  timeout: (baseURL: string) => `${baseURL} didn't answer within 10 s.`,
  unauthorized: (status: number) => `The endpoint rejected the API key (${status}).`,
  noModelList: 'The endpoint has no /models list (404); add model IDs manually.',
  badResponse: (detail: string) => `Unexpected response from /models (${detail}).`,
  redirect: "/models redirected; redirects aren't followed. Use the final URL.",
  unsupportedEdit: 'This provider uses an unsupported type; edit opencode.json directly.',
  hosted: "Custom providers aren't available in hosted workspaces.",
} as const;

export function apiTypeForNpm(npm: unknown): OpenCodeCustomProviderApiType | undefined {
  for (const [apiType, packageName] of Object.entries(CUSTOM_PROVIDER_NPM)) {
    if (npm === packageName) return apiType as OpenCodeCustomProviderApiType;
  }
  return undefined;
}

export function normalizeCustomProviderBaseURL(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Base URL must be a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Base URL must use http or https.');
  }
  if (url.username || url.password) {
    throw new Error("Base URL can't include credentials; put the key in the API key field.");
  }
  if (url.search || url.hash) {
    throw new Error("Base URL can't include a query string or fragment.");
  }
  return url.toString().replace(/\/+$/, '');
}

export const CustomProviderBaseURLSchema = z.string().transform((value, context) => {
  try {
    return normalizeCustomProviderBaseURL(value);
  } catch (error) {
    context.addIssue({ code: 'custom', message: (error as Error).message });
    return z.NEVER;
  }
});

const ModelSchema = z.strictObject({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200).optional(),
});

const ModelsSchema = z
  .array(ModelSchema)
  .min(1, 'Enable at least one model.')
  .max(500, 'At most 500 models.')
  .superRefine((models, context) => {
    const seen = new Set<string>();
    for (const model of models) {
      if (seen.has(model.id)) {
        context.addIssue({ code: 'custom', message: `Duplicate model ID ${model.id}.` });
        return;
      }
      seen.add(model.id);
    }
  });

const providerFields = {
  name: z.string().trim().min(1, 'Display name is required.').max(100),
  apiType: z.enum(['chat-completions', 'responses']),
  baseURL: CustomProviderBaseURLSchema,
  models: ModelsSchema,
};

export const CustomProviderSchema = z.strictObject({
  id: z
    .string()
    .regex(
      CUSTOM_PROVIDER_ID_PATTERN,
      'ID must be lowercase letters, digits, - or _, starting with a letter or digit (max 64).'
    ),
  ...providerFields,
});

export const CustomProviderPatchSchema = z.strictObject(providerFields);

export function customProviderValidationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid custom provider.';
  const field = issue.path.find((segment) => typeof segment === 'string');
  return field ? `${field}: ${issue.message}` : issue.message;
}

export function isSupportedCustomProvider(
  entry: OpenCodeCustomProviderEntry
): entry is OpenCodeCustomProvider {
  return !('unsupported' in entry);
}

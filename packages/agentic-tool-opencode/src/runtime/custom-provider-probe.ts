import { CUSTOM_PROVIDER_MESSAGES } from '../shared/custom-provider-schema.js';
import { CustomProviderError } from './custom-providers.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

function failureReason(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } })?.cause;
  if (typeof cause?.code === 'string') return cause.code;
  if (typeof cause?.message === 'string') return cause.message;
  return error instanceof Error ? error.message : String(error);
}

function badResponse(detail: string): CustomProviderError {
  return new CustomProviderError(
    'CUSTOM_PROVIDER_BAD_RESPONSE',
    CUSTOM_PROVIDER_MESSAGES.badResponse(detail)
  );
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw badResponse('response larger than 1 MB');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Lists model IDs from an OpenAI-compatible `GET <baseURL>/models`. */
export async function probeOpenAICompatibleModels(
  baseURL: string,
  apiKey?: string,
  options: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timedOut = () =>
    new CustomProviderError('CUSTOM_PROVIDER_TIMEOUT', CUSTOM_PROVIDER_MESSAGES.timeout(baseURL));
  try {
    let response: Response;
    try {
      response = await fetch(`${baseURL}/models`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw timedOut();
      throw new CustomProviderError(
        'CUSTOM_PROVIDER_UNREACHABLE',
        CUSTOM_PROVIDER_MESSAGES.unreachable(baseURL, failureReason(error))
      );
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new CustomProviderError('CUSTOM_PROVIDER_REDIRECT', CUSTOM_PROVIDER_MESSAGES.redirect);
    }
    if (response.status === 401 || response.status === 403) {
      throw new CustomProviderError(
        'CUSTOM_PROVIDER_UNAUTHORIZED',
        CUSTOM_PROVIDER_MESSAGES.unauthorized(response.status)
      );
    }
    if (response.status === 404) {
      throw new CustomProviderError(
        'CUSTOM_PROVIDER_NO_MODEL_LIST',
        CUSTOM_PROVIDER_MESSAGES.noModelList
      );
    }
    if (!response.ok) throw badResponse(`HTTP ${response.status}`);
    let text: string;
    try {
      text = await readBounded(response, options.maxBytes ?? DEFAULT_MAX_BYTES);
    } catch (error) {
      if (error instanceof CustomProviderError) throw error;
      if (controller.signal.aborted) throw timedOut();
      throw error;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw badResponse('not JSON');
    }
    const data = (body as { data?: unknown })?.data;
    if (
      !Array.isArray(data) ||
      data.some((item) => typeof (item as { id?: unknown })?.id !== 'string')
    ) {
      throw badResponse('expected { data: [{ id }] }');
    }
    return [...new Set(data.map((item) => (item as { id: string }).id))].sort((a, b) =>
      a.localeCompare(b)
    );
  } finally {
    clearTimeout(timer);
  }
}

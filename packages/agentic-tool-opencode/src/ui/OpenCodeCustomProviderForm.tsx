import type { AgorClient } from '@agor/core/client';
import type {
  OpenCodeCredentialPresence,
  OpenCodeCustomProvider,
  OpenCodeCustomProviderApiType,
  OpenCodeCustomProviderProbeResult,
  OpenCodeProviderSettings,
} from '@agor/core/types';
import { Alert, Button, Checkbox, Form, Input, Radio, Space, Tag, Typography } from 'antd';
import { useId, useState } from 'react';
import {
  CustomProviderPatchSchema,
  CustomProviderSchema,
  customProviderValidationMessage,
} from '../shared/custom-provider-schema.js';

export interface FormModel {
  id: string;
  name?: string;
  enabled: boolean;
  isNew: boolean;
}

/** First discovery enables everything; later refreshes add new models unticked and marked new. */
export function mergeDiscoveredModels(
  current: FormModel[],
  discovered: string[],
  firstDiscovery: boolean
): FormModel[] {
  if (firstDiscovery) return discovered.map((id) => ({ id, enabled: true, isNew: false }));
  const known = new Set(current.map((model) => model.id));
  return [
    ...current,
    ...discovered.filter((id) => !known.has(id)).map((id) => ({ id, enabled: false, isNew: true })),
  ];
}

function errorCode(error: unknown): unknown {
  return (error as { data?: { code?: unknown } } | undefined)?.data?.code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'OpenCode provider operation failed. Try again.';
}

export function OpenCodeCustomProviderForm({
  client,
  existing,
  onSaved,
  onCancel,
}: {
  client: AgorClient;
  existing?: OpenCodeCustomProvider & { credentialPresence: OpenCodeCredentialPresence };
  /** `warning` is set when the provider saved but something after it (the key) did not. */
  onSaved: (settings: OpenCodeProviderSettings, warning?: string) => void;
  onCancel: () => void;
}) {
  const service = client.service('opencode-custom-providers');
  const [id, setId] = useState(existing?.id ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [apiType, setApiType] = useState<OpenCodeCustomProviderApiType>(
    existing?.apiType ?? 'chat-completions'
  );
  const [baseURL, setBaseURL] = useState(existing?.baseURL ?? '');
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [models, setModels] = useState<FormModel[]>(
    existing?.models.map((model) => ({ ...model, enabled: true, isNew: false })) ?? []
  );
  const [discovered, setDiscovered] = useState(Boolean(existing));
  const [manualModelId, setManualModelId] = useState('');
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const fieldId = (field: string) => `${formId}-${field}`;

  const discover = async () => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const typedKey = apiKey.trim();
      const result = (await service.create({
        probe: {
          baseURL,
          ...(typedKey ? { apiKey: typedKey } : existing ? { providerId: existing.id } : {}),
        },
      })) as OpenCodeCustomProviderProbeResult;
      if (result.models.length === 0) setNotice('No models found; add model IDs manually.');
      setModels((current) => mergeDiscoveredModels(current, result.models, !discovered));
      setDiscovered(true);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const addManualModel = () => {
    const modelId = manualModelId.trim();
    if (!modelId || models.some((model) => model.id === modelId)) return;
    setModels((current) => [...current, { id: modelId, enabled: true, isNew: false }]);
    setManualModelId('');
  };

  const save = async () => {
    setError(undefined);
    const enabled = models
      .filter((model) => model.enabled)
      .map((model) => (model.name ? { id: model.id, name: model.name } : { id: model.id }));
    const fields = { name, apiType, baseURL, models: enabled };
    const checked = existing
      ? CustomProviderPatchSchema.safeParse(fields)
      : CustomProviderSchema.safeParse({ id, ...fields });
    if (!checked.success) {
      setError(customProviderValidationMessage(checked.error));
      return;
    }
    const typedKey = apiKey.trim();
    setBusy(true);
    try {
      const settings = existing
        ? await service.patch(existing.id, {
            provider: fields,
            ...(typedKey ? { apiKey: typedKey } : {}),
            ...(clearApiKey && !typedKey ? { clearApiKey: true } : {}),
          })
        : ((await service.create({
            provider: { id, ...fields },
            ...(typedKey ? { apiKey: typedKey } : {}),
          })) as OpenCodeProviderSettings);
      onSaved(settings);
    } catch (failure) {
      if (errorCode(failure) === 'CUSTOM_PROVIDER_KEY_NOT_SAVED') {
        // The definition is on disk: refresh so it can be edited instead of re-created.
        try {
          onSaved(await client.service('opencode-auth').find(), errorMessage(failure));
          return;
        } catch {
          // Fall through to the inline error.
        }
      }
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Form layout="vertical" component={false}>
      <Form.Item
        label="Provider ID"
        htmlFor={fieldId('id')}
        required={!existing}
        extra="Short name OpenCode uses for this provider, e.g. omlx. Lowercase letters, digits, - and _. It can't be changed later."
      >
        <Input
          id={fieldId('id')}
          placeholder="omlx"
          value={id}
          disabled={Boolean(existing)}
          onChange={(event) => setId(event.target.value)}
        />
      </Form.Item>
      <Form.Item
        label="Display name"
        htmlFor={fieldId('name')}
        required
        extra="Shown in Agor's provider list and model picker."
      >
        <Input
          id={fieldId('name')}
          placeholder="oMLX (Mac Studio)"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Form.Item>
      <Form.Item
        label={<span id={fieldId('api-type')}>API type</span>}
        required
        extra="The endpoint OpenCode sends prompts to. Chat Completions (/chat/completions) works with most local servers; pick Responses (/responses) only if the server supports it."
      >
        <div role="radiogroup" aria-labelledby={fieldId('api-type')}>
          <Radio.Group value={apiType} onChange={(event) => setApiType(event.target.value)}>
            <Radio value="chat-completions">Chat Completions</Radio>
            <Radio value="responses">Responses</Radio>
          </Radio.Group>
        </div>
      </Form.Item>
      <Form.Item
        label="Base URL"
        htmlFor={fieldId('base-url')}
        required
        extra="The server's OpenAI-compatible root, usually ending in /v1. Models are listed from <base URL>/models."
      >
        <Input
          id={fieldId('base-url')}
          placeholder="http://192.168.1.175:8000/v1"
          value={baseURL}
          onChange={(event) => setBaseURL(event.target.value)}
        />
      </Form.Item>
      <Form.Item
        label="API key"
        htmlFor={fieldId('api-key')}
        extra={
          existing?.credentialPresence === 'present'
            ? 'A key is saved. Leave blank to keep it, type a new one to replace it, or tick Clear saved key.'
            : "Sent as a bearer token. Leave blank if the server doesn't need one. Stored in OpenCode's auth.json and never shown again."
        }
      >
        <Input.Password
          id={fieldId('api-key')}
          autoComplete="new-password"
          placeholder={
            existing?.credentialPresence === 'present' ? 'Saved — leave blank to keep' : 'Optional'
          }
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </Form.Item>
      {existing?.credentialPresence === 'present' && (
        <Form.Item>
          <Checkbox
            checked={clearApiKey}
            onChange={(event) => setClearApiKey(event.target.checked)}
          >
            Clear saved key
          </Checkbox>
        </Form.Item>
      )}
      <Form.Item
        label={<span id={fieldId('models')}>Models</span>}
        required
        extra="Ticked models appear in OpenCode's model picker. Discover lists them from the server (fill in the base URL and key first), or add model IDs by hand below."
      >
        <Space orientation="vertical" size="small" style={{ width: '100%' }}>
          <Button onClick={() => void discover()} loading={busy} disabled={!baseURL.trim()}>
            {existing ? 'Refresh models' : 'Discover models'}
          </Button>
          {notice && <Typography.Text type="secondary">{notice}</Typography.Text>}
          {models.map((model) => (
            <Space key={model.id} size="small">
              <Checkbox
                checked={model.enabled}
                onChange={(event) =>
                  setModels((current) =>
                    current.map((entry) =>
                      entry.id === model.id ? { ...entry, enabled: event.target.checked } : entry
                    )
                  )
                }
              >
                {model.id}
              </Checkbox>
              {model.isNew && <Tag>new</Tag>}
            </Space>
          ))}
          <Space.Compact style={{ width: '100%' }}>
            <Input
              aria-label="Model ID to add"
              placeholder="Model ID to add, e.g. mlx-community/Qwen3-Coder-30B"
              value={manualModelId}
              onChange={(event) => setManualModelId(event.target.value)}
            />
            <Button onClick={addManualModel}>Add model</Button>
          </Space.Compact>
        </Space>
      </Form.Item>
      {error && (
        <Form.Item>
          <Alert type="error" showIcon title={error} />
        </Form.Item>
      )}
      <Space>
        <Button type="primary" onClick={() => void save()} loading={busy}>
          Save provider
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </Space>
    </Form>
  );
}

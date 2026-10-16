import type { AgorClient } from '@agor/core/client';
import type {
  OpenCodeCredentialPresence,
  OpenCodeCustomProvider,
  OpenCodeCustomProviderApiType,
  OpenCodeCustomProviderProbeResult,
  OpenCodeProviderSettings,
} from '@agor/core/types';
import { Alert, Button, Checkbox, Input, Radio, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
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
  onSaved: (settings: OpenCodeProviderSettings) => void;
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
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Space orientation="vertical" size="small" style={{ width: '100%' }}>
      <Input
        aria-label="Custom provider ID"
        placeholder="omlx"
        value={id}
        disabled={Boolean(existing)}
        onChange={(event) => setId(event.target.value)}
      />
      <Input
        aria-label="Display name"
        placeholder="oMLX (Mac Studio)"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <div role="radiogroup" aria-label="API type">
        <Radio.Group value={apiType} onChange={(event) => setApiType(event.target.value)}>
          <Radio value="chat-completions">Chat Completions</Radio>
          <Radio value="responses">Responses</Radio>
        </Radio.Group>
      </div>
      <Input
        aria-label="Base URL"
        placeholder="http://192.168.1.175:8000/v1"
        value={baseURL}
        onChange={(event) => setBaseURL(event.target.value)}
      />
      <Input.Password
        aria-label="API key"
        autoComplete="new-password"
        placeholder={
          existing?.credentialPresence === 'present' ? 'Saved — leave blank to keep' : 'Optional'
        }
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
      />
      {existing?.credentialPresence === 'present' && (
        <Checkbox checked={clearApiKey} onChange={(event) => setClearApiKey(event.target.checked)}>
          Clear saved key
        </Checkbox>
      )}
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
          value={manualModelId}
          onChange={(event) => setManualModelId(event.target.value)}
        />
        <Button onClick={addManualModel}>Add model</Button>
      </Space.Compact>
      {error && <Alert type="error" showIcon title={error} />}
      <Space>
        <Button type="primary" onClick={() => void save()} loading={busy}>
          Save provider
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </Space>
    </Space>
  );
}

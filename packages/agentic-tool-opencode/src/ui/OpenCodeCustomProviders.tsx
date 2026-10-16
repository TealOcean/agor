import type { AgorClient } from '@agor/core/client';
import type { OpenCodeCustomProviderListing, OpenCodeProviderSettings } from '@agor/core/types';
import { Alert, Button, List, Popconfirm, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
import { isSupportedCustomProvider } from '../shared/custom-provider-schema.js';
import { OpenCodeCustomProviderForm } from './OpenCodeCustomProviderForm.js';

const API_TYPE_LABEL = { 'chat-completions': 'Chat Completions', responses: 'Responses' } as const;

type AvailableSettings = Extract<OpenCodeProviderSettings, { runtime: 'available' }>;

/** Can never be a provider ID: IDs must start with a letter or digit. */
const ADDING = '_new';

/** Fork: OpenAI-compatible providers Agor manages in OpenCode's global config. */
export function OpenCodeCustomProviders({
  client,
  settings,
  onSettings,
}: {
  client: AgorClient;
  settings: AvailableSettings;
  onSettings: (settings: OpenCodeProviderSettings) => void;
}) {
  const [editing, setEditing] = useState<string>();
  const [error, setError] = useState<string>();
  const entries: OpenCodeCustomProviderListing[] = settings.customProviders ?? [];

  const saved = (next: OpenCodeProviderSettings) => {
    setEditing(undefined);
    onSettings(next);
  };

  const remove = async (id: string) => {
    setError(undefined);
    try {
      onSettings(await client.service('opencode-custom-providers').remove(id));
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message
          ? failure.message
          : 'OpenCode provider operation failed. Try again.'
      );
    }
  };

  return (
    <Space
      orientation="vertical"
      size="small"
      style={{ width: '100%' }}
      data-testid="opencode-custom-providers"
    >
      <Typography.Title level={5} style={{ margin: 0 }}>
        Custom providers
      </Typography.Title>
      {settings.customProvidersError && (
        <Alert type="error" showIcon title={settings.customProvidersError} />
      )}
      {error && <Alert type="error" showIcon title={error} />}
      <List
        dataSource={entries}
        locale={{ emptyText: 'No custom providers yet.' }}
        renderItem={(entry) =>
          editing === entry.id && isSupportedCustomProvider(entry) ? (
            <List.Item key={entry.id}>
              <OpenCodeCustomProviderForm
                client={client}
                existing={entry}
                onSaved={saved}
                onCancel={() => setEditing(undefined)}
              />
            </List.Item>
          ) : (
            <List.Item
              key={entry.id}
              data-testid={`custom-provider-${entry.id}`}
              actions={
                isSupportedCustomProvider(entry)
                  ? [
                      <Button key="edit" size="small" onClick={() => setEditing(entry.id)}>
                        Edit
                      </Button>,
                      <Popconfirm
                        key="remove"
                        title={`Remove ${entry.name}?`}
                        okText="Remove provider"
                        onConfirm={() => remove(entry.id)}
                      >
                        <Button size="small" danger>
                          Remove
                        </Button>
                      </Popconfirm>,
                    ]
                  : []
              }
            >
              <List.Item.Meta
                title={
                  <Space>
                    <span>{entry.name}</span>
                    <Typography.Text type="secondary">{entry.id}</Typography.Text>
                  </Space>
                }
                description={
                  isSupportedCustomProvider(entry) ? (
                    <Space wrap>
                      <span>{API_TYPE_LABEL[entry.apiType]}</span>
                      <span>{entry.baseURL}</span>
                      <span>{`${entry.models.length} models`}</span>
                      <Tag>{entry.credentialPresence === 'present' ? 'Key saved' : 'No key'}</Tag>
                    </Space>
                  ) : (
                    <span>Unsupported type — edit opencode.json directly</span>
                  )
                }
              />
            </List.Item>
          )
        }
      />
      {editing === ADDING ? (
        <OpenCodeCustomProviderForm
          client={client}
          onSaved={saved}
          onCancel={() => setEditing(undefined)}
        />
      ) : (
        <Button onClick={() => setEditing(ADDING)}>Add custom provider</Button>
      )}
    </Space>
  );
}

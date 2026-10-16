// @vitest-environment jsdom

import type { AgorClient } from '@agor/core/client';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { OpenCodeCustomProviders } from './OpenCodeCustomProviders.js';

const settings = {
  runtime: 'available',
  runtimeVersion: '1.18.31',
  isolation: { mode: 'simple', boundary: 'logical' },
  providers: [],
  customProviders: [
    {
      id: 'omlx',
      name: 'oMLX',
      apiType: 'chat-completions',
      baseURL: 'http://h/v1',
      models: [{ id: 'a' }, { id: 'b' }],
      credentialPresence: 'present',
    },
    {
      id: 'claude',
      name: 'Claude',
      npm: '@ai-sdk/anthropic',
      unsupported: true,
      credentialPresence: 'absent',
    },
  ],
} as never;

function renderSection(service: Record<string, ReturnType<typeof vi.fn>>, value = settings) {
  const client = { service: vi.fn(() => service) } as unknown as AgorClient;
  const onSettings = vi.fn();
  render(
    <AntApp>
      <OpenCodeCustomProviders client={client} settings={value} onSettings={onSettings} />
    </AntApp>
  );
  return { onSettings };
}

describe('OpenCodeCustomProviders', () => {
  it('lists providers with type, URL, model count and key status', () => {
    renderSection({});
    const row = screen.getByTestId('custom-provider-omlx');
    expect(within(row).getByText('oMLX')).toBeInTheDocument();
    expect(within(row).getByText(/Chat Completions/)).toBeInTheDocument();
    expect(within(row).getByText(/http:\/\/h\/v1/)).toBeInTheDocument();
    expect(within(row).getByText(/2 models/)).toBeInTheDocument();
    expect(within(row).getByText('Key saved')).toBeInTheDocument();
  });

  it('shows unsupported entries read-only', () => {
    renderSection({});
    const row = screen.getByTestId('custom-provider-claude');
    expect(within(row).getByText(/Unsupported type/)).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('opens the add form and the edit form', () => {
    renderSection({});
    fireEvent.click(screen.getByRole('button', { name: 'Add custom provider' }));
    expect(screen.getByLabelText('Custom provider ID')).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(
      within(screen.getByTestId('custom-provider-omlx')).getByRole('button', { name: 'Edit' })
    );
    expect(screen.getByLabelText('Custom provider ID')).toHaveValue('omlx');
  });

  it('edits a provider whose ID is "new" instead of opening the add form', () => {
    renderSection({}, {
      ...(settings as object),
      customProviders: [
        {
          id: 'new',
          name: 'Lab box',
          apiType: 'responses',
          baseURL: 'http://lab/v1',
          models: [{ id: 'm' }],
          credentialPresence: 'absent',
        },
      ],
    } as never);
    fireEvent.click(
      within(screen.getByTestId('custom-provider-new')).getByRole('button', { name: 'Edit' })
    );
    expect(screen.getByLabelText('Custom provider ID')).toHaveValue('new');
    expect(screen.getByLabelText('Custom provider ID')).toBeDisabled();
  });

  it('removes after confirmation and publishes the new settings', async () => {
    const next = { ...(settings as object), customProviders: [] };
    const service = { remove: vi.fn().mockResolvedValue(next) };
    const { onSettings } = renderSection(service);
    fireEvent.click(
      within(screen.getByTestId('custom-provider-omlx')).getByRole('button', { name: 'Remove' })
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Remove provider' }));
    await waitFor(() => expect(onSettings).toHaveBeenCalledWith(next));
    expect(service.remove).toHaveBeenCalledWith('omlx');
  });

  it('shows the config-file error', () => {
    renderSection({}, {
      ...(settings as object),
      customProviders: [],
      customProvidersError: "opencode.json isn't plain JSON; fix or remove it.",
    } as never);
    expect(
      screen.getByText("opencode.json isn't plain JSON; fix or remove it.")
    ).toBeInTheDocument();
  });
});

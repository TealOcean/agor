// @vitest-environment jsdom

import type { AgorClient } from '@agor/core/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { mergeDiscoveredModels, OpenCodeCustomProviderForm } from './OpenCodeCustomProviderForm.js';

function renderForm(
  service: { create: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> },
  existing?: never
) {
  const client = { service: vi.fn(() => service) } as unknown as AgorClient;
  const onSaved = vi.fn();
  render(
    <AntApp>
      <OpenCodeCustomProviderForm
        client={client}
        existing={existing}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />
    </AntApp>
  );
  return { onSaved };
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('mergeDiscoveredModels', () => {
  it('enables everything on first discovery', () => {
    expect(mergeDiscoveredModels([], ['a', 'b'], true)).toEqual([
      { id: 'a', enabled: true, isNew: false },
      { id: 'b', enabled: true, isNew: false },
    ]);
  });

  it('keeps existing choices and adds new models unticked and marked new on refresh', () => {
    const current = [
      { id: 'a', enabled: true, isNew: false },
      { id: 'gone', enabled: true, isNew: false },
    ];
    expect(mergeDiscoveredModels(current, ['a', 'c'], false)).toEqual([
      { id: 'a', enabled: true, isNew: false },
      { id: 'gone', enabled: true, isNew: false },
      { id: 'c', enabled: false, isNew: true },
    ]);
  });
});

describe('OpenCodeCustomProviderForm', () => {
  it('shows a visible label and a hint for every field', () => {
    renderForm({ create: vi.fn(), patch: vi.fn() });
    for (const label of [
      'Provider ID',
      'Display name',
      'API type',
      'Base URL',
      'API key',
      'Models',
    ]) {
      expect(screen.getByText(label, { selector: 'label, label > span' })).toBeVisible();
    }
    expect(screen.getByText(/can't be changed later/)).toBeInTheDocument();
    expect(screen.getByText(/usually ending in \/v1/)).toBeInTheDocument();
    expect(screen.getByText(/Leave blank if the server doesn't need one/)).toBeInTheDocument();
  });

  it('discovers models with the typed key, then creates the provider', async () => {
    const settings = { runtime: 'available' };
    const service = {
      create: vi
        .fn()
        .mockResolvedValueOnce({ models: ['mlx-community/Qwen3', 'gemma'] })
        .mockResolvedValueOnce(settings),
      patch: vi.fn(),
    };
    const { onSaved } = renderForm(service);
    fill('Provider ID', 'omlx');
    fill('Display name', 'oMLX');
    fill('Base URL', 'http://192.168.1.175:8000/v1/');
    fill('API key', 'sk-test');
    fireEvent.click(screen.getByRole('button', { name: 'Discover models' }));

    await screen.findByLabelText('mlx-community/Qwen3');
    expect(service.create).toHaveBeenNthCalledWith(1, {
      probe: { baseURL: 'http://192.168.1.175:8000/v1/', apiKey: 'sk-test' },
    });
    fireEvent.click(screen.getByLabelText('gemma')); // untick

    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(settings));
    expect(service.create).toHaveBeenNthCalledWith(2, {
      provider: {
        id: 'omlx',
        name: 'oMLX',
        apiType: 'chat-completions',
        baseURL: 'http://192.168.1.175:8000/v1/',
        models: [{ id: 'mlx-community/Qwen3' }],
      },
      apiKey: 'sk-test',
    });
  });

  it('says so when the endpoint lists no models', async () => {
    const service = { create: vi.fn().mockResolvedValue({ models: [] }), patch: vi.fn() };
    renderForm(service);
    fill('Base URL', 'http://h/v1');
    fireEvent.click(screen.getByRole('button', { name: 'Discover models' }));
    expect(await screen.findByText(/No models found; add model IDs manually/)).toBeInTheDocument();
  });

  it('shows server errors next to the form', async () => {
    const service = {
      create: vi.fn().mockRejectedValue(new Error('The endpoint rejected the API key (401).')),
      patch: vi.fn(),
    };
    renderForm(service);
    fill('Base URL', 'http://h/v1');
    fireEvent.click(screen.getByRole('button', { name: 'Discover models' }));
    expect(await screen.findByText('The endpoint rejected the API key (401).')).toBeInTheDocument();
  });

  it('blocks saving without an enabled model and shows the validation message', async () => {
    const service = { create: vi.fn(), patch: vi.fn() };
    renderForm(service);
    fill('Provider ID', 'omlx');
    fill('Display name', 'oMLX');
    fill('Base URL', 'http://h/v1');
    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));
    expect(await screen.findByText(/models: Enable at least one model/)).toBeInTheDocument();
    expect(service.create).not.toHaveBeenCalled();
  });

  it('edits an existing provider: ID locked, key write-only, refresh uses the saved key', async () => {
    const existing = {
      id: 'omlx',
      name: 'oMLX',
      apiType: 'responses',
      baseURL: 'http://h/v1',
      models: [{ id: 'a' }],
      credentialPresence: 'present',
    } as never;
    const service = {
      create: vi.fn().mockResolvedValue({ models: ['a', 'b'] }),
      patch: vi.fn().mockResolvedValue({ runtime: 'available' }),
    };
    renderForm(service, existing);
    expect(screen.getByLabelText('Provider ID')).toBeDisabled();
    expect(screen.getByLabelText('API key')).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }));
    await screen.findByLabelText('b');
    expect(service.create).toHaveBeenCalledWith({
      probe: { baseURL: 'http://h/v1', providerId: 'omlx' },
    });
    expect(screen.getByLabelText('b')).not.toBeChecked();
    expect(screen.getByText('new')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Clear saved key'));
    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));
    await waitFor(() =>
      expect(service.patch).toHaveBeenCalledWith('omlx', {
        provider: {
          name: 'oMLX',
          apiType: 'responses',
          baseURL: 'http://h/v1',
          models: [{ id: 'a' }],
        },
        clearApiKey: true,
      })
    );
  });
});

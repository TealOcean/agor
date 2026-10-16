import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeOpenAICompatibleModels } from './custom-provider-probe.js';

let server: Server;
let baseURL: string;
let handler: (request: IncomingMessage, response: ServerResponse) => void;
const seen: Array<{ url?: string; authorization?: string }> = [];

beforeEach(async () => {
  seen.length = 0;
  server = createServer((request, response) => {
    seen.push({ url: request.url, authorization: request.headers.authorization });
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function json(status: number, body: unknown) {
  handler = (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
}

describe('OpenAI-compatible /models probe', () => {
  it('returns sorted unique model IDs and sends the key as a bearer token', async () => {
    json(200, { data: [{ id: 'b' }, { id: 'a/slash' }, { id: 'b' }] });
    await expect(probeOpenAICompatibleModels(baseURL, 'sk-test')).resolves.toEqual([
      'a/slash',
      'b',
    ]);
    expect(seen).toEqual([{ url: '/v1/models', authorization: 'Bearer sk-test' }]);
  });

  it('sends no authorization header without a key', async () => {
    json(200, { data: [] });
    await expect(probeOpenAICompatibleModels(baseURL)).resolves.toEqual([]);
    expect(seen[0]?.authorization).toBeUndefined();
  });

  it.each([
    [401, 'CUSTOM_PROVIDER_UNAUTHORIZED'],
    [403, 'CUSTOM_PROVIDER_UNAUTHORIZED'],
    [404, 'CUSTOM_PROVIDER_NO_MODEL_LIST'],
    [500, 'CUSTOM_PROVIDER_BAD_RESPONSE'],
  ])('maps HTTP %i to %s', async (status, code) => {
    json(status, { error: 'x' });
    await expect(probeOpenAICompatibleModels(baseURL, 'k')).rejects.toMatchObject({ code });
  });

  it('does not follow redirects', async () => {
    handler = (_request, response) => {
      response.writeHead(302, { location: 'http://127.0.0.1:1/steal' });
      response.end();
    };
    await expect(probeOpenAICompatibleModels(baseURL, 'k')).rejects.toMatchObject({
      code: 'CUSTOM_PROVIDER_REDIRECT',
    });
    expect(seen).toHaveLength(1);
  });

  it.each([
    ['not json', 'oops'],
    ['no data array', JSON.stringify({ models: [] })],
    ['non-string ids', JSON.stringify({ data: [{ id: 1 }] })],
  ])('rejects %s', async (_label, body) => {
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    };
    await expect(probeOpenAICompatibleModels(baseURL)).rejects.toMatchObject({
      code: 'CUSTOM_PROVIDER_BAD_RESPONSE',
    });
  });

  it('rejects bodies over the size cap', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'x'.repeat(2048) }] }));
    };
    await expect(
      probeOpenAICompatibleModels(baseURL, undefined, { maxBytes: 1024 })
    ).rejects.toMatchObject({ code: 'CUSTOM_PROVIDER_BAD_RESPONSE' });
  });

  it('times out', async () => {
    handler = () => undefined; // never answers
    await expect(
      probeOpenAICompatibleModels(baseURL, undefined, { timeoutMs: 100 })
    ).rejects.toMatchObject({ code: 'CUSTOM_PROVIDER_TIMEOUT' });
  });

  it('reports unreachable hosts', async () => {
    await expect(probeOpenAICompatibleModels('http://127.0.0.1:1/v1')).rejects.toMatchObject({
      code: 'CUSTOM_PROVIDER_UNREACHABLE',
    });
  });
});

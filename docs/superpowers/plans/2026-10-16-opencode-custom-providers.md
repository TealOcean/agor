# OpenCode Custom Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an Agor user add, edit and remove OpenAI-compatible OpenCode providers (custom base URL, Chat Completions or Responses, optional key, discovered models) from OpenCode's provider settings, and pick their models in sessions.

**Architecture:** Definitions live in OpenCode's global config `<dataHome>/xdg-config/opencode/opencode.json`; keys live in OpenCode's `auth.json` via the OpenCode server's `auth.set`/`auth.remove`. A new runtime module owns the file and the `/models` probe; three new executor operations expose them; a new daemon Feathers service `/opencode-custom-providers` fronts them; the settings UI gets a Custom providers section and form; the model catalog lists custom providers with their models.

**Tech Stack:** TypeScript, Zod 4, Node `fs/promises` + `fetch`, FeathersJS, React 19 + Ant Design, Vitest + Testing Library, Biome, turbo, pnpm 11.17.0.

**Spec:** `docs/superpowers/specs/2026-10-16-opencode-custom-providers-design.md`

## Global Constraints

- Repo `~/dev/agor`, branch `homebase`. Do not rebase or change `3e4589d1` (OpenCode executor env fix).
- pnpm is not installed globally. Use `npx -y pnpm@11.17.0` everywhere this plan says `pnpm` (written as `$PNPM` below; run `export PNPM="npx -y pnpm@11.17.0"` once per shell).
- Local mode only (`simple`/`sandbox`). Hosted (`managed-projection`) returns `Custom providers aren't available in hosted workspaces.`
- ID regex `^[a-z0-9][a-z0-9_-]{0,63}$`; name 1–100 chars; 1–500 unique model IDs of 1–200 chars; base URL `http:`/`https:`, no credentials/query/fragment, trailing `/` stripped.
- API type ↔ npm: `chat-completions` ↔ `@ai-sdk/openai-compatible`, `responses` ↔ `@ai-sdk/openai`.
- Probe: `GET <baseURL>/models`, 10 s timeout, `redirect: 'manual'`, 1 MB body cap, expects `{ data: [{ id }] }`.
- Config writes: atomic (temp file `0600` + `fsync` + `rename`), directories `0700`, never overwrite a non-JSON file, never follow a symlinked `opencode.json`.
- Keys never in `opencode.json`, never in responses (only `credentialPresence`), never in error messages (sanitize with `createOpenCodeSanitizer`).
- Error codes and messages exactly as spec §6 (copied into Task 1's `CUSTOM_PROVIDER_MESSAGES`).
- The daemon must not import `@agor/agentic-tool-opencode/runtime` (filesystem boundary). Shared validation lives in `src/shared/`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Model IDs containing `/`** (oMLX/Hugging Face style, e.g. `mlx-community/Qwen3-Coder-30B`): must save, read back, appear in the catalog and be selectable. Test in Task 2 and Task 4.
- **Base URL entered with a trailing slash** (`http://host:8000/v1/`): must probe `http://host:8000/v1/models`, not `//models`, and be stored without the slash. Test in Task 1 and Task 3.
- **Editing a hand-edited entry** with extra OpenCode fields (`options.headers`, per-model `limit`): Agor's save must keep them. Test in Task 2.
- **Endpoint returns an empty model list** (`{ "data": [] }`): probe returns `[]` and the form says no models were found and to add IDs manually, instead of erroring. Test in Task 3 and Task 6.
- **OpenCode server fails to start during save**: nothing is written to `opencode.json`. Test in Task 4.

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/types/opencode-auth.ts` (modify) | Shared custom-provider types, error codes, request/response shapes; `customProviders` on discovery. |
| `packages/core/src/api/index.ts` (modify) | Typed client for `opencode-custom-providers`. |
| `packages/agentic-tool-opencode/src/shared/custom-provider-schema.ts` (new) | Zod schemas, base-URL normalization, npm mapping, error messages. No I/O. |
| `packages/agentic-tool-opencode/src/shared/index.ts` (modify) | Export the schema module. |
| `packages/agentic-tool-opencode/src/runtime/managed-server.ts` (modify) | Export `ensureOpenCodeConfigDirectory`. |
| `packages/agentic-tool-opencode/src/runtime/custom-providers.ts` (new) | Read/save/remove definitions in `opencode.json`; `CustomProviderError`. |
| `packages/agentic-tool-opencode/src/runtime/custom-provider-probe.ts` (new) | `GET <baseURL>/models` probe. |
| `packages/agentic-tool-opencode/src/runtime/auth-payload.ts` (modify) | Three new operations in the params union. |
| `packages/agentic-tool-opencode/src/runtime/auth-handler.ts` (modify) | Handle new operations; `customProviders` in discovery; custom providers in catalog. |
| `apps/agor-daemon/src/integrations/opencode/custom-providers-service.ts` (new) | Feathers service: validation, mode check, mutation slot, error mapping. |
| `apps/agor-daemon/src/integrations/opencode/index.ts` (modify) | Register the service. |
| `apps/agor-daemon/src/register-hooks.ts`, `utils/realtime-publish.ts`, `utils/realtime-publish-policy.ts` (modify) | Add the path wherever `opencode-auth` is listed. |
| `packages/agentic-tool-opencode/src/ui/OpenCodeCustomProviderForm.tsx` (new) | Add/edit form, discovery merge. |
| `packages/agentic-tool-opencode/src/ui/OpenCodeCustomProviders.tsx` (new) | Section with rows, Add/Edit/Remove. |
| `packages/agentic-tool-opencode/src/ui/OpenCodeProviderSettings.tsx` (modify) | Render the section; hide custom IDs from the built-in list. |

---

### Task 1: Shared types and validation schema

**Files:**
- Modify: `packages/core/src/types/opencode-auth.ts` (append; extend `OpenCodeProviderDiscovery`)
- Create: `packages/agentic-tool-opencode/src/shared/custom-provider-schema.ts`
- Modify: `packages/agentic-tool-opencode/src/shared/index.ts`
- Test: `packages/agentic-tool-opencode/src/shared/custom-provider-schema.test.ts`

**Interfaces:**
- Produces (core types): `OpenCodeCustomProviderApiType`, `OpenCodeCustomProviderModel`, `OpenCodeCustomProvider`, `OpenCodeUnsupportedCustomProvider`, `OpenCodeCustomProviderEntry`, `OpenCodeCustomProviderListing`, `OpenCodeCustomProviderErrorCode`, `OpenCodeCustomProviderProbeRequest`, `OpenCodeCustomProviderProbeResult`, `OpenCodeCustomProviderCreateRequest`, `OpenCodeCustomProviderPatchRequest`; `OpenCodeProviderDiscovery.customProviders?` and `.customProvidersError?`.
- Produces (shared): `CUSTOM_PROVIDER_ID_PATTERN`, `CUSTOM_PROVIDER_NPM`, `apiTypeForNpm(npm: unknown): OpenCodeCustomProviderApiType | undefined`, `normalizeCustomProviderBaseURL(value: string): string`, `CustomProviderSchema`, `CustomProviderPatchSchema`, `CustomProviderBaseURLSchema`, `customProviderValidationMessage(error: z.ZodError): string`, `CUSTOM_PROVIDER_MESSAGES`, `isSupportedCustomProvider(entry): entry is OpenCodeCustomProvider`.

- [ ] **Step 1: Install workspace dependencies (first time only)**

Run: `cd ~/dev/agor && export PNPM="npx -y pnpm@11.17.0" && $PNPM install --frozen-lockfile`
Expected: completes without errors.

Run: `$PNPM --filter @agor/agentic-tool-opencode exec vitest run src/shared`
Expected: existing shared tests PASS (baseline).

- [ ] **Step 2: Add the core types**

Append to `packages/core/src/types/opencode-auth.ts`:

```ts
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

export type OpenCodeCustomProviderEntry = OpenCodeCustomProvider | OpenCodeUnsupportedCustomProvider;

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
```

In the same file, extend `OpenCodeProviderDiscovery`:

```ts
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
```

- [ ] **Step 3: Write the failing schema test**

Create `packages/agentic-tool-opencode/src/shared/custom-provider-schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  apiTypeForNpm,
  CUSTOM_PROVIDER_NPM,
  CustomProviderSchema,
  customProviderValidationMessage,
  normalizeCustomProviderBaseURL,
} from './custom-provider-schema.js';

const valid = {
  id: 'omlx',
  name: 'oMLX (Mac Studio)',
  apiType: 'chat-completions',
  baseURL: 'http://192.168.1.175:8000/v1',
  models: [{ id: 'mlx-community/Qwen3-Coder-30B' }],
};

describe('custom provider schema', () => {
  it('accepts a valid provider, including model IDs with slashes', () => {
    expect(CustomProviderSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    ['http://host:8000/v1/', 'http://host:8000/v1'],
    ['https://host/v1///', 'https://host/v1'],
    ['  http://host:8000/v1  ', 'http://host:8000/v1'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeCustomProviderBaseURL(input)).toBe(expected);
  });

  it.each([
    ['ftp://host/v1', /http or https/],
    ['http://user:pw@host/v1', /credentials/],
    ['http://host/v1?x=1', /query/],
    ['http://host/v1#frag', /query/],
    ['not a url', /valid URL/],
  ])('rejects base URL %s', (input, message) => {
    expect(() => normalizeCustomProviderBaseURL(input)).toThrow(message);
  });

  it.each(['', 'Omlx', '-omlx', 'om lx', 'a'.repeat(65)])('rejects ID %j', (id) => {
    expect(CustomProviderSchema.safeParse({ ...valid, id }).success).toBe(false);
  });

  it('rejects duplicate and empty model lists with a readable message', () => {
    const duplicate = CustomProviderSchema.safeParse({
      ...valid,
      models: [{ id: 'a' }, { id: 'a' }],
    });
    expect(duplicate.success).toBe(false);
    if (!duplicate.success) {
      expect(customProviderValidationMessage(duplicate.error)).toMatch(/models: .*duplicate/i);
    }
    expect(CustomProviderSchema.safeParse({ ...valid, models: [] }).success).toBe(false);
  });

  it('maps API types to npm packages and back', () => {
    expect(CUSTOM_PROVIDER_NPM).toEqual({
      'chat-completions': '@ai-sdk/openai-compatible',
      responses: '@ai-sdk/openai',
    });
    expect(apiTypeForNpm('@ai-sdk/openai')).toBe('responses');
    expect(apiTypeForNpm('@ai-sdk/openai-compatible')).toBe('chat-completions');
    expect(apiTypeForNpm('@ai-sdk/anthropic')).toBeUndefined();
    expect(apiTypeForNpm(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `$PNPM --filter @agor/agentic-tool-opencode exec vitest run src/shared/custom-provider-schema.test.ts`
Expected: FAIL — cannot resolve `./custom-provider-schema.js`.

- [ ] **Step 5: Implement the schema module**

Create `packages/agentic-tool-opencode/src/shared/custom-provider-schema.ts`:

```ts
import type {
  OpenCodeCustomProvider,
  OpenCodeCustomProviderApiType,
  OpenCodeCustomProviderEntry,
  OpenCodeCustomProviderErrorCode,
} from '@agor/core/types';
import { z } from 'zod';

export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const CUSTOM_PROVIDER_NPM = {
  'chat-completions': '@ai-sdk/openai-compatible',
  responses: '@ai-sdk/openai',
} as const satisfies Record<OpenCodeCustomProviderApiType, string>;

/** Fixed user-facing messages (spec §6); `{x}` placeholders are filled by callers. */
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
  unsupportedEdit: "This provider uses an unsupported type; edit opencode.json directly.",
  hosted: "Custom providers aren't available in hosted workspaces.",
} as const;

export type CustomProviderMessageCode = OpenCodeCustomProviderErrorCode;

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
```

Add to `packages/agentic-tool-opencode/src/shared/index.ts` (after the `model-configuration` export block):

```ts
export {
  apiTypeForNpm,
  CUSTOM_PROVIDER_ID_PATTERN,
  CUSTOM_PROVIDER_MESSAGES,
  CUSTOM_PROVIDER_NPM,
  CustomProviderBaseURLSchema,
  CustomProviderPatchSchema,
  CustomProviderSchema,
  customProviderValidationMessage,
  isSupportedCustomProvider,
  normalizeCustomProviderBaseURL,
} from './custom-provider-schema.js';
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `$PNPM --filter @agor/agentic-tool-opencode exec vitest run src/shared/custom-provider-schema.test.ts`
Expected: PASS (all cases).

- [ ] **Step 7: Lint and commit**

Run: `$PNPM exec biome check packages/core/src/types/opencode-auth.ts packages/agentic-tool-opencode/src/shared`
Expected: no errors (run `$PNPM exec biome check --write <files>` for formatting-only issues).

```bash
git add packages/core/src/types/opencode-auth.ts packages/agentic-tool-opencode/src/shared
git commit -m "feat(opencode): shared types and schema for custom providers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Config-file store (`custom-providers.ts`)

**Files:**
- Modify: `packages/agentic-tool-opencode/src/runtime/managed-server.ts` (add an export after `ensureOpenCodeDataHome`)
- Create: `packages/agentic-tool-opencode/src/runtime/custom-providers.ts`
- Test: `packages/agentic-tool-opencode/src/runtime/custom-providers.test.ts`

**Interfaces:**
- Consumes: Task 1 `CUSTOM_PROVIDER_NPM`, `CUSTOM_PROVIDER_MESSAGES`, `apiTypeForNpm`; core types.
- Produces:
  - `ensureOpenCodeConfigDirectory(dataHome: string): Promise<string>` (returns the `xdg-config/opencode` path) in `managed-server.ts`.
  - `class CustomProviderError extends Error { readonly code: OpenCodeCustomProviderErrorCode }`
  - `customProviderConfigPath(dataHome: string): string`
  - `readCustomProviders(dataHome: string): Promise<OpenCodeCustomProviderEntry[]>`
  - `saveCustomProvider(dataHome: string, provider: OpenCodeCustomProvider, options: { create: boolean }): Promise<void>`
  - `removeCustomProvider(dataHome: string, id: string): Promise<void>`

- [ ] **Step 1: Write the failing store test**

Create `packages/agentic-tool-opencode/src/runtime/custom-providers.test.ts`:

```ts
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenCodeCustomProvider } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CustomProviderError,
  customProviderConfigPath,
  readCustomProviders,
  removeCustomProvider,
  saveCustomProvider,
} from './custom-providers.js';
import { ensureOpenCodeDataHome } from './managed-server.js';

let root: string;
let dataHome: string;

const omlx: OpenCodeCustomProvider = {
  id: 'omlx',
  name: 'oMLX (Mac Studio)',
  apiType: 'chat-completions',
  baseURL: 'http://192.168.1.175:8000/v1',
  models: [{ id: 'mlx-community/Qwen3-Coder-30B' }, { id: 'gemma', name: 'Gemma 4' }],
};

async function writeConfig(value: unknown) {
  const path = customProviderConfigPath(dataHome);
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
}

async function readConfig() {
  return JSON.parse(await readFile(customProviderConfigPath(dataHome), 'utf8'));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agor-custom-providers-'));
  dataHome = join(root, 'home', '.local', 'share', 'agor', 'opencode', 'namespace');
  await mkdir(join(root, 'home'), { mode: 0o700 });
  await ensureOpenCodeDataHome(dataHome);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('custom provider store', () => {
  it('returns no providers when opencode.json does not exist', async () => {
    expect(await readCustomProviders(dataHome)).toEqual([]);
  });

  it('round-trips a provider, including slash model IDs, with private permissions', async () => {
    await saveCustomProvider(dataHome, omlx, { create: true });

    expect(await readCustomProviders(dataHome)).toEqual([omlx]);
    expect(await readConfig()).toEqual({
      provider: {
        omlx: {
          npm: '@ai-sdk/openai-compatible',
          name: 'oMLX (Mac Studio)',
          options: { baseURL: 'http://192.168.1.175:8000/v1' },
          models: {
            'mlx-community/Qwen3-Coder-30B': { name: 'mlx-community/Qwen3-Coder-30B' },
            gemma: { name: 'Gemma 4' },
          },
        },
      },
    });
    const file = await lstat(customProviderConfigPath(dataHome));
    expect(file.mode & 0o777).toBe(0o600);
    const dir = await lstat(join(customProviderConfigPath(dataHome), '..'));
    expect(dir.mode & 0o777).toBe(0o700);
  });

  it('maps the responses API type to @ai-sdk/openai', async () => {
    await saveCustomProvider(dataHome, { ...omlx, apiType: 'responses' }, { create: true });
    expect((await readConfig()).provider.omlx.npm).toBe('@ai-sdk/openai');
    expect((await readCustomProviders(dataHome))[0]).toMatchObject({ apiType: 'responses' });
  });

  it('keeps unrelated keys and hand-added fields when editing', async () => {
    await writeConfig({
      $schema: 'https://opencode.ai/config.json',
      theme: 'dark',
      provider: {
        omlx: {
          npm: '@ai-sdk/openai-compatible',
          name: 'old',
          options: { baseURL: 'http://old/v1', headers: { 'X-Test': '1' } },
          models: { gemma: { name: 'Gemma', limit: { context: 32768, output: 4096 } } },
        },
      },
    });

    await saveCustomProvider(dataHome, omlx, { create: false });

    const config = await readConfig();
    expect(config.$schema).toBe('https://opencode.ai/config.json');
    expect(config.theme).toBe('dark');
    expect(config.provider.omlx.options).toEqual({
      baseURL: 'http://192.168.1.175:8000/v1',
      headers: { 'X-Test': '1' },
    });
    expect(config.provider.omlx.models.gemma).toEqual({
      name: 'Gemma 4',
      limit: { context: 32768, output: 4096 },
    });
  });

  it('reports other npm packages as unsupported and refuses to edit them', async () => {
    await writeConfig({
      provider: { claude: { npm: '@ai-sdk/anthropic', name: 'Claude', options: {} } },
    });

    expect(await readCustomProviders(dataHome)).toEqual([
      { id: 'claude', name: 'Claude', npm: '@ai-sdk/anthropic', unsupported: true },
    ]);
    await expect(
      saveCustomProvider(dataHome, { ...omlx, id: 'claude' }, { create: false })
    ).rejects.toMatchObject({ code: 'CUSTOM_PROVIDER_INVALID' });
  });

  it('rejects creating an existing ID and editing or removing a missing one', async () => {
    await saveCustomProvider(dataHome, omlx, { create: true });
    await expect(saveCustomProvider(dataHome, omlx, { create: true })).rejects.toMatchObject({
      code: 'CUSTOM_PROVIDER_ID_TAKEN',
    });
    await expect(
      saveCustomProvider(dataHome, { ...omlx, id: 'other' }, { create: false })
    ).rejects.toMatchObject({ code: 'CUSTOM_PROVIDER_NOT_FOUND' });
    await expect(removeCustomProvider(dataHome, 'other')).rejects.toMatchObject({
      code: 'CUSTOM_PROVIDER_NOT_FOUND',
    });
  });

  it('removes only the named provider', async () => {
    await saveCustomProvider(dataHome, omlx, { create: true });
    await saveCustomProvider(dataHome, { ...omlx, id: 'lab' }, { create: true });
    await removeCustomProvider(dataHome, 'omlx');
    expect((await readCustomProviders(dataHome)).map((entry) => entry.id)).toEqual(['lab']);
  });

  it('never overwrites a file that is not plain JSON', async () => {
    await writeConfig('{ // comment\n "provider": {} }');
    await expect(readCustomProviders(dataHome)).rejects.toBeInstanceOf(CustomProviderError);
    await expect(saveCustomProvider(dataHome, omlx, { create: true })).rejects.toMatchObject({
      code: 'CUSTOM_PROVIDER_CONFIG_UNREADABLE',
    });
    expect(await readFile(customProviderConfigPath(dataHome), 'utf8')).toContain('// comment');
  });

  it('refuses a symlinked opencode.json', async () => {
    const target = join(root, 'elsewhere.json');
    await writeFile(target, '{}');
    await mkdir(join(customProviderConfigPath(dataHome), '..'), { recursive: true, mode: 0o700 });
    await symlink(target, customProviderConfigPath(dataHome));
    await expect(readCustomProviders(dataHome)).rejects.toMatchObject({
      code: 'CUSTOM_PROVIDER_CONFIG_UNREADABLE',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `$PNPM --filter @agor/agentic-tool-opencode exec vitest run src/runtime/custom-providers.test.ts`
Expected: FAIL — cannot resolve `./custom-providers.js`.

- [ ] **Step 3: Export the config-directory helper**

In `packages/agentic-tool-opencode/src/runtime/managed-server.ts`, directly after `ensureOpenCodeDataHome`, add:

```ts
/** Ensures `<dataHome>/xdg-config/opencode` (0700, owned, no symlinks) and returns its path. */
export async function ensureOpenCodeConfigDirectory(dataHome: string): Promise<string> {
  const boundary = resolveOpenCodeNativeBoundary(dataHome);
  await ensureOpenCodeDataHome(boundary.dataHome);
  const xdgConfig = join(boundary.dataHome, 'xdg-config');
  const opencodeConfig = join(xdgConfig, 'opencode');
  await ensureOwnedPrivateDirectory(boundary.homeDir, xdgConfig);
  await ensureOwnedPrivateDirectory(boundary.homeDir, opencodeConfig);
  return opencodeConfig;
}
```

- [ ] **Step 4: Implement the store**

Create `packages/agentic-tool-opencode/src/runtime/custom-providers.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  OpenCodeCustomProvider,
  OpenCodeCustomProviderEntry,
  OpenCodeCustomProviderErrorCode,
} from '@agor/core/types';
import {
  apiTypeForNpm,
  CUSTOM_PROVIDER_MESSAGES,
  CUSTOM_PROVIDER_NPM,
} from '../shared/custom-provider-schema.js';
import { ensureOpenCodeConfigDirectory } from './managed-server.js';

export class CustomProviderError extends Error {
  constructor(
    readonly code: OpenCodeCustomProviderErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'CustomProviderError';
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unreadable(): CustomProviderError {
  return new CustomProviderError(
    'CUSTOM_PROVIDER_CONFIG_UNREADABLE',
    CUSTOM_PROVIDER_MESSAGES.configUnreadable
  );
}

export function customProviderConfigPath(dataHome: string): string {
  return join(dataHome, 'xdg-config', 'opencode', 'opencode.json');
}

async function readConfigDocument(dataHome: string): Promise<JsonRecord> {
  const path = customProviderConfigPath(dataHome);
  try {
    const entry = await lstat(path);
    if (!entry.isFile()) throw unreadable();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw unreadable();
  }
  if (!isRecord(parsed) || (parsed.provider !== undefined && !isRecord(parsed.provider))) {
    throw unreadable();
  }
  return parsed;
}

async function writeConfigDocument(dataHome: string, document: JsonRecord): Promise<void> {
  const directory = await ensureOpenCodeConfigDirectory(dataHome);
  const target = join(directory, 'opencode.json');
  const temporary = join(directory, `opencode.json.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function toEntry(id: string, raw: unknown): OpenCodeCustomProviderEntry {
  const record = isRecord(raw) ? raw : {};
  const name = typeof record.name === 'string' && record.name ? record.name : id;
  const apiType = apiTypeForNpm(record.npm);
  const options = isRecord(record.options) ? record.options : {};
  const baseURL = typeof options.baseURL === 'string' ? options.baseURL : undefined;
  if (!apiType || !baseURL) {
    return { id, name, npm: typeof record.npm === 'string' ? record.npm : '', unsupported: true };
  }
  const models = isRecord(record.models)
    ? Object.entries(record.models).map(([modelId, model]) => {
        const modelName = isRecord(model) && typeof model.name === 'string' ? model.name : '';
        return modelName && modelName !== modelId
          ? { id: modelId, name: modelName }
          : { id: modelId };
      })
    : [];
  return { id, name, apiType, baseURL, models };
}

export async function readCustomProviders(
  dataHome: string
): Promise<OpenCodeCustomProviderEntry[]> {
  const document = await readConfigDocument(dataHome);
  const providers = isRecord(document.provider) ? document.provider : {};
  return Object.entries(providers)
    .map(([id, raw]) => toEntry(id, raw))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function saveCustomProvider(
  dataHome: string,
  provider: OpenCodeCustomProvider,
  options: { create: boolean }
): Promise<void> {
  const document = await readConfigDocument(dataHome);
  const providers: JsonRecord = isRecord(document.provider) ? { ...document.provider } : {};
  const existing = providers[provider.id];
  if (options.create && existing !== undefined) {
    throw new CustomProviderError(
      'CUSTOM_PROVIDER_ID_TAKEN',
      CUSTOM_PROVIDER_MESSAGES.idTaken(provider.id)
    );
  }
  if (!options.create && existing === undefined) {
    throw new CustomProviderError(
      'CUSTOM_PROVIDER_NOT_FOUND',
      CUSTOM_PROVIDER_MESSAGES.notFound(provider.id)
    );
  }
  if (!options.create && 'unsupported' in toEntry(provider.id, existing)) {
    throw new CustomProviderError('CUSTOM_PROVIDER_INVALID', CUSTOM_PROVIDER_MESSAGES.unsupportedEdit);
  }
  const previous = isRecord(existing) ? existing : {};
  const previousOptions = isRecord(previous.options) ? previous.options : {};
  const previousModels = isRecord(previous.models) ? previous.models : {};
  providers[provider.id] = {
    ...previous,
    npm: CUSTOM_PROVIDER_NPM[provider.apiType],
    name: provider.name,
    options: { ...previousOptions, baseURL: provider.baseURL },
    models: Object.fromEntries(
      provider.models.map((model) => {
        const before = isRecord(previousModels[model.id]) ? previousModels[model.id] : {};
        return [model.id, { ...(before as JsonRecord), name: model.name ?? model.id }];
      })
    ),
  };
  await writeConfigDocument(dataHome, { ...document, provider: providers });
}

export async function removeCustomProvider(dataHome: string, id: string): Promise<void> {
  const document = await readConfigDocument(dataHome);
  const providers: JsonRecord = isRecord(document.provider) ? { ...document.provider } : {};
  if (providers[id] === undefined) {
    throw new CustomProviderError('CUSTOM_PROVIDER_NOT_FOUND', CUSTOM_PROVIDER_MESSAGES.notFound(id));
  }
  delete providers[id];
  await writeConfigDocument(dataHome, { ...document, provider: providers });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `$PNPM --filter @agor/agentic-tool-opencode exec vitest run src/runtime/custom-providers.test.ts src/runtime/managed-server.test.ts`
Expected: PASS (new tests and existing managed-server tests).

- [ ] **Step 6: Lint and commit**

Run: `$PNPM exec biome check packages/agentic-tool-opencode/src/runtime/custom-providers.ts packages/agentic-tool-opencode/src/runtime/custom-providers.test.ts packages/agentic-tool-opencode/src/runtime/managed-server.ts`
Expected: no errors.

```bash
git add packages/agentic-tool-opencode/src/runtime/custom-providers.ts packages/agentic-tool-opencode/src/runtime/custom-providers.test.ts packages/agentic-tool-opencode/src/runtime/managed-server.ts
git commit -m "feat(opencode): store custom providers in the global opencode.json

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Model discovery probe (`custom-provider-probe.ts`)

**Files:**
- Create: `packages/agentic-tool-opencode/src/runtime/custom-provider-probe.ts`
- Test: `packages/agentic-tool-opencode/src/runtime/custom-provider-probe.test.ts`

**Interfaces:**
- Consumes: Task 1 `CUSTOM_PROVIDER_MESSAGES`; Task 2 `CustomProviderError`.
- Produces: `probeOpenAICompatibleModels(baseURL: string, apiKey?: string, options?: { timeoutMs?: number; maxBytes?: number }): Promise<string[]>` — returns sorted unique IDs; throws `CustomProviderError` with a probe code.

- [ ] **Step 1: Write the failing probe test**

Create `packages/agentic-tool-opencode/src/runtime/custom-provider-probe.test.ts`:

```ts
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
    await expect(probeOpenAICompatibleModels(baseURL, 'sk-test')).resolves.toEqual(['a/slash', 'b']);
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
    await expect(probeOpenAICompatibleModels(baseURL, undefined, { maxBytes: 1024 })).rejects.toMatchObject({
      code: 'CUSTOM_PROVIDER_BAD_RESPONSE',
    });
  });

  it('times out', async () => {
    handler = () => undefined; // never answers
    await expect(probeOpenAICompatibleModels(baseURL, undefined, { timeoutMs: 100 })).rejects.toMatchObject({
      code: 'CUSTOM_PROVIDER_TIMEOUT',
    });
  });

  it('reports unreachable hosts', async () => {
    await expect(probeOpenAICompatibleModels('http://127.0.0.1:1/v1')).rejects.toMatchObject({
      code: 'CUSTOM_PROVIDER_UNREACHABLE',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `$PNPM --filter @agor/agentic-tool-opencode exec vitest run src/runtime/custom-provider-probe.test.ts`
Expected: FAIL — cannot resolve `./custom-provider-probe.js`.

- [ ] **Step 3: Implement the probe**

Create `packages/agentic-tool-opencode/src/runtime/custom-provider-probe.ts`:

```ts
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
      throw new CustomProviderError(
        'CUSTOM_PROVIDER_BAD_RESPONSE',
        CUSTOM_PROVIDER_MESSAGES.badResponse('response larger than 1 MB')
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

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
      throw new CustomProviderError('CUSTOM_PROVIDER_NO_MODEL_LIST', CUSTOM_PROVIDER_MESSAGES.noModelList);
    }
    if (!response.ok) {
      throw new CustomProviderError(
        'CUSTOM_PROVIDER_BAD_RESPONSE',
        CUSTOM_PROVIDER_MESSAGES.badResponse(`HTTP ${response.status}`)
      );
    }
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
      throw new CustomProviderError(
        'CUSTOM_PROVIDER_BAD_RESPONSE',
        CUSTOM_PROVIDER_MESSAGES.badResponse('not JSON')
      );
    }
    const data = (body as { data?: unknown })?.data;
    if (
      !Array.isArray(data) ||
      data.some((item) => typeof (item as { id?: unknown })?.id !== 'string')
    ) {
      throw new CustomProviderError(
        'CUSTOM_PROVIDER_BAD_RESPONSE',
        CUSTOM_PROVIDER_MESSAGES.badResponse('expected { data: [{ id }] }')
      );
    }
    return [...new Set(data.map((item) => (item as { id: string }).id))].sort((a, b) =>
      a.localeCompare(b)
    );
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `$PNPM --filter @agor/agentic-tool-opencode exec vitest run src/runtime/custom-provider-probe.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Lint and commit**

Run: `$PNPM exec biome check packages/agentic-tool-opencode/src/runtime/custom-provider-probe.ts packages/agentic-tool-opencode/src/runtime/custom-provider-probe.test.ts`

```bash
git add packages/agentic-tool-opencode/src/runtime/custom-provider-probe.ts packages/agentic-tool-opencode/src/runtime/custom-provider-probe.test.ts
git commit -m "feat(opencode): probe OpenAI-compatible /models for custom providers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Executor operations, discovery and catalog

**Files:**
- Modify: `packages/agentic-tool-opencode/src/runtime/auth-payload.ts`
- Modify: `packages/agentic-tool-opencode/src/runtime/auth-handler.ts`
- Test: `packages/agentic-tool-opencode/src/runtime/auth-handler.custom-providers.test.ts`

**Interfaces:**
- Consumes: Task 1 `CustomProviderSchema`, `CUSTOM_PROVIDER_MESSAGES`, `isSupportedCustomProvider`; Task 2 store + `CustomProviderError`; Task 3 probe; existing `withFreshClient`, `readConfigurationSnapshot`, `savedCredentialProviderIds`, `createOpenCodeSanitizer`.
- Produces:
  - Executor params: `{ operation: 'save-custom-provider'; create: boolean; provider: OpenCodeCustomProvider; apiKey?: string; clearApiKey?: boolean }`, `{ operation: 'remove-custom-provider'; providerId: string }`, `{ operation: 'probe-custom-provider-models'; baseURL: string; apiKey?: string; providerId?: string }`.
  - Results: save/remove → `{ success: true, data: OpenCodeProviderDiscovery }`; probe → `{ success: true, data: { models: string[] } }`; known failures → `{ success: false, error: { code: OpenCodeCustomProviderErrorCode, message } }`.
  - `OpenCodeAuthRuntimeDependencies.customProviders?: OpenCodeCustomProviderRuntime` where `OpenCodeCustomProviderRuntime = { read; save; remove; probe }` (signatures of Tasks 2–3).
  - Discovery gains `customProviders` (with `credentialPresence`) or `customProvidersError`; `read-model-catalog` appends supported custom providers with models.

- [ ] **Step 1: Write the failing handler test**

Create `packages/agentic-tool-opencode/src/runtime/auth-handler.custom-providers.test.ts`:

```ts
import type { OpenCodeCustomProvider } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleOpenCodeAuth, type OpenCodeAuthPayload } from './auth-handler.js';
import { CustomProviderError } from './custom-providers.js';

const fs = vi.hoisted(() => ({ readAuthFile: vi.fn() }));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: fs.readAuthFile };
});

const sdk = vi.hoisted(() => ({ clients: [] as unknown[] }));
vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: vi.fn(() => sdk.clients.shift()),
}));

const DATA_HOME = '/home/alice/.local/share/agor/opencode/opaque';
const omlx: OpenCodeCustomProvider = {
  id: 'omlx',
  name: 'oMLX',
  apiType: 'chat-completions',
  baseURL: 'http://192.168.1.175:8000/v1',
  models: [{ id: 'mlx-community/Qwen3-Coder-30B' }],
};

const store = {
  read: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  probe: vi.fn(),
};
const runtime = {
  ensureOpenCodeDataHome: vi.fn(async () => undefined),
  verifyOpenCodeAuthFileBoundary: vi.fn(async () => undefined),
  startManagedOpenCodeServer: vi.fn(),
  customProviders: store,
};

function fakeClient(providerIds: string[] = ['openai']) {
  return {
    auth: {
      set: vi.fn(async () => ({ data: true })),
      remove: vi.fn(async () => ({ data: true })),
    },
    provider: {
      list: vi.fn(async () => ({
        data: { all: providerIds.map((id) => ({ id, name: id })), connected: [], default: {} },
      })),
      auth: vi.fn(async () => ({ data: {} })),
    },
    config: {
      providers: vi.fn(async () => ({ data: { providers: [], default: {} } })),
      get: vi.fn(async () => ({ data: {} })),
    },
    instance: { dispose: vi.fn(async () => ({ data: true })) },
  };
}

function run(params: OpenCodeAuthPayload['params']) {
  return handleOpenCodeAuth({ command: 'opencode.auth', dataHome: DATA_HOME, params }, {}, runtime as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AGOR_MANAGED_AGENTIC_TOOLS', '0');
  sdk.clients = [];
  fs.readAuthFile.mockResolvedValue('{}');
  store.read.mockResolvedValue([omlx]);
  store.save.mockResolvedValue(undefined);
  store.remove.mockResolvedValue(undefined);
  runtime.startManagedOpenCodeServer.mockResolvedValue({
    baseUrl: 'http://127.0.0.1:1234',
    authorization: 'Basic synthetic',
    sanitizer: { text: (value: string) => value, error: (value: unknown) => value as Error },
    close: vi.fn(async () => undefined),
  });
});

describe('custom provider executor operations', () => {
  it('saves the definition, then the key, and returns discovery with custom providers', async () => {
    const client = fakeClient();
    sdk.clients.push(client);
    fs.readAuthFile.mockResolvedValue(JSON.stringify({ omlx: { type: 'api', key: 'sk-secret' } }));

    const result = await run({ operation: 'save-custom-provider', create: true, provider: omlx, apiKey: 'sk-secret' });

    expect(store.save).toHaveBeenCalledWith(DATA_HOME, omlx, { create: true });
    expect(client.auth.set).toHaveBeenCalledWith({
      providerID: 'omlx',
      auth: { type: 'api', key: 'sk-secret' },
    });
    expect(store.save.mock.invocationCallOrder[0]).toBeLessThan(
      client.auth.set.mock.invocationCallOrder[0]
    );
    expect(result).toMatchObject({
      success: true,
      data: { customProviders: [{ ...omlx, credentialPresence: 'present' }] },
    });
    expect(JSON.stringify(result)).not.toContain('sk-secret');
  });

  it('rejects an ID OpenCode already has before writing anything', async () => {
    sdk.clients.push(fakeClient(['openai', 'lmstudio']));
    const result = await run({
      operation: 'save-custom-provider',
      create: true,
      provider: { ...omlx, id: 'lmstudio' },
    });
    expect(result).toEqual({
      success: false,
      error: { code: 'CUSTOM_PROVIDER_ID_TAKEN', message: 'OpenCode already has a provider with ID lmstudio.' },
    });
    expect(store.save).not.toHaveBeenCalled();
  });

  it('keeps the definition and reports KEY_NOT_SAVED when the key cannot be stored', async () => {
    const client = fakeClient();
    client.auth.set.mockRejectedValue(new Error('boom sk-secret'));
    sdk.clients.push(client);
    const result = await run({ operation: 'save-custom-provider', create: true, provider: omlx, apiKey: 'sk-secret' });
    expect(store.save).toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: { code: 'CUSTOM_PROVIDER_KEY_NOT_SAVED', message: "Saved, but the API key couldn't be stored. Try again." },
    });
  });

  it('writes nothing when the OpenCode server cannot start', async () => {
    runtime.startManagedOpenCodeServer.mockRejectedValue(new Error('spawn failed'));
    const result = await run({ operation: 'save-custom-provider', create: true, provider: omlx });
    expect(store.save).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, error: { code: 'OPENCODE_AUTH_FAILED' } });
  });

  it('clears a saved key on edit when asked', async () => {
    const client = fakeClient(['openai', 'omlx']);
    sdk.clients.push(client);
    await run({ operation: 'save-custom-provider', create: false, provider: omlx, clearApiKey: true });
    expect(client.provider.list).not.toHaveBeenCalled();
    expect(client.auth.remove).toHaveBeenCalledWith({ providerID: 'omlx' });
  });

  it('passes store errors through as structured failures', async () => {
    sdk.clients.push(fakeClient());
    store.save.mockRejectedValue(new CustomProviderError('CUSTOM_PROVIDER_CONFIG_UNREADABLE', "opencode.json isn't plain JSON; fix or remove it."));
    const result = await run({ operation: 'save-custom-provider', create: true, provider: omlx });
    expect(result).toMatchObject({ success: false, error: { code: 'CUSTOM_PROVIDER_CONFIG_UNREADABLE' } });
  });

  it('removes the definition and its saved key', async () => {
    const client = fakeClient(['openai', 'omlx']);
    sdk.clients.push(client);
    fs.readAuthFile.mockResolvedValue(JSON.stringify({ omlx: { type: 'api', key: 'k' } }));
    store.read.mockResolvedValue([]);
    const result = await run({ operation: 'remove-custom-provider', providerId: 'omlx' });
    expect(store.remove).toHaveBeenCalledWith(DATA_HOME, 'omlx');
    expect(client.auth.remove).toHaveBeenCalledWith({ providerID: 'omlx' });
    expect(result).toMatchObject({ success: true, data: { customProviders: [] } });
  });

  it('probes with the saved key when none is supplied, without returning it', async () => {
    fs.readAuthFile.mockResolvedValue(JSON.stringify({ omlx: { type: 'api', key: 'sk-saved' } }));
    store.probe.mockResolvedValue(['a', 'b']);
    const result = await run({ operation: 'probe-custom-provider-models', baseURL: omlx.baseURL, providerId: 'omlx' });
    expect(store.probe).toHaveBeenCalledWith(omlx.baseURL, 'sk-saved');
    expect(result).toEqual({ success: true, data: { models: ['a', 'b'] } });
  });

  it('redacts the key from probe error messages', async () => {
    store.probe.mockRejectedValue(new CustomProviderError('CUSTOM_PROVIDER_UNREACHABLE', "Couldn't reach http://h (sk-typed)."));
    const result = await run({ operation: 'probe-custom-provider-models', baseURL: 'http://h', apiKey: 'sk-typed' });
    expect(result).toMatchObject({ success: false, error: { code: 'CUSTOM_PROVIDER_UNREACHABLE' } });
    expect(JSON.stringify(result)).not.toContain('sk-typed');
  });

  it('adds supported custom providers and their models to the model catalog', async () => {
    store.read.mockResolvedValue([
      omlx,
      { id: 'claude-proxy', name: 'Claude proxy', npm: '@ai-sdk/anthropic', unsupported: true },
    ]);
    const result = await run({ operation: 'read-model-catalog' });
    expect(runtime.startManagedOpenCodeServer).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      data: {
        providers: expect.arrayContaining([
          {
            id: 'omlx',
            name: 'oMLX',
            availableForSelection: true,
            models: [
              { id: 'mlx-community/Qwen3-Coder-30B', name: 'mlx-community/Qwen3-Coder-30B', status: 'active' },
            ],
          },
        ]),
      },
    });
    const ids = (result as { data: { providers: Array<{ id: string }> } }).data.providers.map((p) => p.id);
    expect(ids).not.toContain('claude-proxy');
  });

  it('falls back to the curated catalog when opencode.json is unreadable', async () => {
    store.read.mockRejectedValue(new CustomProviderError('CUSTOM_PROVIDER_CONFIG_UNREADABLE', 'x'));
    const result = await run({ operation: 'read-model-catalog' });
    expect(result).toMatchObject({ success: true, data: { providers: expect.arrayContaining([expect.objectContaining({ id: 'openai' })]) } });
  });

  it('reports an unreadable opencode.json in discovery instead of failing', async () => {
    sdk.clients.push(fakeClient());
    store.read.mockRejectedValue(new CustomProviderError('CUSTOM_PROVIDER_CONFIG_UNREADABLE', "opencode.json isn't plain JSON; fix or remove it."));
    const result = await run({ operation: 'discover' });
    expect(result).toMatchObject({
      success: true,
      data: { customProvidersError: "opencode.json isn't plain JSON; fix or remove it." },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `$PNPM --filter @agor/agentic-tool-opencode exec vitest run src/runtime/auth-handler.custom-providers.test.ts`
Expected: FAIL — the payload schema rejects the new operations (`Invalid input`/type errors) and `customProviders` is missing from discovery.

- [ ] **Step 3: Extend the payload schema**

In `packages/agentic-tool-opencode/src/runtime/auth-payload.ts`, add the import and three union members:

```ts
import { z } from 'zod';
import { CustomProviderBaseURLSchema, CustomProviderSchema } from '../shared/custom-provider-schema.js';

export const OpenCodeAuthParamsSchema = z.discriminatedUnion('operation', [
  // ...existing members unchanged...
  z.object({
    operation: z.literal('save-custom-provider'),
    create: z.boolean(),
    provider: CustomProviderSchema,
    apiKey: z.string().trim().min(1).optional(),
    clearApiKey: z.boolean().optional(),
  }),
  z.object({
    operation: z.literal('remove-custom-provider'),
    providerId: z.string().trim().min(1).max(64),
  }),
  z.object({
    operation: z.literal('probe-custom-provider-models'),
    baseURL: CustomProviderBaseURLSchema,
    apiKey: z.string().trim().min(1).optional(),
    providerId: z.string().trim().min(1).max(64).optional(),
  }),
]);
```

- [ ] **Step 4: Wire the store into the handler's runtime dependencies**

In `packages/agentic-tool-opencode/src/runtime/auth-handler.ts`:

```ts
import type {
  OpenCodeCustomProviderEntry,
  OpenCodeCustomProviderErrorCode,
  // ...existing type imports...
} from '@agor/core/types';
import { CUSTOM_PROVIDER_MESSAGES, isSupportedCustomProvider } from '../shared/custom-provider-schema.js';
import { probeOpenAICompatibleModels } from './custom-provider-probe.js';
import {
  CustomProviderError,
  readCustomProviders,
  removeCustomProvider,
  saveCustomProvider,
} from './custom-providers.js';
import { createOpenCodeSanitizer } from './managed-server.js';

export interface OpenCodeCustomProviderRuntime {
  read: typeof readCustomProviders;
  save: typeof saveCustomProvider;
  remove: typeof removeCustomProvider;
  probe: typeof probeOpenAICompatibleModels;
}

const DEFAULT_CUSTOM_PROVIDER_RUNTIME: OpenCodeCustomProviderRuntime = {
  read: readCustomProviders,
  save: saveCustomProvider,
  remove: removeCustomProvider,
  probe: probeOpenAICompatibleModels,
};

export interface OpenCodeAuthRuntimeDependencies {
  ensureOpenCodeDataHome: typeof defaultEnsureOpenCodeDataHome;
  startManagedOpenCodeServer: typeof defaultStartManagedOpenCodeServer;
  verifyOpenCodeAuthFileBoundary: typeof defaultVerifyOpenCodeAuthFileBoundary;
  /** Fork: custom provider store; defaults to the real file store and probe. */
  customProviders?: OpenCodeCustomProviderRuntime;
}

function customProviderRuntime(runtime: OpenCodeAuthRuntimeDependencies) {
  return runtime.customProviders ?? DEFAULT_CUSTOM_PROVIDER_RUNTIME;
}

type CustomProviderFailure = { code: OpenCodeCustomProviderErrorCode; message: string };
type CustomProviderOutcome<T> = { ok: true; value: T } | { ok: false; failure: CustomProviderFailure };

function customProviderFailure(
  failure: CustomProviderFailure,
  secrets: readonly unknown[]
): { success: false; error: CustomProviderFailure } {
  return {
    success: false,
    error: { code: failure.code, message: createOpenCodeSanitizer(secrets).text(failure.message) },
  };
}

async function readCustomProvidersSafely(
  dataHome: string,
  runtime: OpenCodeAuthRuntimeDependencies
): Promise<{ entries: OpenCodeCustomProviderEntry[]; error?: string }> {
  try {
    return { entries: await customProviderRuntime(runtime).read(dataHome) };
  } catch (error) {
    if (error instanceof CustomProviderError) return { entries: [], error: error.message };
    throw error;
  }
}

async function savedApiKey(dataHome: string, providerId: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(dataHome, 'opencode', 'auth.json'), 'utf8')) as Record<
      string,
      { type?: unknown; key?: unknown }
    >;
    const entry = parsed?.[providerId];
    return entry?.type === 'api' && typeof entry.key === 'string' ? entry.key : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 5: Add custom providers to discovery and the catalog**

Change `readConfigurationSnapshot` to take the runtime and attach custom providers (keep everything it already computes):

```ts
async function readConfigurationSnapshot(
  client: V2Client,
  dataHome: string,
  directory: string,
  runtime: OpenCodeAuthRuntimeDependencies = DEFAULT_AUTH_RUNTIME
): Promise<OpenCodeProviderDiscovery> {
  // ...existing body up to the final return...
  const custom = await readCustomProvidersSafely(dataHome, runtime);
  return {
    runtime: 'available',
    runtimeVersion: OPENCODE_VERSION,
    ...(projectConfigured ? { projectConfigured } : {}),
    ...(suggestedSelection ? { suggestedSelection } : {}),
    providers,
    customProviders: custom.entries.map((entry) => ({
      ...entry,
      credentialPresence: credentialPresence(credentialProviderIds, entry.id),
    })),
    ...(custom.error ? { customProvidersError: custom.error } : {}),
  };
}
```

Update its existing callers to pass `runtime` as the fourth argument (`discover`, the `connect-api-key`/`disconnect` path, and the OAuth completion path — search the file for `readConfigurationSnapshot(`).

Replace `discoverModels`:

```ts
async function discoverModels(
  dataHome: string,
  runtime = DEFAULT_AUTH_RUNTIME
): Promise<OpenCodeModelCatalog> {
  await runtime.ensureOpenCodeDataHome(dataHome);
  await runtime.verifyOpenCodeAuthFileBoundary(dataHome, { allowMissing: true });
  const catalog = createOpenCodeKnownModelCatalog(await savedCredentialProviderIds(dataHome));
  const custom = await readCustomProvidersSafely(dataHome, runtime);
  if (custom.error) console.warn(`[OpenCode] Custom providers unavailable: ${custom.error}`);
  const supported = custom.entries.filter(isSupportedCustomProvider);
  const customIds = new Set(supported.map((provider) => provider.id));
  return {
    runtimeVersion: OPENCODE_VERSION,
    ...catalog,
    providers: [
      ...catalog.providers.filter((provider) => !customIds.has(provider.id)),
      ...supported.map((provider) => ({
        id: provider.id,
        name: provider.name,
        availableForSelection: true,
        models: provider.models.map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
          status: 'active' as const,
        })),
      })),
    ],
  };
}
```

- [ ] **Step 6: Implement the three operations**

Add these functions above `handleOpenCodeAuth`:

```ts
async function saveCustomProviderOperation(
  payload: OpenCodeAuthPayload & { params: { operation: 'save-custom-provider' } },
  runtime: OpenCodeAuthRuntimeDependencies
) {
  const { dataHome } = payload;
  const { create, provider, apiKey, clearApiKey } = payload.params;
  const secrets = [apiKey ?? ''];
  if (apiKey && clearApiKey) {
    return customProviderFailure(
      { code: 'CUSTOM_PROVIDER_INVALID', message: 'Choose either a new API key or Clear key, not both.' },
      secrets
    );
  }
  const store = customProviderRuntime(runtime);
  const outcome = await withFreshClient<CustomProviderOutcome<OpenCodeProviderDiscovery>>(
    dataHome,
    secrets,
    async (client) => {
      if (create) {
        const listed = await client.provider.list({ directory: dataHome });
        if (listed.error || !listed.data) throw new Error('OpenCode provider list unavailable');
        if (listed.data.all.some((existing) => existing.id === provider.id)) {
          return {
            ok: false,
            failure: { code: 'CUSTOM_PROVIDER_ID_TAKEN', message: CUSTOM_PROVIDER_MESSAGES.idTaken(provider.id) },
          };
        }
      }
      try {
        await store.save(dataHome, provider, { create });
      } catch (error) {
        if (error instanceof CustomProviderError) {
          return { ok: false, failure: { code: error.code, message: error.message } };
        }
        throw error;
      }
      if (apiKey || clearApiKey) {
        try {
          const response = apiKey
            ? await client.auth.set({ providerID: provider.id, auth: { type: 'api', key: apiKey } })
            : await client.auth.remove({ providerID: provider.id });
          if (response.error || response.data !== true) throw new Error('auth mutation rejected');
          await runtime.verifyOpenCodeAuthFileBoundary(dataHome, { allowMissing: !apiKey });
        } catch {
          return {
            ok: false,
            failure: { code: 'CUSTOM_PROVIDER_KEY_NOT_SAVED', message: CUSTOM_PROVIDER_MESSAGES.keyNotSaved },
          };
        }
      }
      return { ok: true, value: await readConfigurationSnapshot(client, dataHome, dataHome, runtime) };
    },
    dataHome,
    runtime
  );
  return outcome.ok ? { success: true, data: outcome.value } : customProviderFailure(outcome.failure, secrets);
}

async function removeCustomProviderOperation(
  payload: OpenCodeAuthPayload & { params: { operation: 'remove-custom-provider' } },
  runtime: OpenCodeAuthRuntimeDependencies
) {
  const { dataHome } = payload;
  const { providerId } = payload.params;
  const store = customProviderRuntime(runtime);
  const outcome = await withFreshClient<CustomProviderOutcome<OpenCodeProviderDiscovery>>(
    dataHome,
    [],
    async (client) => {
      try {
        await store.remove(dataHome, providerId);
      } catch (error) {
        if (error instanceof CustomProviderError) {
          return { ok: false, failure: { code: error.code, message: error.message } };
        }
        throw error;
      }
      if ((await savedCredentialProviderIds(dataHome))?.has(providerId)) {
        // A key left behind is harmless and stays removable from the provider list.
        await client.auth.remove({ providerID: providerId }).catch(() => undefined);
      }
      return { ok: true, value: await readConfigurationSnapshot(client, dataHome, dataHome, runtime) };
    },
    dataHome,
    runtime
  );
  return outcome.ok ? { success: true, data: outcome.value } : customProviderFailure(outcome.failure, []);
}

async function probeCustomProviderOperation(
  payload: OpenCodeAuthPayload & { params: { operation: 'probe-custom-provider-models' } },
  runtime: OpenCodeAuthRuntimeDependencies
) {
  const { dataHome } = payload;
  const { baseURL, providerId } = payload.params;
  let apiKey = payload.params.apiKey;
  if (!apiKey && providerId) {
    await runtime.verifyOpenCodeAuthFileBoundary(dataHome, { allowMissing: true });
    apiKey = await savedApiKey(dataHome, providerId);
  }
  try {
    const models = await customProviderRuntime(runtime).probe(baseURL, apiKey);
    return { success: true, data: { models } };
  } catch (error) {
    if (error instanceof CustomProviderError) {
      return customProviderFailure({ code: error.code, message: error.message }, [apiKey ?? '']);
    }
    throw error;
  }
}
```

Inside `handleOpenCodeAuth`'s `try`, before the existing `connect-oauth` check, dispatch:

```ts
    if (payload.params.operation === 'save-custom-provider') {
      return await saveCustomProviderOperation(payload as never, runtime);
    }
    if (payload.params.operation === 'remove-custom-provider') {
      return await removeCustomProviderOperation(payload as never, runtime);
    }
    if (payload.params.operation === 'probe-custom-provider-models') {
      return await probeCustomProviderOperation(payload as never, runtime);
    }
```

Also update the `discover` branch to pass `runtime` through (already does) and make sure the generic `connect-api-key`/`disconnect` code after it is only reached for those two operations (add `if (payload.params.operation !== 'connect-api-key' && payload.params.operation !== 'disconnect') throw new Error('Unsupported OpenCode operation');` before `const { providerId } = payload.params;` so TypeScript narrows correctly).

- [ ] **Step 7: Run the new and existing handler tests**

Run: `$PNPM --filter @agor/agentic-tool-opencode exec vitest run src/runtime/auth-handler.custom-providers.test.ts src/runtime/auth-handler.integration.test.ts src/runtime/auth-handler.test.ts src/runtime/auxiliary-adapter.test.ts`
Expected: PASS. If an existing integration test now fails only because discovery gained `customProviders: []`, change that assertion to `expect.objectContaining` or add `customProviders: []` to its expected object — do not change behaviour.

- [ ] **Step 8: Typecheck the package, lint, commit**

Run: `$PNPM --filter @agor/agentic-tool-opencode typecheck`
Expected: no errors.
Run: `$PNPM exec biome check packages/agentic-tool-opencode/src/runtime`

```bash
git add packages/agentic-tool-opencode/src/runtime
git commit -m "feat(opencode): executor operations for custom providers

Save, remove and probe custom providers; list them in discovery and in
the session model catalog.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Daemon service and registration

**Files:**
- Create: `apps/agor-daemon/src/integrations/opencode/custom-providers-service.ts`
- Modify: `apps/agor-daemon/src/integrations/opencode/index.ts`
- Modify: `apps/agor-daemon/src/register-hooks.ts` (`TENANT_IDENTITY_ONLY_SERVICE_PATHS`, `CONSTRAINED_HA_PROCESS_AFFINE_SERVICE_GATES`)
- Modify: `apps/agor-daemon/src/utils/realtime-publish.ts` (`REDIS_FEATHERS_DENIED_PATHS`)
- Modify: `apps/agor-daemon/src/utils/realtime-publish-policy.ts`
- Modify: `packages/core/src/api/index.ts`
- Test: `apps/agor-daemon/src/integrations/opencode/custom-providers-service.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas/messages (from `@agor/agentic-tool-opencode`), Task 4 executor params/results; existing `resolveAuthenticatedOpenCodeSubjectContext`, `startOpenCodeExecutorInvocation`, `inOpenCodeNativeStateMutationSlot`, `blockOpenCodeNativeStateNamespace`, `resolveOpenCodeCapabilities`.
- Produces: Feathers path `opencode-custom-providers`:
  - `create({ probe: { baseURL, apiKey?, providerId? } }) → { models: string[] }`
  - `create({ provider, apiKey? }) → OpenCodeProviderSettings`
  - `patch(id, { provider, apiKey?, clearApiKey? }) → OpenCodeProviderSettings`
  - `remove(id) → OpenCodeProviderSettings`
  - Errors: `BadRequest(message, { code })` for `CUSTOM_PROVIDER_*`.
  - Client typing `service(path: 'opencode-custom-providers'): OpenCodeCustomProvidersService`.

- [ ] **Step 1: Write the failing service test**

Create `apps/agor-daemon/src/integrations/opencode/custom-providers-service.test.ts`:

```ts
import { isTenantAgenticToolEnabled, loadConfigSync } from '@agor/core/config';
import { runWithTenantContext, UsersRepository } from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodeCustomProvidersService } from './custom-providers-service';

const containment = vi.hoisted(() => ({ release: vi.fn(), reserve: vi.fn(), verify: vi.fn() }));
vi.mock('../../executor-tracking.js', () => ({
  releaseExecutorContainmentFenceIntent: containment.release,
  reserveExecutorContainmentFence: containment.reserve,
  verifyExecutorContainmentFence: containment.verify,
}));
vi.mock('@agor/core/config', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/config')>('@agor/core/config');
  return { ...actual, isTenantAgenticToolEnabled: vi.fn(), loadConfigSync: vi.fn() };
});
vi.mock('@agor/core/db', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/db')>('@agor/core/db');
  return { ...actual, UsersRepository: vi.fn() };
});
const capabilities = vi.hoisted(() => ({ override: undefined as unknown }));
vi.mock('@agor/agentic-tool-opencode/daemon', async () => {
  const actual = await vi.importActual<typeof import('@agor/agentic-tool-opencode/daemon')>(
    '@agor/agentic-tool-opencode/daemon'
  );
  return {
    ...actual,
    resolveOpenCodeCapabilities: (config: Parameters<typeof actual.resolveOpenCodeCapabilities>[0]) =>
      capabilities.override ?? actual.resolveOpenCodeCapabilities(config),
  };
});

const runCommand = vi.hoisted(() => vi.fn());
const attached = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../utils/spawn-executor.js', () => ({
  requestExecutor: runCommand,
  startContainedExecutorCommand: (payload: unknown, options: unknown) => ({
    result: runCommand(payload, options),
    verifyAbsence: vi.fn(async () => true),
    retainContainmentFence: vi.fn(async () => {
      attached.count += 1;
    }),
  }),
}));

const db = { run: vi.fn() } as never;
const params = { user: { user_id: 'same-user', email: 'u@example.com', role: 'member' } } as never;
const discovery = { runtime: 'available', runtimeVersion: '1.18.31', providers: [], customProviders: [] };
const provider = {
  id: 'omlx',
  name: 'oMLX',
  apiType: 'chat-completions',
  baseURL: 'http://192.168.1.175:8000/v1/',
  models: [{ id: 'gemma' }],
};

function service() {
  return createOpenCodeCustomProvidersService(db, loadConfigSync());
}

function sentRequest() {
  return (runCommand.mock.calls[0]?.[0] as { params: { request: Record<string, unknown> } }).params.request;
}

beforeEach(() => {
  vi.clearAllMocks();
  attached.count = 0;
  containment.release.mockResolvedValue(undefined);
  containment.reserve.mockResolvedValue('intent');
  containment.verify.mockResolvedValue(true);
  vi.mocked(isTenantAgenticToolEnabled).mockResolvedValue(true);
  vi.mocked(loadConfigSync).mockReturnValue({ execution: { unix_user_mode: 'simple' } } as never);
  vi.mocked(UsersRepository).mockImplementation(function repository() {
    return { findById: vi.fn(async () => ({ unix_username: 'alice' })) };
  } as never);
  runCommand.mockResolvedValue({ success: true, data: discovery });
});

describe('OpenCode custom providers service', () => {
  it('requires an authenticated caller', async () => {
    await runWithTenantContext('tenant-a', async () => {
      await expect(service().create({ provider } as never)).rejects.toThrow(/sign in/i);
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('refuses hosted workspaces', async () => {
    capabilities.override = { mode: 'managed-projection' };
    try {
      await runWithTenantContext('tenant-a', async () => {
        await expect(service().create({ provider } as never, params)).rejects.toThrow(
          /hosted workspaces/
        );
      });
      expect(runCommand).not.toHaveBeenCalled();
    } finally {
      capabilities.override = undefined;
    }
  });

  it('validates and normalizes before calling the executor, inside the mutation slot', async () => {
    const result = await runWithTenantContext('tenant-a', () =>
      service().create({ provider, apiKey: ' sk ' } as never, params)
    );
    expect(sentRequest()).toEqual({
      operation: 'save-custom-provider',
      create: true,
      provider: { ...provider, baseURL: 'http://192.168.1.175:8000/v1' },
      apiKey: 'sk',
    });
    expect(result).toMatchObject({ customProviders: [], isolation: { mode: 'simple', boundary: 'logical' } });
  });

  it('rejects invalid input with a field message and no executor call', async () => {
    await runWithTenantContext('tenant-a', async () => {
      await expect(
        service().create({ provider: { ...provider, id: 'Bad ID' } } as never, params)
      ).rejects.toMatchObject({ message: expect.stringMatching(/^id: /), data: { code: 'CUSTOM_PROVIDER_INVALID' } });
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('patches with the ID from the path and supports clearing the key', async () => {
    const { id: _id, ...fields } = provider;
    await runWithTenantContext('tenant-a', () =>
      service().patch('omlx', { provider: fields, clearApiKey: true } as never, params)
    );
    expect(sentRequest()).toMatchObject({
      operation: 'save-custom-provider',
      create: false,
      provider: { id: 'omlx' },
      clearApiKey: true,
    });
  });

  it('removes by ID', async () => {
    await runWithTenantContext('tenant-a', () => service().remove('omlx', params));
    expect(sentRequest()).toEqual({ operation: 'remove-custom-provider', providerId: 'omlx' });
  });

  it('probes without the mutation slot and returns models', async () => {
    runCommand.mockResolvedValue({ success: true, data: { models: ['a'] } });
    const result = await runWithTenantContext('tenant-a', () =>
      service().create({ probe: { baseURL: 'http://h/v1/', providerId: 'omlx' } } as never, params)
    );
    expect(sentRequest()).toEqual({ operation: 'probe-custom-provider-models', baseURL: 'http://h/v1', providerId: 'omlx' });
    expect(result).toEqual({ models: ['a'] });
  });

  it('turns CUSTOM_PROVIDER_* executor errors into BadRequest with the message and code', async () => {
    runCommand.mockResolvedValue({
      success: false,
      error: { code: 'CUSTOM_PROVIDER_UNAUTHORIZED', message: 'The endpoint rejected the API key (401).' },
    });
    await runWithTenantContext('tenant-a', async () => {
      await expect(
        service().create({ probe: { baseURL: 'http://h/v1' } } as never, params)
      ).rejects.toMatchObject({
        message: 'The endpoint rejected the API key (401).',
        data: { code: 'CUSTOM_PROVIDER_UNAUTHORIZED' },
      });
    });
  });

  it('keeps unknown executor errors generic', async () => {
    runCommand.mockResolvedValue({ success: false, error: { code: 'OPENCODE_AUTH_FAILED', message: 'x' } });
    await runWithTenantContext('tenant-a', async () => {
      await expect(service().remove('omlx', params)).rejects.toThrow('OpenCode provider operation failed. Try again.');
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `$PNPM --filter @agor/daemon exec vitest run src/integrations/opencode/custom-providers-service.test.ts`
Expected: FAIL — cannot resolve `./custom-providers-service`.

- [ ] **Step 3: Implement the service**

Create `apps/agor-daemon/src/integrations/opencode/custom-providers-service.ts`:

```ts
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

export class OpenCodeCustomProvidersService {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly config: DeepReadonly<AgorConfig>
  ) {}

  private async context(params?: AuthenticatedParams): Promise<AuthenticatedOpenCodeSubjectContext> {
    const capabilities = resolveOpenCodeCapabilities(this.config);
    if (capabilities.mode === 'unsupported') throw new BadRequest(capabilities.reason.message);
    if (capabilities.mode === 'managed-projection') throw new BadRequest(CUSTOM_PROVIDER_MESSAGES.hosted);
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
      if (typeof code === 'string' && code.startsWith('CUSTOM_PROVIDER_') && result.error?.message) {
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
    request: { provider: OpenCodeCustomProvider; create: boolean; apiKey?: string; clearApiKey?: boolean },
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
    return this.save({ provider: provider as OpenCodeCustomProvider, create: true, apiKey }, params);
  }

  async patch(id: string, data: unknown, params?: AuthenticatedParams): Promise<OpenCodeProviderSettings> {
    const { provider, apiKey, clearApiKey } = parse(PatchSchema, data);
    const full = parse(CustomProviderSchema, { ...provider, id });
    return this.save({ provider: full as OpenCodeCustomProvider, create: false, apiKey, clearApiKey }, params);
  }

  async remove(id: string, params?: AuthenticatedParams): Promise<OpenCodeProviderSettings> {
    const providerId = id?.trim();
    if (!providerId) throw new BadRequest('Provider is required.', { code: 'CUSTOM_PROVIDER_INVALID' });
    const context = await this.context(params);
    const discovery = await inOpenCodeNativeStateMutationSlot(context.namespaceKey, (fence) =>
      this.run<OpenCodeProviderDiscovery>(context, { operation: 'remove-custom-provider', providerId }, fence)
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
```

If `zod` is not a direct dependency of `apps/agor-daemon/package.json`, check with `jq .dependencies.zod apps/agor-daemon/package.json`; if it is `null`, add it with the same version range as `packages/agentic-tool-opencode` (`^4.6.5`) and rerun `$PNPM install`.

- [ ] **Step 4: Run the service test**

Run: `$PNPM --filter @agor/daemon exec vitest run src/integrations/opencode/custom-providers-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the service everywhere `opencode-auth` is registered**

`apps/agor-daemon/src/integrations/opencode/index.ts` — add the import and, after the `/opencode-models` block:

```ts
import { createOpenCodeCustomProvidersService } from './custom-providers-service.js';

  ctx.app.use('/opencode-custom-providers', createOpenCodeCustomProvidersService(ctx.db, ctx.config));
  ctx.app.service('/opencode-custom-providers').hooks({ before: { all: [ctx.requireAuth] } });
  ctx.app.service('/opencode-custom-providers').publish(() => []);
```

`apps/agor-daemon/src/register-hooks.ts`:
- In `TENANT_IDENTITY_ONLY_SERVICE_PATHS`, after `'opencode-models',` add `'opencode-custom-providers',`.
- In `CONSTRAINED_HA_PROCESS_AFFINE_SERVICE_GATES`, after `['opencode-models', 'openCodeAuth'],` add `['opencode-custom-providers', 'openCodeAuth'],`.

`apps/agor-daemon/src/utils/realtime-publish.ts` — in `REDIS_FEATHERS_DENIED_PATHS`, after `'opencode-auth',` add `'opencode-custom-providers',`.

`apps/agor-daemon/src/utils/realtime-publish-policy.ts` — after the `'opencode-models'` entry add:

```ts
  'opencode-custom-providers': { audience: 'none', why: 'Credential control plane.' },
```

`packages/core/src/api/index.ts`:
- Add to the service result map (next to `'opencode-models': OpenCodeModelCatalog;`): `'opencode-custom-providers': OpenCodeProviderSettings;`
- Add after `OpenCodeAuthService`:

```ts
export interface OpenCodeCustomProvidersService {
  create(data: OpenCodeCustomProviderProbeRequest, params?: Params): Promise<OpenCodeCustomProviderProbeResult>;
  create(data: OpenCodeCustomProviderCreateRequest, params?: Params): Promise<OpenCodeProviderSettings>;
  patch(id: string, data: OpenCodeCustomProviderPatchRequest, params?: Params): Promise<OpenCodeProviderSettings>;
  remove(id: string, params?: Params): Promise<OpenCodeProviderSettings>;
}
```

- Add next to `service(path: 'opencode-models')`: `service(path: 'opencode-custom-providers'): OpenCodeCustomProvidersService;`
- Import the four `OpenCodeCustomProvider*` request/result types alongside the existing `OpenCodeProviderSettings` import.

- [ ] **Step 6: Run the daemon tests that cover these registries**

Run: `$PNPM --filter @agor/daemon exec vitest run src/integrations/opencode src/utils/realtime-publish-policy.test.ts src/register-hooks`
Expected: PASS. (If `src/register-hooks*` matches no file, drop it from the command.)

- [ ] **Step 7: Lint and commit**

Run: `$PNPM exec biome check apps/agor-daemon/src/integrations/opencode apps/agor-daemon/src/register-hooks.ts apps/agor-daemon/src/utils/realtime-publish.ts apps/agor-daemon/src/utils/realtime-publish-policy.ts packages/core/src/api/index.ts`

```bash
git add apps/agor-daemon packages/core/src/api/index.ts
git commit -m "feat(opencode): daemon service for custom providers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Custom provider form

**Files:**
- Create: `packages/agentic-tool-opencode/src/ui/OpenCodeCustomProviderForm.tsx`
- Test: `packages/agentic-tool-opencode/src/ui/OpenCodeCustomProviderForm.test.tsx`

**Interfaces:**
- Consumes: Task 1 `CustomProviderSchema`, `CustomProviderPatchSchema`, `customProviderValidationMessage`; Task 5 service `opencode-custom-providers`.
- Produces:
  - `mergeDiscoveredModels(current: FormModel[], discovered: string[], firstDiscovery: boolean): FormModel[]` where `FormModel = { id: string; name?: string; enabled: boolean; isNew: boolean }`.
  - `OpenCodeCustomProviderForm(props: { client: AgorClient; existing?: OpenCodeCustomProvider & { credentialPresence: OpenCodeCredentialPresence }; onSaved: (settings: OpenCodeProviderSettings) => void; onCancel: () => void })`.
  - Accessible labels used by Task 7 tests: `Custom provider ID`, `Display name`, `API type`, `Base URL`, `API key`, `Clear saved key`, buttons `Discover models` / `Refresh models`, `Add model`, input `Model ID to add`, `Save provider`, `Cancel`.

- [ ] **Step 1: Write the failing form test**

Create `packages/agentic-tool-opencode/src/ui/OpenCodeCustomProviderForm.test.tsx`:

```tsx
// @vitest-environment jsdom

import type { AgorClient } from '@agor/core/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { mergeDiscoveredModels, OpenCodeCustomProviderForm } from './OpenCodeCustomProviderForm.js';

function renderForm(service: { create: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> }, existing?: never) {
  const client = { service: vi.fn(() => service) } as unknown as AgorClient;
  const onSaved = vi.fn();
  render(
    <AntApp>
      <OpenCodeCustomProviderForm client={client} existing={existing} onSaved={onSaved} onCancel={vi.fn()} />
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
    fill('Custom provider ID', 'omlx');
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
    fill('Custom provider ID', 'omlx');
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
    expect(screen.getByLabelText('Custom provider ID')).toBeDisabled();
    expect(screen.getByLabelText('API key')).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }));
    await screen.findByLabelText('b');
    expect(service.create).toHaveBeenCalledWith({ probe: { baseURL: 'http://h/v1', providerId: 'omlx' } });
    expect(screen.getByLabelText('b')).not.toBeChecked();
    expect(screen.getByText('new')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Clear saved key'));
    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));
    await waitFor(() =>
      expect(service.patch).toHaveBeenCalledWith('omlx', {
        provider: { name: 'oMLX', apiType: 'responses', baseURL: 'http://h/v1', models: [{ id: 'a' }] },
        clearApiKey: true,
      })
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `$PNPM --filter @agor/agentic-tool-opencode exec vitest run src/ui/OpenCodeCustomProviderForm.test.tsx`
Expected: FAIL — cannot resolve `./OpenCodeCustomProviderForm.js`.

- [ ] **Step 3: Implement the form**

Create `packages/agentic-tool-opencode/src/ui/OpenCodeCustomProviderForm.tsx`:

```tsx
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
  return error instanceof Error && error.message ? error.message : 'OpenCode provider operation failed. Try again.';
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
  const [apiType, setApiType] = useState<OpenCodeCustomProviderApiType>(existing?.apiType ?? 'chat-completions');
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
      <Input aria-label="Custom provider ID" placeholder="omlx" value={id} disabled={Boolean(existing)} onChange={(event) => setId(event.target.value)} />
      <Input aria-label="Display name" placeholder="oMLX (Mac Studio)" value={name} onChange={(event) => setName(event.target.value)} />
      <Radio.Group aria-label="API type" value={apiType} onChange={(event) => setApiType(event.target.value)}>
        <Radio value="chat-completions">Chat Completions</Radio>
        <Radio value="responses">Responses</Radio>
      </Radio.Group>
      <Input aria-label="Base URL" placeholder="http://192.168.1.175:8000/v1" value={baseURL} onChange={(event) => setBaseURL(event.target.value)} />
      <Input.Password
        aria-label="API key"
        autoComplete="new-password"
        placeholder={existing?.credentialPresence === 'present' ? 'Saved — leave blank to keep' : 'Optional'}
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
      />
      {existing?.credentialPresence === 'present' && (
        <Checkbox aria-label="Clear saved key" checked={clearApiKey} onChange={(event) => setClearApiKey(event.target.checked)}>
          Clear saved key
        </Checkbox>
      )}
      <Button onClick={() => void discover()} loading={busy} disabled={!baseURL.trim()}>
        {existing ? 'Refresh models' : 'Discover models'}
      </Button>
      {notice && <Typography.Text type="secondary">{notice}</Typography.Text>}
      {models.map((model) => (
        <Checkbox
          key={model.id}
          aria-label={model.id}
          checked={model.enabled}
          onChange={(event) =>
            setModels((current) =>
              current.map((entry) => (entry.id === model.id ? { ...entry, enabled: event.target.checked } : entry))
            )
          }
        >
          {model.name ?? model.id} {model.isNew && <Tag>new</Tag>}
        </Checkbox>
      ))}
      <Space.Compact style={{ width: '100%' }}>
        <Input aria-label="Model ID to add" value={manualModelId} onChange={(event) => setManualModelId(event.target.value)} />
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `$PNPM --filter @agor/agentic-tool-opencode exec vitest run src/ui/OpenCodeCustomProviderForm.test.tsx`
Expected: PASS. If an Ant Design control does not forward `aria-label` to its `<input>` (check `Radio.Group` and `Checkbox`), wrap it in an element carrying the label — `<div role="radiogroup" aria-label="API type">` for the radio group, and for checkboxes pass the label through antd's input props or render the `new` tag outside the `<Checkbox>` so the label text is exactly the model ID. Keep every label string identical to the test.

- [ ] **Step 5: Lint and commit**

Run: `$PNPM exec biome check --write packages/agentic-tool-opencode/src/ui/OpenCodeCustomProviderForm.tsx packages/agentic-tool-opencode/src/ui/OpenCodeCustomProviderForm.test.tsx`

```bash
git add packages/agentic-tool-opencode/src/ui/OpenCodeCustomProviderForm.tsx packages/agentic-tool-opencode/src/ui/OpenCodeCustomProviderForm.test.tsx
git commit -m "feat(opencode): custom provider form with model discovery

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Custom providers section in provider settings

**Files:**
- Create: `packages/agentic-tool-opencode/src/ui/OpenCodeCustomProviders.tsx`
- Modify: `packages/agentic-tool-opencode/src/ui/OpenCodeProviderSettings.tsx`
- Test: `packages/agentic-tool-opencode/src/ui/OpenCodeCustomProviders.test.tsx`
- Test (modify): `packages/agentic-tool-opencode/src/ui/OpenCodeProviderSettings.test.tsx`

**Interfaces:**
- Consumes: Task 6 `OpenCodeCustomProviderForm`; Task 1 `isSupportedCustomProvider`; existing `publishSettings` in `OpenCodeProviderSettings`.
- Produces: `OpenCodeCustomProviders(props: { client: AgorClient; settings: OpenCodeProviderSettings & { runtime: 'available' }; onSettings: (settings: OpenCodeProviderSettings) => void })`.

- [ ] **Step 1: Write the failing section test**

Create `packages/agentic-tool-opencode/src/ui/OpenCodeCustomProviders.test.tsx`:

```tsx
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
    { id: 'claude', name: 'Claude', npm: '@ai-sdk/anthropic', unsupported: true, credentialPresence: 'absent' },
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
    fireEvent.click(within(screen.getByTestId('custom-provider-omlx')).getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Custom provider ID')).toHaveValue('omlx');
  });

  it('removes after confirmation and publishes the new settings', async () => {
    const next = { ...(settings as object), customProviders: [] };
    const service = { remove: vi.fn().mockResolvedValue(next) };
    const { onSettings } = renderSection(service);
    fireEvent.click(within(screen.getByTestId('custom-provider-omlx')).getByRole('button', { name: 'Remove' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove provider' }));
    await waitFor(() => expect(onSettings).toHaveBeenCalledWith(next));
    expect(service.remove).toHaveBeenCalledWith('omlx');
  });

  it('shows the config-file error', () => {
    renderSection({}, { ...(settings as object), customProviders: [], customProvidersError: "opencode.json isn't plain JSON; fix or remove it." } as never);
    expect(screen.getByText("opencode.json isn't plain JSON; fix or remove it.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `$PNPM --filter @agor/agentic-tool-opencode exec vitest run src/ui/OpenCodeCustomProviders.test.tsx`
Expected: FAIL — cannot resolve `./OpenCodeCustomProviders.js`.

- [ ] **Step 3: Implement the section**

Create `packages/agentic-tool-opencode/src/ui/OpenCodeCustomProviders.tsx`:

```tsx
import type { AgorClient } from '@agor/core/client';
import type { OpenCodeCustomProviderListing, OpenCodeProviderSettings } from '@agor/core/types';
import { Alert, Button, List, Popconfirm, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
import { isSupportedCustomProvider } from '../shared/custom-provider-schema.js';
import { OpenCodeCustomProviderForm } from './OpenCodeCustomProviderForm.js';

const API_TYPE_LABEL = { 'chat-completions': 'Chat Completions', responses: 'Responses' } as const;

type AvailableSettings = Extract<OpenCodeProviderSettings, { runtime: 'available' }>;

export function OpenCodeCustomProviders({
  client,
  settings,
  onSettings,
}: {
  client: AgorClient;
  settings: AvailableSettings;
  onSettings: (settings: OpenCodeProviderSettings) => void;
}) {
  const [editing, setEditing] = useState<string | 'new'>();
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
      setError(failure instanceof Error ? failure.message : 'OpenCode provider operation failed. Try again.');
    }
  };

  return (
    <Space orientation="vertical" size="small" style={{ width: '100%' }} data-testid="opencode-custom-providers">
      <Typography.Title level={5} style={{ margin: 0 }}>
        Custom providers
      </Typography.Title>
      {settings.customProvidersError && <Alert type="error" showIcon title={settings.customProvidersError} />}
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
      {editing === 'new' ? (
        <OpenCodeCustomProviderForm client={client} onSaved={saved} onCancel={() => setEditing(undefined)} />
      ) : (
        <Button onClick={() => setEditing('new')}>Add custom provider</Button>
      )}
    </Space>
  );
}
```

- [ ] **Step 4: Run the section test**

Run: `$PNPM --filter @agor/agentic-tool-opencode exec vitest run src/ui/OpenCodeCustomProviders.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing settings-integration test**

Append to `packages/agentic-tool-opencode/src/ui/OpenCodeProviderSettings.test.tsx` (inside the top-level `describe`, reusing `renderSettings` and `createAuthService` from that file):

```tsx
  it('shows custom providers in their own section and not in the built-in list', async () => {
    const withCustom = {
      ...initial,
      providers: [
        ...initial.providers,
        {
          id: 'omlx',
          name: 'oMLX',
          runtimeAvailable: true,
          credentialPresence: 'present',
          models: [],
          authMethods: [],
        },
      ],
      customProviders: [
        {
          id: 'omlx',
          name: 'oMLX',
          apiType: 'chat-completions',
          baseURL: 'http://h/v1',
          models: [{ id: 'a' }],
          credentialPresence: 'present',
        },
      ],
    } as Settings;
    const service = createAuthService({ find: vi.fn().mockResolvedValue(withCustom) });
    renderSettings(service);

    const section = await screen.findByTestId('opencode-custom-providers');
    expect(within(section).getByText('oMLX')).toBeInTheDocument();
    expect(screen.getAllByText('oMLX')).toHaveLength(1);
  });

  it('does not show the custom providers section in hosted workspaces', async () => {
    const hosted = { ...initial, isolation: { mode: 'managed-projection', boundary: 'executor-run' } } as Settings;
    renderSettings(createAuthService({ find: vi.fn().mockResolvedValue(hosted) }));
    await screen.findByText(/Save an API key for a supported provider/);
    expect(screen.queryByTestId('opencode-custom-providers')).toBeNull();
  });
```

Add `within` to that file's `@testing-library/react` import if it is not already imported.

- [ ] **Step 6: Run it to verify it fails**

Run: `$PNPM --filter @agor/agentic-tool-opencode exec vitest run src/ui/OpenCodeProviderSettings.test.tsx`
Expected: FAIL — `opencode-custom-providers` test ID not found.

- [ ] **Step 7: Integrate into the settings panel**

In `packages/agentic-tool-opencode/src/ui/OpenCodeProviderSettings.tsx`:

Add the import:

```tsx
import { OpenCodeCustomProviders } from './OpenCodeCustomProviders.js';
```

Replace the `connectableProviders`/`visibleProviders` derivations so custom IDs are excluded:

```tsx
  const customProviderIds = useMemo(
    () =>
      new Set(
        settings?.runtime === 'available'
          ? (settings.customProviders ?? []).map((provider) => provider.id)
          : []
      ),
    [settings]
  );
  const connectableProviders = useMemo(
    () =>
      settings?.providers.filter(
        (provider) =>
          provider.credentialPresence !== 'present' && !customProviderIds.has(provider.id)
      ) ?? [],
    [settings, customProviderIds]
  );
  const selectedProvider = connectableProviders.find(
    (provider) => provider.id === selectedProviderId
  );
  const visibleProviders =
    settings?.providers.filter(
      (provider) =>
        !customProviderIds.has(provider.id) &&
        (provider.credentialPresence === 'present' ||
          provider.runtimeAvailable ||
          provider.id === selectedProvider?.id)
    ) ?? [];
```

In the returned JSX, directly before the `<Select aria-label="Provider to connect" … />`, insert:

```tsx
      {settings?.runtime === 'available' && settings.isolation.mode !== 'managed-projection' && (
        <OpenCodeCustomProviders client={client} settings={settings} onSettings={publishSettings} />
      )}
```

- [ ] **Step 8: Run all UI tests**

Run: `$PNPM --filter @agor/agentic-tool-opencode exec vitest run src/ui`
Expected: PASS (new and existing UI tests).

- [ ] **Step 9: Lint and commit**

Run: `$PNPM exec biome check --write packages/agentic-tool-opencode/src/ui`

```bash
git add packages/agentic-tool-opencode/src/ui
git commit -m "feat(opencode): custom providers section in provider settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Gates, deploy and live verification

**Files:** none new (fixes only if a gate fails).

**Interfaces:**
- Consumes: everything above.
- Produces: the deployed `agor:latest` image from `homebase`, verified with a mock endpoint and with oMLX.

- [ ] **Step 1: Full package tests**

Run: `$PNPM --filter @agor/agentic-tool-opencode test && $PNPM --filter @agor/core test && $PNPM --filter @agor/daemon exec vitest run src/integrations/opencode src/utils`
Expected: PASS. (`@agor/daemon`'s full suite is large; run it in the background with `$PNPM --filter @agor/daemon test` if time allows and report its result.)

- [ ] **Step 2: Typecheck and lint the workspace**

Run: `$PNPM turbo run typecheck --filter=@agor/agentic-tool-opencode... --filter=@agor/daemon... --filter=@agor/core...`
Expected: no errors.
Run: `$PNPM lint`
Expected: no errors or warnings.

- [ ] **Step 3: Boundary checks**

Run: `$PNPM check:daemon-filesystem-boundaries && $PNPM check:realtime-boundaries && $PNPM check:multitenancy-boundaries`
Expected: all pass. If the filesystem check fails, the daemon is importing `@agor/agentic-tool-opencode/runtime` somewhere — move the import to the shared entry instead of adding an exception.

- [ ] **Step 4: Push and build**

```bash
git push origin homebase
```

Then (Komodo MCP; needs an authenticated session): run build `agor`, wait for `success: true`, then deploy stack `agor`. Wait until `curl -s http://192.168.1.107:3030/health` reports `"status":"ok"` and `"buildSha":"dev"`.

- [ ] **Step 5: Verify the key reaches both API types (mock endpoint)**

Through the Agor UI (the user) or `komodo_exec` on `agor-prod`: start a throwaway Node HTTP server on `127.0.0.1:18080` inside the container that logs method, path and whether `Authorization: Bearer <key>` is present. Add custom provider `mocktest` (Chat Completions, base URL `http://127.0.0.1:18080/v1`, key `sk-mock`, model ID `m1`) in the UI, start an OpenCode session on `mocktest/m1`, send "hi". Then switch it to Responses and repeat.
Expected log: `POST /v1/chat/completions auth=bearer` then `POST /v1/responses auth=bearer`. Remove `mocktest` afterwards and confirm `opencode.json` no longer contains it and `auth.json` has no `mocktest` entry (`jq 'has("mocktest")'` → `false`, never print the file).

- [ ] **Step 6: Verify end to end with oMLX (the user)**

Add `omlx` (base URL `http://192.168.1.175:8000/v1`, the oMLX key), click **Discover models**, keep one coding model, save, start an OpenCode session with it, and run a short prompt. Expected: the model answers; the provider row shows `Key saved` and the model count.

- [ ] **Step 7: Record the outcome**

If any step failed, stop and report with the exact output; do not deploy further changes until it is understood. If all passed, summarize the commits on `homebase` since `afc1b287` and the image deployed.

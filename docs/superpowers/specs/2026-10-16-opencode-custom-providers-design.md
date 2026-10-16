# OpenCode custom providers — design

- **Date:** 2026-10-16
- **Branch:** `TealOcean/agor@homebase` (fork of `preset-io/agor` at `v0.27.0`)
- **Audience:** this fork only (local `simple`/`sandbox` execution). Not intended for upstream.
- **Status:** approved design, awaiting implementation plan

## 1. Goal

Let an Agor user define an OpenAI-compatible OpenCode provider from Agor's UI — for example oMLX
running on another machine on the LAN (`http://192.168.1.175:8000/v1`, API key required) — and then
pick its models in an OpenCode session, without hand-editing OpenCode's config file.

### Success criteria

1. From OpenCode's provider settings, the user can add, edit and remove a custom provider with an
   ID, display name, API type, base URL, optional API key and a model list.
2. Models can be discovered from the endpoint's `/models` list and trimmed, or typed manually.
3. The custom provider's enabled models appear in the session model picker and are selectable.
4. An OpenCode session using such a model sends requests to the configured base URL with the saved
   key, over the chosen API type.
5. The API key is never returned to the browser, written to the config file, or shown in logs or
   error messages.

### Non-goals

- Hosted / multi-tenant (`managed-projection`) mode. It keeps refusing custom endpoints.
- Overriding the base URL of OpenCode's built-in providers (`openai`, `lmstudio`, …).
- Per-provider OpenCode options beyond those listed (headers, context limits, costs, per-model
  options).
- Non-OpenAI-shaped APIs.
- Upstreaming to `preset-io/agor` (their hosted design lists custom endpoints as out of scope).

## 2. Background (verified)

- Agor has no base-URL setting for OpenCode. Claude Code (`ANTHROPIC_BASE_URL`) and Codex
  (`OPENAI_BASE_URL`) have one; OpenCode does not.
- In local mode Agor starts OpenCode with `XDG_CONFIG_HOME=<dataHome>/xdg-config`, where
  `<dataHome>` is the per-user native data home
  `~/.local/share/agor/opencode/<namespace-hash>`. OpenCode reads its global config from
  `<dataHome>/xdg-config/opencode/opencode.json`. The hosted-mode lockdown
  (`OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_PURE`) does not apply to local mode.
- Tested in the deployed container with the bundled OpenCode 1.18.31:
  - A custom provider in the global file is listed by `/config/providers` and `/provider` with
    `source: "config"` and its models.
  - OpenCode merges that file with the `OPENCODE_CONFIG_CONTENT` Agor injects for sessions
    (`agent`, `permission`, `tools`): both sets of keys are present. Sessions need no change.
  - `npm: "@ai-sdk/openai-compatible"` sends `POST <baseURL>/chat/completions`;
    `npm: "@ai-sdk/openai"` sends `POST <baseURL>/responses`. Both use the custom base URL and
    send the key as a bearer token (key supplied inline in that test).
  - OpenCode reports no auth methods for a config-defined provider (`/provider/auth` → `null`), so
    the existing per-method key UI cannot be reused as-is.
- oMLX on the Mac Studio exposes `/v1/models`, `/v1/chat/completions`, `/v1/responses` and
  `/v1/messages` (each `401` without a key; unknown paths `404`).
- Today the session model picker (`read-model-catalog`) lists a curated set
  (`kimi-for-coding`, `openai`, `anthropic`, `opencode`) plus any provider with a saved key, the
  latter with no models.

## 3. User experience

### Provider settings

A **Custom providers** section above the existing built-in provider list:

- Each row shows display name, ID, API type, base URL, number of enabled models and key status
  (`Key saved` / `No key`), with **Edit** and **Remove**.
- Entries in `opencode.json` using an `npm` package other than the two supported ones are shown
  read-only with "Unsupported type — edit `opencode.json` directly"; no Edit or Remove.
- **Add custom provider** opens a form:

| Field | Rules |
|---|---|
| ID | `^[a-z0-9][a-z0-9_-]{0,63}$`. Fixed after creation. Must not match any existing OpenCode provider (built-in or custom). Sessions reference models as `<id>/<model>`. |
| Display name | 1–100 characters. |
| API type | **Chat Completions** (default) or **Responses**. |
| Base URL | `http`/`https`; no credentials, query or fragment; trailing `/` removed. LAN addresses allowed. |
| API key | Optional, write-only. On edit, blank keeps the saved key; a **Clear key** checkbox removes it. |
| Models | **Discover models** fills a checklist from `<baseURL>/models` (all ticked on first discovery). **Add model ID** adds one by hand. On edit, **Refresh** re-discovers: enabled models stay ticked, newly found ones are added unticked and marked *new*, models no longer listed by the endpoint stay as they are. At least one model must be enabled to save. |

- Discovery uses the key typed in the form; if none is typed and the provider has a saved key, it
  uses the saved key (server-side).
- Errors appear inline next to the relevant field (see §6).
- Custom provider IDs are filtered out of the built-in provider list so they are not shown twice.

### Session model picker

Custom providers appear as regular, selectable providers whose model list is their enabled models.
They are selectable with or without a saved key. No exact-ID typing is needed.

## 4. Architecture

```
UI (settings section + form, model picker)
   │  Feathers client
   ▼
Daemon: opencode-custom-providers service  ──►  executor (agentic-tool.invoke, opencode)
   │  auth, mode check, mutation slot                 │
   │                                                   ▼
   │                                   runtime/custom-providers.ts  (file + probe)
   │                                   runtime/auth-handler.ts      (ops, auth.set/remove
   │                                                                  via temporary server)
   ▼                                                   │
Daemon: opencode-models (read-model-catalog) ◄─────────┘ reads opencode.json
```

### 4.1 Storage

- **Definitions:** `<dataHome>/xdg-config/opencode/opencode.json`, key `provider.<id>`:

```json
{
  "provider": {
    "omlx": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "oMLX (Mac Studio)",
      "options": { "baseURL": "http://192.168.1.175:8000/v1" },
      "models": { "qwen3-coder-30b": { "name": "qwen3-coder-30b" } }
    }
  }
}
```

  `npm` is `@ai-sdk/openai-compatible` for API type `chat-completions` and `@ai-sdk/openai` for
  `responses`. Agor treats every `provider` entry in this file as a custom provider. All other
  top-level keys and unknown fields inside an entry are preserved on write.
- **Keys:** OpenCode's own `<dataHome>/opencode/auth.json`, written only through the OpenCode
  server's `auth.set` / `auth.remove` (same as the existing `connect-api-key` / `disconnect`).
  Never in `opencode.json`.

### 4.2 Runtime module — `packages/agentic-tool-opencode/src/runtime/custom-providers.ts` (new)

No UI or daemon dependencies.

- `type CustomProviderApiType = 'chat-completions' | 'responses'`
- `type CustomProvider = { id; name; apiType; baseURL; models: Array<{ id; name? }> }`
- `type CustomProviderEntry = CustomProvider | { id; name; unsupported: true; npm }`
- `readCustomProviders(dataHome): Promise<CustomProviderEntry[]>` — missing file → `[]`;
  file that is not plain JSON → throws `CustomProviderConfigUnreadableError`.
- `saveCustomProvider(dataHome, provider, { create: boolean })` — read, validate, replace one
  entry, write atomically. `create: true` fails if the ID already exists in the file.
- `removeCustomProvider(dataHome, id)` — read, delete one entry, write atomically. Missing ID is
  an error.
- `probeOpenAICompatibleModels(baseURL, apiKey?, options?)` → `string[]` — see §6.
- Writes: ensure `xdg-config` and `xdg-config/opencode` with the existing
  `ensureOwnedPrivateDirectory` (0700, no symlinks, owner check), write `opencode.json.<random>.tmp`
  with mode `0600`, `fsync`, `rename`.

### 4.3 Executor operations — `runtime/auth-payload.ts`, `runtime/auth-handler.ts`

Add to `OpenCodeAuthParamsSchema`:

| Operation | Params | Result |
|---|---|---|
| `save-custom-provider` | `create`, `provider` (§4.2 shape), `apiKey?`, `clearApiKey?` | refreshed discovery |
| `remove-custom-provider` | `providerId` | refreshed discovery |
| `probe-custom-provider-models` | `baseURL`, `apiKey?`, `providerId?` | `{ models: string[] }` |

- **save:** with a temporary OpenCode server (existing `withFreshClient`): when `create`, reject if
  `/provider` lists the ID with a source other than this file; write the definition; then
  `auth.set` (if `apiKey`) or `auth.remove` (if `clearApiKey`); return
  `readConfigurationSnapshot`. Definition first, key second.
- **remove:** delete the definition, then `auth.remove` if a key is saved; return discovery.
- **probe:** if no `apiKey` and `providerId` is given, read that provider's key from `auth.json`
  inside the executor. Never returns the key.
- **discover** (existing) additionally returns `customProviders: CustomProviderEntry[]` with
  `credentialPresence` per entry.
- **read-model-catalog** (existing) appends each supported custom provider as
  `{ id, name, availableForSelection: true, models }`, replacing the bare entry it would
  otherwise add from `auth.json`. On `CustomProviderConfigUnreadableError` it logs a warning and
  returns the current catalog unchanged.

New ops return structured errors (`code` + safe `message`, §6) instead of the existing generic
`OPENCODE_AUTH_FAILED`.

### 4.4 Daemon — `apps/agor-daemon/src/integrations/opencode/custom-providers-service.ts` (new)

Feathers service at `/opencode-custom-providers`, registered next to `/opencode-auth` with the same
`requireAuth` hook and empty `publish`.

- `create(data)`: `data.probe` → probe op; otherwise save with `create: true`.
- `patch(id, data)`: save with `create: false`, ID from the path.
- `remove(id)`: remove op.
- Capability check with `resolveOpenCodeCapabilities`: unsupported → error as today;
  `managed-projection` → `BadRequest('Custom providers aren't available in hosted workspaces.')`.
- Context from `resolveAuthenticatedOpenCodeSubjectContext` (per-user data home, filtered executor
  env including the managed-runtime markers).
- save/remove run inside `inOpenCodeNativeStateMutationSlot`; probe changes nothing and runs
  outside it.
- Executor errors with a known `code` become `BadRequest(message, { code })`; anything else stays
  the existing generic message.
- Responses: save/remove return `OpenCodeProviderSettings` (as `/opencode-auth` does); probe
  returns `{ models }`.

### 4.5 Shared types — `packages/core/src/types/opencode-auth.ts`

- Add `OpenCodeCustomProvider`, `OpenCodeCustomProviderEntry`, `OpenCodeCustomProviderApiType`.
- `OpenCodeProviderDiscovery.customProviders?: Array<OpenCodeCustomProviderEntry & { credentialPresence }>`.
- Request/response types for the new service.

### 4.6 UI — `packages/agentic-tool-opencode/src/ui/`

- `OpenCodeCustomProviders.tsx` (new): section, rows, Add/Edit/Remove, removal confirmation.
- `OpenCodeCustomProviderForm.tsx` (new): the form in §3, calling `/opencode-custom-providers`.
- `OpenCodeProviderSettings.tsx`: render the section above the list; filter custom IDs from the
  built-in list; refresh settings from the returned discovery.
- `OpenCodeModelSelector.tsx` / `useOpenCodeModelCatalog.ts`: no structural change expected; custom
  providers arrive as catalog providers with models. Invalidate the catalog after a custom-provider
  mutation (as is done after key mutations).

## 5. Data flow

**Add:** form → `create` → daemon (auth, mode, mutation slot) → executor `save-custom-provider`
(write file → `auth.set`) → discovery → settings re-render → catalog invalidated → picker shows the
models.

**Discover:** form → `create({ probe })` → executor `probe-custom-provider-models` →
`GET <baseURL>/models` → IDs → checklist.

**Session:** unchanged. The session's OpenCode server reads the global file and `auth.json`;
Agor's `OPENCODE_CONFIG_CONTENT` merges on top.

## 6. Error handling and security

### Validation

Zod schemas in `auth-payload.ts`, used by daemon and executor: ID regex, name 1–100, API type enum,
base URL (parse; `http:`/`https:`; no `username`/`password`/`search`/`hash`; strip trailing `/`),
1–500 unique model IDs of 1–200 characters.

### Probe

`GET <baseURL>/models`, `Accept: application/json`, bearer key if any, 10 s timeout,
`redirect: 'manual'` (3xx is an error), 1 MB body cap, expects `{ data: [{ id }] }`.

| Code | Message |
|---|---|
| `CUSTOM_PROVIDER_UNREACHABLE` | Couldn't reach `<baseURL>` (`<reason>`). |
| `CUSTOM_PROVIDER_TIMEOUT` | `<baseURL>` didn't answer within 10 s. |
| `CUSTOM_PROVIDER_UNAUTHORIZED` | The endpoint rejected the API key (`<status>`). |
| `CUSTOM_PROVIDER_NO_MODEL_LIST` | The endpoint has no `/models` list (`404`); add model IDs manually. |
| `CUSTOM_PROVIDER_BAD_RESPONSE` | Unexpected response from `/models` (`<detail>`). |
| `CUSTOM_PROVIDER_REDIRECT` | `/models` redirected; redirects aren't followed. Use the final URL. |

### Mutations

| Code | Message |
|---|---|
| `CUSTOM_PROVIDER_INVALID` | Field-specific validation message. |
| `CUSTOM_PROVIDER_ID_TAKEN` | OpenCode already has a provider with ID `<id>`. |
| `CUSTOM_PROVIDER_NOT_FOUND` | No custom provider with ID `<id>`. |
| `CUSTOM_PROVIDER_CONFIG_UNREADABLE` | `opencode.json` isn't plain JSON; fix or remove it. |
| `CUSTOM_PROVIDER_KEY_NOT_SAVED` | Saved, but the API key couldn't be stored. Try again. |

Every message passes through `createOpenCodeSanitizer` with the request's key registered as a
secret.

### Keys

Write-only from the UI; returned only as `credentialPresence`; carried browser → daemon → executor
stdin (as `connect-api-key` does); stored only in `auth.json` (0600); read for probing only inside
the executor.

### Concurrency and integrity

Mutations serialized per namespace by the mutation slot; atomic file replacement; non-JSON file
never overwritten; save writes definition before key, remove deletes definition before key.

### Degraded paths

- Catalog read failure → curated catalog + warning; sessions unaffected.
- Endpoint down during a session → normal OpenCode provider error in that session.

## 7. Testing

Vitest, Testing Library, Biome, turbo `typecheck`, written test-first.

- `runtime/custom-providers.test.ts` (new): real temp dirs shaped like the data home; round-trip;
  preserves unrelated keys and unknown entry fields; refuses non-JSON without writing; `0600`
  mode; API type ↔ `npm` mapping; unsupported entries; validation; probe against a local HTTP
  server for list / 401 / 404 / timeout / redirect / oversize / malformed.
- `runtime/auth-payload` schema tests for the three ops.
- `runtime/auth-handler.test.ts` additions (mocked runtime, existing pattern): save order
  (definition then `auth.set`); key failure → `CUSTOM_PROVIDER_KEY_NOT_SAVED` with definition kept;
  ID collision with built-in; remove; probe with saved key; key absent from every error message;
  discover includes `customProviders`.
- Catalog tests: custom providers with models, selectable; unreadable file → curated catalog.
- `custom-providers-service.test.ts` (new, modelled on `auth-service.test.ts`): auth required;
  hosted refused; mutation slot used for save/remove only; error-code mapping.
- UI tests: form validation; discover fills checklist; refresh marks new models unticked; key
  write-only and Clear key; unsupported rows read-only; custom IDs filtered from built-in list;
  picker lists custom models.
- Gates before push: package tests, `typecheck`, `biome check`, `check:daemon-filesystem-boundaries`.

### Manual verification in the deployed container

1. A key saved through the UI reaches a local mock server as a bearer token for both API types.
2. oMLX end to end: add via UI, discover, pick a model in a session, run a short prompt.

## 8. Rollout and maintenance

- Commits on `TealOcean/agor@homebase` → push → Komodo `agor` build (`production-source`) →
  deploy `agor` stack.
- Rollback: re-tag the previous commit-tagged image as `agor:latest` and redeploy. Removing custom
  providers in the UI restores `opencode.json` and `auth.json`.
- These commits are carried on top of each new upstream tag together with the OpenCode executor
  env fix; the `Agor-Auto-Update` Discord alert signals when to rebase.

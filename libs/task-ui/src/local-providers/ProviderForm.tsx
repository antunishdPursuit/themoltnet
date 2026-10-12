import {
  Button,
  ConfirmDialog,
  InlineNotice,
  Input,
  Select,
  Stack,
  Text,
} from '@themoltnet/design-system';
import { useState } from 'react';

import type { AgentServerProvider, ProviderActions } from './types.js';

const PRESETS: Array<{
  id: string;
  label: string;
  baseUrl: string;
  supportsDeveloperRole?: boolean;
}> = [
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    supportsDeveloperRole: false,
  },
  {
    id: 'ollama-cloud',
    label: 'Ollama Cloud',
    baseUrl: 'https://ollama.com/v1',
    supportsDeveloperRole: false,
  },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', baseUrl: '' },
];

const CLASSIFIER_APIS = {
  'typesafe-system-one': {
    label: 'Typesafe System One',
    hint: 'Use an endpoint serving the System One API.',
  },
  'cloudflare-workers-ai-system-one': {
    label: 'Cloudflare Workers AI System One',
    hint: 'Use your Cloudflare Workers AI account endpoint and API token.',
  },
  'llama-cpp-classify': {
    label: 'llama.cpp',
    hint: 'Use llama-server with token probabilities and its native tokenize, apply-template, and completion endpoints.',
  },
} as const;

/** Discovery uses the server's stored key; full model capabilities survive selection. */
export function ProviderForm({
  providers,
  actions,
  existingId,
  onChanged,
  onDone,
}: {
  providers: Record<string, AgentServerProvider>;
  actions: ProviderActions;
  existingId?: string;
  onChanged: () => void;
  onDone: () => void;
}) {
  const existing = existingId ? providers[existingId] : undefined;
  const [preset, setPreset] = useState(existing ? 'custom' : 'ollama');
  const [id, setId] = useState(existingId ?? 'ollama');
  const [baseUrl, setBaseUrl] = useState(
    existing?.baseUrl ?? PRESETS[0].baseUrl,
  );
  const [supportsDeveloperRole, setSupportsDeveloperRole] = useState(
    existing?.supportsDeveloperRole ??
      PRESETS.find((entry) => entry.id === (existingId ?? 'ollama'))
        ?.supportsDeveloperRole ??
      true,
  );
  const [apiKey, setApiKey] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const [saved, setSaved] = useState<AgentServerProvider | undefined>(existing);
  const [models, setModels] = useState(existing?.models ?? []);
  const [selected, setSelected] = useState(
    new Set(models.map((model) => model.id)),
  );
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(50);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState(false);
  const [classifierId, setClassifierId] = useState('');
  const [classifierApi, setClassifierApi] = useState<
    keyof typeof CLASSIFIER_APIS
  >('typesafe-system-one');
  const [classifierContext, setClassifierContext] = useState('8192');
  const contextWindow = Number(classifierContext);
  const validContext = Number.isSafeInteger(contextWindow) && contextWindow > 0;
  const duplicateModel = models.some(
    (model) => model.id === classifierId.trim(),
  );
  const providerId = id.trim();
  const providerLabel =
    PRESETS.find((entry) => entry.id === providerId)?.label ?? providerId;
  const duplicate = !saved && Object.hasOwn(providers, providerId);
  const valid = /^[a-z0-9][a-z0-9-]{0,63}$/u.test(providerId) && baseUrl.trim();
  const needsKey = providerId === 'ollama-cloud' && !saved?.hasApiKey;
  const filtered = models.filter((model) =>
    model.id.toLowerCase().includes(filter.toLowerCase()),
  );

  const saveConnection = async () => {
    const provider =
      saved && !editingKey
        ? saved
        : await actions.putProvider(providerId, {
            api: existing?.api ?? 'openai-completions',
            baseUrl: baseUrl.trim(),
            envName:
              existing?.envName ??
              `MOLTNET_PROVIDER_${providerId.replaceAll('-', '_').toUpperCase()}_API_KEY`,
            models: saved?.models ?? [],
            supportsDeveloperRole,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          });
    setSaved(provider);
    setApiKey('');
    setEditingKey(false);
    onChanged();
    return provider;
  };

  const saveConnectionOnly = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveConnection();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setApiKey('');
      setBusy(false);
    }
  };

  const discover = async () => {
    setBusy(true);
    setError(null);
    try {
      const provider = await saveConnection();
      const found = await actions.discoverModels(providerId);
      // Keep configured models (including their metadata) even if a provider's
      // discovery endpoint no longer lists them.
      const merged = new Map(found.map((model) => [model.id, model]));
      for (const model of provider.models) merged.set(model.id, model);
      for (const model of models) {
        if (selected.has(model.id)) merged.set(model.id, model);
      }
      setModels([...merged.values()]);
      if (!discovered && selected.size === 0 && found.length === 1) {
        setSelected(new Set([found[0].id]));
      }
      setDiscovered(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setApiKey('');
      setBusy(false);
    }
  };

  const addClassifier = () => {
    const id = classifierId.trim();
    if (!id || duplicateModel || !validContext || busy || editingKey) return;
    setModels((current) => [
      ...current,
      { id, type: 'classifier', api: classifierApi, contextWindow },
    ]);
    setSelected((current) => new Set([...current, id]));
    setClassifierId('');
    setClassifierContext('8192');
  };

  const saveModels = async () => {
    if (!saved || editingKey) return;
    setBusy(true);
    setError(null);
    try {
      await actions.putProvider(providerId, {
        api: saved.api,
        baseUrl: saved.baseUrl,
        envName: saved.envName,
        models: models.filter((model) => selected.has(model.id)),
        supportsDeveloperRole,
      });
      onChanged();
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setRemoving(false);
    setBusy(true);
    setError(null);
    try {
      await actions.deleteProvider(providerId);
      onChanged();
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap={4}>
      <Text as="h2" variant="bodyLarge" weight="semibold">
        {saved ? `Configure ${providerLabel}` : 'Add a provider'}
      </Text>
      {!saved ? (
        <Select
          label="Provider type"
          value={preset}
          disabled={busy}
          onChange={(event) => {
            const next = PRESETS.find(
              (entry) => entry.id === event.target.value,
            );
            if (!next) return;
            setPreset(next.id);
            setId(next.id === 'custom' ? '' : next.id);
            setBaseUrl(next.baseUrl);
            setSupportsDeveloperRole(next.supportsDeveloperRole ?? true);
            setApiKey('');
            setError(null);
          }}
        >
          {PRESETS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </Select>
      ) : null}
      {saved ? (
        <Stack gap={2}>
          <Text weight="semibold">Connection saved on this Mac</Text>
          <Text variant="caption">Provider ID: {providerId}</Text>
          <Text variant="caption">Endpoint: {saved.baseUrl}</Text>
          <Text variant="caption">
            {saved.hasApiKey
              ? 'API key saved on this Mac.'
              : 'No API key stored.'}
          </Text>
          {!editingKey ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setEditingKey(true)}
            >
              {saved.hasApiKey ? 'Replace API key' : 'Add API key'}
            </Button>
          ) : null}
        </Stack>
      ) : (
        <>
          <Input
            label="Provider ID"
            value={id}
            disabled={busy || Boolean(saved)}
            hint="Use this ID in your runtime profiles: lowercase letters, digits, and hyphens only."
            error={
              duplicate
                ? 'This provider already exists. Use its Configure models action.'
                : undefined
            }
            onChange={(event) => setId(event.target.value)}
          />
          <Input
            label="Base URL"
            type="url"
            value={baseUrl}
            disabled={busy || Boolean(saved)}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </>
      )}
      <Select
        label="Instruction message role"
        value={supportsDeveloperRole ? 'developer' : 'system'}
        disabled={busy}
        onChange={(event) =>
          setSupportsDeveloperRole(event.target.value === 'developer')
        }
      >
        <option value="system">System</option>
        <option value="developer">Developer</option>
      </Select>
      {(!saved && preset !== 'ollama') || editingKey ? (
        <Input
          label={
            editingKey
              ? 'New API key'
              : needsKey
                ? 'API key'
                : 'API key (optional)'
          }
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          disabled={busy}
          hint="Stored on this Mac and sent only to this provider."
          onChange={(event) => setApiKey(event.target.value)}
        />
      ) : !saved ? (
        <Text variant="caption" color="secondary">
          Ollama must be running on this Mac. Local models do not need an API
          key.
        </Text>
      ) : null}
      {error ? (
        <InlineNotice tone="error" title="Provider setup needs attention">
          {error}
        </InlineNotice>
      ) : null}
      <Stack direction="row" gap={2} wrap>
        {!saved || editingKey ? (
          <Button
            variant="secondary"
            disabled={
              !valid ||
              duplicate ||
              ((needsKey || editingKey) && !apiKey.trim()) ||
              busy
            }
            onClick={() => void saveConnectionOnly()}
          >
            {editingKey ? 'Save key' : 'Save connection'}
          </Button>
        ) : null}
        <Button
          variant="secondary"
          disabled={
            !valid ||
            duplicate ||
            ((needsKey || editingKey) && !apiKey.trim()) ||
            busy
          }
          loading={busy}
          loadingLabel="Working"
          onClick={() => void discover()}
        >
          {editingKey
            ? 'Save key and discover models'
            : saved
              ? 'Refresh models'
              : 'Save connection and discover models'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onDone}>
          {saved ? 'Close setup' : 'Cancel setup'}
        </Button>
        {editingKey ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setApiKey('');
              setEditingKey(false);
            }}
          >
            Cancel key change
          </Button>
        ) : null}
      </Stack>
      {saved ? (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => setRemoving(true)}
        >
          Remove provider
        </Button>
      ) : null}
      <ConfirmDialog
        open={removing}
        title={`Remove ${providerLabel}?`}
        message="This removes the connection and its stored API key. Runtime profiles using it will need another provider."
        confirmLabel="Remove provider"
        destructive
        onCancel={() => setRemoving(false)}
        onConfirm={() => void remove()}
      />
      {saved && !saved.models.length ? (
        <Text variant="caption" color="secondary">
          Connection saved. Choose and save models below to finish setup for
          runtime profiles.
        </Text>
      ) : null}
      {discovered ? (
        <Text variant="caption" color="secondary">
          Model list retrieved from {providerLabel}. Generating a response has
          not been tested.
        </Text>
      ) : null}
      {!saved ? (
        <Text variant="caption" color="muted">
          Save the connection to add a classifier manually, or discover
          generation models from the provider.
        </Text>
      ) : null}
      {saved ? (
        <Stack gap={3}>
          <Text as="h3" variant="body" weight="semibold">
            Add a classifier model
          </Text>
          <Text variant="caption" color="secondary">
            Classifiers share this provider's endpoint and credentials. The
            endpoint must support the selected classifier API; ordinary Ollama
            endpoints do not. Model discovery is optional.
          </Text>
          <Select
            label="Classifier API"
            value={classifierApi}
            disabled={busy || editingKey}
            onChange={(event) => {
              const api = event.target.value;
              if (Object.hasOwn(CLASSIFIER_APIS, api))
                setClassifierApi(api as keyof typeof CLASSIFIER_APIS);
            }}
          >
            {Object.entries(CLASSIFIER_APIS).map(([api, { label }]) => (
              <option key={api} value={api}>
                {label}
              </option>
            ))}
          </Select>
          <Text variant="caption" color="secondary">
            {CLASSIFIER_APIS[classifierApi].hint}
          </Text>
          <Input
            label="Classifier model ID"
            value={classifierId}
            disabled={busy || editingKey}
            error={
              duplicateModel
                ? 'This model ID is already configured. Choose a different ID.'
                : undefined
            }
            onChange={(event) => setClassifierId(event.target.value)}
          />
          <Input
            label="Classifier context window"
            type="number"
            min={1}
            step={1}
            value={classifierContext}
            disabled={busy || editingKey}
            hint="Maximum number of input tokens. Defaults to 8192."
            error={
              !validContext
                ? 'Enter a positive whole number of tokens.'
                : undefined
            }
            onChange={(event) => setClassifierContext(event.target.value)}
          />
          <Button
            variant="secondary"
            disabled={
              !classifierId.trim() ||
              duplicateModel ||
              !validContext ||
              busy ||
              editingKey
            }
            onClick={addClassifier}
          >
            Add classifier
          </Button>
          <Text variant="caption" color="secondary">
            Save models below to apply your additions and selections.
          </Text>
        </Stack>
      ) : null}
      {discovered && models.length === 0 ? (
        <div role="status">
          <Text variant="caption">
            No models found. For local Ollama, pull a model in Ollama, then
            discover again.
          </Text>
        </div>
      ) : null}
      {models.length > 0 ? (
        <Stack gap={3}>
          <Text as="h3" variant="body" weight="semibold">
            Models for {providerLabel}
          </Text>
          <Text variant="caption" color="secondary">
            {selected.size} selected · {saved?.models.length ?? 0} saved.
            Selections apply to {providerId} only.
          </Text>
          <Button
            disabled={busy || editingKey || selected.size === 0}
            onClick={() => void saveModels()}
          >
            Save models for {providerLabel} ({selected.size})
          </Button>
          <Input
            label="Filter models"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setLimit(50);
            }}
          />
          <Stack direction="row" gap={2} wrap>
            <Button
              variant="secondary"
              disabled={
                busy ||
                filtered.length === 0 ||
                filtered.every((model) => selected.has(model.id))
              }
              onClick={() =>
                setSelected(
                  (current) =>
                    new Set([...current, ...filtered.map((model) => model.id)]),
                )
              }
            >
              {filter
                ? `Select all matching (${filtered.length})`
                : `Select all (${filtered.length})`}
            </Button>
            <Button
              variant="ghost"
              disabled={
                busy || !filtered.some((model) => selected.has(model.id))
              }
              onClick={() =>
                setSelected(
                  (current) =>
                    new Set(
                      [...current].filter(
                        (id) => !filtered.some((model) => model.id === id),
                      ),
                    ),
                )
              }
            >
              {filter ? 'Clear matching selection' : 'Clear selection'}
            </Button>
          </Stack>
          <div role="group" aria-label="Available models">
            <Stack gap={2}>
              {filtered.slice(0, limit).map((model) => (
                <label key={model.id}>
                  <input
                    type="checkbox"
                    checked={selected.has(model.id)}
                    disabled={busy}
                    onChange={() =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(model.id)) next.delete(model.id);
                        else next.add(model.id);
                        return next;
                      })
                    }
                  />{' '}
                  {model.id}
                  {model.type === 'classifier' ? ' (classifier)' : ''}
                </label>
              ))}
            </Stack>
          </div>
          {filtered.length > limit ? (
            <Button variant="ghost" onClick={() => setLimit(limit + 50)}>
              Show more models
            </Button>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
}

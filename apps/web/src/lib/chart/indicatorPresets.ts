import { useSyncExternalStore } from "react";

export type PresetParams = Record<string, unknown>;
export type Preset = { name: string; params: PresetParams };
export type PresetsByIndicator = Record<string, Preset[]>;
export type PresetSaveOutcome = "saved" | "full" | "not-written";
export type PresetSource = "browser" | "account";
export type PresetSignInResult = { merged: string[]; failed: string[]; left: string[] };

export const INDICATOR_PRESETS_STORAGE_KEY = "terminal.indicator-presets.v1";
export const MAX_PRESET_NAME_LENGTH = 64;
export const MAX_PRESETS_PER_INDICATOR = 32;
const MAX_PARAM_STRING_LENGTH = 256;

export const isSameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export const HISTORICAL_PRESET_SCOPE = "historical";

export function historicalPresetScope(scope: string): string {
  return `${HISTORICAL_PRESET_SCOPE}:${scope}`;
}

export function presetKeyFor(indicatorId: string, scope?: string): string {
  return scope === undefined || scope === "" ? indicatorId : `${indicatorId}@${scope}`;
}

export function isPresetName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_PRESET_NAME_LENGTH;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function jsonValue(value: unknown): boolean {
  switch (kindOf(value)) {
    case "number":
      return Number.isFinite(value);
    case "string":
      return (value as string).length <= MAX_PARAM_STRING_LENGTH;
    case "boolean":
    case "null":
      return true;
    case "array":
      return (value as unknown[]).every(jsonValue);
    case "object":
      return Object.values(value as Record<string, unknown>).every(jsonValue);
    default:
      return false;
  }
}

function copyParams(params: PresetParams): PresetParams {
  const copied: PresetParams = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && jsonValue(value)) copied[key] = JSON.parse(JSON.stringify(value)) as unknown;
  }
  return copied;
}

export function withPresetSaved(presets: readonly Preset[], name: string, params: PresetParams): Preset[] {
  const preset: Preset = { name: name.trim(), params: copyParams(params) };
  const index = presets.findIndex((other) => isSameName(other.name, name));
  if (index === -1) return [...presets, preset];
  return presets.map((other, i) => (i === index ? preset : other));
}

export function withoutPreset(presets: readonly Preset[], name: string): Preset[] {
  return presets.filter((other) => !isSameName(other.name, name));
}

export function mergePresets(account: readonly Preset[], browser: readonly Preset[]): Preset[] {
  const browserOnly = browser.filter((p) => !account.some((a) => isSameName(a.name, p.name)));
  return [...account, ...browserOnly];
}

function restorePresets(raw: unknown): Preset[] {
  if (!Array.isArray(raw)) return [];
  const presets: Preset[] = [];
  for (const item of raw) {
    if (!record(item)) continue;
    const { name, params } = item;
    if (typeof name !== "string" || !isPresetName(name) || !record(params)) continue;
    if (presets.some((other) => isSameName(other.name, name))) continue;
    presets.push({ name: name.trim(), params: copyParams(params) });
    if (presets.length === MAX_PRESETS_PER_INDICATOR) break;
  }
  return presets;
}

export function restorePresetsByIndicator(raw: unknown): PresetsByIndicator {
  const restored: PresetsByIndicator = {};
  if (!record(raw)) return restored;
  for (const [key, value] of Object.entries(raw)) {
    if (key.length === 0 || key.length > 192) continue;
    const presets = restorePresets(value);
    if (presets.length > 0) restored[key] = presets;
  }
  return restored;
}

export interface PresetBrowserStorage {
  load(): unknown;
  save(all: PresetsByIndicator): void;
}

export interface PresetAccountStorage {
  load(): Promise<unknown>;
  write(indicatorKey: string, presets: readonly Preset[]): Promise<void>;
}

export interface PresetStore {
  list(key: string): readonly Preset[];
  save(key: string, name: string, params: PresetParams): Promise<PresetSaveOutcome>;
  remove(key: string, name: string): Promise<boolean>;
  subscribe(listener: () => void): () => void;
  source(): PresetSource;
  refresh(): void;
  signIn(account: PresetAccountStorage): Promise<PresetSignInResult>;
  signOut(): void;
}

export function localStoragePresetBackend(storageKey = INDICATOR_PRESETS_STORAGE_KEY): PresetBrowserStorage {
  return {
    load() {
      const encoded = localStorage.getItem(storageKey);
      return encoded === null ? {} : JSON.parse(encoded);
    },
    save(all) {
      localStorage.setItem(storageKey, JSON.stringify(all));
    },
  };
}

const NO_PRESETS: readonly Preset[] = Object.freeze([]);

export function createPresetStore(browser: PresetBrowserStorage): PresetStore {
  let all: PresetsByIndicator | null = null;
  let account: PresetAccountStorage | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();

  function browserPresets(): PresetsByIndicator {
    try {
      return restorePresetsByIndicator(browser.load());
    } catch {
      return {};
    }
  }

  function loaded(): PresetsByIndicator {
    if (all === null) all = account === null ? browserPresets() : {};
    return all;
  }

  function notify() {
    for (const listener of listeners) listener();
  }

  function syncFromBrowser() {
    if (account !== null) return;
    const fresh = browserPresets();
    if (all === null) {
      all = fresh;
      return;
    }
    if (JSON.stringify(fresh) === JSON.stringify(all)) return;
    all = fresh;
    notify();
  }

  function current(): PresetsByIndicator {
    syncFromBrowser();
    return loaded();
  }

  function set(key: string, presets: Preset[]) {
    const next = { ...loaded() };
    if (presets.length === 0) delete next[key];
    else next[key] = presets;
    all = next;
    notify();
  }

  async function persist(key: string): Promise<boolean> {
    try {
      if (account !== null) await account.write(key, loaded()[key] ?? NO_PRESETS);
      else browser.save(loaded());
      return true;
    } catch {
      return false;
    }
  }

  async function writeTo(target: PresetAccountStorage, key: string, presets: readonly Preset[]): Promise<boolean> {
    try {
      await target.write(key, presets);
      return true;
    } catch {
      return false;
    }
  }

  return {
    list(key) {
      return loaded()[key] ?? NO_PRESETS;
    },
    async save(key, name, params) {
      const next = withPresetSaved(current()[key] ?? NO_PRESETS, name, params);
      if (next.length > MAX_PRESETS_PER_INDICATOR) return "full";
      set(key, next);
      return (await persist(key)) ? "saved" : "not-written";
    },
    async remove(key, name) {
      const existing = current()[key];
      if (existing === undefined) return true;
      set(key, withoutPreset(existing, name));
      return persist(key);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    source() {
      return account === null ? "browser" : "account";
    },
    refresh() {
      current();
    },
    async signIn(next) {
      const mine = ++generation;
      const remote = restorePresetsByIndicator(await next.load());
      const local = browserPresets();
      if (mine !== generation) return { merged: [], failed: [], left: Object.keys(local) };
      const merged: PresetsByIndicator = { ...remote };
      const changed: string[] = [];
      const keep: PresetsByIndicator = {};
      for (const [key, presets] of Object.entries(local)) {
        const current = remote[key] ?? NO_PRESETS;
        const union = mergePresets(current, presets);
        if (union.length > MAX_PRESETS_PER_INDICATOR) keep[key] = union.slice(MAX_PRESETS_PER_INDICATOR);
        if (union.length === current.length) continue;
        merged[key] = union.slice(0, MAX_PRESETS_PER_INDICATOR);
        changed.push(key);
      }
      account = next;
      all = merged;
      notify();
      const failed: string[] = [];
      for (const key of changed) {
        const written = await writeTo(next, key, loaded()[key] ?? NO_PRESETS);
        if (mine !== generation) return { merged: changed, failed, left: Object.keys(local) };
        if (!written) {
          failed.push(key);
          keep[key] = local[key];
        }
      }
      if (Object.keys(local).length === 0) return { merged: changed, failed, left: [] };
      try {
        browser.save(keep);
        return { merged: changed, failed, left: Object.keys(keep) };
      } catch {
        return { merged: changed, failed, left: Object.keys(local) };
      }
    },
    signOut() {
      generation += 1;
      account = null;
      all = null;
      notify();
    },
  };
}

export const indicatorPresets: PresetStore = createPresetStore(localStoragePresetBackend());

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === INDICATOR_PRESETS_STORAGE_KEY || event.key === null) indicatorPresets.refresh();
  });
}

export function useIndicatorPresets(key: string, store: PresetStore = indicatorPresets): readonly Preset[] {
  return useSyncExternalStore(store.subscribe, () => store.list(key), () => store.list(key));
}

import { describe, expect, it } from "vitest";
import {
  INDICATOR_PRESETS_STORAGE_KEY,
  MAX_PRESETS_PER_INDICATOR,
  createPresetStore,
  isPresetName,
  localStoragePresetBackend,
  mergePresets,
  presetKeyFor,
  restorePresetsByIndicator,
  withPresetSaved,
  withoutPreset,
  type Preset,
  type PresetAccountStorage,
  type PresetsByIndicator,
} from "./indicatorPresets";

const scalp: Preset = { name: "Scalp mode", params: { length: 9, color: "#fff" } };
const swing: Preset = { name: "Swing mode", params: { length: 50, color: "#000" } };

describe("preset operations", () => {
  it("saves a new preset at the end, in creation order", () => {
    const presets = withPresetSaved([scalp], "Swing mode", swing.params);
    expect(presets.map((p) => p.name)).toEqual(["Scalp mode", "Swing mode"]);
  });

  it("replaces a preset saved under the same name in any letter case, in place", () => {
    const presets = withPresetSaved([scalp, swing], "  scalp MODE ", { length: 14, color: "#abc" });
    expect(presets).toHaveLength(2);
    expect(presets[0]).toEqual({ name: "scalp MODE", params: { length: 14, color: "#abc" } });
    expect(presets[1]).toBe(swing);
  });

  it("keeps a copy of the params, so later edits do not change the preset", () => {
    const params = { length: 9, floors: { x3: 100 } };
    const [preset] = withPresetSaved([], "Scalp", params);
    params.length = 99;
    params.floors.x3 = 1;
    expect(preset.params).toEqual({ length: 9, floors: { x3: 100 } });
  });

  it("drops params that cannot be stored: undefined, functions, non-finite numbers", () => {
    const [preset] = withPresetSaved([], "Scalp", { length: 9, gone: undefined, fn: () => 1, inf: Infinity, nan: NaN });
    expect(preset.params).toEqual({ length: 9 });
  });

  it("deletes only the named preset, in any letter case", () => {
    expect(withoutPreset([scalp, swing], "SWING MODE")).toEqual([scalp]);
    expect(withoutPreset([scalp, swing], "unknown")).toEqual([scalp, swing]);
  });





  it("merges the browser's presets into the account's, the account's version winning on a shared name", () => {
    const account = [scalp];
    const browser = [{ name: "scalp mode", params: { length: 1 } }, swing];
    expect(mergePresets(account, browser)).toEqual([scalp, swing]);
  });

  it("names: empty or blank refused, 64 characters at most", () => {
    expect(isPresetName("")).toBe(false);
    expect(isPresetName("   ")).toBe(false);
    expect(isPresetName("Scalp")).toBe(true);
    expect(isPresetName("x".repeat(64))).toBe(true);
    expect(isPresetName("x".repeat(65))).toBe(false);
  });

  it("keys presets by indicator, or by indicator and instrument", () => {
    expect(presetKeyFor("rsi")).toBe("rsi");
    expect(presetKeyFor("aggressiveOrders", "")).toBe("aggressiveOrders");
    expect(presetKeyFor("aggressiveOrders", "DXFEED:FUTURE:/NQZ26:XCME")).toBe("aggressiveOrders@DXFEED:FUTURE:/NQZ26:XCME");
  });
});

describe("restoring stored presets", () => {
  it("keeps only well-formed presets and drops a second preset of the same name", () => {
    const restored = restorePresetsByIndicator({
      rsi: [scalp, { name: "SCALP MODE", params: { length: 1 } }, { name: "", params: {} }, { name: "no params" }, "junk", swing],
      "": [scalp],
      bad: "not a list",
      empty: [],
    });
    expect(restored).toEqual({ rsi: [scalp, swing] });
  });

  it("gives an empty map for anything that is not an object", () => {
    expect(restorePresetsByIndicator(null)).toEqual({});
    expect(restorePresetsByIndicator([scalp])).toEqual({});
    expect(restorePresetsByIndicator("x")).toEqual({});
  });

  it(`keeps at most ${MAX_PRESETS_PER_INDICATOR} presets per indicator`, () => {
    const many = Array.from({ length: MAX_PRESETS_PER_INDICATOR + 5 }, (_, i) => ({ name: `p${i}`, params: {} }));
    expect(restorePresetsByIndicator({ rsi: many }).rsi).toHaveLength(MAX_PRESETS_PER_INDICATOR);
  });
});

describe("preset store", () => {
  function memoryBackend(initial: unknown = {}, failWrites = false) {
    const writes: PresetsByIndicator[] = [];
    let stored = initial;
    return {
      writes,
      backend: {
        load: () => stored,
        save: (all: PresetsByIndicator) => {
          if (failWrites) throw new Error("quota");
          writes.push(all);
          stored = JSON.parse(JSON.stringify(all)) as unknown;
        },
      },
    };
  }

  it("lists the stored presets of one indicator only", () => {
    const { backend } = memoryBackend({ rsi: [scalp], macd: [swing] });
    const store = createPresetStore(backend);
    expect(store.list("rsi")).toEqual([scalp]);
    expect(store.list("macd")).toEqual([swing]);
    expect(store.list("ema")).toEqual([]);
    expect(store.source()).toBe("browser");
  });

  it("a save updates memory first, then writes everything to the browser, and tells the listeners", async () => {
    const { backend, writes } = memoryBackend({ macd: [swing] });
    const store = createPresetStore(backend);
    let notified = 0;
    store.subscribe(() => { notified += 1; });
    const outcome = store.save("rsi", "Scalp mode", scalp.params);
    expect(store.list("rsi")).toEqual([scalp]);
    expect(notified).toBe(1);
    expect(await outcome).toBe("saved");
    expect(writes).toEqual([{ macd: [swing], rsi: [scalp] }]);
  });

  it("a failed write keeps the preset in memory and reports it", async () => {
    const { backend } = memoryBackend({}, true);
    const store = createPresetStore(backend);
    expect(await store.save("rsi", "Scalp mode", scalp.params)).toBe("not-written");
    expect(store.list("rsi")).toEqual([scalp]);
  });

  it(`refuses the ${MAX_PRESETS_PER_INDICATOR + 1}th preset of an indicator but still replaces an existing name`, async () => {
    const { backend, writes } = memoryBackend({});
    const store = createPresetStore(backend);
    for (let i = 0; i < MAX_PRESETS_PER_INDICATOR; i += 1) await store.save("rsi", `p${i}`, {});
    expect(await store.save("rsi", "one more", {})).toBe("full");
    expect(store.list("rsi")).toHaveLength(MAX_PRESETS_PER_INDICATOR);
    expect(await store.save("rsi", "P1", { length: 2 })).toBe("saved");
    expect(store.list("rsi")[1]).toEqual({ name: "P1", params: { length: 2 } });
    expect(writes).toHaveLength(MAX_PRESETS_PER_INDICATOR + 1);
  });

  it("removing the last preset of an indicator drops its key from storage", async () => {
    const { backend, writes } = memoryBackend({ rsi: [scalp], macd: [swing] });
    const store = createPresetStore(backend);
    expect(await store.remove("rsi", "scalp mode")).toBe(true);
    expect(store.list("rsi")).toEqual([]);
    expect(writes).toEqual([{ macd: [swing] }]);
    expect(await store.remove("ema", "nothing")).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it("a broken storage reads as no presets", () => {
    const store = createPresetStore({ load: () => { throw new Error("blocked"); }, save: () => {} });
    expect(store.list("rsi")).toEqual([]);
  });

  it("an unsubscribed listener hears nothing more", async () => {
    const { backend } = memoryBackend({});
    const store = createPresetStore(backend);
    let notified = 0;
    const stop = store.subscribe(() => { notified += 1; });
    await store.save("rsi", "a", {});
    stop();
    await store.save("rsi", "b", {});
    expect(notified).toBe(1);
  });

  it("the browser backend keeps one key holding every indicator's presets, and reads it back after a reload", async () => {
    const first = createPresetStore(localStoragePresetBackend());
    await first.save("rsi", "Scalp mode", scalp.params);
    await first.save("aggressiveOrders@BINANCE:PERPETUAL:BTC-USDT", "Quiet", { minVolume: 5 });
    expect(JSON.parse(localStorage.getItem(INDICATOR_PRESETS_STORAGE_KEY)!)).toEqual({
      rsi: [scalp],
      "aggressiveOrders@BINANCE:PERPETUAL:BTC-USDT": [{ name: "Quiet", params: { minVolume: 5 } }],
    });
    const reloaded = createPresetStore(localStoragePresetBackend());
    expect(reloaded.list("rsi")).toEqual([scalp]);
    expect(reloaded.list("aggressiveOrders@BINANCE:PERPETUAL:BTC-USDT")).toEqual([{ name: "Quiet", params: { minVolume: 5 } }]);
  });

  it("the browser backend survives garbage under its key", () => {
    localStorage.setItem(INDICATOR_PRESETS_STORAGE_KEY, "{not json");
    expect(createPresetStore(localStoragePresetBackend()).list("rsi")).toEqual([]);
  });
});

describe("preset store with an account", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  function fakeAccount(initial: PresetsByIndicator = {}, failing: readonly string[] = []) {
    const rows: PresetsByIndicator = { ...initial };
    const writes: [string, Preset[]][] = [];
    const account: PresetAccountStorage = {
      async load() {
        await tick();
        return { ...rows };
      },
      async write(key, presets) {
        await tick();
        if (failing.includes(key)) throw new Error("network");
        writes.push([key, [...presets]]);
        if (presets.length === 0) delete rows[key];
        else rows[key] = [...presets];
      },
    };
    return { account, rows, writes };
  }

  it("at sign-in the browser's presets move into the account, the account's version winning on a shared name, and the browser copy is cleared", async () => {
    const browser = createPresetStore(localStoragePresetBackend());
    await browser.save("rsi", "Scalp mode", { length: 1 });
    await browser.save("rsi", "Swing mode", swing.params);
    await browser.save("macd", "Fast", { length: 3 });
    const { account, rows, writes } = fakeAccount({ rsi: [scalp], ema: [swing] });
    const store = createPresetStore(localStoragePresetBackend());
    const result = await store.signIn(account);
    expect(store.source()).toBe("account");
    expect(result).toEqual({ merged: ["rsi", "macd"], failed: [], left: [] });
    expect(store.list("rsi")).toEqual([scalp, swing]);
    expect(store.list("macd")).toEqual([{ name: "Fast", params: { length: 3 } }]);
    expect(store.list("ema")).toEqual([swing]);
    expect(writes).toEqual([["rsi", [scalp, swing]], ["macd", [{ name: "Fast", params: { length: 3 } }]]]);
    expect(rows.rsi).toEqual([scalp, swing]);
    expect(localStorage.getItem(INDICATOR_PRESETS_STORAGE_KEY)).toBe("{}");
  });

  it("signed in, a save writes that indicator's row, an empty list deletes the row, and the browser copy stays untouched", async () => {
    const { account, rows, writes } = fakeAccount({ rsi: [scalp] });
    const store = createPresetStore(localStoragePresetBackend());
    await store.signIn(account);
    let notified = 0;
    store.subscribe(() => { notified += 1; });
    const outcome = store.save("rsi", "Swing mode", swing.params);
    expect(store.list("rsi")).toEqual([scalp, swing]);
    expect(notified).toBe(1);
    expect(await outcome).toBe("saved");
    expect(await store.remove("rsi", "scalp mode")).toBe(true);
    expect(await store.remove("rsi", "swing mode")).toBe(true);
    expect(writes.map(([key, presets]) => [key, presets.map((p) => p.name)])).toEqual([["rsi", ["Scalp mode", "Swing mode"]], ["rsi", ["Swing mode"]], ["rsi", []]]);
    expect(rows.rsi).toBeUndefined();
    expect(localStorage.getItem(INDICATOR_PRESETS_STORAGE_KEY)).toBeNull();
  });

  it("a failed account write keeps the preset on screen and reports it, for saves and deletes", async () => {
    const { account } = fakeAccount({ rsi: [scalp] }, ["rsi"]);
    const store = createPresetStore(localStoragePresetBackend());
    await store.signIn(account);
    expect(await store.save("rsi", "Swing mode", swing.params)).toBe("not-written");
    expect(store.list("rsi")).toEqual([scalp, swing]);
    expect(await store.remove("rsi", "Scalp mode")).toBe(false);
    expect(store.list("rsi")).toEqual([swing]);
  });

  it("a merge write that fails keeps the browser copy, so nothing is lost", async () => {
    const browser = createPresetStore(localStoragePresetBackend());
    await browser.save("rsi", "Scalp mode", scalp.params);
    const { account } = fakeAccount({}, ["rsi"]);
    const store = createPresetStore(localStoragePresetBackend());
    expect(await store.signIn(account)).toEqual({ merged: ["rsi"], failed: ["rsi"], left: ["rsi"] });
    expect(store.list("rsi")).toEqual([scalp]);
    expect(JSON.parse(localStorage.getItem(INDICATOR_PRESETS_STORAGE_KEY)!)).toEqual({ rsi: [scalp] });
  });

  it("a preset deleted while signed in stays deleted after a sign-out and a new sign-in", async () => {
    const browser = createPresetStore(localStoragePresetBackend());
    await browser.save("rsi", "Scalp mode", scalp.params);
    const { account } = fakeAccount();
    const store = createPresetStore(localStoragePresetBackend());
    await store.signIn(account);
    await store.remove("rsi", "Scalp mode");
    store.signOut();
    expect(store.source()).toBe("browser");
    expect(store.list("rsi")).toEqual([]);
    await store.signIn(account);
    expect(store.list("rsi")).toEqual([]);
  });

  it("an account that cannot be read leaves the store on the browser", async () => {
    const store = createPresetStore(localStoragePresetBackend());
    await store.save("rsi", "Scalp mode", scalp.params);
    await expect(store.signIn({ load: () => Promise.reject(new Error("offline")), write: () => Promise.resolve() })).rejects.toThrow("offline");
    expect(store.source()).toBe("browser");
    expect(store.list("rsi")).toEqual([scalp]);
  });

  it("signing out while the browser still holds presets shows them again", async () => {
    const browser = createPresetStore(localStoragePresetBackend());
    await browser.save("rsi", "Scalp mode", scalp.params);
    const { account } = fakeAccount({}, ["rsi"]);
    const store = createPresetStore(localStoragePresetBackend());
    await store.signIn(account);
    store.signOut();
    expect(store.list("rsi")).toEqual([scalp]);
  });
});

describe("preset store across tabs", () => {
  it("a save or a delete in a tab that loaded earlier never erases what another tab saved since", async () => {
    const tab1 = createPresetStore(localStoragePresetBackend());
    const tab2 = createPresetStore(localStoragePresetBackend());
    expect(tab1.list("sma")).toEqual([]);
    await tab2.save("aggressiveOrders@DXFEED:FUTURE:/NQZ26:XCME", "NQ quiet", { minVolume: 40 });
    await tab2.save("sma", "Fast", { length: 9 });
    await tab1.save("aggressiveOrders@BINANCE:PERPETUAL:BTC-USDT", "BTC scalp", { minVolume: 5 });
    await tab1.save("sma", "Slow", { length: 50 });
    await tab2.save("rsi", "Gone soon", { length: 2 });
    await tab1.remove("rsi", "Gone soon");
    const reloaded = createPresetStore(localStoragePresetBackend());
    expect(reloaded.list("aggressiveOrders@DXFEED:FUTURE:/NQZ26:XCME").map((p) => p.name)).toEqual(["NQ quiet"]);
    expect(reloaded.list("aggressiveOrders@BINANCE:PERPETUAL:BTC-USDT").map((p) => p.name)).toEqual(["BTC scalp"]);
    expect(reloaded.list("sma").map((p) => p.name)).toEqual(["Fast", "Slow"]);
    expect(reloaded.list("rsi")).toEqual([]);
  });

  it("refresh shows what another tab wrote and tells the listeners, and stays quiet when nothing changed", async () => {
    const tab1 = createPresetStore(localStoragePresetBackend());
    const tab2 = createPresetStore(localStoragePresetBackend());
    expect(tab1.list("rsi")).toEqual([]);
    let notified = 0;
    tab1.subscribe(() => { notified += 1; });
    await tab2.save("rsi", "Scalp mode", scalp.params);
    tab1.refresh();
    expect(tab1.list("rsi")).toEqual([scalp]);
    expect(notified).toBe(1);
    tab1.refresh();
    expect(notified).toBe(1);
  });
});

describe("signing in", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  function slowAccount(initial: PresetsByIndicator = {}, failing: readonly string[] = []) {
    const rows: PresetsByIndicator = { ...initial };
    let release: () => void = () => {};
    const loaded = new Promise<void>((resolve) => { release = resolve; });
    const account: PresetAccountStorage = {
      async load() {
        await loaded;
        return { ...rows };
      },
      async write(key, presets) {
        await tick();
        if (failing.includes(key)) throw new Error("network");
        if (presets.length === 0) delete rows[key];
        else rows[key] = [...presets];
      },
    };
    return { account, rows, release };
  }

  it("clears a browser preset the account already holds, so one deleted while signed in stays deleted", async () => {
    await createPresetStore(localStoragePresetBackend()).save("rsi", "Scalp mode", { length: 1 });
    const { account, release } = slowAccount({ rsi: [scalp] });
    release();
    const store = createPresetStore(localStoragePresetBackend());
    expect(await store.signIn(account)).toEqual({ merged: [], failed: [], left: [] });
    expect(localStorage.getItem(INDICATOR_PRESETS_STORAGE_KEY)).toBe("{}");
    await store.remove("rsi", "Scalp mode");
    store.signOut();
    expect(store.list("rsi")).toEqual([]);
    await store.signIn(account);
    expect(store.list("rsi")).toEqual([]);
  });

  it("keeps the presets past the cap in the browser and names their indicator", async () => {
    const accountPresets = Array.from({ length: 30 }, (_, i) => ({ name: `a${i}`, params: {} }));
    const browser = createPresetStore(localStoragePresetBackend());
    for (let i = 0; i < 5; i += 1) await browser.save("rsi", `b${i}`, {});
    const { account, rows, release } = slowAccount({ rsi: accountPresets });
    release();
    const store = createPresetStore(localStoragePresetBackend());
    expect(await store.signIn(account)).toEqual({ merged: ["rsi"], failed: [], left: ["rsi"] });
    expect(rows.rsi.map((p) => p.name)).toEqual([...accountPresets.map((p) => p.name), "b0", "b1"]);
    expect(Object.keys(JSON.parse(localStorage.getItem(INDICATOR_PRESETS_STORAGE_KEY)!))).toEqual(["rsi"]);
    expect(JSON.parse(localStorage.getItem(INDICATOR_PRESETS_STORAGE_KEY)!).rsi.map((p: Preset) => p.name)).toEqual(["b2", "b3", "b4"]);
  });

  it("after a partial failure keeps only the indicators whose write failed in the browser", async () => {
    const browser = createPresetStore(localStoragePresetBackend());
    await browser.save("rsi", "Scalp mode", scalp.params);
    await browser.save("macd", "Fast", { length: 3 });
    const { account, rows, release } = slowAccount({}, ["rsi"]);
    release();
    const store = createPresetStore(localStoragePresetBackend());
    expect(await store.signIn(account)).toEqual({ merged: ["rsi", "macd"], failed: ["rsi"], left: ["rsi"] });
    expect(rows.macd).toEqual([{ name: "Fast", params: { length: 3 } }]);
    expect(JSON.parse(localStorage.getItem(INDICATOR_PRESETS_STORAGE_KEY)!)).toEqual({ rsi: [scalp] });
  });

  it("says every indicator is left in the browser when the browser copy cannot be rewritten", async () => {
    const local = { rsi: [scalp] };
    const store = createPresetStore({ load: () => local, save: () => { throw new Error("blocked"); } });
    const { account, release } = slowAccount();
    release();
    expect(await store.signIn(account)).toEqual({ merged: ["rsi"], failed: [], left: ["rsi"] });
  });

  it("merges a preset saved while the account was still loading", async () => {
    const store = createPresetStore(localStoragePresetBackend());
    const { account, rows, release } = slowAccount();
    const signingIn = store.signIn(account);
    await store.save("macd", "Late", { length: 7 });
    release();
    expect(await signingIn).toEqual({ merged: ["macd"], failed: [], left: [] });
    expect(rows.macd).toEqual([{ name: "Late", params: { length: 7 } }]);
  });

  it("a sign-out while the account loads leaves the store on the browser, with the browser copy untouched", async () => {
    await createPresetStore(localStoragePresetBackend()).save("rsi", "Scalp mode", scalp.params);
    const store = createPresetStore(localStoragePresetBackend());
    const { account, rows, release } = slowAccount();
    const signingIn = store.signIn(account);
    store.signOut();
    release();
    expect(await signingIn).toEqual({ merged: [], failed: [], left: ["rsi"] });
    expect(store.source()).toBe("browser");
    expect(rows).toEqual({});
    expect(store.list("rsi")).toEqual([scalp]);
  });

  it("a sign-out during the merge writes stops before the browser copy is cleared", async () => {
    const browser = createPresetStore(localStoragePresetBackend());
    await browser.save("rsi", "Scalp mode", scalp.params);
    await browser.save("macd", "Fast", { length: 3 });
    const store = createPresetStore(localStoragePresetBackend());
    const { account, release } = slowAccount();
    release();
    const signingIn = store.signIn(account);
    await tick();
    store.signOut();
    const result = await signingIn;
    expect(result.left).toEqual(["rsi", "macd"]);
    expect(JSON.parse(localStorage.getItem(INDICATOR_PRESETS_STORAGE_KEY)!)).toEqual({ rsi: [scalp], macd: [{ name: "Fast", params: { length: 3 } }] });
  });
});

describe("signing in, while the merge writes run", () => {
  it("a save made meanwhile reaches the account with the merged presets", async () => {
    const browser = createPresetStore(localStoragePresetBackend());
    await browser.save("rsi", "Scalp mode", scalp.params);
    await browser.save("macd", "Fast", { length: 3 });
    const rows: PresetsByIndicator = {};
    let releaseWrites: () => void = () => {};
    const writesHeld = new Promise<void>((resolve) => { releaseWrites = resolve; });
    const account: PresetAccountStorage = {
      load: async () => ({}),
      async write(key, presets) {
        await writesHeld;
        if (presets.length === 0) delete rows[key];
        else rows[key] = [...presets];
      },
    };
    const store = createPresetStore(localStoragePresetBackend());
    const signingIn = store.signIn(account);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const saving = store.save("macd", "Late", { length: 7 });
    releaseWrites();
    await signingIn;
    await saving;
    expect(rows.macd.map((p) => p.name)).toEqual(["Fast", "Late"]);
  });
});

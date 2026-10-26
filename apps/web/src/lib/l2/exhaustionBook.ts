import type { ExhaustionShade, ExhaustionShadesFrame } from "../../types/frames";

export type ExhaustionApplyOutcome = "reset" | "applied" | "ignored";

function byStart(a: ExhaustionShade, b: ExhaustionShade): number {
  return a.startTs - b.startTs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export class ExhaustionBook {
  private _byId = new Map<string, ExhaustionShade>();
  private _sorted: readonly ExhaustionShade[] | null = null;
  private _version = 0;
  private _synced = false;
  private _untrusted = false;
  private _lastTs = 0;
  private _lastSeq = -1;
  private _liveSince: number | null = null;
  private _loading: number | null = null;

  get version(): number {
    return this._version;
  }

  get size(): number {
    return this._byId.size;
  }

  get lastTs(): number {
    return this._lastTs;
  }

  get lastSeq(): number {
    return this._lastSeq;
  }

  get liveSince(): number | null {
    return this._liveSince;
  }

  get loading(): number | null {
    return this._loading;
  }

  trusted(): boolean {
    return this._synced && !this._untrusted;
  }

  apply(frame: ExhaustionShadesFrame): ExhaustionApplyOutcome {
    let outcome: ExhaustionApplyOutcome = "ignored";
    if (frame.reset) {
      this._byId = new Map();
      this._synced = true;
      this._untrusted = false;
      outcome = "reset";
    } else if (!this._synced) {
      return "ignored";
    }
    for (const shade of frame.shades) {
      const known = this._byId.get(shade.id);
      if (known !== undefined && known.updatedAt > shade.updatedAt) continue;
      this._byId.set(shade.id, shade);
      if (outcome === "ignored") outcome = "applied";
    }
    if (outcome === "ignored" && frame.loading === this._loading) return outcome;
    if (outcome === "ignored") outcome = "applied";
    this._loading = frame.loading;
    this._liveSince = frame.liveSince;
    this._lastTs = frame.ts;
    this._lastSeq = frame.seq;
    this._sorted = null;
    this._version += 1;
    return outcome;
  }

  list(): readonly ExhaustionShade[] {
    if (this._sorted === null) this._sorted = Object.freeze([...this._byId.values()].sort(byStart));
    return this._sorted;
  }

  get(id: string): ExhaustionShade | undefined {
    return this._byId.get(id);
  }

  markUntrusted(): void {
    if (this._untrusted) return;
    this._untrusted = true;
    this._version += 1;
  }

  clear(): void {
    this._byId = new Map();
    this._sorted = null;
    this._synced = false;
    this._liveSince = null;
    this._loading = null;
    this._untrusted = false;
    this._lastTs = 0;
    this._lastSeq = -1;
    this._version += 1;
  }
}

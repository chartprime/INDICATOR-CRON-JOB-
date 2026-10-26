import type { InitiativeBand, InitiativeBandsFrame } from "../../types/frames";

export type InitiativeApplyOutcome = "reset" | "applied" | "ignored";

export const INITIATIVE_BOOK_KEEP_MS = 7 * 86_400_000;

function byPivot(a: InitiativeBand, b: InitiativeBand): number {
  return a.pivotTs - b.pivotTs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export class InitiativeBook {
  private _byId = new Map<string, InitiativeBand>();
  private _sorted: readonly InitiativeBand[] | null = null;
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

  apply(frame: InitiativeBandsFrame): InitiativeApplyOutcome {
    let outcome: InitiativeApplyOutcome = "ignored";
    if (frame.reset) {
      this._byId = new Map();
      this._synced = true;
      this._untrusted = false;
      outcome = "reset";
    } else if (!this._synced) {
      return "ignored";
    }
    const horizon = frame.ts - INITIATIVE_BOOK_KEEP_MS;
    for (const band of frame.bands) {
      if (band.frozenTs < horizon) continue;
      const known = this._byId.get(band.id);
      if (known !== undefined && known.updatedAt > band.updatedAt) continue;
      this._byId.set(band.id, band);
      if (outcome === "ignored") outcome = "applied";
    }
    for (const [id, band] of this._byId) {
      if (band.frozenTs >= horizon) continue;
      this._byId.delete(id);
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

  list(): readonly InitiativeBand[] {
    if (this._sorted === null) this._sorted = Object.freeze([...this._byId.values()].sort(byPivot));
    return this._sorted;
  }

  get(id: string): InitiativeBand | undefined {
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

import type { IcebergOrder, IcebergOrdersFrame } from "../../types/frames";

export type IcebergApplyOutcome = "reset" | "applied" | "ignored";

function byMark(a: IcebergOrder, b: IcebergOrder): number {
  return a.markedAt - b.markedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export class IcebergBook {
  private _byId = new Map<string, IcebergOrder>();
  private _sorted: readonly IcebergOrder[] | null = null;
  private _version = 0;
  private _synced = false;
  private _untrusted = false;
  private _lastTs = 0;
  private _lastSeq = -1;
  private _watched: ReadonlyArray<readonly [number, number]> = [];
  private _liveSince: number | null = null;

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

  get watched(): ReadonlyArray<readonly [number, number]> {
    return this._watched;
  }

  get liveSince(): number | null {
    return this._liveSince;
  }

  get historyFrom(): number | null {
    let from = this._watched.length === 0 ? null : this._watched[0][0];
    for (const iceberg of this._byId.values()) {
      if (iceberg.origin === "runtime" && iceberg.status !== "active" && (from === null || iceberg.markedAt < from)) from = iceberg.markedAt;
    }
    return from;
  }

  trusted(): boolean {
    return this._synced && !this._untrusted;
  }

  apply(frame: IcebergOrdersFrame): IcebergApplyOutcome {
    let outcome: IcebergApplyOutcome = "ignored";
    if (frame.reset) {
      this._byId = new Map();
      this._synced = true;
      this._untrusted = false;
      outcome = "reset";
    } else if (!this._synced) {
      return "ignored";
    }
    for (const iceberg of frame.icebergs) {
      const known = this._byId.get(iceberg.id);
      if (known !== undefined && known.updatedAt > iceberg.updatedAt) continue;
      this._byId.set(iceberg.id, iceberg);
      if (outcome === "ignored") outcome = "applied";
    }
    if (outcome === "ignored") return outcome;
    this._watched = frame.watched;
    this._liveSince = frame.liveSince;
    this._lastTs = frame.ts;
    this._lastSeq = frame.seq;
    this._sorted = null;
    this._version += 1;
    return outcome;
  }

  list(): readonly IcebergOrder[] {
    if (this._sorted === null) this._sorted = Object.freeze([...this._byId.values()].sort(byMark));
    return this._sorted;
  }

  get(id: string): IcebergOrder | undefined {
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
    this._watched = [];
    this._liveSince = null;
    this._untrusted = false;
    this._lastTs = 0;
    this._lastSeq = -1;
    this._version += 1;
  }
}

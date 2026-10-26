import type { L2WallsFrame } from "../../types/frames";
import { wallOf, type ApplyOutcome, type L2Wall } from "./types";

const EMPTY: readonly L2Wall[] = Object.freeze([]);

export class WallBook {
  private _walls = new Map<number, L2Wall>();
  private _seq: number | null = null;
  private _synced = false;
  private _lastTs: number | null = null;
  private _list: readonly L2Wall[] | null = EMPTY;

  get seq(): number | null {
    return this._seq;
  }

  get synced(): boolean {
    return this._synced;
  }

  get lastTs(): number | null {
    return this._lastTs;
  }

  apply(frame: L2WallsFrame): ApplyOutcome {
    if (frame.reset) {
      this._walls = new Map(frame.walls.map((wire) => [wire.id, wallOf(wire)]));
      this._seq = frame.seq;
      this._synced = true;
      this._lastTs = frame.ts;
      this._list = null;
      return "applied";
    }
    if (this._synced && this._seq !== null && frame.seq <= this._seq) return "duplicate";
    if (!this._synced || this._seq === null || frame.seq !== this._seq + 1) {
      this._synced = false;
      return "gap";
    }
    for (const wire of frame.walls) this._walls.set(wire.id, wallOf(wire));
    for (const id of frame.removed) this._walls.delete(id);
    this._seq = frame.seq;
    this._lastTs = frame.ts;
    this._list = null;
    return "applied";
  }

  list(): readonly L2Wall[] {
    if (this._list === null) this._list = Object.freeze([...this._walls.values()].sort((a, b) => a.startTs - b.startTs || a.id - b.id));
    return this._list;
  }

  get(id: number): L2Wall | null {
    return this._walls.get(id) ?? null;
  }

  markUntrusted(): void {
    this._synced = false;
  }

  clear(): void {
    this._walls = new Map();
    this._seq = null;
    this._synced = false;
    this._lastTs = null;
    this._list = EMPTY;
  }
}

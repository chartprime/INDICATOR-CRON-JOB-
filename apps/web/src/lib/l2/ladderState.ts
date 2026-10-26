import type { L2LadderFrame } from "../../types/frames";
import type { L2Ladder } from "./types";

export class LadderState {
  private _ladder: L2Ladder | null = null;
  private _synced = false;

  get ladder(): L2Ladder | null {
    return this._ladder;
  }

  get synced(): boolean {
    return this._synced;
  }

  get lastTs(): number | null {
    return this._ladder?.ts ?? null;
  }

  apply(frame: L2LadderFrame): void {
    this._ladder = Object.freeze({
      ts: frame.ts,
      depth: frame.depth,
      bids: Object.freeze(frame.bids.map(([price, size]) => Object.freeze([price, size] as const))),
      asks: Object.freeze(frame.asks.map(([price, size]) => Object.freeze([price, size] as const))),
    });
    this._synced = true;
  }

  markUntrusted(): void {
    this._synced = false;
  }

  clear(): void {
    this._ladder = null;
    this._synced = false;
  }
}

import type { L2EventsFrame } from "../../types/frames";
import { eventOf, type ApplyOutcome, type L2Event } from "./types";

export const DEFAULT_L2_EVENT_CAPACITY = 5_000;

export interface L2EventSlice {
  readonly seq: number;
  readonly events: readonly L2Event[];
  readonly missed: number;
  readonly complete: boolean;
}

const EMPTY_SLICE: L2EventSlice = Object.freeze({ seq: 0, events: Object.freeze([]), missed: 0, complete: false });

export class EventRing {
  private _events: L2Event[] = [];
  private _seq: number | null = null;
  private _resetSeq: number | null = null;
  private _synced = false;
  private _missed = 0;
  private _missedThroughSeq: number | null = null;
  private _lastTs: number | null = null;
  private readonly _capacity: number;

  constructor(capacity: number = DEFAULT_L2_EVENT_CAPACITY) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error("EventRing: capacity must be a positive integer");
    this._capacity = capacity;
  }

  get seq(): number | null {
    return this._seq;
  }

  get synced(): boolean {
    return this._synced;
  }

  get lastTs(): number | null {
    return this._lastTs;
  }

  get missed(): number {
    return this._missed;
  }

  apply(frame: L2EventsFrame): ApplyOutcome {
    if (frame.reset) {
      this._events = frame.events.map(eventOf);
      this._seq = frame.seq;
      this._resetSeq = frame.seq;
      this._synced = true;
      this._missed = 0;
      this._missedThroughSeq = null;
      this._lastTs = frame.ts;
      this._trim();
      return "applied";
    }
    if (this._synced && this._seq !== null && (frame.events.length === 0 ? frame.seq < this._seq : frame.seq <= this._seq)) return "duplicate";
    if (!this._synced || this._seq === null || frame.seq - frame.events.length !== this._seq) {
      this._synced = false;
      return "gap";
    }
    for (const wire of frame.events) this._events.push(eventOf(wire));
    this._seq = frame.seq;
    this._missed += frame.missed;
    if (frame.missed > 0) this._missedThroughSeq = frame.seq;
    this._lastTs = frame.ts;
    this._trim();
    return "applied";
  }

  since(sinceSeq?: number): L2EventSlice {
    if (this._seq === null || this._resetSeq === null) return EMPTY_SLICE;
    const oldestExact = this._seq - this._events.length;
    const exact = sinceSeq !== undefined && sinceSeq >= this._resetSeq && sinceSeq >= oldestExact && sinceSeq <= this._seq;
    const events = exact ? this._events.slice(this._events.length - (this._seq - sinceSeq)) : this._events.slice();
    const afterReportedLoss = this._missedThroughSeq === null || (sinceSeq !== undefined && sinceSeq > this._missedThroughSeq);
    return Object.freeze({ seq: this._seq, events: Object.freeze(events), missed: this._missed, complete: exact && this._synced && afterReportedLoss });
  }

  markUntrusted(): void {
    this._synced = false;
  }

  clear(): void {
    this._events = [];
    this._seq = null;
    this._resetSeq = null;
    this._synced = false;
    this._missed = 0;
    this._missedThroughSeq = null;
    this._lastTs = null;
  }

  private _trim(): void {
    if (this._events.length > this._capacity) this._events.splice(0, this._events.length - this._capacity);
  }
}

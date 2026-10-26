import type { L2Channel, L2EventsFrame, L2LadderFrame, L2Segment as L2SegmentWire, L2ViewFrame, L2WallsFrame } from "../../types/frames";
import { EventRing } from "./eventRing";
import { LadderState } from "./ladderState";
import { LaneGrids, type LaneYardstick, type DecodedLane } from "./laneGrids";
import type { L2ChannelStatus, L2Segment } from "./types";
import { WallBook } from "./wallBook";

export const L2_RESYNC_DEBOUNCE_MS = 3_000;

export type L2Frame = L2ViewFrame | L2WallsFrame | L2EventsFrame | L2LadderFrame;

export interface L2StoreOptions {
  now?: () => number;
  requestResync?: (channel: L2Channel) => void;
  yardstick?: LaneYardstick | null;
}

function segmentStart(id: string): number | null {
  const match = /:(\d+):(LIVE|GAP)$/.exec(id);
  if (match === null) return null;
  const start = Number(match[1]);
  return Number.isSafeInteger(start) ? start : null;
}

export class L2Store {
  readonly lanes: LaneGrids;
  readonly walls = new WallBook();
  readonly events = new EventRing();
  readonly ladder = new LadderState();
  private _version = 0;
  private _segment: L2Segment | null = null;
  private _segmentPriority = 0;
  private _segmentFromEvents = false;
  private readonly _frameAt = new Map<L2Channel, number>();
  private readonly _resyncNotBefore = new Map<L2Channel, number>();
  private readonly _now: () => number;
  private readonly _requestResync: (channel: L2Channel) => void;

  constructor({ now = () => Date.now(), requestResync = () => {}, yardstick = null }: L2StoreOptions = {}) {
    this._now = now;
    this._requestResync = requestResync;
    this.lanes = new LaneGrids({ yardstick });
  }

  get version(): number {
    return this._version;
  }

  get segment(): L2Segment | null {
    return this._segment;
  }

  apply(frame: L2Frame, decodedLane: DecodedLane | null = null): boolean {
    if (frame.type === "l2_ladder") {
      this.ladder.apply(frame);
      this._adoptSegment(frame.segment, 4);
      this._frameAt.set(frame.type, this._now());
      this._version += 1;
      return true;
    }
    const wasSynced = frame.type === "l2_view" ? this.lanes.laneSynced(frame.lane) : frame.type === "l2_walls" ? this.walls.synced : this.events.synced;
    const outcome = frame.type === "l2_view"
      ? decodedLane === null ? this.lanes.apply(frame) : this.lanes.applyDecoded(frame, decodedLane)
      : frame.type === "l2_walls" ? this.walls.apply(frame) : this.events.apply(frame);
    if (outcome === "gap") {
      if (wasSynced) this._version += 1;
      this._resync(frame.type);
      return false;
    }
    if (outcome === "duplicate") return false;
    this._frameAt.set(frame.type, this._now());
    if (frame.type === "l2_events") {
      for (const event of frame.events) if (event.event === "segment") this._adoptSegment({ id: event.segment, state: event.state }, 2, true);
    } else {
      this._adoptSegment(frame.segment, frame.type === "l2_walls" ? 3 : 1);
    }
    this._version += 1;
    return true;
  }

  status(channel: L2Channel): L2ChannelStatus {
    const lastFrameAt = this._frameAt.get(channel) ?? null;
    if (channel === "l2_ladder") {
      return Object.freeze({ synced: this.ladder.synced, seq: null, lastTs: this.ladder.lastTs, lastFrameAt });
    }
    const model = channel === "l2_view" ? this.lanes : channel === "l2_walls" ? this.walls : this.events;
    return Object.freeze({ synced: model.synced, seq: model.seq, lastTs: model.lastTs, lastFrameAt });
  }

  trusted(channels: readonly L2Channel[] = ["l2_walls", "l2_events"]): boolean {
    if (this._segment === null || this._segment.state !== "LIVE") return false;
    return channels.every((channel) => this.status(channel).synced);
  }

  markUntrusted(): void {
    this.lanes.markUntrusted();
    this.walls.markUntrusted();
    this.events.markUntrusted();
    this.ladder.markUntrusted();
    this._segmentFromEvents = false;
    this._version += 1;
  }

  clear(): void {
    this.lanes.clear();
    this.walls.clear();
    this.events.clear();
    this.ladder.clear();
    this._segment = null;
    this._segmentPriority = 0;
    this._segmentFromEvents = false;
    this._frameAt.clear();
    this._resyncNotBefore.clear();
    this._version += 1;
  }

  private _adoptSegment(segment: L2SegmentWire | null, priority: number, orderedEvent = false): void {
    if (segment === null) return;
    const incomingStart = segmentStart(segment.id);
    const currentStart = this._segment === null ? null : segmentStart(this._segment.id);
    if (incomingStart !== null && currentStart !== null) {
      if (incomingStart < currentStart) return;
      if (incomingStart === currentStart && !orderedEvent && (
        (this._segmentFromEvents && segment.state !== this._segment?.state) || priority < this._segmentPriority
      )) return;
    }
    const newer = this._segment === null || currentStart === null || (incomingStart !== null && incomingStart > currentStart);
    if (this._segment === null || this._segment.id !== segment.id || this._segment.state !== segment.state) {
      this._segment = Object.freeze({ id: segment.id, state: segment.state });
    }
    this._segmentPriority = newer || orderedEvent
      ? priority
      : Math.max(this._segmentPriority, priority);
    this._segmentFromEvents = newer ? orderedEvent : this._segmentFromEvents || orderedEvent;
  }

  private _resync(channel: L2Channel): void {
    const at = this._now();
    if (at < (this._resyncNotBefore.get(channel) ?? 0)) return;
    this._resyncNotBefore.set(channel, at + L2_RESYNC_DEBOUNCE_MS);
    this._requestResync(channel);
  }
}

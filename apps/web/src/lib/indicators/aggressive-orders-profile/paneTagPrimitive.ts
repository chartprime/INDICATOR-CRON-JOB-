import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { IPanePrimitive, IPanePrimitivePaneView, IPrimitivePaneRenderer, PrimitivePaneViewZOrder, Time } from "lightweight-charts";

export const PANE_TAG_LEFT_PX = 8;
export const PANE_TAG_BOTTOM_PX = 4;
export const PANE_TAG_HEIGHT_PX = 16;
export const PANE_TAG_PAD_PX = 6;
export const PANE_TAG_FONT_PX = 10;

export interface PaneTagColours {
  text: string;
  fill: string;
  border: string;
}

export const PANE_TAG_DARK: PaneTagColours = { text: "rgba(250, 250, 247, 0.85)", fill: "rgba(32, 32, 32, 0.92)", border: "rgba(250, 250, 247, 0.18)" };
export const PANE_TAG_LIGHT: PaneTagColours = { text: "rgba(10, 10, 10, 0.78)", fill: "rgba(255, 255, 255, 0.92)", border: "rgba(10, 10, 10, 0.14)" };

const DEFAULT_FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif";

class TagRenderer implements IPrimitivePaneRenderer {
  private readonly _host: PaneTagPrimitive;

  constructor(host: PaneTagPrimitive) {
    this._host = host;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const host = this._host;
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      const top = mediaSize.height - PANE_TAG_BOTTOM_PX - PANE_TAG_HEIGHT_PX;
      if (top < 0) return;
      context.save();
      try {
        context.font = `600 ${PANE_TAG_FONT_PX}px ${host.fontFamily}`;
        const width = Math.ceil(context.measureText(host.text).width) + PANE_TAG_PAD_PX * 2;
        context.fillStyle = host.colours.fill;
        context.fillRect(PANE_TAG_LEFT_PX, top, width, PANE_TAG_HEIGHT_PX);
        context.strokeStyle = host.colours.border;
        context.lineWidth = 1;
        context.strokeRect(PANE_TAG_LEFT_PX + 0.5, top + 0.5, width - 1, PANE_TAG_HEIGHT_PX - 1);
        context.fillStyle = host.colours.text;
        context.textAlign = "left";
        context.textBaseline = "middle";
        context.fillText(host.text, PANE_TAG_LEFT_PX + PANE_TAG_PAD_PX, top + PANE_TAG_HEIGHT_PX / 2);
      } finally {
        context.restore();
      }
    });
  }
}

class TagView implements IPanePrimitivePaneView {
  private readonly _renderer: TagRenderer;

  constructor(host: PaneTagPrimitive) {
    this._renderer = new TagRenderer(host);
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "top";
  }

  renderer(): IPrimitivePaneRenderer | null {
    return this._renderer;
  }
}

export class PaneTagPrimitive implements IPanePrimitive<Time> {
  readonly text: string;
  readonly colours: PaneTagColours;
  readonly fontFamily: string;
  private readonly _views: readonly IPanePrimitivePaneView[];

  constructor(text: string, dark: boolean, fontFamily = DEFAULT_FONT_FAMILY) {
    this.text = text;
    this.colours = dark ? PANE_TAG_DARK : PANE_TAG_LIGHT;
    this.fontFamily = fontFamily;
    this._views = [new TagView(this)];
  }

  paneViews(): readonly IPanePrimitivePaneView[] {
    return this._views;
  }
}

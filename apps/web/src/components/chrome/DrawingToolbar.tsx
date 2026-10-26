import type { DrawingToolId } from "../../lib/chart/drawingStore";

const DRAWING_TOOLS: readonly { id: DrawingToolId; label: string }[] = [
  { id: "trendline", label: "Trendline" },
  { id: "fibonacci", label: "Fibonacci" },
  { id: "fixedRangeProfile", label: "Fixed Range" },
];

interface DrawingToolbarProps {
  activeTool: DrawingToolId | null;
  onSelectTool: (tool: DrawingToolId | null) => void;
}

export function DrawingToolbar({ activeTool, onSelectTool }: DrawingToolbarProps) {
  return (
    <div className="drawing-toolbar" role="group" aria-label="Drawing tools">
      <button
        type="button"
        className={`tf-pill${activeTool === null ? " active" : ""}`}
        onClick={() => onSelectTool(null)}
        aria-pressed={activeTool === null}
        title="Cursor"
      >
        Cursor
      </button>
      {DRAWING_TOOLS.map((tool) => (
        <button
          key={tool.id}
          type="button"
          className={`tf-pill${activeTool === tool.id ? " active" : ""}`}
          onClick={() => onSelectTool(activeTool === tool.id ? null : tool.id)}
          aria-pressed={activeTool === tool.id}
          title={tool.label}
        >
          {tool.label}
        </button>
      ))}
    </div>
  );
}

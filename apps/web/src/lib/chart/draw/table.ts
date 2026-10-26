import { create, remove, tablesForOwners, update } from "./registry";

export type TablePosition = "top-right" | "bottom-right";

export interface TableOptions {
  position?: TablePosition;
}

export interface TableCellOptions {
  text: string;
  bgColor?: string;
  textColor?: string;
}

export interface TableCell {
  text: string;
  bgColor: string;
  textColor: string;
}

export interface TableData {
  position: TablePosition;
  pendingGrid: Record<string, TableCell>;
  committedGrid: Record<string, TableCell>;
}

export interface TableHandle {
  cell(row: number, col: number, options: TableCellOptions): void;
  delete(): void;
}

export const DEFAULT_TABLE_CELL_BG = "transparent";
export const DEFAULT_TABLE_CELL_TEXT_COLOR = "#d1d4dc";

function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

export function createTable(ownerId: string, options: TableOptions = {}): TableHandle {
  const handleId = create<TableData>(ownerId, "table", { position: options.position ?? "top-right", pendingGrid: {}, committedGrid: {} });

  return {
    cell(row, col, options) {
      update<TableData>(handleId, (data) => ({
        ...data,
        pendingGrid: {
          ...data.pendingGrid,
          [cellKey(row, col)]: {
            text: options.text,
            bgColor: options.bgColor ?? DEFAULT_TABLE_CELL_BG,
            textColor: options.textColor ?? DEFAULT_TABLE_CELL_TEXT_COLOR,
          },
        },
      }));
    },
    delete() {
      remove(handleId);
    },
  };
}

/**
 * Flips every table object owned by `ownerId` from its buffered pending grid
 * to the committed grid actually read for rendering -- called once per bar
 * transition (never per `.cell()` call) so a table's on-screen content only
 * ever changes once per bar, matching plotshape/plotchar's own discipline.
 */
export function flushTableCells(ownerId: string): void {
  for (const record of tablesForOwners([ownerId])) {
    update<TableData>(record.handleId, (data) => ({ ...data, committedGrid: data.pendingGrid }));
  }
}

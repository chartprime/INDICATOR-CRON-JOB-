// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { KillzonesSettingsModal } from "../KillzonesSettingsModal";
import { KILLZONE_SESSIONS, type KillzoneId } from "../killzones";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function render({
  visible = true,
  onVisibleChange = vi.fn<(visible: boolean) => void>(),
  selectedSessions = new Set<KillzoneId>(),
  onSessionChange = vi.fn<(sessionId: KillzoneId, selected: boolean) => void>(),
}: {
  visible?: boolean;
  onVisibleChange?: ReturnType<typeof vi.fn<(visible: boolean) => void>>;
  selectedSessions?: ReadonlySet<KillzoneId>;
  onSessionChange?: ReturnType<typeof vi.fn<(sessionId: KillzoneId, selected: boolean) => void>>;
} = {}): Promise<{
  container: HTMLDivElement;
  root: Root;
  onVisibleChange: ReturnType<typeof vi.fn<(visible: boolean) => void>>;
  onSessionChange: ReturnType<typeof vi.fn<(sessionId: KillzoneId, selected: boolean) => void>>;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <KillzonesSettingsModal
        isOpen={true}
        onClose={() => {}}
        visible={visible}
        onVisibleChange={onVisibleChange}
        selectedSessions={selectedSessions}
        onSessionChange={onSessionChange}
      />,
    );
  });
  return { container, root, onVisibleChange, onSessionChange };
}

function sessionCheckbox(container: HTMLDivElement, label: string): HTMLInputElement {
  const fieldset = container.querySelector(".indicator-settings-session-list")!;
  const row = Array.from(fieldset.querySelectorAll("label")).find((el) => el.textContent === label)!;
  return row.querySelector("input")!;
}

describe("KillzonesSettingsModal", () => {
  it("lists all six sessions in their defined order, labeled and unchecked by default", async () => {
    const { container } = await render();
    const rows = Array.from(container.querySelectorAll(".indicator-settings-session-list label"));
    expect(rows.map((row) => row.textContent)).toEqual(KILLZONE_SESSIONS.map((s) => s.label));
    expect(rows.every((row) => (row.querySelector("input") as HTMLInputElement).checked === false)).toBe(true);
  });

  it("reflects each session's selected state independently from selectedSessions", async () => {
    const { container } = await render({ selectedSessions: new Set(["london", "nypm"]) });
    for (const session of KILLZONE_SESSIONS) {
      const expected = session.id === "london" || session.id === "nypm";
      expect(sessionCheckbox(container, session.label).checked).toBe(expected);
    }
  });

  it.each(KILLZONE_SESSIONS.map((s) => [s.id, s.label] as const))(
    "checking the %s session box calls onSessionChange(%s, true)",
    async (id, label) => {
      const { container, onSessionChange } = await render();
      await act(async () => {
        sessionCheckbox(container, label).click();
      });
      expect(onSessionChange).toHaveBeenCalledWith(id, true);
    },
  );

  it.each(KILLZONE_SESSIONS.map((s) => [s.id, s.label] as const))(
    "unchecking an already-selected %s session box calls onSessionChange(%s, false)",
    async (id, label) => {
      const { container, onSessionChange } = await render({ selectedSessions: new Set([id]) });
      await act(async () => {
        sessionCheckbox(container, label).click();
      });
      expect(onSessionChange).toHaveBeenCalledWith(id, false);
    },
  );

  it("toggling one session never calls onSessionChange for any other session", async () => {
    const { container, onSessionChange } = await render();
    await act(async () => {
      sessionCheckbox(container, "London").click();
    });
    expect(onSessionChange).toHaveBeenCalledTimes(1);
    expect(onSessionChange).toHaveBeenCalledWith("london", true);
  });

  it("the Show on chart checkbox reflects visible and calls onVisibleChange independently of session toggles", async () => {
    const { container, onVisibleChange, onSessionChange } = await render({ visible: false });
    const showCheckbox = container.querySelector<HTMLInputElement>(".indicator-settings-checkbox input")!;
    expect(showCheckbox.checked).toBe(false);

    await act(async () => {
      showCheckbox.click();
    });

    expect(onVisibleChange).toHaveBeenCalledWith(true);
    expect(onSessionChange).not.toHaveBeenCalled();
  });
});

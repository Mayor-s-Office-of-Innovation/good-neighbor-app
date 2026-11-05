import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { showEnrollmentCode } from "./site-access-code.js";
import { t } from "../i18n/i18n.js";

vi.mock("../dialog-history.js", () => ({ openOverlayDialog: vi.fn() }));
let dialog, display, output, close, cancel, trigger, view;
function node() {
  const listeners = {};
  return {
    listeners,
    addEventListener: (name, handler) => {
      listeners[name] = handler;
    },
    click() {
      listeners.click?.({ currentTarget: this, target: this });
    },
    focus: vi.fn(),
    remove: vi.fn(),
    setAttribute: vi.fn(),
    replaceChildren: vi.fn(),
  };
}
beforeEach(() => {
  display = node();
  output = node();
  close = node();
  cancel = node();
  dialog = {
    ...node(),
    close() {
      this.listeners.close?.();
    },
    querySelector: (selector) =>
      ({
        "[data-display-code]": display,
        "[data-code-output]": output,
        "[data-cancel-code]": cancel,
      })[selector],
    querySelectorAll: () => [close, cancel],
  };
  trigger = {
    ...node(),
    disabled: false,
    isConnected: true,
    closest: () => null,
  };
  view = { append: vi.fn(), querySelector: () => null };
  vi.stubGlobal("document", { createElement: () => dialog });
  vi.stubGlobal("HTMLElement", class {});
});
afterEach(() => vi.unstubAllGlobals());

it.each(["close", "cancel", "escape"])(
  "allows reopening when dismissed before display via %s",
  (method) => {
    const grant = { code: "ABC234" };
    showEnrollmentCode(view, grant, trigger);
    if (method === "close") close.click();
    else if (method === "cancel") cancel.click();
    else dialog.close();
    expect(grant.code).toBe("ABC234");
    expect(trigger.disabled).toBe(false);
    expect(dialog.replaceChildren).toHaveBeenCalledOnce();
  },
);

it.each(["close", "cancel", "escape"])(
  "discards the displayed code and disables reopening after %s",
  (method) => {
    const grant = { code: "ABC234" };
    showEnrollmentCode(view, grant, trigger);
    display.click();
    expect(output.textContent).toBe("ABC234");
    expect(cancel.textContent).toBe(t("common.close"));
    expect(display.remove).toHaveBeenCalledOnce();
    expect(grant.code).toBeUndefined();
    if (method === "close") close.click();
    else if (method === "cancel") cancel.click();
    else dialog.close();
    expect(trigger.disabled).toBe(true);
    expect(dialog.replaceChildren).toHaveBeenCalledOnce();
    expect(dialog.remove).toHaveBeenCalledOnce();
    view.append.mockClear();
    showEnrollmentCode(view, grant, trigger);
    expect(view.append).not.toHaveBeenCalled();
  },
);

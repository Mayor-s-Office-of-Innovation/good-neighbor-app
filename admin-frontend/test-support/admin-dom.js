// Mounts <admin-app> against admin-mock.js's fake /admin/v1, so unit tests and
// the Playwright specs share one set of synthetic records and handlers.
import { afterAll, afterEach, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";
import {
  adminData,
  mockAdmin,
  mockFailures,
  releaseGates,
} from "../../e2e/admin-tests/admin-mock.js";
import { getToasts, onToastsChange } from "../../frontend/src/state/toasts.js";
import { quietInspect } from "./quiet-inspect.js";

// A local binding, so tests can keep importing window from here.
const { window } = globalThis;
quietInspect(window);
// Vitest turns off happy-dom's error capture; without it a handler's throw or
// rejection escapes the test that caused it instead of failing that test.
window.happyDOM.settings.disableErrorCapturing = false;

const FIELD_TAGS =
  "wa-input,wa-select,wa-textarea,wa-number-input,wa-checkbox,wa-switch";

/** A stand-in for Web Awesome's form controls: a value, a checked state and focus. */
class FakeControl extends window.HTMLElement {
  constructor() {
    super();
    // A click toggles a checkbox, as Web Awesome's does.
    this.addEventListener("click", () => {
      if (this.localName !== "wa-checkbox" || this.disabled) return;
      this.checked = !this.checked;
      for (const type of ["input", "change"])
        this.dispatchEvent(userEvent(type));
    });
  }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.localName === "wa-checkbox")
      return this.getAttribute("value") ?? "on";
    const multiple = this.hasAttribute("multiple");
    if (this.hasAttribute("value") || this.localName !== "wa-select") {
      const value = this.getAttribute("value") ?? "";
      return multiple ? value.split(" ").filter(Boolean) : value;
    }
    const chosen = [...this.querySelectorAll("wa-option")]
      .filter((option) => option.selected)
      .map((option) => option.getAttribute("value") ?? "");
    return multiple ? chosen : (chosen[0] ?? "");
  }
  set value(next) {
    this._value = next;
    const values = Array.isArray(next) ? next : [next];
    for (const option of this.querySelectorAll("wa-option"))
      option.selected = values.includes(option.getAttribute("value") ?? "");
  }
  get checked() {
    return this._checked ?? this.hasAttribute("checked");
  }
  set checked(next) {
    this._checked = Boolean(next);
  }
  get disabled() {
    return this._disabled ?? this.hasAttribute("disabled");
  }
  // Lit reflects the attribute on its next update, after the current task's FormData.
  set disabled(next) {
    this._disabled = Boolean(next);
    queueMicrotask(() => this.toggleAttribute("disabled", this._disabled));
  }
  get required() {
    return this.hasAttribute("required");
  }
  get name() {
    return this.getAttribute("name") || "";
  }
  get updateComplete() {
    return Promise.resolve(true);
  }
  checkValidity() {
    const value = String(this.value ?? "");
    if (this.localName === "wa-checkbox") return !this.required || this.checked;
    if (!value) return !this.required;
    const pattern = this.getAttribute("pattern");
    if (pattern && !new RegExp(`^(?:${pattern})$`).test(value)) return false;
    return (
      this.getAttribute("type") !== "email" ||
      /^[^@\s]+@[^@\s]+$/.test(value.trim())
    );
  }
  reportValidity() {
    return this.checkValidity();
  }
  setCustomValidity() {}
}
// happy-dom has no prompt; each test answers confirm() itself.
window.confirm = () => false;

window.customElements.define(
  "wa-option",
  class extends window.HTMLElement {
    get selected() {
      return this._selected ?? this.hasAttribute("selected");
    }
    set selected(next) {
      this._selected = Boolean(next);
    }
    get value() {
      return this.getAttribute("value") ?? "";
    }
    set value(next) {
      this.setAttribute("value", next);
    }
  },
);
for (const tag of FIELD_TAGS.split(","))
  window.customElements.define(tag, class extends FakeControl {});

// Browsers add form-associated custom elements to FormData; happy-dom can't.
class FormDataWithControls extends window.FormData {
  /** @param {any} [form] @param {any} [submitter] */
  constructor(form, submitter) {
    super(form, submitter);
    if (!form) return;
    for (const control of form.querySelectorAll(FIELD_TAGS)) {
      if (!control.name || control.hasAttribute("disabled")) continue;
      if (control.localName === "wa-checkbox") {
        if (control.checked) this.append(control.name, control.value);
      } else if (Array.isArray(control.value)) {
        for (const value of control.value) this.append(control.name, value);
      } else this.append(control.name, String(control.value ?? ""));
    }
  }
}
Object.defineProperty(globalThis, "FormData", {
  configurable: true,
  value: FormDataWithControls,
});
// Form-associated controls return to their markup's value when a form resets.
window.document.addEventListener(
  "reset",
  (event) => {
    for (const control of event.target.querySelectorAll(FIELD_TAGS)) {
      control._value = undefined;
      control._checked = undefined;
    }
    for (const option of event.target.querySelectorAll("wa-option"))
      option._selected = undefined;
  },
  true,
);
// Form-associated controls are listed in form.elements in a browser.
Object.defineProperty(window.HTMLFormElement.prototype, "elements", {
  configurable: true,
  get() {
    return [
      ...this.querySelectorAll(
        `input,select,textarea,button,fieldset,output,${FIELD_TAGS}`,
      ),
    ];
  },
});
// Real forms block submit when a required Web Awesome field is blank.
const checkValidity = window.HTMLFormElement.prototype.checkValidity;
window.HTMLFormElement.prototype.checkValidity = function () {
  const controls = [...this.querySelectorAll(FIELD_TAGS)];
  return (
    controls.every((control) => control.checkValidity()) &&
    checkValidity.call(this)
  );
};
window.HTMLFormElement.prototype.reportValidity =
  window.HTMLFormElement.prototype.checkValidity;

// happy-dom matches nothing for :modal, which hides errors meant for an open dialog.
const querySelectorAll = window.document.querySelectorAll;
window.document.querySelectorAll = function (selector) {
  return querySelectorAll.call(
    this,
    selector === "dialog:modal" ? "dialog[open]" : selector,
  );
};

/**
 * One mounted app's routes and what reached the page while it was mounted. A
 * request is charged to the mount that was current when it started.
 * @typedef {{
 *   routes: { pattern: RegExp, handler: (route: any) => any }[],
 *   otherFetch: ((url: string, init: any) => Response | undefined) | null,
 *   fetch: string[],
 *   mocks: string[][],
 *   errors: string[],
 * }} Mount
 */
/** @type {Mount | null} */
let mount = null;
/** Mounts made in the running test; its teardown drains and checks each one. @type {Mount[]} */
let mounts = [];
/** Errors and requests while no app was mounted, checked at the next teardown or afterAll(). @type {string[]} */
let strayErrors = [];
/** @type {string[]} */
let strayFetches = [];
// Counts fetch starts and ends, so settle() can tell a held request from progress.
let activity = 0;

const page = {
  /** @param {() => void} script */
  addInitScript: async (script) => script(),
  // admin-mock's settle(page) needs a browser page.
  evaluate: async () => {
    throw new Error(
      "page.evaluate is unavailable in the unit harness: use admin-dom's settle(), not api.expectNotSent()",
    );
  },
  waitForResponse: async () => {
    throw new Error(
      "page.waitForResponse is unavailable in the unit harness: release the gate, then await admin-dom's settle()",
    );
  },
  /** @param {RegExp | string} pattern @param {(route: any) => any} handler */
  route: async (pattern, handler) => {
    mount?.routes.push({
      pattern: typeof pattern === "string" ? globToRegExp(pattern) : pattern,
      handler,
    });
  },
};

/**
 * Matches URLs as Playwright 1.63's globToRegexPattern does, so a spec's
 * page.route() glob catches the same requests here.
 * @param {string} glob
 */
export function globToRegExp(glob) {
  let source = "";
  let inGroup = false;
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "\\" && index + 1 < glob.length) {
      source += escapeGlobChar(glob[++index]);
    } else if (char === "*") {
      const before = glob[index - 1];
      let stars = 1;
      while (glob[index + 1] === "*") {
        stars++;
        index++;
      }
      if (stars === 1) source += "[^/]*";
      else if (glob[index + 1] !== "/") source += ".*";
      else {
        index++;
        source += before === "/" ? "(?:.+/|)" : ".*/";
      }
    } else if (char === "{") {
      if (inGroup) throw new Error(`Nested { in glob ${glob}`);
      inGroup = true;
      source += "(?:";
    } else if (char === "}") {
      if (!inGroup) throw new Error(`Unmatched } in glob ${glob}`);
      inGroup = false;
      source += ")";
    } else if (char === "," && inGroup) source += "|";
    else source += escapeGlobChar(char);
  }
  if (inGroup) throw new Error(`Unmatched { in glob ${glob}`);
  return new RegExp(`^${source}$`);
}

/**
 * Playwright's precedence: contentType, then a content-type header, then JSON
 * only for a json reply.
 * @param {{ json?: any, body?: string, contentType?: string, headers?: Record<string, string> }} reply
 */
function fulfillHeaders(reply) {
  const headers = Object.fromEntries(
    Object.entries(reply.headers || {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  if (reply.contentType) headers["content-type"] = reply.contentType;
  else if (reply.body === undefined && reply.json !== undefined)
    headers["content-type"] = "application/json";
  return headers;
}

/**
 * Empty for a status-only reply, as Playwright sends it. Response() throws on
 * a body for 204, 205 or 304, which would leave the page's fetch hanging.
 * @param {{ status?: number, json?: any, body?: string }} reply
 */
function fulfillBody(reply) {
  if ([204, 205, 304].includes(reply.status ?? 200)) return null;
  if (reply.body !== undefined) return reply.body;
  return reply.json !== undefined ? JSON.stringify(reply.json) : "";
}

/** @param {string} char */
function escapeGlobChar(char) {
  return /[$^+.*()|\\?{}[\]]/.test(char) ? `\\${char}` : char;
}

// happy-dom catches a listener's throw or rejection and only fires this event,
// so without it a handler that crashes leaves the test passing.
window.addEventListener("error", (/** @type {any} */ event) => {
  (mount?.errors ?? strayErrors).push(
    String(event.error?.message ?? event.message),
  );
});

globalThis.fetch = /** @type {any} */ (
  async (/** @type {any} */ input, /** @type {any} */ init = {}) => {
    const url = String(input?.url ?? input);
    const method = init.method || "GET";
    const owner = mount;
    /** @returns {Response} */
    const noRoute = () => {
      // A request that outlives its test's checks is checked at the next teardown.
      (owner && mounts.includes(owner) ? owner.fetch : strayFetches).push(
        `${method} ${url}`,
      );
      return new Response("{}", { status: 404 });
    };
    activity++;
    try {
      if (init.signal?.aborted)
        throw new DOMException("The operation was aborted.", "AbortError");
      const other = owner?.otherFetch?.(url, init);
      if (other) return await other;
      // Newest first, as Playwright tries routes.
      const matching = (owner?.routes ?? [])
        .filter(({ pattern }) => pattern.test(url))
        .reverse();
      if (!matching.length) return noRoute();
      return await new Promise((resolve, reject) => {
        // A browser rejects a pending request when its signal aborts, not only at the start.
        init.signal?.addEventListener(
          "abort",
          () =>
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            ),
          { once: true },
        );
        const request = {
          url: () => url,
          method: () => method,
          postData: () => init.body ?? null,
          headers: () => init.headers || {},
        };
        /** @param {number} index */
        const run = (index) => {
          const route = matching[index];
          if (!route) return resolve(noRoute());
          Promise.resolve(
            route.handler({
              request: () => request,
              fulfill: async (
                /** @type {{ status?: number, json?: any, body?: string, contentType?: string, headers?: Record<string, string> }} */ reply,
              ) =>
                resolve(
                  new Response(fulfillBody(reply), {
                    status: reply.status || 200,
                    headers: fulfillHeaders(reply),
                  }),
                ),
              fallback: async () => run(index + 1),
            }),
          ).catch(reject);
        };
        run(0);
      });
    } finally {
      activity++;
    }
  }
);

// A fake clock (vite.config.js lists what it fakes): toast, notice and retry
// timers neither slow a test nor outlive it.
beforeEach(() => {
  vi.useFakeTimers({ now: Date.now() });
});
afterEach(() => teardown());

/**
 * Release, drain and remove the test's mounts, then fail on any route gap or
 * page error they saw. afterEach runs it; a test may call it to check it.
 */
export async function teardown() {
  const checked = mounts;
  const strays = { fetches: strayFetches, errors: strayErrors };
  strayFetches = [];
  strayErrors = [];
  /** @type {any} */
  let settleError = null;
  try {
    // A failed assert can skip a test's release(); its held read would then
    // stay in admin-api's shared reads and stall the next test's same read.
    releaseGates();
    // Late renders and requests count against this test, not the next one.
    await settle();
  } catch (error) {
    // Kept for after the checks below, so a stalled settle() can't hide a route gap.
    settleError = error;
  } finally {
    mounts = [];
    mount = null;
    // A held request stays pending: rejecting it would run the removed app's
    // error paths, which a browser closing the page never does.
    current?.remove();
    current = null;
    // Toasts close first: clearing a timer from an earlier fake clock removes a live one.
    closeToasts();
    vi.useRealTimers();
  }
  const failures = [
    ...strays.fetches,
    ...strayFetches,
    ...checked.flatMap((each) => [...each.fetch, ...each.mocks.flat()]),
  ];
  // A held handler can throw after this check, so the next teardown sees it.
  for (const list of checked.flatMap((each) => each.mocks))
    list.push = (/** @type {string[]} */ ...items) =>
      strayFetches.push(...items);
  const errors = [
    ...strays.errors,
    ...strayErrors,
    ...checked.flatMap((each) => each.errors),
  ];
  strayFetches = [];
  strayErrors = [];
  if (settleError && (failures.length || errors.length))
    settleError.message += `; also ${JSON.stringify({ failures, errors })}`;
  if (settleError) throw settleError;
  // The same checks as the E2E fixture, so a mock gap or a crashed handler fails here too.
  assert.deepEqual(
    failures,
    [],
    "requests with no mock route or a handler that threw",
  );
  assert.deepEqual(errors, [], "uncaught page errors");
}

/**
 * Let fetches, promise chains, renders and zero-delay tasks finish. A request a
 * test holds open counts as finished once nothing else moves.
 */
export async function settle() {
  let quiet = 0;
  let seen = -1;
  for (let turn = 0; turn < 400 && quiet < 6; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
    // Zero-delay timers run as they would in a browser; longer ones wait for tick().
    if (vi.isFakeTimers()) vi.advanceTimersByTime(0);
    quiet = activity === seen ? quiet + 1 : 0;
    seen = activity;
  }
  // Returning anyway would let a test assert mid-flight, on a page that hasn't caught up.
  if (quiet < 6)
    throw new Error("settle(): fetches kept starting for 400 turns");
}

/**
 * Wait for work settle() can't see, such as a digest off the event loop.
 * The deadline is wall-clock time, since the fake clock doesn't move it.
 * @param {() => unknown} predicate
 * @param {{ timeout?: number }} [options] milliseconds
 */
export async function waitFor(predicate, { timeout = 1000 } = {}) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > deadline)
      throw new Error(`waitFor(): condition still false after ${timeout} ms`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

await import("../src/main.js");
// main.js lazy-loads the /system-status page; Vite's first load of that file
// outlasts settle(), so a test on that page would assert before it draws.
await import("../src/system-status.js");
document.body.append(document.createElement("app-toasts"));

/** @type {any} */
let current = null;

// Open toasts hold 3.5 s timers that would keep each test process alive.
function closeToasts() {
  // getToasts() shows one queued toast at a time, so drain until none is left.
  for (let toast = getToasts()[0]; toast; ) {
    toast.close();
    const next = getToasts()[0];
    if (next === toast) break;
    toast = next;
  }
  toastsSeen.clear();
}
afterAll(() => {
  // Nothing checks after the last test's teardown otherwise.
  assert.deepEqual(
    strayFetches,
    [],
    "requests with no mock route or a handler that threw",
  );
  assert.deepEqual(strayErrors, [], "uncaught page errors");
});

/**
 * Mount a fresh <admin-app> at `path` against fresh synthetic data.
 * @param {string} path
 * @param {{ role?: "compliance-supervisor" | "compliance-manager", data?: any, setup?: (api: any) => void, fetch?: (url: string, init: any) => Response | undefined }} [options]
 */
export async function mountAdmin(path = "/sites", options = {}) {
  // A read the old app still holds can be joined by the new app's identical
  // read (admin-api shares simultaneous reads), so release gates before remounting.
  if (current) {
    releaseGates();
    await settle();
  }
  current?.remove();
  closeToasts();
  mount = {
    routes: [],
    otherFetch: options.fetch || null,
    fetch: [],
    mocks: [],
    errors: [],
  };
  mounts.push(mount);
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, "", path);
  const api = await mockAdmin(/** @type {any} */ (page), {
    role: options.role,
    data: options.data || adminData(),
  });
  mount.mocks.push(mockFailures(/** @type {any} */ (page)));
  options.setup?.(api);
  current = document.createElement("admin-app");
  document.body.append(current);
  await settle();
  return { app: /** @type {any} */ (current), api };
}

// CSS class: back links share the brand link's href and data-route.
export const brandLink = "a.brand";

/** @param {string} selector @returns {any} */
export function $(selector) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`No element matches ${selector}`);
  return element;
}

/** @param {string} selector @returns {any[]} */
export function $$(selector) {
  return [...document.querySelectorAll(selector)];
}

// Tests assert on these booleans, not on nodes: a failed assertion prints its
// values, and a happy-dom node drags in its whole window.

/** @param {string} selector */
export function missing(selector) {
  return !document.querySelector(selector);
}

/** @param {string} selector */
export function focused(selector) {
  return document.activeElement === document.querySelector(selector);
}

/** @param {string} selector */
export function text(selector) {
  return $(selector).textContent.replace(/\s+/g, " ").trim();
}

/** The visible text of the whole app, whitespace collapsed. */
export function pageText() {
  return (current?.textContent || "").replace(/\s+/g, " ").trim();
}

/** @param {string | Element} target */
export async function click(target) {
  const element = typeof target === "string" ? $(target) : target;
  element.click();
  await settle();
}

/**
 * Find a button or link by its visible text.
 * @param {string} label
 * @param {string} [scope]
 * @returns {any}
 */
export function byText(label, scope = "button, a") {
  const match = $$(scope).find(
    (element) => element.textContent.replace(/\s+/g, " ").trim() === label,
  );
  if (!match) throw new Error(`No ${scope} with text ${label}`);
  return match;
}

/** An event as a user's action fires it; happy-dom leaves isTrusted unset. @param {string} type */
export function userEvent(type) {
  const event = new window.Event(type, { bubbles: true });
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
}

/**
 * Set a field's value and fire the events a user's typing fires.
 * @param {string | Element} target
 * @param {string | string[] | boolean} value
 */
export async function fill(target, value) {
  const element = typeof target === "string" ? $(target) : target;
  // A user opens a select's listbox before picking from it.
  if (element.localName === "wa-select")
    element.dispatchEvent(new window.Event("wa-show"));
  if (typeof value === "boolean") element.checked = value;
  else element.value = value;
  for (const type of ["input", "change"])
    element.dispatchEvent(userEvent(type));
  await settle();
}

/** @param {string | Element} target @param {string} key */
export async function press(target, key) {
  const element = typeof target === "string" ? $(target) : target;
  element.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    }),
  );
  await settle();
}

/** Run timers due within `ms` on the fake clock, then settle. @param {number} ms */
export async function tick(ms) {
  vi.advanceTimersByTime(ms);
  await settle();
}

/** @param {string | Element} target form or a control inside it */
export async function submit(target) {
  const element = typeof target === "string" ? $(target) : target;
  const form = element.localName === "form" ? element : element.form;
  form.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }),
  );
  await settle();
}

/**
 * Run `action` and return the one promise rejection nothing handled, so a
 * test can pin a known bug without failing on it. A second rejection throws,
 * so a new bug in the same action still fails the test.
 * @param {() => Promise<unknown>} action
 * @returns {Promise<any>}
 */
export async function unhandledRejection(action) {
  const listeners = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  /** @type {any[]} */
  const caught = [];
  process.on("unhandledRejection", (error) => caught.push(error));
  try {
    await action();
    await settle();
  } finally {
    process.removeAllListeners("unhandledRejection");
    for (const listener of listeners)
      process.on("unhandledRejection", listener);
  }
  if (caught.length > 1)
    throw new Error(
      `More than one unhandled rejection: ${caught.map((error) => error?.message ?? error).join("; ")}`,
    );
  return caught[0];
}

// Toast objects, not text: two announcements with the same words still count twice.
/** @type {Set<any>} */
const toastsSeen = new Set();
// Recorded as each shows, since a toast can time out during tick() before a test reads it.
onToastsChange(() => getToasts().forEach((toast) => toastsSeen.add(toast)));
/** @param {any} toast */
const toastLine = (toast) =>
  `${toast.title || ""} ${toast.message || ""}`.trim();

/**
 * Titles and messages of every toast shown since mountAdmin() ran. Toasts show
 * one at a time, so this lets each plain toast time out, as a reader would wait.
 */
export function toastText() {
  // Bounded, and stops on a toast that won't close, so a stuck toast can't spin forever.
  for (let shown = 0; shown < 20; shown++) {
    const next = getToasts().find((toast) => !toast.onDismiss);
    if (!next) break;
    next.close();
    if (getToasts().includes(next)) break;
  }
  return [...new Set([...toastsSeen].map(toastLine))].join(" ");
}

/**
 * How many separate toasts containing `fragment` have shown since mountAdmin() ran.
 * @param {string} fragment
 */
export function toastCount(fragment) {
  toastText();
  return [...toastsSeen].filter((toast) => toastLine(toast).includes(fragment))
    .length;
}

/** Text of every alert on the page, such as a failed action's notice. */
export function alertText() {
  return $$('[role="alert"]')
    .map((alert) => alert.textContent.replace(/\s+/g, " ").trim())
    .join(" ");
}

/** The page-level error banner's text, or "" when none shows. */
export function pageError() {
  return (
    document
      .querySelector('#main-content > [role="alert"]')
      ?.textContent.replace(/\s+/g, " ")
      .trim() || ""
  );
}

/** Move to a route the way main.js's router does, without a page load. @param {string} path */
export async function routeTo(path) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new window.PopStateEvent("popstate"));
  await settle();
}

// Exported so admin-dom.test.js can script replies the admin mock never sends.
export { window, adminData, page as fakePage };

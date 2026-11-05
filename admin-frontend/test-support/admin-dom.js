// Mounts one page, or the whole <admin-app> through app-mount.js, in happy-dom against
// the Playwright specs' fake /admin/v1 backend, so both suites share its records.
import { afterAll, afterEach, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";
import {
  adminData,
  fakeAdminApi,
  releaseGates,
} from "../../e2e/admin-tests/admin-mock.js";
import { getToasts, onToastsChange } from "../../frontend/src/state/toasts.js";
import { quietInspect } from "./quiet-inspect.js";
import { errorLineText } from "../src/admin-error-messages.js";
import { t } from "../../frontend/src/i18n/i18n.js";

/**
 * @typedef {import("../src/admin-catalog.js").AdminCatalog} AdminCatalog
 * @typedef {import("../src/admin-session.js").AdminSession} AdminSession
 */

// A local binding, so tests can keep importing window from here.
const { window } = globalThis;
quietInspect(window);
// Vitest turns off happy-dom's error capture; without it a handler's throw or
// rejection escapes the test that caused it instead of failing that test.
window.happyDOM.settings.disableErrorCapturing = false;

const FIELD_TAGS = "wa-input,wa-select,wa-textarea,wa-number-input,wa-checkbox";

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
    if (this.hasAttribute("value") || this.localName !== "wa-select")
      return this.getAttribute("value") ?? "";
    const chosen = [...this.querySelectorAll("wa-option")].find(
      (option) => option.selected,
    );
    return chosen?.getAttribute("value") ?? "";
  }
  set value(next) {
    this._value = next;
    for (const option of this.querySelectorAll("wa-option"))
      option.selected = (option.getAttribute("value") ?? "") === next;
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
 * One mount's fake backend and what reached the page while it was mounted. A
 * request is charged to the mount that was current when it started.
 * @typedef {{
 *   api: ReturnType<typeof fakeAdminApi>,
 *   otherFetch: ((url: string, init: any) => Response | undefined) | null,
 *   fetch: string[],
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

const abortError = () =>
  new DOMException("The operation was aborted.", "AbortError");

// happy-dom catches a listener's throw or rejection and only fires this event,
// so without it a handler that crashes leaves the test passing.
window.addEventListener("error", (/** @type {any} */ event) => {
  (mount?.errors ?? strayErrors).push(
    String(event.error?.message ?? event.message),
  );
});

globalThis.fetch = /** @type {any} */ (
  async (/** @type {any} */ input, /** @type {any} */ init = {}) => {
    const url = new URL(String(input?.url ?? input), window.location.href);
    const method = init.method || "GET";
    const owner = mount;
    activity++;
    try {
      if (init.signal?.aborted) throw abortError();
      const other = owner?.otherFetch?.(url.href, init);
      if (other) return await other;
      if (!owner || !url.pathname.startsWith("/admin/v1/")) {
        // A request that outlives its test's checks is checked at the next teardown.
        (owner && mounts.includes(owner) ? owner.fetch : strayFetches).push(
          `${method} ${url.href}`,
        );
        return new Response("{}", { status: 404 });
      }
      const reply = await new Promise((resolve, reject) => {
        // A browser rejects a pending request when its signal aborts, not only at the start.
        init.signal?.addEventListener("abort", () => reject(abortError()), {
          once: true,
        });
        owner.api
          .handle(method, url, init.body ?? null, init.headers || {})
          .then(resolve, reject);
      });
      const json = reply.body === undefined;
      const status = reply.status || 200;
      // A browser drops the body of these, so the page reads them as empty.
      const noBody = [204, 205, 304].includes(status);
      return new Response(
        noBody ? null : json ? JSON.stringify(reply.json ?? {}) : reply.body,
        {
          status,
          headers: {
            ...reply.headers,
            "content-type": json
              ? "application/json"
              : reply.contentType || "text/plain",
          },
        },
      );
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
    unfollow();
    current?.remove();
    current = null;
    // Toasts close first: clearing a timer from an earlier fake clock removes a live one.
    closeToasts();
    vi.useRealTimers();
  }
  const failures = [
    ...strays.fetches,
    ...strayFetches,
    ...checked.flatMap((each) => [...each.fetch, ...each.api.failures]),
  ];
  // A held handler can throw after this check, so the next teardown sees it.
  for (const list of checked.map((each) => each.api.failures))
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

const { createAdminCatalog, directorySites } = await import(
  "../src/admin-catalog.js"
);
const { createAdminSession } = await import("../src/admin-session.js");
const { currentRoute } = await import("../src/router.js");
document.body.append(document.createElement("app-toasts"));

/** @type {any} */
let current = null;
/** What <admin-app>'s error line would show for a page mounted alone. */
let pageErrorLine = "";
/** Stops a mountPage() `follow` listener, so it can't outlive its test. */
let unfollow = () => {};

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
 * Attach `element` as the test's mounted app, then settle. For app-mount.js.
 * @param {HTMLElement} element
 */
export async function attach(element) {
  current = element;
  document.body.append(current);
  await settle();
  return /** @type {any} */ (current);
}

/**
 * Mount one page element without <admin-app>, so the test loads only that page.
 * Requests outside `calls` fail the test; so do page errors, unless `recordErrors`.
 * @param {string} tag
 * @param {string} path
 * @param {{ calls: RegExp[], recordErrors?: boolean, follow?: string[], sites?: boolean, role?: "compliance-supervisor" | "compliance-manager", data?: any, setup?: (api: any) => void, catalog?: AdminCatalog, session?: AdminSession }} options an earlier mount's `catalog` and `session` share its lists and role
 */
export async function mountPage(tag, path, options) {
  // The test file imports the page's module, so the page alone is loaded.
  if (!customElements.get(tag)) throw new Error(`<${tag}> is not defined`);
  const api = await startMount(path, options);
  // Oldest handler, so the test's own handlers still answer first.
  api.on("*", /.*/, (/** @type {any} */ request) => {
    const call = `${request.method} ${request.path}${request.search}`;
    if (options.calls.some((pattern) => pattern.test(call))) return undefined;
    throw new Error(`${call} is not one of this page's calls`);
  });
  options.setup?.(api);
  /** Seeded from the fake backend's own replies, so lists match what <admin-app> reads at start-up. @param {string} apiPath @param {string} [search] */
  const read = (apiPath, search = "") =>
    api.reply({
      method: "GET",
      path: apiPath,
      search,
      body: undefined,
      headers: {},
    }).json;
  let { catalog, session } = options;
  if (!session) {
    const reply = read("session");
    session = createAdminSession();
    session.seed({
      ...reply,
      profile:
        reply.role === "compliance-manager" ? read("profile").profile : null,
    });
  }
  if (!catalog) {
    const programManagers = read("program-managers").programManagers;
    catalog = createAdminCatalog();
    catalog.freezeLists();
    catalog.seed({
      providers: read("providers").providers,
      programs: read("programs").programs,
      oversightOptions: read("oversight-options"),
      programManagers,
      // Only when the test passes sites: true, so an unexpected Sites read fails the test.
      ...(options.sites && {
        // Cloned like a fetch reply, since the catalog edits the Sites it stores.
        sites: directorySites(
          structuredClone(read("providers", "?directory=1").sites),
          programManagers,
        ),
      }),
    });
  }
  const owner = mount;
  /** @type {string[]} */
  const errors = [];
  current = document.createElement(tag);
  current.catalog = catalog;
  current.session = session;
  // <admin-app> shows page-error events in its error line; with no app, the test reads or fails on them.
  current.addEventListener("page-error", (/** @type {any} */ event) => {
    // The text <admin-app> would show, so pageError() reads the same with or without it.
    pageErrorLine = errorLineText(event.detail, t);
    // Pages send an empty message to clear <admin-app>'s error line; it isn't an error.
    if (!event.detail.message) return;
    if (options.recordErrors) errors.push(event.detail.message);
    else owner?.errors.push(`page-error: ${event.detail.message}`);
  });
  const page = current;
  // `follow` lists the routes <admin-app> opens this page for, so routeTo() can move between them.
  if (options.follow) {
    const follow = options.follow;
    const routeChanged = async () => {
      pageErrorLine = "";
      const route = currentRoute();
      if (!follow.includes(route.name)) {
        page.leave();
        page.remove();
      } else if (await page.open(route)) {
        if (page.isConnected) page.render();
        else document.body.append(page);
        page.focusOnOpen();
      }
    };
    window.addEventListener("popstate", routeChanged);
    unfollow = () => window.removeEventListener("popstate", routeChanged);
  }
  // Open, attach, then focus, as <admin-app> does on a first visit, so renders match.
  if (await page.open(currentRoute())) {
    document.body.append(page);
    page.focusOnOpen();
  }
  await settle();
  return { page: /** @type {any} */ (current), api, errors, catalog, session };
}

/**
 * What <admin-app> does to the mounted page when the user goes to `path`.
 * @param {string} path
 */
export async function leavePage(path) {
  window.history.pushState({}, "", path);
  current.leave();
  current.remove();
  await settle();
}

/**
 * What <admin-app> does when the user goes to `path` and the mounted page shows
 * it too, such as another Site or tab: detach the page, open it again, reattach.
 * @param {string} path
 */
export async function revisitPage(path) {
  window.history.pushState({}, "", path);
  current.remove();
  if (await current.open(currentRoute())) {
    document.body.append(current);
    current.focusOnOpen();
  }
  await settle();
}

/**
 * Reset the window and fake backend for a new mount. For mountPage() and app-mount.js.
 * @param {string} path
 * @param {{ role?: "compliance-supervisor" | "compliance-manager", data?: any, fetch?: (url: string, init: any) => Response | undefined }} options
 */
export async function startMount(path, options) {
  // A read the old app still holds can be joined by the new app's identical
  // read (admin-api shares simultaneous reads), so release gates before remounting.
  if (current) {
    releaseGates();
    await settle();
  }
  unfollow();
  pageErrorLine = "";
  current?.remove();
  closeToasts();
  const api = fakeAdminApi(
    { role: options.role, data: options.data || adminData() },
    settle,
  );
  mount = { api, otherFetch: options.fetch || null, fetch: [], errors: [] };
  mounts.push(mount);
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, "", path);
  // What admin-frontend/config.js sets in a browser.
  /** @type {any} */ (window).GOOD_NEIGHBOR_ADMIN_CONFIG = {
    apiBase: window.location.origin,
    localDebugAdmin: true,
  };
  return api;
}

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
 * @param {string | boolean} value
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

// Toast objects, not text: two announcements with the same words still count twice.
/** @type {Set<any>} */
const toastsSeen = new Set();
// Recorded as each shows, since a toast can time out during tick() before a test reads it.
onToastsChange(() => getToasts().forEach((toast) => toastsSeen.add(toast)));
/** @param {any} toast */
const toastLine = (toast) =>
  `${toast.title || ""} ${toast.message || ""}`.trim();

/**
 * Titles and messages of every toast shown since the last mount. Toasts show
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
 * How many separate toasts containing `fragment` have shown since the last mount.
 * @param {string} fragment
 */
export function toastCount(fragment) {
  toastText();
  return [...toastsSeen].filter((toast) => toastLine(toast).includes(fragment))
    .length;
}

/** The page-level error banner's text, or "" when none shows. A page mounted alone has no banner, so its last error stands in. */
export function pageError() {
  const banner = document.querySelector('#main-content > [role="alert"]');
  return banner
    ? banner.textContent.replace(/\s+/g, " ").trim()
    : current?.localName === "admin-app"
      ? ""
      : pageErrorLine;
}

/** Move to a route the way router.js's navigate() does, without a page load. @param {string} path */
export async function routeTo(path) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new window.PopStateEvent("popstate"));
  await settle();
}

export { window, adminData };

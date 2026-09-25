// Analytics page: canned queries over the reporting lake (ADR 0013), run
// from buttons, plus an advanced panel that shows and lets you edit the SQL
// behind the last query. Reads only the lake — never the production table.
import {
  clearAdminSession,
  hasAdminSession,
  signOutAdmin,
  startAdminLogin,
} from "./services/admin-auth.js";
import { adminApi } from "./services/admin-api.js";
import { getAdminConfig } from "./config.js";
import { asForm, dataAttr, escapeHtml, formatTimestamp } from "./dom.js";

/**
 * @typedef {{ name: string, label: string, type: "integer" | "string", default?: number | string, required?: boolean, min?: number, max?: number, hint?: string }} CatalogParam
 * @typedef {{ id: string, title: string, description: string, group: string, params: CatalogParam[], sql: string, scheduled: boolean }} CatalogQuery
 * @typedef {{ columns: string[], rows: unknown[][], truncated: boolean, elapsedMs: number, asOf: string | null }} QueryResult
 * @typedef {{ siteId: string, name: string }} SiteOption
 * @typedef {object} AnalyticsState
 * @property {boolean} hasToken
 * @property {boolean} authBusy
 * @property {string} error
 * @property {CatalogQuery[]} catalog
 * @property {boolean} loading
 * @property {string} selectedId
 * @property {Record<string, string>} params
 * @property {SiteOption[]} sites
 * @property {QueryResult | null} result
 * @property {string} resultTitle
 * @property {string} ranSql
 * @property {boolean} busy
 * @property {string} resultError
 * @property {string | null} asOf
 * @property {boolean} advancedOpen
 * @property {string} advancedSql
 */

const FRESHNESS_QUERY = "lake-freshness";
const SITES_QUERY = "sites";

class AdminAnalytics extends HTMLElement {
  constructor() {
    super();
    /** @type {AnalyticsState} */
    this.state = initialState();
  }

  /** @returns {Promise<void>} */
  async connectedCallback() {
    this.state = { ...initialState(), hasToken: hasAdminSession() };
    this.render();
    if (this.state.hasToken) await this.load();
  }

  /**
   * Load the catalog, then the freshness query (proves the pipeline end to
   * end) and the site list (feeds the site picker).
   * @returns {Promise<void>}
   */
  async load() {
    this.state.loading = true;
    this.render();
    try {
      const data = await adminApi.analyticsCatalog();
      this.state.catalog = data.queries || [];
      this.state.error = "";
    } catch (err) {
      this.state.error = errorMessage(err);
      this.state.loading = false;
      this.render();
      return;
    }
    this.state.loading = false;
    this.render();
    await Promise.all([this.loadSites(), this.select(FRESHNESS_QUERY)]);
  }

  /** @returns {Promise<void>} */
  async loadSites() {
    if (!this.state.catalog.some((q) => q.id === SITES_QUERY)) return;
    try {
      const result = await adminApi.analyticsRun(SITES_QUERY, {});
      const idIdx = result.columns.indexOf("siteId");
      const nameIdx = result.columns.indexOf("name");
      this.state.sites = result.rows
        .map((row) => ({
          siteId: String(row[idIdx] ?? ""),
          name: String(row[nameIdx] ?? ""),
        }))
        .filter((s) => s.siteId);
      this.render();
    } catch {
      // The picker degrades to a plain text field; not worth an error banner.
    }
  }

  /**
   * Select a catalog query. Runs it immediately when every required
   * parameter has a value; otherwise shows the form and waits.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async select(id) {
    const query = this.state.catalog.find((q) => q.id === id);
    if (!query) return;
    this.state.selectedId = id;
    this.state.params = defaultParams(query);
    this.state.resultError = "";
    this.state.result = null;
    this.render();
    const missing = query.params.some(
      (p) => p.required && !this.state.params[p.name],
    );
    if (!missing) await this.run();
  }

  /**
   * Run the selected query with the current parameters.
   * @returns {Promise<void>}
   */
  async run() {
    const query = this.state.catalog.find(
      (q) => q.id === this.state.selectedId,
    );
    if (!query) return;
    this.state.busy = true;
    this.state.resultError = "";
    this.render();
    try {
      const result = await adminApi.analyticsRun(query.id, this.state.params);
      this.state.result = result;
      this.state.resultTitle = query.title;
      this.state.ranSql = query.sql;
      this.state.advancedSql = query.sql;
      this.state.asOf = result.asOf ?? this.state.asOf;
    } catch (err) {
      this.state.resultError = errorMessage(err);
    }
    this.state.busy = false;
    this.render();
  }

  /**
   * Run the SQL in the advanced panel as-is.
   * @param {string} sql
   * @returns {Promise<void>}
   */
  async runAdvanced(sql) {
    if (!sql.trim()) return;
    this.state.advancedSql = sql;
    this.state.advancedOpen = true;
    this.state.busy = true;
    this.state.resultError = "";
    this.render();
    try {
      const result = await adminApi.analyticsQuery(sql);
      this.state.result = result;
      this.state.resultTitle = "Custom SQL";
      this.state.ranSql = sql;
      this.state.asOf = result.asOf ?? this.state.asOf;
    } catch (err) {
      this.state.resultError = errorMessage(err);
    }
    this.state.busy = false;
    this.render();
  }

  /**
   * Read parameter values from the form into state (no re-render).
   * @param {HTMLFormElement} form
   */
  readParams(form) {
    const data = new FormData(form);
    /** @type {Record<string, string>} */
    const params = {};
    for (const [key, value] of data.entries()) {
      if (key.startsWith("param-")) params[key.slice(6)] = String(value).trim();
    }
    this.state.params = params;
  }

  /** Hand the current result to the browser as a CSV file. */
  downloadCsv() {
    const result = this.state.result;
    if (!result) return;
    const csv = toCsv(result.columns, result.rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug(this.state.resultTitle || "query")}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Bind event handlers to the rendered DOM. */
  bind() {
    this.querySelector("#sign-in")?.addEventListener("click", async () => {
      this.state.authBusy = true;
      this.state.error = "";
      this.render();
      await startAdminLogin().catch((err) => {
        this.state.authBusy = false;
        this.state.error = errorMessage(err);
        this.render();
      });
    });
    this.querySelector("#clear-token")?.addEventListener("click", () => {
      clearAdminSession();
      this.state = { ...initialState(), hasToken: false };
      signOutAdmin();
    });
    this.querySelectorAll("[data-query]").forEach((button) => {
      button.addEventListener("click", () =>
        this.select(dataAttr(button, "data-query")),
      );
    });
    this.querySelector("#params-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this.readParams(asForm(e.currentTarget));
      this.run();
    });
    this.querySelector("#download-csv")?.addEventListener("click", () =>
      this.downloadCsv(),
    );
    const advanced = this.querySelector("#advanced");
    if (advanced instanceof HTMLDetailsElement) {
      advanced.addEventListener("toggle", () => {
        this.state.advancedOpen = advanced.open;
      });
    }
    this.querySelector("#advanced-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const sql = String(
        new FormData(asForm(e.currentTarget)).get("advanced-sql") || "",
      );
      this.runAdvanced(sql);
    });
  }

  /** Render the page from state. */
  render() {
    const s = this.state;
    this.innerHTML = `
      <main class="admin">
        <header class="admin__header">
          <div class="site-title">
            <h1>Analytics</h1>
            <nav class="admin__nav"><a href="/">Site management</a></nav>
          </div>
          ${s.hasToken ? '<button id="clear-token" type="button">Sign out</button>' : ""}
        </header>
        ${
          getAdminConfig().localDebugAdmin
            ? '<p class="muted">Local debug admin mode is active.</p>'
            : ""
        }
        ${s.hasToken ? "" : renderSignIn(s)}
        ${s.error ? `<p class="error" role="alert">${escapeHtml(s.error)}</p>` : ""}
        ${s.hasToken ? renderWorkspace(s) : ""}
      </main>
    `;
    this.bind();
  }
}

/** @returns {AnalyticsState} */
function initialState() {
  return {
    hasToken: false,
    authBusy: false,
    error: "",
    catalog: [],
    loading: false,
    selectedId: "",
    params: {},
    sites: [],
    result: null,
    resultTitle: "",
    ranSql: "",
    busy: false,
    resultError: "",
    asOf: null,
    advancedOpen: false,
    advancedSql: "",
  };
}

/**
 * @param {AnalyticsState} s
 * @returns {string}
 */
function renderSignIn(s) {
  const config = getAdminConfig();
  return `
    <section class="panel">
      <h2>Sign in</h2>
      <p class="muted">Use the City-managed admin sign-in to continue.</p>
      <button id="sign-in" type="button" ${s.authBusy ? "disabled" : ""}>
        ${s.authBusy ? "Opening sign in..." : "Sign in with Cognito"}
      </button>
      ${
        !config.cognitoDomain || !config.clientId
          ? '<p class="error">Admin login is not configured for this environment.</p>'
          : ""
      }
    </section>
  `;
}

/**
 * @param {AnalyticsState} s
 * @returns {string}
 */
function renderWorkspace(s) {
  if (s.loading) return '<p class="muted">Loading queries...</p>';
  if (!s.catalog.length) return "";
  const selected = s.catalog.find((q) => q.id === s.selectedId) ?? null;
  return `
    <p class="muted freshness">
      Reporting lake data as of ${escapeHtml(s.asOf ? formatTimestamp(s.asOf) : "unknown")}.
      Exports run every 6 hours; nothing here reads the live app database.
    </p>
    <div class="analytics">
      <aside class="panel catalog" aria-label="Queries">
        ${renderCatalog(s)}
      </aside>
      <section class="panel query" aria-live="polite">
        ${selected ? renderQuery(s, selected) : '<p class="muted">Pick a query.</p>'}
        ${renderResult(s)}
        ${renderAdvanced(s)}
      </section>
    </div>
  `;
}

/**
 * @param {AnalyticsState} s
 * @returns {string}
 */
function renderCatalog(s) {
  /** @type {Map<string, CatalogQuery[]>} */
  const groups = new Map();
  for (const q of s.catalog) {
    const list = groups.get(q.group) ?? [];
    list.push(q);
    groups.set(q.group, list);
  }
  return [...groups]
    .map(
      ([group, queries]) => `
        <div class="catalog__group">
          <h3>${escapeHtml(group)}</h3>
          <div class="list">
            ${queries
              .map(
                (q) => `
                  <button type="button" data-query="${escapeHtml(q.id)}"
                          aria-current="${q.id === s.selectedId ? "true" : "false"}"
                          title="${escapeHtml(q.description)}">
                    ${escapeHtml(q.title)}
                  </button>
                `,
              )
              .join("")}
          </div>
        </div>
      `,
    )
    .join("");
}

/**
 * @param {AnalyticsState} s
 * @param {CatalogQuery} q
 * @returns {string}
 */
function renderQuery(s, q) {
  return `
    <div class="query__head">
      <h2>${escapeHtml(q.title)}</h2>
      ${q.scheduled ? '<span class="badge" title="Also materialized daily by the report Lambda">Daily report</span>' : ""}
    </div>
    <p class="muted query__description">${escapeHtml(q.description)}</p>
    <form id="params-form" class="query-params">
      ${q.params.map((p) => renderParam(s, p)).join("")}
      <button type="submit" ${s.busy ? "disabled" : ""}>
        ${s.busy ? "Running..." : q.params.length ? "Run" : "Run again"}
      </button>
    </form>
  `;
}

/**
 * @param {AnalyticsState} s
 * @param {CatalogParam} p
 * @returns {string}
 */
function renderParam(s, p) {
  const value = s.params[p.name] ?? "";
  const id = `param-${p.name}`;
  if (p.type === "integer") {
    return `
      <label>
        <span>${escapeHtml(p.label)}</span>
        <input id="${id}" name="${id}" type="number" inputmode="numeric"
               value="${escapeHtml(value)}"
               ${p.min !== undefined ? `min="${p.min}"` : ""}
               ${p.max !== undefined ? `max="${p.max}"` : ""}
               ${p.required ? "required" : ""} />
      </label>
    `;
  }
  const isSite = p.name === "siteId" && s.sites.length > 0;
  return `
    <label>
      <span>${escapeHtml(p.label)}</span>
      ${
        isSite
          ? `<select id="${id}" name="${id}" ${p.required ? "required" : ""}>
               <option value="">Choose a site</option>
               ${s.sites
                 .map(
                   (
                     site,
                   ) => `<option value="${escapeHtml(site.siteId)}" ${site.siteId === value ? "selected" : ""}>
                     ${escapeHtml(site.name || site.siteId)}
                   </option>`,
                 )
                 .join("")}
             </select>`
          : `<input id="${id}" name="${id}" value="${escapeHtml(value)}"
                    placeholder="${escapeHtml(p.hint ?? "")}"
                    ${p.required ? "required" : ""} />`
      }
    </label>
  `;
}

/**
 * @param {AnalyticsState} s
 * @returns {string}
 */
function renderResult(s) {
  if (s.resultError) {
    return `<p class="error" role="alert">${escapeHtml(s.resultError)}</p>`;
  }
  const r = s.result;
  if (!r) return "";
  return `
    <div class="result-meta">
      <p class="muted">
        ${r.rows.length} row${r.rows.length === 1 ? "" : "s"}
        ${r.truncated ? " · <strong>truncated</strong>" : ""}
        · ${r.elapsedMs} ms
      </p>
      ${r.rows.length ? '<button id="download-csv" type="button">Download CSV</button>' : ""}
    </div>
    ${
      r.rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr>${r.columns.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join("")}</tr></thead>
            <tbody>
              ${r.rows
                .map(
                  (row) =>
                    `<tr>${row.map((v) => `<td>${escapeHtml(formatCell(v))}</td>`).join("")}</tr>`,
                )
                .join("")}
            </tbody>
          </table></div>`
        : '<p class="muted">No rows returned.</p>'
    }
  `;
}

/**
 * @param {AnalyticsState} s
 * @returns {string}
 */
function renderAdvanced(s) {
  return `
    <details id="advanced" class="advanced" ${s.advancedOpen ? "open" : ""}>
      <summary>Advanced: view and edit the SQL</summary>
      <p class="muted">
        This is the SQL behind the last query, with parameters shown as
        <code>$name</code>. Edit it and run: one read-only SELECT over the
        views checks, tasks, conditions, assessments, artifacts, analyses,
        sites, providers, devices. Parameters aren't bound here — replace
        <code>$days</code> and friends with values.
      </p>
      <form id="advanced-form" class="advanced__form">
        <label>
          <span>SQL</span>
          <textarea name="advanced-sql" rows="12" spellcheck="false">${escapeHtml(s.advancedSql)}</textarea>
        </label>
        <button type="submit" ${s.busy ? "disabled" : ""}>Run SQL</button>
      </form>
    </details>
  `;
}

/**
 * @param {CatalogQuery} q
 * @returns {Record<string, string>}
 */
function defaultParams(q) {
  /** @type {Record<string, string>} */
  const params = {};
  for (const p of q.params) {
    params[p.name] = p.default === undefined ? "" : String(p.default);
  }
  return params;
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function formatCell(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

/**
 * @param {string[]} columns
 * @param {unknown[][]} rows
 * @returns {string}
 */
function toCsv(columns, rows) {
  const cell = (/** @type {unknown} */ v) => {
    const s = formatCell(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(cell).join(",")]
    .concat(rows.map((row) => row.map(cell).join(",")))
    .join("\n");
}

/**
 * @param {string} value
 * @returns {string}
 */
function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Prefer the server's explanatory message (sql_invalid / params_invalid carry
 * one) over the bare error code.
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  const detail = /** @type {any} */ (err)?.detail;
  if (typeof detail === "string" && detail) return detail;
  const code = err instanceof Error ? err.message : String(err);
  if (code === "query_failed")
    return "The query could not be run. Check the lake status or try again.";
  if (code === "forbidden") return "Your account is not a central admin.";
  return code;
}

customElements.define("admin-analytics", AdminAnalytics);

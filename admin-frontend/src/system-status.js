import { navigate } from "./router.js";
import { rulebookText } from "../../frontend/src/i18n/rulebook.js";
import { adminApi } from "./services/admin-api.js";
import { escapeHtml as e } from "./dom.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import { formatTime } from "../../frontend/src/i18n/dates.js";
import "./system-status.css";
import "@awesome.me/webawesome/dist/components/tooltip/tooltip.js";

const activities = [
  "submissions",
  "checks",
  "issues",
  "actions",
  "deletions",
  "duplicates",
];
const label = (key) => e(t(`admin.status.${key}`));
const number = (value) => e(String(value));
const percent = (value) =>
  value === null ? label("noData") : `${Math.floor(value * 10) / 10}%`;
const dot = (kind, state) =>
  `<span class="status-dot status-dot--${state}" aria-label="${label(`${kind}Tooltip.${state}`)}" role="img"></span>`;

export function sparkline(values, ceiling) {
  const max = ceiling || Math.max(1, ...values.filter((v) => v !== null));
  // Separate segments at missing samples: absence is not a zero-percent result.
  const paths = [];
  let points = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (points.length) paths.push(points);
      points = [];
    } else
      points.push(
        `${values.length > 1 ? (i / (values.length - 1)) * 120 : 60},${28 - (v / max) * 24}`,
      );
  });
  if (points.length) paths.push(points);
  const description = e(
    t("admin.status.hourValues", {
      values: values
        .map((v) =>
          v === null ? t("admin.status.noData") : Math.floor(v * 10) / 10,
        )
        .join(", "),
    }),
  );
  return `<svg class="status-spark" viewBox="0 0 120 32" role="img" aria-label="${label("hourly")}. ${description}"><title>${e(t("admin.status.hourValues", { values: values.map((v) => (v === null ? t("admin.status.noData") : Math.round(v))).join(", ") }))}</title>${paths.map((path) => (path.length === 1 ? `<circle cx="${path[0].split(",")[0]}" cy="${path[0].split(",")[1]}" r="2" fill="currentColor"/>` : `<polyline points="${path.join(" ")}"/>`)).join("")}</svg>`;
}

class SystemStatus extends HTMLElement {
  data = null;
  filter = "all";
  sort = "name";
  pages = new Map();
  busySites = new Map();
  generations = new Map();
  error = "";
  loading = false;
  previewSequence = 0;

  connectedCallback() {
    this.kind = this.getAttribute("view") || "";
    this.addEventListener("click", this.click);
    this.addEventListener("change", this.change);
    this.addEventListener("close", this.closed, true);
    this.addEventListener("error", this.imageError, true);
    document.addEventListener("visibilitychange", this.visibility);
    this.timer = setInterval(() => {
      if (!document.hidden) this.refresh();
    }, 60000);
    this.refresh();
  }
  disconnectedCallback() {
    clearInterval(this.timer);
    document.removeEventListener("visibilitychange", this.visibility);
    this.removeEventListener("click", this.click);
    this.removeEventListener("change", this.change);
    this.removeEventListener("close", this.closed, true);
    this.removeEventListener("error", this.imageError, true);
    this.observer?.disconnect();
    this.previewSequence++;
  }
  imageError = (event) => {
    if (!(event.target instanceof HTMLImageElement)) return;
    const message = document.createElement("span");
    message.textContent = t("admin.status.mediaUnavailable");
    event.target.replaceWith(message);
  };
  closed = () => {
    this.previewSequence++;
    this.render();
  };
  visibility = () => {
    if (!document.hidden) this.refresh();
  };
  change = (event) => {
    if (event.target.id === "status-sort") {
      this.sort = event.target.value;
      this.render();
    }
  };
  click = async (event) => {
    const link = event.target.closest("a[data-status-route]");
    if (
      link &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      navigate(link.getAttribute("href"));
      return;
    }
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.filter) {
      this.filter = button.dataset.filter;
      this.render();
    }
    if (button.dataset.load) await this.loadSite(button.dataset.load);
    if (button.id === "status-refresh") await this.refresh();
    if (button.dataset.preview)
      await this.preview(button.dataset.site, button.dataset.preview);
    if (button.id === "status-close") this.querySelector("dialog")?.close();
  };
  updateRefreshState() {
    const button = this.querySelector("#status-refresh");
    button?.setAttribute("aria-busy", String(this.loading));
    button?.setAttribute("aria-disabled", String(this.loading));
  }
  invalidateSite(siteId) {
    this.generations.set(siteId, (this.generations.get(siteId) || 0) + 1);
    this.pages.delete(siteId);
    this.busySites.delete(siteId);
  }
  async refresh() {
    if (this.loading) return;
    this.loading = true;
    this.updateRefreshState();
    if (!this.data) this.render();
    try {
      const next = await adminApi.getSystemStatus();
      if (!this.isConnected) return;
      if (this.data?.start !== next.start)
        for (const siteId of new Set([
          ...this.pages.keys(),
          ...this.busySites.keys(),
        ]))
          this.invalidateSite(siteId);
      else
        for (const site of next.sites) {
          const prior = this.data?.sites.find((s) => s.siteId === site.siteId);
          if (prior && prior.counts[this.kind] !== site.counts[this.kind])
            this.invalidateSite(site.siteId);
        }
      // Renew expiring URLs without discarding pagination or scroll position.
      for (const site of next.sites) {
        const page = this.pages.get(site.siteId);
        for (const entry of page?.entries || []) {
          if (!entry.url || Date.parse(entry.urlExpiresAt) > Date.now() + 60000)
            continue;
          const generation = this.generations.get(site.siteId) || 0;
          const media = await adminApi.getStatusMedia(
            site.siteId,
            entry.checkId,
            entry.artifactId,
            true,
          );
          if (!this.isConnected) return;
          if (generation === (this.generations.get(site.siteId) || 0)) {
            delete entry.url;
            delete entry.urlExpiresAt;
            Object.assign(entry, media);
          }
        }
      }
      this.data = next;
      this.error = "";
    } catch {
      this.error = t("admin.status.loadError");
    } finally {
      this.loading = false;
      this.updateRefreshState();
      if (this.isConnected && !this.querySelector("dialog[open]"))
        this.render();
    }
  }
  async loadSite(siteId) {
    const prior = this.pages.get(siteId);
    if (this.busySites.has(siteId) || prior?.complete) return;
    const generation = this.generations.get(siteId) || 0;
    this.busySites.set(siteId, generation);
    try {
      const page = await adminApi.getStatusEntries(
        siteId,
        this.kind,
        prior?.cursor,
      );
      if (
        !this.isConnected ||
        generation !== (this.generations.get(siteId) || 0)
      )
        return;
      const entries = [...(prior?.entries || []), ...page.entries];
      this.pages.set(siteId, {
        entries: [...new Map(entries.map((row) => [row.id, row])).values()],
        cursor: page.cursor,
        complete: !page.cursor,
      });
    } catch {
      if (generation === (this.generations.get(siteId) || 0))
        this.pages.set(siteId, { ...prior, error: true });
    } finally {
      if (this.busySites.get(siteId) === generation)
        this.busySites.delete(siteId);
      if (this.isConnected && !this.querySelector("dialog[open]"))
        this.render();
    }
  }
  async preview(siteId, id) {
    const row = this.pages
      .get(siteId)
      ?.entries.find((entry) => entry.id === id);
    if (!row) return;
    const dialog = this.querySelector("dialog");
    const body = dialog.querySelector(".status-preview-body");
    const sequence = ++this.previewSequence;
    body.innerHTML = `<p role="status">${label("loading")}</p>`;
    dialog.showModal();
    try {
      const result =
        this.kind === "duplicates"
          ? await adminApi.getStatusDuplicate(siteId, row.taskId, row.eventKey)
          : {
              pair: [
                await adminApi.getStatusMedia(
                  siteId,
                  row.checkId,
                  row.artifactId,
                ),
              ],
            };
      if (sequence !== this.previewSequence || !this.isConnected) return;
      body.innerHTML = `${result.separated ? `<p>${label("separated")}</p>` : ""}<div class="status-pair">${result.pair.map((media, i) => `<figure><figcaption>${this.kind === "duplicates" ? label(i ? "matchedSubmission" : "newSubmission") : label("submissions")}</figcaption>${media.url ? `<img src="${e(media.url)}" alt="${label("photo")}">` : `<p>${media.unavailable ? label("mediaUnavailable") : e(media.text)}</p>`}</figure>`).join("")}</div>`;
    } catch {
      body.innerHTML = `<p role="alert">${label("loadError")}</p>`;
    }
  }
  render() {
    const focus = document.activeElement?.id;
    const scrolls = new Map(
      [...this.querySelectorAll(".status-filmstrip")].map((el) => [
        el.dataset.site,
        el.scrollLeft,
      ]),
    );
    const data = this.data;
    const total = (kind) =>
      data.sites.reduce((n, site) => n + site.counts[kind], 0);
    const row = (kind, value, state) =>
      `<a id="status-row-${kind}" class="status-row" data-status-route href="/system-status/${kind}">${state ? dot(kind, state) : ""}<span class="status-row-title">${label(kind)}</span><span class="status-row-value">${value}</span><span aria-hidden="true">›</span></a>${state ? `<wa-tooltip for="status-row-${kind}">${label(`${kind}Tooltip.${state}`)}</wa-tooltip>` : ""}`;
    this.innerHTML = `<section class="status-page" aria-labelledby="status-title"><a class="site-back-link" data-status-route href="${this.kind ? "/system-status" : "/sites"}">‹ ${this.kind ? label("title") : e(t("admin.breadcrumb.admin"))}</a><div class="panel__head"><h1 id="status-title" tabindex="-1">${label(this.kind || "title")}</h1><button class="btn-icon status-refresh" id="status-refresh" type="button" aria-busy="${this.loading}" aria-disabled="${this.loading}" aria-label="${label("refresh")}" title="${label("refresh")}"><wa-icon name="rotate" aria-hidden="true"></wa-icon></button></div>
      ${this.error ? `<p role="alert">${e(this.error)}</p>` : ""}
      ${
        !data
          ? `<p role="status">${label(this.loading ? "loading" : "noData")}</p>`
          : `
      <p class="muted">${e(t("admin.status.updated", { time: formatTime(data.now) }))}</p>
      ${this.kind ? this.details() : `<h2>${label("health")}</h2><div class="status-list">${row("network", percent(data.network.percent), data.network.state)}${row("analysis", percent(data.analysis.percent), data.analysis.state)}</div><p class="muted">${e(t("admin.status.pending", { count: data.pending }))}</p><h2>${label("activity")}</h2><div class="status-list">${activities.map((kind) => row(kind, kind === "duplicates" && !data.duplicatesAvailable && !total(kind) ? label("unavailable") : number(total(kind)))).join("")}</div>`}`
      }
      <dialog class="status-dialog" aria-label="${label("preview")}"><button type="button" class="btn-secondary" id="status-close">${label("close")}</button><div class="status-preview-body"></div></dialog></section>`;
    if (focus)
      this.querySelector(`#${CSS.escape(focus)}`)?.focus({
        preventScroll: true,
      });
    for (const strip of this.querySelectorAll(".status-filmstrip"))
      strip.scrollLeft = scrolls.get(strip.dataset.site) || 0;
    this.observer?.disconnect();
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            this.observer.unobserve(entry.target);
            const id = entry.target.dataset.load;
            if (!this.pages.get(id)?.error) this.loadSite(id);
          }
      },
      { rootMargin: "100px" },
    );
    this.querySelectorAll("[data-autoload]").forEach((el) =>
      this.observer.observe(el),
    );
  }
  details() {
    const kind = this.kind,
      data = this.data;
    let sites = [...data.sites];
    if (this.sort !== "name")
      sites.sort((a, b) => {
        const metric = (s) =>
          kind === "analysis"
            ? (s.analysis.percent ?? -1)
            : s.counts.submissions;
        return (
          (metric(a) - metric(b)) * (this.sort === "ascending" ? 1 : -1) ||
          a.name.localeCompare(b.name)
        );
      });
    else sites.sort((a, b) => a.name.localeCompare(b.name));
    return `<p class="muted">${label(kind === "network" ? "networkWindow" : "today")}</p>${kind === "duplicates" && !data.duplicatesAvailable ? `<p>${label("unavailable")}</p>` : ""}
    ${["network", "analysis"].includes(kind) ? `<wa-select id="status-sort" label="${label("sort")}" value="${this.sort}"><wa-option value="name" ${this.sort === "name" ? "selected" : ""}>${label("siteName")}</wa-option><wa-option value="descending" ${this.sort === "descending" ? "selected" : ""}>${label("highest")}</wa-option><wa-option value="ascending" ${this.sort === "ascending" ? "selected" : ""}>${label("lowest")}</wa-option></wa-select>` : ""}
    ${kind === "checks" ? `<div class="status-filters" aria-label="${label("checkFilter")}">${["all", "unfinished", "finished"].map((value) => `<button type="button" class="btn-secondary" id="status-filter-${value}" data-filter="${value}" aria-pressed="${this.filter === value}">${label(value)}</button>`).join("")}</div>` : ""}
    <div class="status-list">${
      sites
        .map(
          (
            site,
          ) => `<article class="status-site"><div class="status-site-heading"><h2>${e(site.name)}</h2><span>${kind === "analysis" ? percent(site.analysis.percent) : number(kind === "network" ? site.counts.submissions : kind === "checks" && this.filter !== "all" ? site.checks[this.filter] : site.counts[kind])}</span>${["network", "analysis"].includes(kind) ? sparkline(site[kind === "network" ? "submissionHours" : "analysisHours"], kind === "analysis" ? 100 : Math.max(1, ...sites.flatMap((s) => s.submissionHours))) : ""}</div>
      ${kind === "analysis" ? `<p>${e(t("admin.status.analysisCounts", { succeeded: site.succeeded, failed: site.failed, pending: site.pending }))}</p>` : ""}
      ${
        kind === "checks"
          ? `<p>${["unfinished", "finished"]
              .filter((state) => this.filter === "all" || this.filter === state)
              .map((state) => `${label(state)}: ${site.checks[state]}`)
              .join(" · ")}</p>`
          : ""
      }
      ${["issues", "actions", "deletions"].includes(kind) ? this.groups(site.groups[kind], kind) : ""}
      ${["submissions", "duplicates"].includes(kind) ? this.entries(site) : ""}</article>`,
        )
        .join("") || `<p>${label("noSites")}</p>`
    }</div>`;
  }
  groups(groups, kind) {
    const entries = Object.entries(groups);
    return entries.length
      ? `<ul>${entries.map(([category, count]) => `<li>${e(t(`admin.status.category.${category.replaceAll("_", "-")}`) === `admin.status.category.${category.replaceAll("_", "-")}` ? rulebookText(category, "rulebook.category") : t(`admin.status.category.${category.replaceAll("_", "-")}`))} <strong>${count}</strong></li>`).join("")}</ul>`
      : `<p>${label(`empty.${kind}`)}</p>`;
  }
  entries(site) {
    if (!site.counts[this.kind]) return `<p>${label(`empty.${this.kind}`)}</p>`;
    const page = this.pages.get(site.siteId);
    return `<div class="status-filmstrip" data-site="${e(site.siteId)}" tabindex="0" aria-label="${label(this.kind)}">${(page?.entries || []).map((row, i) => `<button class="btn-secondary status-tile" id="status-entry-${e(site.siteId)}-${i}" data-preview="${e(row.id)}" data-site="${e(site.siteId)}" type="button">${this.kind === "duplicates" ? label("duplicatePair") : row.url ? `<img loading="lazy" src="${e(row.url)}" alt="${label("photo")}">` : `<span>${row.unavailable ? label("mediaUnavailable") : e(row.text)}</span>`}<small>${e(formatTime(row.at))}</small></button>`).join("")}${!page?.complete ? `<button class="btn-secondary" type="button" data-load="${e(site.siteId)}" ${page?.error ? "" : "data-autoload"}>${label(page?.error ? "retry" : "loadMore")}</button>` : ""}</div>`;
  }
}
customElements.define("system-status-view", SystemStatus);

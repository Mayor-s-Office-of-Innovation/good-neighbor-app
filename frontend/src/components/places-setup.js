// @ts-nocheck -- lenient migration baseline (checkJs).
import { getSite, newId, saveSiteSettings } from "../db.js";
import { currentRoute, navigate } from "../router.js";
import { getSiteSettings, putSitePlaces } from "../services/api.js";
import { placesShell } from "./places-setup.templates.js";

const SEEDED_COPY = {
  title: "Places you check",
  subtitle:
    "Take photos at these places around your site.\nWe added a few to get you started.\nChange the names or order if needed.",
};

const EMPTY_COPY = {
  title: "Add the places you check",
  subtitle:
    'Add the places where you take photos.\nUse street names or simple names that your team recognizes, like "6th St" or "Front entrance."\nPut them in the order you will check on them.',
};

const EDIT_COPY = {
  title: "Edit places",
  subtitle: "Update the places included in each perimeter check",
};

function normalizePlaces(places) {
  return (Array.isArray(places) ? places : [])
    .map((place, index) => ({
      id: String(place.id || newId()).trim(),
      name: String(place.name || "").trim(),
      order: index,
    }))
    .filter((place) => place.id);
}

export function cleanPlaces(places) {
  return (Array.isArray(places) ? places : [])
    .map((place) => ({
      id: place.id,
      name: String(place.name || "").trim(),
    }))
    .filter((place) => place.name);
}

function signature(places) {
  return JSON.stringify(
    places.map((place) => ({ id: place.id, name: place.name.trim() })),
  );
}

class PlacesSetup extends HTMLElement {
  async connectedCallback() {
    this._mode = currentRoute().startsWith("/places/edit") ? "edit" : "setup";
    this._menuIndex = null;
    this._removeIndex = null;
    this._error = "";
    this._onDocumentClick = (event) => this._closeMenuFromOutsideClick(event);
    document.addEventListener("click", this._onDocumentClick);
    this._site = await getSite();
    if (!this._site) {
      navigate("/today");
      return;
    }

    await this._loadSettings();
    this._render();
  }

  disconnectedCallback() {
    if (this._onDocumentClick) {
      document.removeEventListener("click", this._onDocumentClick);
    }
  }

  async _loadSettings() {
    let remote = null;
    try {
      remote = (await getSiteSettings()).site;
      if (remote) {
        const localPlaces = Array.isArray(this._site?.places)
          ? this._site.places
          : [];
        const remotePlaces = Array.isArray(remote.places) ? remote.places : [];
        this._site = await saveSiteSettings({
          ...remote,
          places: remotePlaces.length ? remotePlaces : localPlaces,
          providerSiteId: this._site.providerSiteId || remote.providerSiteId,
        });
      }
    } catch (err) {
      console.error("getSiteSettings failed", err);
    }

    const places = normalizePlaces(this._site.places);
    this._hadSeededPlaces = places.some((place) => place.name.trim());
    this._places = this._hadSeededPlaces
      ? places
      : [{ id: newId(), name: "", order: 0 }];
    this._savedSignature = signature(normalizePlaces(this._site.places));
  }

  _copy() {
    if (this._mode === "edit") return EDIT_COPY;
    return this._hadSeededPlaces ? SEEDED_COPY : EMPTY_COPY;
  }

  _render() {
    const copy = this._copy();
    const clean = this._cleanPlaces();
    this.innerHTML = placesShell({
      title: copy.title,
      subtitle: copy.subtitle,
      siteName: this._site?.name || "Your site",
      places: this._places,
      canAdd: !this._places.some((place) => !place.name.trim()),
      canSave: clean.length > 0,
      mode: this._mode,
      menuIndex: this._menuIndex,
    });
    this._bind();
  }

  _bind() {
    this.querySelector("#add-place")?.addEventListener("click", () => {
      this._places.push({ id: newId(), name: "", order: this._places.length });
      this._menuIndex = null;
      this._render();
      requestAnimationFrame(() =>
        this.querySelector(
          `[data-place-input="${this._places.length - 1}"]`,
        )?.focus(),
      );
    });
    this.querySelector("#save-places")?.addEventListener("click", () =>
      this._save(),
    );
    this.querySelector("#places-back")?.addEventListener("click", () =>
      this._back(),
    );
    this.querySelector("#remove-place-confirm")?.addEventListener("click", () =>
      this._confirmRemove(),
    );
    this.querySelector("#discard-places-confirm")?.addEventListener(
      "click",
      () => {
        this.querySelector("#discard-places-dialog")?.close();
        navigate("/today");
      },
    );
    this.querySelector("#places-list")?.addEventListener("input", (event) =>
      this._onInput(event),
    );
    this.querySelector("#places-list")?.addEventListener("click", (event) =>
      this._onListClick(event),
    );
    this.querySelectorAll("dialog").forEach((dialog) => {
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
    });
  }

  _onInput(event) {
    const field = event.target.closest("[data-place-input]");
    if (!field) return;
    const index = Number(field.getAttribute("data-place-input"));
    if (!Number.isInteger(index) || !this._places[index]) return;
    this._places[index].name = field.value;
    this._syncButtons();
  }

  _onListClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const menuWrap = target.closest(".places-row__menu-wrap");
    if (menuWrap) event.stopPropagation();

    const menu = target.closest("[data-place-menu]");
    if (menu) {
      const index = Number(menu.getAttribute("data-place-menu"));
      const place = this._places[index];
      if (!place) return;
      if (!place.name.trim()) {
        this._places.splice(index, 1);
        if (!this._places.length) {
          this._places.push({ id: newId(), name: "", order: 0 });
        }
        this._menuIndex = null;
      } else {
        this._menuIndex = this._menuIndex === index ? null : index;
      }
      this._render();
      return;
    }

    const action = target.closest("[data-place-action]");
    if (!action) return;
    const index = Number(action.getAttribute("data-index"));
    const kind = action.getAttribute("data-place-action");
    if (kind === "up") this._move(index, -1);
    if (kind === "down") this._move(index, 1);
    if (kind === "remove") this._showRemove(index);
  }

  _closeMenuFromOutsideClick(event) {
    if (this._menuIndex === null) return;
    const path = event.composedPath?.() || [];
    if (
      path.some(
        (node) =>
          node instanceof Element && node.closest?.(".places-row__menu-wrap"),
      )
    )
      return;
    this._menuIndex = null;
    this._render();
  }

  _move(index, delta) {
    const next = index + delta;
    if (!this._places[index] || !this._places[next]) return;
    const [place] = this._places.splice(index, 1);
    this._places.splice(next, 0, place);
    this._places.forEach((item, i) => (item.order = i));
    this._menuIndex = next;
    this._render();
  }

  _showRemove(index) {
    const place = this._places[index];
    if (!place) return;
    this._removeIndex = index;
    this._menuIndex = null;
    this._render();
    this.querySelector("#remove-place-title").textContent =
      `Remove "${place.name.trim()}"?`;
    this.querySelector("#remove-place-dialog")?.showModal();
  }

  _confirmRemove() {
    if (this._removeIndex !== null) {
      this._places.splice(this._removeIndex, 1);
      if (!this._places.length) {
        this._places.push({ id: newId(), name: "", order: 0 });
      }
    }
    this._removeIndex = null;
    this.querySelector("#remove-place-dialog")?.close();
    this._render();
  }

  _syncButtons() {
    const canAdd = !this._places.some((place) => !place.name.trim());
    const canSave = this._cleanPlaces().length > 0;
    const add = this.querySelector("#add-place");
    const save = this.querySelector("#save-places");
    if (add) add.disabled = !canAdd;
    if (save) save.disabled = !canSave;
  }

  _cleanPlaces() {
    return cleanPlaces(this._places);
  }

  _isDirty() {
    return signature(this._cleanPlaces()) !== this._savedSignature;
  }

  _back() {
    if (!this._isDirty()) {
      navigate("/today");
      return;
    }
    this.querySelector("#discard-places-dialog")?.showModal();
  }

  async _save() {
    const clean = this._cleanPlaces();
    if (!clean.length) return;
    const save = this.querySelector("#save-places");
    save.disabled = true;
    save.textContent = "Saving...";
    try {
      const localPlaces = clean.map((place, order) => ({ ...place, order }));
      const savedSite = await saveSiteSettings({
        places: localPlaces,
        placesConfirmedAt: new Date().toISOString(),
      });
      window.dispatchEvent(
        new CustomEvent("siteplacesupdated", { detail: { site: savedSite } }),
      );
      navigate("/today");
    } catch (err) {
      console.error("saveSiteSettings failed", err);
      save.disabled = false;
      save.textContent = "Save places";
      return;
    }

    putSitePlaces(clean)
      .then(async ({ site }) => {
        if (!site) return;
        const savedSite = await saveSiteSettings({
          ...site,
          placesConfirmedAt: new Date().toISOString(),
        });
        window.dispatchEvent(
          new CustomEvent("siteplacesupdated", {
            detail: { site: savedSite },
          }),
        );
      })
      .catch((err) => {
        console.error("putSitePlaces failed", err);
      });
  }
}

customElements.define("places-setup", PlacesSetup);

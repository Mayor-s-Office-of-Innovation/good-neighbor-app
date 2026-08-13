// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  capture-photo — take a photo with the device camera or pick an existing image.
  Uses a native file input with capture hint (works on iOS/Android + desktop).
  Exposes `this.file` (a Blob/File or null). Light DOM so app.css styles it.
*/
class CapturePhoto extends HTMLElement {
  connectedCallback() {
    this.file = null;
    this._url = null;
    this.innerHTML = `
      <div class="stack stack--tight">
        <label id="photo-label" for="photo-input">Photo</label>
        <input id="photo-input" type="file" accept="image/*" capture="environment"
               class="visually-hidden" />
        <wa-button type="button" appearance="outlined" id="photo-btn">
          <wa-icon slot="start" name="camera"></wa-icon>
          <span class="btn-label">Add photo</span>
        </wa-button>
        <div class="media-preview" id="photo-preview" hidden>
          <img alt="Preview of the photo you captured" id="photo-img" />
        </div>
      </div>
    `;
    this._input = this.querySelector("#photo-input");
    this._btn = this.querySelector("#photo-btn");
    this._label = this.querySelector("#photo-btn .btn-label");
    this._preview = this.querySelector("#photo-preview");
    this._img = this.querySelector("#photo-img");

    this._btn.addEventListener("click", () => this._input.click());
    this._input.addEventListener("change", () => this._onPick());
  }

  _onPick() {
    const f = this._input.files && this._input.files[0];
    if (this._url) {
      URL.revokeObjectURL(this._url);
      this._url = null;
    }
    if (!f) {
      this.file = null;
      this._preview.hidden = true;
      this._label.textContent = "Add photo";
      return;
    }
    this.file = f;
    this._url = URL.createObjectURL(f);
    this._img.src = this._url;
    this._preview.hidden = false;
    this._label.textContent = "Replace photo";
    this.dispatchEvent(new CustomEvent("change"));
  }

  reset() {
    if (this._url) {
      URL.revokeObjectURL(this._url);
      this._url = null;
    }
    this.file = null;
    this._input.value = "";
    this._preview.hidden = true;
    this._label.textContent = "Add photo";
  }

  disconnectedCallback() {
    if (this._url) URL.revokeObjectURL(this._url);
  }
}
customElements.define("capture-photo", CapturePhoto);

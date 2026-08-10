import "@awesome.me/webawesome/dist/styles/webawesome.css";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/card/card.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "./styles.css";

class GoodNeighborApp extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <main class="app-shell">
        <section class="intro" aria-labelledby="page-title">
          <p class="eyebrow">City and County of San Francisco</p>
          <h1 id="page-title">Good Neighbor App</h1>
          <p>
            A Level 2 SDLC-ready starter for secure, accessible neighborhood service workflows.
          </p>
        </section>

        <wa-card class="capture-card">
          <h2>Offline-ready capture</h2>
          <form id="submission-form">
            <label>
              Request summary
              <wa-input name="summary" autocomplete="off" required></wa-input>
            </label>
            <wa-button type="submit" variant="brand">Queue submission</wa-button>
          </form>
          <p id="status" role="status" aria-live="polite"></p>
        </wa-card>
      </main>
    `;

    this.querySelector("form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const data = new FormData(form);
      const status = this.querySelector("#status");

      await fetch("/api/submissions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ summary: data.get("summary") }),
      });

      if (status) {
        status.textContent = "Submission queued.";
      }

      form.reset();
    });
  }
}

customElements.define("good-neighbor-app", GoodNeighborApp);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js");
}

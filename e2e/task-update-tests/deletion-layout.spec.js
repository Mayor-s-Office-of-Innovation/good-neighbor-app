import { test, expect } from "@playwright/test";

for (const width of [320, 390, 1280])
  for (const locale of ["en", "es", "fil", "vi", "zh-Hant"])
    test(`deletion buttons align and wrap at ${width}px in ${locale}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      let state = "group";
      await page.route("**/v1/**", (route) => {
        if (state === "deleted")
          return route.fulfill({
            status: 409,
            json: { code: "already_deleted" },
          });
        const selected =
          new URL(route.request().url()).searchParams.get("view") ===
          "selected";
        if (!selected && state === "unavailable")
          return route.fulfill({
            status: 409,
            json: { code: "matching_unavailable" },
          });
        return route.fulfill({
          json: {
            deletion: {
              kind: selected ? "single" : "group",
              targets: selected
                ? [{ taskId: "root" }]
                : [{ taskId: "root" }, { taskId: "child" }],
            },
          },
        });
      });
      await page.route("**/__layout_test", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dialog layout</title></head><body><main></main></body></html>',
        }),
      );
      await page.goto("/__layout_test");
      for (const mode of [
        "group",
        "unavailable",
        "selected",
        "deleted",
        "success",
        "edit",
      ]) {
        state = mode;
        await page.evaluate(
          async ({ locale, mode }) => {
            const load = (/** @type {string} */ path) => import(path);
            await load("/src/styles/tokens.css");
            await load("/src/styles/base.css");
            const { setSite } = await load("/src/db.js");
            await setSite("Synthetic layout site", {
              siteId: "site",
              token: "synthetic-token",
            });
            const { setLocale, t } = await load("/src/i18n/i18n.js");
            await setLocale(locale);
            document.documentElement.lang = locale;
            const { analysisDialogs } = await load(
              "/src/components/analysis-results.templates.js",
            );
            const { prepareCardDeletion } = await load(
              "/src/components/analysis-card-deletion.js",
            );
            const host = /** @type {any} */ (document.querySelector("main"));
            host.innerHTML = analysisDialogs();
            host._activeProblem = { taskId: "root" };
            host.querySelector("#analysis-delete-title").textContent = t(
              "analysis.deleteDialog.titleFor",
              { title: "Synthetic issue" },
            );
            if (["success", "edit"].includes(mode)) {
              host.querySelector(`#analysis-${mode}-dialog`).showModal();
              return;
            }
            host.querySelector("#analysis-delete-dialog").showModal();
            await prepareCardDeletion(host, host._activeProblem);
            if (mode === "selected")
              host.querySelector("[data-delete-selected]").click();
          },
          { locale, mode },
        );
        const dialog = page.locator("dialog[open]");
        await expect(dialog).toBeVisible();
        const geometry = await dialog.evaluate((node) => {
          const buttons = [
            ...node.querySelectorAll(
              ".analysis-dialog__actions button:not([hidden])",
            ),
          ];
          return {
            dialog: {
              left: node.getBoundingClientRect().left,
              right: node.getBoundingClientRect().right,
            },
            buttons: buttons.map((button) => {
              const r = button.getBoundingClientRect();
              const range = document.createRange();
              range.selectNodeContents(button);
              const text = range.getBoundingClientRect();
              return {
                left: r.left,
                right: r.right,
                top: r.top,
                bottom: r.bottom,
                height: r.height,
                textTop: text.top,
                textBottom: text.bottom,
                textLeft: text.left,
                textRight: text.right,
                font: window.getComputedStyle(button).fontSize,
                client: button.clientWidth,
                scroll: button.scrollWidth,
              };
            }),
          };
        });
        expect(geometry.dialog.left).toBeGreaterThanOrEqual(0);
        expect(geometry.dialog.right).toBeLessThanOrEqual(width);
        for (const [index, button] of geometry.buttons.entries()) {
          expect(button.left).toBeCloseTo(geometry.buttons[0].left, 0);
          expect(button.right).toBeCloseTo(geometry.buttons[0].right, 0);
          expect(button.height).toBeGreaterThanOrEqual(44);
          expect(button.font).toBe(geometry.buttons[0].font);
          expect(button.scroll).toBeLessThanOrEqual(button.client + 1);
          expect(button.textTop).toBeGreaterThanOrEqual(button.top);
          expect(button.textBottom).toBeLessThanOrEqual(button.bottom);
          expect(button.textLeft).toBeGreaterThanOrEqual(button.left);
          expect(button.textRight).toBeLessThanOrEqual(button.right);
          if (index)
            expect(button.top).toBeGreaterThanOrEqual(
              geometry.buttons[index - 1].bottom,
            );
        }
        if (
          locale === "fil" &&
          width === 320 &&
          ["group", "unavailable", "selected", "deleted"].includes(mode)
        ) {
          await expect(dialog).toHaveCSS("opacity", "1");
          await dialog.screenshot({
            path: testInfo.outputPath(`${mode}.png`),
            animations: "disabled",
          });
        }
        await page.keyboard.press("Escape");
      }
    });

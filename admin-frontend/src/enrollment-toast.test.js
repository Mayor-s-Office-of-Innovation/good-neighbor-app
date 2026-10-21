import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
for (const kind of ["Manager", "ProviderManager"]) {
  for (const delivery of ["accepted", "failed", "rejected"]) {
    test(`${kind} enrollment toast requires accepted email (${delivery})`, async () => {
      const method = `issue${kind}Grant`;
      const start = source.indexOf(`  async ${method}(`);
      const end = source.indexOf("\n  }", start) + 4;
      const toasts = [];
      const Subject = vm.runInNewContext(
        `(class { ${source.slice(start, end)} })`,
        {
          adminApi: {
            [`create${kind}Grant`]: async () => {
              if (delivery === "rejected") throw new Error("offline");
              return { grant: { deliveryStatus: delivery } };
            },
          },
          showToast: (toast) => toasts.push(toast),
          t: (key) => key,
          attachCreatedEnrollmentUrl: (grants) => grants,
        },
      );
      const app = new Subject();
      app.state = {
        site: { siteId: "site" },
        provider: { providerId: "provider" },
        managerMemberships: [],
      };
      app.openSite = app.openProvider = async () => {
        assert.equal(toasts.length, delivery === "accepted" ? 1 : 0);
      };
      app.render = () => {};
      if (delivery === "rejected")
        await assert.rejects(app[method]("manager"), /offline/);
      else await app[method]("manager");
      assert.equal(toasts.length, delivery === "accepted" ? 1 : 0);
      if (toasts.length) {
        assert.equal(toasts[0].title, "admin.enrollment.emailed");
        assert.equal(toasts[0].tone, "success");
      }
    });
  }
}

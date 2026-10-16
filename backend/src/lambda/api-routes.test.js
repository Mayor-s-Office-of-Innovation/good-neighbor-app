import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("deployed admin API routes", () => {
  it("exposes every admin Lambda route through API Gateway", () => {
    const lambda = readFileSync(new URL("./api.js", import.meta.url), "utf8");
    const terraform = readFileSync(
      new URL("../../../infra/modules/app/api.tf", import.meta.url),
      "utf8",
    );
    const routes = [...lambda.matchAll(/"((?:GET|POST|PUT|PATCH|DELETE) \/admin\/v1\/[^"\n]+)"\s*:/g)]
      .map((match) => match[1]);
    expect(routes.length).toBeGreaterThan(0);
    const deployedRoutes = new Set(
      [...terraform.matchAll(/"((?:GET|POST|PUT|PATCH|DELETE) \/admin\/v1\/[^"\n]+)"/g)]
        .map((match) => match[1]),
    );
    expect(routes.filter((route) => !deployedRoutes.has(route))).toEqual([]);
  });
});

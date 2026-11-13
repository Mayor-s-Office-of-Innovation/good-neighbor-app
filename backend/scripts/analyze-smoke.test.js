import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it.each([
  ["3.0.0", "3.0.0", 0],
  ["2.0.0", "3.0.0", 1],
  ["3.0.0", "2.0.0", 1],
])(
  "checks endpoint version %s and analysis version %s",
  (published, analyzed, status) => {
    const smoke = new URL("./analyze-smoke.mjs", import.meta.url).href;
    const fixture = new URL(
      "../src/analysis/fixtures/excellent.js",
      import.meta.url,
    ).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { excellentResponse } from ${JSON.stringify(fixture)};
    process.env.ANALYZER_BASE_URL = "https://analyzer.example.test/dev";
    process.env.ANALYZER_API_KEY = "synthetic-test-key";
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("/versions/3.0.0"))
        return Response.json({ id: "good-neighbor-app", version: ${JSON.stringify(published)} });
      const body = JSON.parse(init.body);
      if (body.rubric_version !== "3.0.0" || body.storage.store_input !== false)
        throw new Error("Wrong request pin or retention setting");
      return Response.json({ ...excellentResponse, rubric: { id: "good-neighbor-app", version: ${JSON.stringify(analyzed)} } });
    };
    await import(${JSON.stringify(smoke)});
  `,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(status);
    expect(result.stdout.includes("live analyzer smoke passed")).toBe(
      status === 0,
    );
  },
);

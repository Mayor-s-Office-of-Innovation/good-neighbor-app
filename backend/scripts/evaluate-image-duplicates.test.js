import { it, expect } from "vitest";
import process from "node:process";
import { URL } from "node:url";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";

it("persists incomplete progress and review state when the comparison endpoint fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "duplicate-progress-"));
  const images = join(root, "images"),
    output = join(root, "output");
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(422, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "invalid_model_response" } }));
  });
  try {
    await mkdir(images);
    await mkdir(join(output, "assessments"), { recursive: true });
    for (const [i, background] of ["red", "blue"].entries()) {
      const bytes = await sharp({
        create: { width: 8, height: 8, channels: 3, background },
      })
        .png()
        .toBuffer();
      await writeFile(join(images, `${i}.png`), bytes);
      const hash = createHash("sha256").update(bytes).digest("hex");
      await writeFile(
        join(output, "assessments", `${hash}.json`),
        JSON.stringify({
          adapted: {
            concerns: [
              {
                conditionId: "issue",
                category: "Litter",
                rating: 2,
                explanation: "synthetic litter",
              },
            ],
          },
        }),
      );
    }
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected local test address");
    await promisify(execFile)(
      process.execPath,
      [
        new URL("./evaluate-image-duplicates.mjs", import.meta.url).pathname,
        "--folder",
        images,
        "--production-search",
      ],
      {
        env: {
          ...process.env,
          DUPLICATE_OUTPUT_DIR: output,
          DUPLICATE_ANALYZER_BASE_URL: `http://127.0.0.1:${address.port}`,
          DUPLICATE_ANALYZER_API_KEY: "test-only",
        },
        timeout: 15000,
      },
    );
    const results = JSON.parse(
      await readFile(join(output, "results.json"), "utf8"),
    );
    const progress = JSON.parse(
      await readFile(join(output, "progress.json"), "utf8"),
    );
    expect(results).toHaveLength(2);
    const incomplete = results.filter((result) => result.candidateCount > 0);
    expect(incomplete).toHaveLength(1);
    for (const result of incomplete) {
      expect(result.status).toBe("incomplete");
      expect(result.possibleDuplicate).toBeNull();
      expect(
        progress.filter((p) => p.sourceId === result.sourceId).at(-1)
          .processingState,
      ).toBe("incomplete");
    }
    expect(await readFile(join(output, "review.html"), "utf8")).toContain(
      "<td>incomplete</td>",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

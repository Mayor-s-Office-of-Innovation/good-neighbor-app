import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// GitHub Actions sets CI=true. Avoid treating CI=false as a request to skip.
if (["true", "1"].includes(process.env.CI?.toLowerCase())) {
  console.log("Skipping local Git hook installation in CI.");
  process.exit(0);
}

const result = spawnSync("pre-commit", ["install", "--install-hooks"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: "inherit",
});

if (result.error?.code === "ENOENT") {
  console.error(
    "Git hook setup failed: pre-commit is not on PATH.\n" +
      "Install it with `brew install pre-commit` (macOS) or " +
      "`pipx install pre-commit`, then rerun `npm run setup:hooks`.\n" +
      "Hook setup is incomplete until that command succeeds.",
  );
} else if (result.error || result.status !== 0) {
  console.error(
    "Git hook setup failed. Resolve the pre-commit error above and rerun " +
      "`npm run setup:hooks`.",
  );
  if (result.error) console.error(result.error.message);
}

process.exit(result.status ?? 1);

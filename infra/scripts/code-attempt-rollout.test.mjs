import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// These are deployment safety contracts: a syntactically valid Terraform
// configuration can still activate the API before the trusted edge header exists.
const moduleRoot = new URL("../modules/app/", import.meta.url);
const lambda = readFileSync(new URL("lambda.tf", moduleRoot), "utf8");
const cloudfront = readFileSync(new URL("cloudfront.tf", moduleRoot), "utf8");

function resource(source, type, name) {
  const start = source.indexOf(`resource "${type}" "${name}" {`);
  assert.ok(start >= 0, `${type}.${name} must exist`);
  const next = source.indexOf('\nresource "', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

test("source-limiting API waits for the viewer-header distribution", () => {
  const api = resource(lambda, "aws_lambda_function", "api");
  const dependencies = api.match(/\bdepends_on\s*=\s*\[([^\]]*)\]/s)?.[1];
  assert.match(dependencies ?? "", /\baws_cloudfront_distribution\.frontend\b/);
});

test("viewer-header distribution waits for propagation before releasing the API", () => {
  const frontend = resource(
    cloudfront,
    "aws_cloudfront_distribution",
    "frontend",
  );
  assert.match(frontend, /^\s*wait_for_deployment\s*=\s*true\s*$/m);
});

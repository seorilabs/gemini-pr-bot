import assert from "node:assert/strict";
import test from "node:test";
import { classifyChange } from "./repo-context.js";

test("standard XCTest and .NET test paths are classified as tests-only", () => {
  assert.equal(classifyChange(["MyAppTests/FooTests.swift"]), "tests_only");
  assert.equal(classifyChange(["Project.Tests/FooTests.cs"]), "tests_only");
});

test("product, config, and mixed changes receive stable host classifications", () => {
  assert.equal(classifyChange(["src/save.ts"]), "product_logic");
  assert.equal(classifyChange([".github/workflows/ci.yml"]), "config_or_workflow");
  assert.equal(classifyChange(["src/save.ts", "README.md"]), "mixed");
  assert.equal(classifyChange(["package.json", "README.md"]), "config_or_workflow");
  assert.equal(classifyChange(["scripts/release.ts"]), "config_or_workflow");
  assert.equal(classifyChange(["src/api.generated.ts"]), "docs_assets");
});

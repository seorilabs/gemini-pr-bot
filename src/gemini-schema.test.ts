import assert from "node:assert/strict";
import test from "node:test";
import { toGeminiResponseJsonSchema } from "./gemini.js";

test("Gemini response schema keeps supported constraints and removes unsupported bounds", () => {
  const result = toGeminiResponseJsonSchema({
    type: "object",
    additionalProperties: false,
    required: ["status", "line"],
    properties: {
      status: {
        enum: ["covered", "missing", "unknown"],
        pattern: "^[a-z]+$",
      },
      line: {
        type: ["integer", "null"],
        minimum: 1,
      },
      evidence: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        items: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
        },
      },
    },
  });

  assert.deepEqual(result, {
    type: "object",
    required: ["status", "line"],
    properties: {
      status: {
        type: "string",
        enum: ["covered", "missing", "unknown"],
      },
      line: {
        anyOf: [
          { type: "integer", minimum: 1 },
          { type: "null" },
        ],
      },
      evidence: {
        type: "array",
        items: { type: "string" },
      },
    },
    additionalProperties: false,
  });
});

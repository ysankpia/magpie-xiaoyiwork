import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSchema,
  normalizeToolSchemas,
} from "../src/xiaoyi/schema.mjs";

test("$ref 内联：引用换成目标内容，$defs 不再出现", () => {
  const schema = {
    type: "object",
    properties: { city: { $ref: "#/$defs/City" } },
    required: ["city"],
    $defs: { City: { type: "string", description: "城市" } },
  };
  const out = normalizeSchema(schema);
  assert.deepEqual(out.properties.city, {
    type: "string",
    description: "城市",
  });
  assert.equal(out.$defs, undefined);
  assert.deepEqual(out.required, ["city"]);
});

test("$ref 同级键覆盖目标里的同名键", () => {
  const schema = {
    type: "object",
    properties: { city: { $ref: "#/$defs/City", description: "覆盖" } },
    $defs: { City: { type: "string", description: "原始" } },
  };
  const out = normalizeSchema(schema);
  assert.equal(out.properties.city.description, "覆盖");
  assert.equal(out.properties.city.type, "string");
});

test("缺 type 的 enum / const 补上 type", () => {
  const out = normalizeSchema({
    type: "object",
    properties: {
      a: { enum: ["x", "y"] },
      b: { enum: [1, 2] },
      c: { const: true },
      d: { enum: ["x", 1] },
    },
  });
  assert.equal(out.properties.a.type, "string");
  assert.equal(out.properties.b.type, "integer");
  assert.equal(out.properties.c.type, "boolean");
  assert.deepEqual(out.properties.d.type, ["string", "integer"]);
});

test("循环引用不会挂死，也不会把 $ref 漏给上游", () => {
  const schema = {
    type: "object",
    properties: { node: { $ref: "#/$defs/Node" } },
    $defs: {
      Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } },
    },
  };
  const out = normalizeSchema(schema);
  const text = JSON.stringify(out);
  assert.equal(text.includes("$ref"), false);
  assert.equal(text.includes("$defs"), false);
  assert.equal(out.properties.node.type, "object");
});

test("解不开的引用退成同级约束，不留 $ref", () => {
  const out = normalizeSchema({
    type: "object",
    properties: { x: { $ref: "#/$defs/Missing" } },
  });
  assert.equal(JSON.stringify(out).includes("$ref"), false);
  assert.equal(out.properties.x.type, undefined);
});

test("没有 $ref 也没有缺 type 的 enum 时原样返回", () => {
  const schema = {
    type: "object",
    properties: { city: { type: "string" }, n: { type: "integer" } },
    required: ["city"],
  };
  assert.deepEqual(normalizeSchema(schema), schema);
});

test("normalizeToolSchemas 就地改写 tools，无工具时返回 false", () => {
  const body = {
    tools: [
      {
        type: "function",
        function: {
          name: "f",
          parameters: {
            type: "object",
            properties: { c: { $ref: "#/$defs/C" } },
            $defs: { C: { type: "string" } },
          },
        },
      },
    ],
  };
  assert.equal(normalizeToolSchemas(body), true);
  assert.equal(JSON.stringify(body).includes("$ref"), false);
  assert.equal(normalizeToolSchemas({ messages: [] }), false);
});

// 工具 Schema 归一化
//
// Kimi 后端对 JSON Schema 的校验比 OpenAI 严：
//   · 任何 $ref 引用都直接拒（SSE 错帧 `11115 / server inner`，magpie 记成 502）
//   · 缺 type 的 enum / const 也拒
//
// 实测（2026-11-26）：同一份带 $ref 的 schema，DeepSeek / GLM-5.3 / GLM-Flash /
// MiniMax 全部 200，只有 Kimi 37 秒后 502；把 $ref 内联成等价 schema 后 200 / 3.5 秒。
//
// 没有 $ref 也没有缺 type 的 enum/const 时这里是空操作，所以对所有模型都跑一遍，
// 不用维护一份「哪些模型严」的名单。

const MAX_DEPTH = 64;

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function jsonType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  switch (typeof v) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(v) ? "integer" : "number";
    default:
      return "object";
  }
}

/** 解析本地引用（只认 `#/` 开头的 JSON Pointer）；解不开返回 undefined */
function resolvePointer(root, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  let cur = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObj(cur) && !Array.isArray(cur)) return undefined;
    cur = cur[key];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** 缺 type 的 enum / const 补上 type；type 已存在时原样返回 */
function withType(node) {
  if (!isObj(node) || node.type !== undefined) return node;
  if (node.enum !== undefined) {
    const values = Array.isArray(node.enum) ? node.enum : [];
    const types = [...new Set(values.map(jsonType))];
    if (types.length === 1) return { ...node, type: types[0] };
    if (types.length > 1) return { ...node, type: types };
    return node;
  }
  if (node.const !== undefined) return { ...node, type: jsonType(node.const) };
  return node;
}

function walk(node, root, stack, depth) {
  if (depth > MAX_DEPTH) return node;
  if (Array.isArray(node))
    return node.map((v) => walk(v, root, stack, depth + 1));
  if (!isObj(node)) return node;

  if (typeof node.$ref === "string") {
    const target = resolvePointer(root, node.$ref);
    const { $ref, ...rest } = node;
    // 解不开 / 成环：$ref 不能漏给上游，退成只剩同级约束的 schema
    if (target === undefined || stack.has(node.$ref))
      return walk(withType(rest), root, stack, depth + 1);
    // 同级键（description 之类）覆盖目标里的同名键，与 JSON Schema 的语义一致
    const merged = {
      ...walk(target, root, new Set([...stack, node.$ref]), depth + 1),
      ...rest,
    };
    return walk(withType(merged), root, stack, depth + 1);
  }

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    // 内联之后没有引用者了，留着只会让上游再看到一次 $defs
    if (key === "$defs" || key === "definitions") continue;
    out[key] = walk(value, root, stack, depth + 1);
  }
  return withType(out);
}

/** 把一棵 schema 里的本地 $ref 内联，并给缺 type 的 enum/const 补上 */
export function normalizeSchema(schema) {
  if (!isObj(schema)) return schema;
  return walk(schema, schema, new Set(), 0);
}

/** 就地改写 body.tools[].function.parameters；返回是否改动了 */
export function normalizeToolSchemas(body) {
  const tools = body?.tools;
  if (!Array.isArray(tools)) return false;
  let changed = false;
  for (const tool of tools) {
    const fn = tool?.function;
    if (!isObj(fn) || !isObj(fn.parameters)) continue;
    const next = normalizeSchema(fn.parameters);
    if (JSON.stringify(next) !== JSON.stringify(fn.parameters)) {
      fn.parameters = next;
      changed = true;
    }
  }
  return changed;
}

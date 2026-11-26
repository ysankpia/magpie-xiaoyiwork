// 上游帧 → 标准 OpenAI chat chunk 的字段映射
//
// 上游（HAG 网关）给的是 OpenAI chat 形状，但有几处不是标准命名：
//   · usage 用 Responses 风格的 input_tokens/output_tokens（最后一帧也带 prompt_tokens）
//   · 顶层没有 object/created/model（要补）
//   · choice.index 偶尔缺失
// 这里统一映射，对外只给标准 OpenAI 字段。

import crypto from "node:crypto";

export const newId = () => "chatcmpl-" + crypto.randomBytes(9).toString("hex");

/** 上游会把 token 数写成字符串；SDK 的 usage schema 是 z.number()，不转会整帧被拒 */
const toNum = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

/**
 * usage → OpenAI 标准 usage。
 * 上游一个 token 数都没给就返回 undefined —— 编一组 0 是在说"这次调用没花钱"。
 */
export function mapUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const prompt = toNum(usage.prompt_tokens) ?? toNum(usage.input_tokens);
  const completion =
    toNum(usage.completion_tokens) ?? toNum(usage.output_tokens);
  const total = toNum(usage.total_tokens);
  // 只给了 total 的帧也是真数据，别丢
  if (prompt === undefined && completion === undefined && total === undefined)
    return undefined;
  const p = prompt ?? 0;
  const c = completion ?? 0;
  const out = {
    prompt_tokens: p,
    completion_tokens: c,
    total_tokens: total ?? p + c,
  };
  // ⚠ 嵌套的明细也是同一批"可能是字符串"的数字。SDK 的 schema 对它们是 z.number()，
  //   一个字符串就让整帧被拒 —— 而 usage 帧被拒 = 整条回复判成 error。
  //   Responses 风格（input_tokens_details / output_tokens_details）也要一起认。
  const cached = toNum(
    usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens,
  );
  if (cached !== undefined)
    out.prompt_tokens_details = { cached_tokens: cached };
  const details =
    usage.completion_tokens_details ?? usage.output_tokens_details ?? {};
  const completionDetails = {};
  for (const key of [
    "reasoning_tokens",
    "accepted_prediction_tokens",
    "rejected_prediction_tokens",
  ]) {
    const n = toNum(details[key]);
    if (n !== undefined) completionDetails[key] = n;
  }
  if (Object.keys(completionDetails).length)
    out.completion_tokens_details = completionDetails;
  return out;
}

/** 上游的 index 可能是字符串；非整数就退回位置 */
const toIndex = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

/**
 * 上游的 tool_calls 分片直接转发会被 SDK 拒（schema 要求 index 是 number、function 必须存在），
 * 整帧被拒 = 这个工具调用丢了。补齐成 SDK 认的形状。
 *
 * ⚠ index 必须跨帧连续地对上同一个调用。上游的续帧常常只带 arguments、不带 index，
 *   此时**不能**退回"帧内位置"：两个调用各自的续帧都会落到 0，被合并成一个。
 *   规则：显式 index 优先；否则按 id 认领；再否则接在上一帧那个调用后面。
 *
 * @param {any[]} list 上游分片
 * @param {{byId: Map<string, number>, next: number, last?: number}} state 一条回复共用一个
 */
function mapToolCalls(list, state) {
  return list
    .filter((tc) => tc && typeof tc === "object")
    .map((tc) => {
      let index;
      if (tc.index != null) {
        index = toIndex(tc.index, state.next);
      } else if (tc.id != null) {
        const id = String(tc.id);
        index = state.byId.has(id) ? state.byId.get(id) : state.next++;
        if (!state.byId.has(id)) state.byId.set(id, index);
      } else {
        index = state.last ?? state.next++;
      }
      if (index >= state.next) state.next = index + 1;
      state.last = index;
      // ⚠ function 键必须在，但里面可以为空 —— 塞 name:"" 会让 SDK 当成"名字是空"而丢掉
      //   这一帧带的 id，最后凭空生成一个 id，调用方就认不出这是哪个工具了。
      const out = { index, function: {} };
      if (tc.id != null) out.id = String(tc.id);
      if (tc.function?.name != null)
        out.function.name = String(tc.function.name);
      if (tc.function?.arguments != null) {
        out.function.arguments =
          typeof tc.function.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments);
      }
      if (tc.extra_content) out.extra_content = tc.extra_content;
      return out;
    });
}

/**
 * 上游的 finish_reason 值空间比 OpenAI 大（eos / stop_sequence / end_turn / max_tokens…）。
 * SDK 只认五个，别的一律落到 "other" —— 客户端会看到一个它不认识的中止状态。
 */
const FINISH_MAP = {
  stop: "stop",
  length: "length",
  content_filter: "content_filter",
  function_call: "function_call",
  tool_calls: "tool_calls",
  eos: "stop",
  stop_sequence: "stop",
  end_turn: "stop",
  completed: "stop",
  max_tokens: "length",
  max_output_tokens: "length",
};
export const normalizeFinish = (v) =>
  typeof v === "string" && v ? (FINISH_MAP[v] ?? "stop") : null;

/** 两个字段都可能是空串（上游每帧都发 reasoning_content:""）—— 取真正有内容的那个 */
const pickText = (a, b) => {
  if (typeof a === "string" && a !== "") return a;
  if (typeof b === "string" && b !== "") return b;
  return undefined;
};

/** 单个 choice → 标准 OpenAI choice；坏 choice 返回 null（由调用方过滤） */
export function mapChoice(choice, index, { first = false, tools } = {}) {
  if (!choice || typeof choice !== "object") return null;
  // ⚠ 只搬 OpenAI 认识的键。上游会带 finish_details / matched_stop 之类，
  //   原样透传会让严格 schema 把整帧拒掉。
  const c = { index: typeof choice.index === "number" ? choice.index : index };
  const src = choice.delta || {};
  const delta = {};
  // ⚠ 不补空 content：上游多数帧的 delta 里根本没有 content（只有 reasoning_content），
  //   补成 "" 会让每帧都带空内容（实测 546/558 帧是空串），既噪音又误导客户端。
  if (typeof src.content === "string") {
    if (src.content !== "") delta.content = src.content;
  } else if (Array.isArray(src.content) && src.content.length) {
    delta.content = src.content; // SDK 的 content schema 也收数组，别丢
  }
  // ⚠ 上游两种命名都见过，SDK 也两种都读（delta.reasoning_content ?? delta.reasoning）。
  //   统一输出 OpenAI 的 reasoning_content，客户端只认这一个名字。
  const reasoning = pickText(src.reasoning_content, src.reasoning);
  if (reasoning) delta.reasoning_content = reasoning;
  if (typeof src.refusal === "string" && src.refusal !== "")
    delta.refusal = src.refusal;
  if (Array.isArray(src.tool_calls) && src.tool_calls.length)
    delta.tool_calls = mapToolCalls(src.tool_calls, tools);
  // ⚠ 上游**每帧**都带 role:"assistant"，但 OpenAI 规范是 role 只在首帧出现。
  //   固定写 "assistant"：SDK 的枚举只认 assistant / ""，上游给了别的值整帧会被拒。
  if (first && Object.keys(delta).length) delta.role = "assistant";
  c.delta = delta;
  // finish_reason：上游只在末帧给，其余帧没有这个键 —— 标准做法是显式 null。
  // ⚠ 空串也算没给：透出 "" 是枚举外的值，客户端会认为这一轮没有正常结束。
  c.finish_reason = normalizeFinish(choice.finish_reason);
  c.logprobs = choice.logprobs ?? null;
  return c;
}

/** 整帧 → 标准 OpenAI chunk */
export function mapChunk(
  frame,
  { model = "", id = "", created = 0, first = false, tools } = {},
) {
  const list = Array.isArray(frame.choices) ? frame.choices : [];
  // 一条回复共用的工具调用序号表（跨帧对齐 index），由调用方持有
  const toolState = tools ?? { byId: new Map(), next: 0 };
  const out = {
    // ⚠ 调用方的上下文优先：上游的 id/created 在帧之间会跳（内容帧带 mp-…、收尾帧不带），
    //   让帧覆盖就会在同一条回复里换 id。
    id: id || frame.id || newId(),
    object: "chat.completion.chunk",
    created: created || frame.created || Math.floor(Date.now() / 1000),
    model: model || frame.model || "",
    choices: list
      .map((c, i) => mapChoice(c, i, { first, tools: toolState }))
      .filter(Boolean),
  };
  if (frame.system_fingerprint)
    out.system_fingerprint = frame.system_fingerprint;
  const usage = mapUsage(frame.usage);
  if (usage) out.usage = usage;
  return out;
}

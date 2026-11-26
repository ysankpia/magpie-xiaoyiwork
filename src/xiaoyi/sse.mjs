// SSE 改写 / 聚合
//
// 上游只吃 SSE 且不发 [DONE]、缺 id/object/created/index 标准字段：
//   流式 → 逐帧补齐字段原样转发，收尾补 finish_reason 和 [DONE]
//   非流式 → 本地聚合（含 reasoning_content 与流式 tool_calls 拼接）
// CRLF 行尾统一成 \n 再判块，否则 \r\n\r\n 永远凑不出 \n\n。

import crypto from "node:crypto";
import { readJsonSafe } from "./protocol.mjs";
import { mapChunk, mapUsage, newId, normalizeFinish } from "./openai-map.mjs";

/** 单帧 SSE 事件不该有这么大。超过就是上游抽风或流是半截的，别把内存吃光。 */
const MAX_BUFFER = 4 * 1024 * 1024;

/** 从一个 SSE 事件块里取 data 文本（多行 data: 拼接）；无 data 返回 null */
function frameData(block) {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")
    .trim();
  return data || null;
}

/**
 * 增量解码器：把 chunk 字节变成已经归一化行尾的文本。
 *
 * ⚠ 两件事必须一起做，否则会撕坏帧：
 *   ① TextDecoder({stream:true}) 保住跨 chunk 被切开的多字节字符（中文 3 字节）。
 *   ② \r\n 可能正好被切在两个 chunk 之间。逐块 replace 会把它变成**两个**换行，
 *      在多行 data: 事件里就把一帧撕成两半。所以把结尾的孤立 \r 留到下一块再判。
 */
function makeLineReader() {
  const decoder = new TextDecoder();
  let carry = "";
  return {
    push(value) {
      const text = carry + decoder.decode(value, { stream: true });
      const held = text.endsWith("\r");
      carry = held ? "\r" : "";
      return (held ? text.slice(0, -1) : text).replace(/\r\n?/g, "\n");
    },
    flush() {
      const rest = carry + decoder.decode();
      carry = "";
      return rest.replace(/\r\n?/g, "\n");
    },
  };
}

/**
 * 上游把错误塞在**流里**：HTTP 200，但帧是 `{"error":{"code":"11115","message":"..."}}`。
 * 不挑出来就成了一张"内容为空的正常回复" —— 客户端什么都看不到。
 *
 * 帧形状对齐 @ai-sdk/openai-compatible 的 errorSchema（error.message 必填，
 * code/type 可选），SDK 才会把它当成错误帧抛出来，而不是当成一个空 chunk。
 * 上游三种形状都见过：裸字符串、{message}、只有 {code} —— 只有 code 时拿 code 当消息。
 * 连 code 都没有也**不能**当成空帧咽下去：那是把一次真失败伪装成空回复。
 */
export function frameError(frame) {
  const e = frame?.error;
  if (e == null) return null;
  const message =
    (typeof e === "string"
      ? e
      : String(e.message ?? e.desc ?? e.text ?? e.code ?? "")
    ).trim() || "上游返回了一个没有说明的错误";
  const out = { message };
  if (typeof e === "object") {
    if (e.code !== undefined) out.code = e.code;
    if (e.type !== undefined) out.type = e.type;
  }
  return out;
}

/** 流式：上游 body → 标准 OpenAI SSE ReadableStream（字段映射 + 收尾 [DONE]） */
export function transformSse(upstream, modelHint) {
  const encoder = new TextEncoder();
  const lines = makeLineReader();
  let buf = "";
  // 同一条回复的所有 chunk 共用一个 id（OpenAI 规范）
  const streamId = newId();
  const created = Math.floor(Date.now() / 1000);
  // ⚠ reader 必须在 start() 外面拿到：start 里 getReader() 之后上游流就被锁了，
  //   此时 `upstream.cancel()` 会抛「stream is locked」—— 客户端按停就掐不掉上游，白烧积分。
  const reader = upstream.getReader();
  return new ReadableStream({
    async start(controller) {
      // 客户端断开后 controller 已关，enqueue 会抛 —— 吞掉
      const push = (text) => {
        if (!text) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          /* 已取消 */
        }
      };
      const send = (obj) => push(`data: ${JSON.stringify(obj)}\n\n`);
      let roleSent = false;
      let sawFinish = false;
      let sawToolCalls = false;
      let errored = false;
      // 一条回复共用：工具调用分片的 index 要跨帧对齐到同一个调用
      const tools = { byId: new Map(), next: 0 };

      // ⚠ 单帧出错只能毁掉这一帧。抛到外层循环的话，一次映射异常会被报成
      //   「上游流式中断」，后面所有内容全丢 —— 把我们的 bug 冒充成上游的故障。
      //   返回 true = 这一轮已经定局，别再读了。
      const emit = (data) => {
        const parsed = readJsonSafe(data);
        // 非 JSON 帧直接丢掉：原样转发等于让上游往客户端注入任意 SSE，
        // 包括一行伪造的 `data: [DONE]` 或伪造的错误帧。
        if (!parsed || typeof parsed !== "object") return false;
        const err = frameError(parsed);
        if (err) {
          errored = true;
          send({ error: err });
          return true;
        }
        const chunk = mapChunk(parsed, {
          model: modelHint,
          id: streamId,
          created,
          first: !roleSent,
          tools,
        });
        const choice = chunk.choices[0];
        if (choice?.delta && Object.keys(choice.delta).length) roleSent = true;
        if (choice?.finish_reason != null) sawFinish = true;
        if (choice?.delta?.tool_calls) sawToolCalls = true;
        // 空帧不发：上游绝大多数帧是 {role, content:"", reasoning_content:""}
        const onlyEmpty =
          chunk.choices.length === 1 &&
          !Object.keys(choice.delta).length &&
          choice.finish_reason == null &&
          !chunk.usage;
        if ((!chunk.choices.length || onlyEmpty) && !chunk.usage) return false;
        send(chunk);
        return false;
      };

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += lines.push(value);
          // 一直没有分隔符就一直涨 —— 上游抽风或半截流时别把内存吃光
          if (buf.length > MAX_BUFFER)
            throw new Error(`SSE 帧超过 ${MAX_BUFFER} 字节仍无分隔符`);
          let idx;
          let settled = false;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = frameData(block);
            if (!data || data === "[DONE]") continue;
            try {
              if (emit(data)) {
                settled = true;
                break;
              }
            } catch {
              /* 这一帧映射不了，跳过，别连累后面的内容 */
            }
          }
          // ⚠⚠ 上游在流里报了错、客户端也已经看到了 —— 此时继续读就是白烧积分。
          //   只有掐掉 reader 才真的停得掉上游（signal 不会被我们触发）。
          if (settled) {
            await reader.cancel("upstream error frame").catch(() => {});
            break;
          }
        }
        buf += lines.flush();
        const tail = frameData(buf);
        // 半截帧（流断在中间）不是合法 JSON，丢掉 —— 别让客户端收到一个解析错误
        if (tail && tail !== "[DONE]" && readJsonSafe(tail)) {
          try {
            emit(tail);
          } catch {
            /* 同上 */
          }
        }
      } catch (err) {
        errored = true;
        send({ error: { message: `上游流式中断: ${err?.message || err}` } });
      } finally {
        // ⚠⚠ SDK 的 flush 见到「整条流没有 finish_reason」会把回复判成 error，
        //   把用户已经看到的内容整段丢掉。上游不给，就得我们补。
        //   已经报过错的就不补了 —— 别让一条失败的回合同时"失败"又"正常结束"。
        if (!sawFinish && !errored) {
          send({
            id: streamId,
            object: "chat.completion.chunk",
            created,
            model: modelHint || "",
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: sawToolCalls ? "tool_calls" : "stop",
              },
            ],
          });
        }
        push("data: [DONE]\n\n"); // 上游不发 [DONE]，不补客户端会一直挂着等
        try {
          reader.releaseLock();
        } catch {
          /* ignore */
        }
        try {
          controller.close();
        } catch {
          /* 已取消 */
        }
      }
    },
    // ⚠ 客户端按停时上游还在生成 —— 不掐掉就是白烧积分。
    //   取消 reader（不是 upstream：它已被 getReader() 锁住）。
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** 非流式：上游 SSE 聚合成一次完整 chat.completion */
export async function aggregate(upstream, modelHint) {
  const lines = makeLineReader();
  let buf = "";
  const acc = {
    content: "",
    reasoning: "",
    refusal: "",
    toolCalls: new Map(),
    finish: null,
    usage: null,
    error: null,
  };
  // 和流式同一套规则：续帧不带 index 时接在上一帧那个调用后面，别按帧内位置重编
  let anon = 0;
  let lastTool = null;

  const feed = (data) => {
    const frame = readJsonSafe(data);
    if (!frame || typeof frame !== "object") return;
    // ⚠ 上游的错误在流里（HTTP 200）。非流式路径不挑出来 = 返回一个空回复，
    //   调用方以为"模型没话说"，永远不知道上游报错了。
    const err = frameError(frame);
    if (err) {
      acc.error = err;
      return;
    }
    // ⚠ 只存**有数字**的 usage。上游绝大多数帧带的是 `usage:{}`，
    //   无条件覆盖会把最后几帧里真正的数字擦成空。
    const usage = mapUsage(frame.usage);
    if (usage) acc.usage = usage;
    const choice = Array.isArray(frame.choices) ? frame.choices[0] : null;
    if (!choice || typeof choice !== "object") return;
    const delta = choice.delta || {};
    let reasoningFromArray = "";
    if (typeof delta.content === "string") acc.content += delta.content;
    else if (Array.isArray(delta.content)) {
      // 和 SDK 的 convertOpenAICompatibleContent 保持同一套规则：
      // text 段进正文，thinking 段进思考 —— 不然流式和非流式会给出不同的 reasoning。
      for (const part of delta.content) {
        if (part?.type === "text" && typeof part.text === "string")
          acc.content += part.text;
        else if (part?.type === "thinking" && Array.isArray(part.thinking)) {
          reasoningFromArray += part.thinking
            .filter((c) => c?.type === "text" && typeof c.text === "string")
            .map((c) => c.text)
            .join("");
        }
      }
    }
    // 数组形式已经贡献了思考，就别再把同帧的字符串再算一遍
    if (reasoningFromArray) acc.reasoning += reasoningFromArray;
    else if (typeof delta.reasoning_content === "string")
      acc.reasoning += delta.reasoning_content;
    else if (typeof delta.reasoning === "string")
      acc.reasoning += delta.reasoning;
    if (typeof delta.refusal === "string" && delta.refusal)
      acc.refusal += delta.refusal;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        // ⚠ 键要能区分调用：index 可能是字符串；续帧常常只带 arguments、不带 index，
        //   此时要接在上一帧那个调用后面 —— 按"帧内位置"会把它并到 0 号调用里去。
        const n = Number(tc.index);
        let key;
        if (Number.isFinite(n)) key = n;
        else if (tc.id) key = `id:${tc.id}`;
        else key = lastTool ?? `anon:${anon++}`;
        lastTool = key;
        const entry = acc.toolCalls.get(key) ?? {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (tc.id) entry.id = tc.id;
        const name = tc.function?.name ?? tc.name;
        if (name) entry.function.name = entry.function.name || name;
        const args = tc.function?.arguments ?? tc.arguments;
        if (typeof args === "string") entry.function.arguments += args;
        else if (args && typeof args === "object")
          entry.function.arguments += JSON.stringify(args);
        acc.toolCalls.set(key, entry);
      }
    }
    if (choice.finish_reason) acc.finish = choice.finish_reason;
  };

  for await (const chunk of upstream) {
    buf += lines.push(chunk);
    if (buf.length > MAX_BUFFER)
      throw new Error(`SSE 帧超过 ${MAX_BUFFER} 字节仍无分隔符`);
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = frameData(block);
      if (data && data !== "[DONE]") feed(data);
    }
  }
  buf += lines.flush();
  const tail = frameData(buf);
  // 半截帧不是合法 JSON —— 丢掉，别把 `{"delta":{"cont` 当内容拼进去
  if (tail && tail !== "[DONE]" && readJsonSafe(tail)) feed(tail);

  // 上游报了错 → 抛出去（形态对齐 OpenAI：error.message 必填）
  if (acc.error) {
    throw Object.assign(new Error(acc.error.message), {
      code: acc.error.code,
      upstream: true,
    });
  }

  const message = { role: "assistant", content: acc.content };
  if (acc.reasoning) message.reasoning_content = acc.reasoning;
  // 拒答是 OpenAI 的正式字段；SDK 会据此把 finish_reason 判成 content-filter
  if (acc.refusal) message.refusal = acc.refusal;
  // ⚠ 没有名字的"工具调用"不是工具调用。留着会让 SDK 抛 AI_NoSuchToolError。
  const calls = [...acc.toolCalls.values()].filter((tc) => tc.function.name);
  if (calls.length) {
    message.tool_calls = calls.map((tc) => ({
      id: tc.id || "call_" + crypto.randomBytes(6).toString("hex"),
      type: "function",
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments || "{}",
      },
    }));
    if (!message.content) message.content = null;
  }
  // 上游声称 tool_calls 但一个带名字的调用都没有 → 它其实没调工具
  const finish =
    acc.finish === "tool_calls" && !calls.length
      ? "stop"
      : acc.finish || (calls.length ? "tool_calls" : "stop");
  return {
    id: newId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelHint || "",
    choices: [
      {
        index: 0,
        message,
        finish_reason: normalizeFinish(finish),
        logprobs: null,
      },
    ],
    // 上游没给 usage 就不给 —— 编一组 0 等于说这次调用没花钱
    ...(acc.usage ? { usage: acc.usage } : {}),
  };
}

// ④ auth.loader —— 接管所有出站请求
//
//   1. 换成 HAG 鉴权头（businessCredential + x-uid + x-device-id），删掉 SDK 的 Bearer
//   2. 上游只吃 SSE：强制 stream:true；客户端要非流式就本地聚合
//   3. 错误分流：401 → 登录失效；429 → 可重试 503；模型级 → 404；其余原样
//   4. Response 原样交回 —— 绝不在 fetch 里读成功响应的流

import {
  HAG,
  HEADERS,
  MAX_BODY_BYTES,
  SSE_BASE,
  PROVIDER,
} from "../context.mjs";
import { hagHeaders, readJsonSafe } from "../xiaoyi/protocol.mjs";
import { normalizeToolSchemas } from "../xiaoyi/schema.mjs";
import { transformSse, aggregate } from "../xiaoyi/sse.mjs";
import { stateOf } from "./refresh.mjs";

/**
 * 剥掉 magpie 的 provider 前缀：`xiaoyiwork/DeepSeek_V4.1_Flash_VE` → `DeepSeek_V4.1_Flash_VE`
 * 上游不认带斜杠的名字，会静默降级成通用助手。
 */
export function stripProviderPrefix(model) {
  const id = String(model ?? "");
  const prefix = `${PROVIDER}/`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function errorResponse(status, code, message, headers = {}) {
  return new Response(
    JSON.stringify({ error: { type: "upstream_error", code, message } }),
    {
      status,
      headers: { "content-type": "application/json", ...headers },
    },
  );
}

const byteLength = (v) => {
  if (typeof v === "string") return new TextEncoder().encode(v).byteLength;
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return v.byteLength;
  return 0;
};

/**
 * 上游对请求体超过 5 MiB 的反应不是 413，而是挂起约 56 秒再回 408。
 * 前置到 4.5 MiB 回标准 413，magpie 的 body_cap 会裁掉最早的历史图片再重试。
 */
function bodyTooLarge(actual, limit = MAX_BODY_BYTES) {
  const mb = (n) => (n / 1048576).toFixed(2);
  return new Response(
    JSON.stringify({
      error: {
        message: `请求体 ${mb(actual)} MB，超过单次请求上限 ${mb(limit)} MB`,
        type: "invalid_request_error",
        code: "request_too_large",
      },
    }),
    {
      status: 413,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

/**
 * 把上游响应头搬过来，去掉会被我们改写坏掉的几个。
 * body 已经被我们改写过（聚合 / SSE），长度和压缩标记都对不上了。
 */
function passthroughHeaders(headers) {
  const out = new Headers(headers);
  out.delete("content-length");
  out.delete("content-encoding");
  return out;
}

/**
 * 上游静默忽略的参数（实测：带不带都 200、结果一样）。
 * 删掉是为了别让调用方以为 max_tokens 生效了 —— 实际上限由模型自己定。
 *
 * ⚠ `stream_options` 不在这里：它是 OpenAI 协议的一部分，而且上游**本来就在每帧带 usage**，
 *   放过去既不会坏，又能在宿主打开 include_usage 时如实告诉它"这个字段我们收了"。
 */
const IGNORED_PARAMS = [
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "top_k",
  "stop",
  "n",
  "presence_penalty",
  "frequency_penalty",
  "logprobs",
  "top_logprobs",
  "seed",
  "user",
  "thinking",
];

export function loaderHook() {
  return async (getAuth) => {
    const auth = await getAuth();
    const state = stateOf(auth);
    if (!state) return {};

    return {
      baseURL: SSE_BASE,
      // 网关对任何路径都校验这两个头：宿主自己发的请求（如模型探测）也带上
      headers: {
        "x-request-from": HEADERS.requestFrom,
        "x-businessId": HEADERS.businessId,
      },
      fetch: async (input, init = {}) => {
        const url =
          typeof input === "string" ? input : (input?.url ?? String(input));
        const target = new URL(url);
        // ⚠ 我们在这个 fetch 上挂了 7 天的 businessCredential + x-uid + x-device-id。
        //   不锁目标源的话，宿主把任何 URL 递进来都会带着它们出门。
        if (target.origin !== HAG)
          throw new Error(`拒绝向上游以外的地址发请求：${target.origin}`);

        // ⚠ 所有请求都要带 HAG 头 —— 网关对**任何**路径都校验 x-request-from 等，
        //   漏了就是 400「Parameter is not valid. Parameter is [x-request-from]」。
        const headers = new Headers(init.headers);
        headers.delete("authorization"); // 上游用 businessCredential，不要 SDK 的 Bearer
        headers.delete("x-api-key");
        headers.delete("content-length");
        for (const [k, v] of Object.entries(hagHeaders(state)))
          headers.set(k, v);
        // 2api 同款：压缩的 SSE 会被解压缓冲成「一卡一卡」，要明文流
        headers.set("accept-encoding", "identity");

        // 非补全请求（/models 之类）也带头上游；连不上就让 fetch 抛，不编状态码。
        // redirect: manual —— 跨域重定向时 undici 只剥 authorization，自定义头照发，
        // 一个 302 就能把凭据交出去。
        if (!target.pathname.includes("/chat/completions"))
          return fetch(input, { ...init, headers, redirect: "manual" });

        let bodyObj = null;
        let bodyText = init.body;
        if (typeof init.body === "string") bodyObj = readJsonSafe(init.body);
        else if (
          init.body instanceof Uint8Array ||
          init.body instanceof ArrayBuffer
        ) {
          bodyObj = readJsonSafe(new TextDecoder().decode(init.body));
        }
        const wantStream = Boolean(bodyObj?.stream);
        if (bodyObj && typeof bodyObj === "object") {
          // ⚠⚠ 必须剥掉 provider 前缀（magpie 发的模型名是 "xiaoyiwork/DeepSeek_V4.1_Flash_VE"）。
          //   实测（2026-11-25）：带前缀上游**照收**，但回的是「通用助手」的通用回答，
          //   不是 DeepSeek —— 帧 id 是 `mp-…` 而非 `021795…`。乱写的模型名也一样回通用回答。
          //   也就是说上游不认带斜杠的名字，会静默降级成 Auto-Model。
          //   裸 id（"DeepSeek_V4.1_Flash_VE"）才真的路由到对应模型。
          bodyObj.model = stripProviderPrefix(bodyObj.model);
          for (const key of IGNORED_PARAMS) delete bodyObj[key];
          bodyObj.stream = true; // 上游只吃 SSE
          // Kimi 后端不认 $ref：内联掉再发，否则 11115 / server inner（magpie 记成 502）。
          // 对其他模型是空操作。
          normalizeToolSchemas(bodyObj);
          bodyText = JSON.stringify(bodyObj);
        }

        // 上游超过 5 MiB 会挂起约 56 秒再回 408 —— 在这里提前回 413，见 bodyTooLarge
        const bodyBytes = byteLength(bodyText);
        if (bodyBytes > MAX_BODY_BYTES) return bodyTooLarge(bodyBytes);

        const res = await fetch(url, {
          method: init.method || "POST",
          headers,
          body: bodyText,
          signal: init.signal,
          redirect: "manual",
        });

        if (res.ok) {
          // ⚠ 200 但没有 body（网关抽风 / 204 / HEAD 形状）：再往下走就是一句裸
          //   TypeError，SDK 认不出它是可重试的错误，用户看到一段栈。
          if (!res.body) {
            return errorResponse(
              502,
              "empty_upstream_body",
              "小艺Work 返回了 200 但响应体是空的",
            );
          }
          const modelHint = bodyObj?.model;
          // 流式响应也要把上游的头带回去（trace id、限流信息），只要别带会误导的
          const streamHeaders = passthroughHeaders(res.headers);
          streamHeaders.set("content-type", "text/event-stream; charset=utf-8");
          if (wantStream || !bodyObj) {
            return new Response(transformSse(res.body, modelHint), {
              status: 200,
              headers: streamHeaders,
            });
          }
          // 上游在流里报错（HTTP 200 + {"error":{...}}）时 aggregate 会抛，别让它变成空回复
          const full = await aggregate(res.body, modelHint);
          return new Response(JSON.stringify(full), {
            status: 200,
            headers: {
              ...Object.fromEntries(streamHeaders),
              "content-type": "application/json; charset=utf-8",
            },
          });
        }

        // —— 错误分流：只读错误响应的 body ——
        // body 读不出来也要按状态码判（401 的登录态标记不能丢）；但用户按停不算读不出来
        const text = await res.text().catch((err) => {
          if (err?.name === "AbortError") throw err;
          return "";
        });
        // ⚠ 实测（2026-11-25）：凭据无效 / uid 不对 / deviceId 不对 / 缺凭据，
        //   上游**一律 401 + {"code":"authFailed"}** —— 不是 403。只有 401 才算登录失效，
        //   否则一个 403 就能把还能用的账号永久标死。
        if (res.status === 401) {
          return errorResponse(
            401,
            "sign_in_expired",
            "小艺Work 登录态已过期，请重新登录。",
            {
              "X-Magpie-Sign-In": "expired",
            },
          );
        }
        if (res.status === 429) {
          // ⚠ 上游说了等多久就得让它等到 —— 丢掉 retry-after，SDK 会按固定 2s/4s 重打，
          //   三次都撞在限流器上，还可能把限流升级。
          const retryAfter =
            res.headers.get("retry-after") || res.headers.get("retry-after-ms");
          return errorResponse(
            503,
            "rate_limited",
            `上游限流，稍后重试：${text.slice(0, 300)}`,
            retryAfter ? { "retry-after": retryAfter } : {},
          );
        }
        if (res.status === 404) {
          return errorResponse(
            404,
            "model_unavailable",
            `该模型在当前账号不可用：${text.slice(0, 300)}`,
          );
        }
        // ⚠ 别把上游的 content-length / content-encoding 原样带回来：
        //   body 已经被我们改写过（聚合 / SSE），长度和压缩标记都对不上了。
        return new Response(text || null, {
          status: res.status,
          headers: passthroughHeaders(res.headers),
        });
      },
    };
  };
}

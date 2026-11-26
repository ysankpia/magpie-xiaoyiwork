// ② auth.methods —— 浏览器 OAuth 登录
//
// authorize() 立刻返回；换 token / 签票全在 callback() 里。
// deviceId = sha256(机器种子)_uid，首次 createCredential 成功即登记设备。
//
// 加第二个账号：华为的授权页没有任何强制登录 / 切换账号的参数（实测
// prompt / prompt=select_account / login_hint 一律被静默忽略，返回的页面字节数
// 完全相同），浏览器里已登录哪个华为账号就直接拿哪个授权。所以第二个账号只能
// 用无痕窗口打开，插件这边只负责把这句话说清楚。

import crypto from "node:crypto";
import { PROVIDER } from "../context.mjs";
import { deviceIdFor, createCredential } from "../xiaoyi/protocol.mjs";
import {
  pkcePair,
  buildAuthorizeUrl,
  portFree,
  startCallbackServer,
  exchangeCode,
} from "../xiaoyi/oauth.mjs";
import { slotsForUid } from "../duplicate.mjs";

const INSTRUCTIONS =
  "用华为账号登录。注意：小艺Work 桌面端若开着会占用 17355 端口，请先退出它。" +
  "要添加**另一个**华为账号，请把下面的链接复制到无痕窗口打开 —— 普通窗口会直接用已登录的那个账号授权。";

/**
 * @param {{ configDir?: string|null, allowDuplicate?: () => boolean }} [deps]
 */
export function methods({
  configDir = null,
  allowDuplicate = () => false,
} = {}) {
  return [
    {
      type: "oauth",
      label: "华为账号登录（浏览器）",
      async authorize(_inputs, ctx = {}) {
        if (!(await portFree())) {
          return {
            type: "failed",
            error:
              "端口 17355 被占用：登录需要它接回调，请先完全退出小艺Work 桌面端再重试",
          };
        }
        const { verifier, challenge } = pkcePair();
        const state = crypto.randomUUID().replace(/-/g, "");
        let server;
        try {
          server = startCallbackServer(state, ctx.signal);
          await server.listening;
        } catch (err) {
          // 不关就会漏掉一个 5 分钟定时器 + 一个监听器
          server?.close();
          return {
            type: "failed",
            error: `回调服务启动失败：${err?.message || err}`,
          };
        }
        return {
          url: buildAuthorizeUrl(challenge, state),
          instructions: INSTRUCTIONS,
          method: "auto",
          async callback(_code, cbCtx = {}) {
            try {
              const code = await server.codePromise;
              const session = await exchangeCode(code, verifier);
              const uid = session.uid;
              if (!uid)
                return { type: "failed", error: "华为账号信息里没有 uid" };
              // ⚠ 签票会作废旧票。流程被丢弃后还去签，账号里就留一张死票 + 7 天后的
              //   expires —— renewAt 不会触发，只能重新登录。
              if (cbCtx.signal?.aborted)
                return { type: "failed", error: "登录已取消" };
              // ⚠ 去重必须在签票之前：签完才发现重复，旧票已经废了，两个槽位都不能用。
              if (!allowDuplicate()) {
                const slots = slotsForUid(configDir, PROVIDER, uid);
                if (slots.length) {
                  const who = session.displayName || uid;
                  return {
                    type: "failed",
                    error:
                      `账号 ${who} 已经添加过了（${slots.join("、")}）。同一个账号只允许一个槽位；` +
                      `要给同一个账号再开一个，先在编辑页打开「允许同一账号重复添加」。` +
                      `要添加的是**另一个**华为账号的话，请用无痕窗口重新登录。`,
                  };
                }
              }
              const deviceId = deviceIdFor(uid);
              const created = await createCredential(
                session.accessToken,
                uid,
                deviceId,
              );
              if (!created.ok) {
                return {
                  type: "failed",
                  error: `${created.message}。这台设备可能尚未登记：先用小艺Work 在本机登录一次再试。`,
                };
              }
              return {
                type: "success",
                refresh: session.refreshToken,
                access: created.credential,
                expires: created.validTimeSec * 1000,
                // accountId 是给人看的名字（华为账号的 display_name）。取不到就不给 ——
                // uid 是内部 ID，拿它当名字会让卡片显示成一串数字。
                ...(session.displayName
                  ? { accountId: String(session.displayName) }
                  : {}),
                uid,
                deviceId,
                metadata: {
                  uid,
                  deviceId,
                  displayName: session.displayName || null,
                },
              };
            } catch (err) {
              return { type: "failed", error: err?.message || String(err) };
            }
            // 不在这里 server.close()：回调页刚发出去，浏览器还要取 favicon、
            // 用户也可能刷新。结算后由 startCallbackServer 的宽限期关闭。
          },
        };
      },
    },
  ];
}

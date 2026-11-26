// ③ auth.refresh —— 续期（代刷 → 立刻签票，背靠背）
//
// ⚠ 签名是 (auth, provider) —— 第一个参数是账号对象，不是 getter（marvis 踩过：
//   写成 getAuth() 后 refresh 一次都没跑起来过）。兼容函数形态。
// ⚠ 返回是合并语义：metadata 必须展开旧值再覆盖，只给新字段会把 uid/deviceId 丢掉。
// ⚠ 锁键 = refreshToken 本身（凭据身份）：token 一换键就换，成功回放天然失效。

import { createRefreshLock } from "../refresh-lock.mjs";
import { renewCredential, deviceIdFor } from "../xiaoyi/protocol.mjs";

const lock = createRefreshLock();

/** 从账号对象归一出续期要的四件套 */
export function stateOf(auth) {
  const meta = auth?.metadata ?? {};
  const credential = auth?.access || auth?.key || null;
  const uid = auth?.uid || meta.uid || null;
  if (!credential || !uid) return null;
  return {
    credential,
    uid,
    deviceId: auth?.deviceId || meta.deviceId || deviceIdFor(uid),
    refreshToken: auth?.refresh || meta.refreshToken || null,
  };
}

export function refreshHook() {
  return async (authOrGetter, _provider) => {
    const auth =
      typeof authOrGetter === "function" ? await authOrGetter() : authOrGetter;
    const state = stateOf(auth);
    if (!state)
      throw Object.assign(new Error("登录信息不完整，请重新登录"), {
        signIn: "expired",
      });
    if (!state.refreshToken)
      throw Object.assign(new Error("没有 refreshToken，请重新登录"), {
        signIn: "expired",
      });

    return lock.run(state.refreshToken, async () => {
      const renewed = await renewCredential(state);
      if (!renewed.ok) {
        throw Object.assign(new Error(`续期失败：${renewed.message}`), {
          signIn: "expired",
        });
      }
      const meta = auth?.metadata ?? {};
      return {
        access: renewed.credential,
        // ⚠ 必须保留 refresh token：上游代刷只回 accessToken，refresh token 不轮换。
        //   丢了就再也续不了期，只能重新登录。两个位置都写，老数据路径也覆盖到。
        refresh: state.refreshToken,
        expires: renewed.validTimeSec * 1000,
        uid: state.uid,
        deviceId: state.deviceId,
        // accountId 是给人看的名字，取不到就空串（别拿 uid 这种内部 ID 当名字）
        ...(meta.displayName ? { accountId: String(meta.displayName) } : {}),
        metadata: {
          ...meta,
          uid: state.uid,
          deviceId: state.deviceId,
          refreshToken: state.refreshToken,
          expires: renewed.validTimeSec * 1000,
        },
      };
    });
  };
}

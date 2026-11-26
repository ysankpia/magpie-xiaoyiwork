// 同一账号去重
//
// 签票（business-credential/create）会**作废**上一张票。同一个 uid 再加一次，
// 不会得到两个能用的槽位，只会多一个死槽位 + 一张废掉的旧票。所以判断必须放在
// 签票**之前** —— 签完再发现重复，旧票已经废了，只能重新登录。
//
// ⚠ 但「已经占着这个 uid」不等于「重复添加」：凭据过期后重新登录，槽位还在。
//   所以这里只负责把槽位和它的凭据读出来，由调用方探测旧票还活不活着 ——
//   死了就放行（这是重新登录），活着才拒绝。
//
// 读的是 magpie 自己的 plugin-auth.json：槽位键是 `provider` 或 `provider#<slot>`，
// uid 可能在顶层，也可能在 metadata 里（本机导入那条路会放在 metadata）。

import fs from "node:fs";
import path from "node:path";

/**
 * 这个 uid 已经占了的槽位，带各自的凭据。
 * @returns {{ key: string, credential: string|null, uid: string, deviceId: string|null }[]}
 */
export function entriesForUid(configDir, provider, uid) {
  if (!configDir || !uid || !provider) return [];
  let all;
  try {
    all = JSON.parse(
      fs.readFileSync(path.join(configDir, "plugin-auth.json"), "utf8"),
    );
  } catch {
    return [];
  }
  if (!all || typeof all !== "object") return [];
  const out = [];
  for (const [key, value] of Object.entries(all)) {
    if (key !== provider && !key.startsWith(`${provider}#`)) continue;
    if (!value || typeof value !== "object") continue;
    if ((value.uid ?? value.metadata?.uid) !== uid) continue;
    out.push({
      key,
      credential: value.access ?? value.key ?? null,
      uid,
      deviceId: value.deviceId ?? value.metadata?.deviceId ?? null,
    });
  }
  return out;
}

/** 只要槽位键（给提示文案用） */
export function slotsForUid(configDir, provider, uid) {
  return entriesForUid(configDir, provider, uid).map((e) => e.key);
}

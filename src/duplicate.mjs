// 同一账号去重
//
// 签票（business-credential/create）会**作废**上一张票。同一个 uid 再加一次，
// 不会得到两个能用的槽位，只会多一个死槽位 + 一张废掉的旧票。所以判断必须放在
// 签票**之前** —— 签完再发现重复，旧票已经废了，只能重新登录。
//
// 读的是 magpie 自己的 plugin-auth.json：槽位键是 `provider` 或 `provider#<slot>`，
// uid 可能在顶层，也可能在 metadata 里（本机导入那条路会放在 metadata）。

import fs from "node:fs";
import path from "node:path";

/**
 * 这个 uid 已经占了哪些槽位。读不到就返回空数组（宁可让用户加，也别卡死登录）。
 * @returns {string[]}
 */
export function slotsForUid(configDir, provider, uid) {
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
    if ((value.uid ?? value.metadata?.uid) === uid) out.push(key);
  }
  return out;
}

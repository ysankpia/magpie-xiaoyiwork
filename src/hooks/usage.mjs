// ⑤ auth.usage —— 积分额度展示
//
// 额度有两个互不相干的桶，别混成一个数字：
//   ① 会员积分池（agentId=1 的 celiaPremiumPrivilege.aiPoints）
//      freePoints/purchasedPoints/giftPoints/compstPoints 之和 = totalPoints
//      —— 上游不给任何重置日期（aiPointDetailDisplay:false），不编
//   ② 权益包（平台 agentId 的 privilegeList）
//      privilegeDetail 里带"剩余积分：N"，expireTime 是作废时间（runsOutAt）
//
// 上游没有发放总量字段：「总计」只能取装插件后观测到的最大值当分母。
// 只观测到一个值时不声称知道总量（走钱包型），见 pointsWindow。
// 状态按 uid 分文件存（同机多账号互不覆盖）。
// 上游额度接口偶发 408：一个窗口都没拿到时回落上次成功结果。

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { usage as buildUsage, QuotaShapeError } from "../quota.mjs";
import { PREMIUM_AGENT_ID, PLATFORM_AGENT_ID } from "../context.mjs";
import {
  queryBilling,
  parsePrivilegeDetail,
  parseCompactTime,
  num,
} from "../xiaoyi/billing.mjs";
import { stateOf } from "./refresh.mjs";

// 每次调用时读：测试要能指到临时目录，不然会写进真实缓存
const stateDir = () =>
  process.env.MAGPIE_XIAOYIWORK_STATE_DIR ||
  path.join(os.homedir(), ".cache", "magpie");

/** ⚠ 一个 uid 一个文件：同机的两个账号曾经共写同一个 JSON，后写的把前一个的「总计」抹掉。 */
const stateFile = (uid) => {
  const safe = String(uid).replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(stateDir(), `xiaoyiwork-points.${safe}.json`);
};

function readState(uid) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(uid), "utf8")) ?? {};
  } catch {
    return {};
  }
}

function writeState(uid, state) {
  try {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 原子写 + 独占临时名（两个并发调用共用一个 tmp 路径会互相踩掉）
    const tmp = `${stateFile(uid)}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, stateFile(uid));
  } catch {
    /* 只读目录之类，忽略 */
  }
}

/** 记录观测到的最大余额（= 总计推断值）；返回新 bucket 和合并后的值。不可变。 */
function observe(bucket, key, amount) {
  const prev = num(bucket[key]);
  const total = Math.max(prev, num(amount));
  return {
    bucket: total === prev ? bucket : { ...bucket, [key]: total },
    total,
  };
}

/**
 * 额度窗口。返回的是**声明**，构造器校验由末尾 buildUsage 做一次。
 *
 * ⚠ 只有 total > remain（真的观测到过更高的余额）才用 amount/limit。
 *   拿「第一次读到的余额」当分母会算出 used=0%，路由会把这账号当成池子里最空的，
 *   把所有请求压过去。不知道总量时就说还剩多少（钱包型），宿主认这种窗口。
 */
function pointsWindow({
  name,
  remain,
  total,
  unit = "点",
  note = "",
  runsOutAt,
}) {
  const known = total > remain;
  const shape = known
    ? { amount: Math.max(0, total - remain), limit: total, unit }
    : { balance: remain, unit };
  return {
    name,
    display: known
      ? `剩余 ${remain} / 总计 ${total} ${unit}${note}`
      : `剩余 ${remain} ${unit}${note}`,
    ...shape,
    ...(runsOutAt ? { runsOutAt } : {}),
  };
}

const fmtDate = (ms) =>
  new Date(ms)
    .toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })
    .replace(/:\d{2}$/, "");

export function usageHook() {
  return async (getAuth, _provider, { signal } = {}) => {
    try {
      const auth = await getAuth();
      const state = stateOf(auth);
      if (!state) return { error: "未登录", windows: [] };
      const label = auth?.accountId || auth?.metadata?.displayName || state.uid;

      // ⚠ 这里**不要**自己续期。宿主在调 usage 前已经 fresh()（会走它的续期锁并把新票存回）。
      //   自己续期有两个坏处：① 绕过宿主的锁，可能与宿主并发续期互相作废凭据；
      //   ②「签票会作废旧票」—— 签了新票却不存回宿主，宿主手里那张就死了，后续请求全 401。

      const [premium, platform] = await Promise.all([
        queryBilling(PREMIUM_AGENT_ID, state, signal),
        queryBilling(PLATFORM_AGENT_ID, state, signal),
      ]);

      const celia = premium?.celiaPremiumPrivilege ?? null;
      const points = celia?.aiPoints ?? {};
      const membership = celia?.membership ?? {};
      const subscription = celia?.subscription ?? null;
      const privileges = Array.isArray(platform?.privilegeList)
        ? platform.privilegeList
        : [];

      const stored = readState(state.uid);
      let bucket = stored.bucket ?? {};
      const windows = [];

      // ⚠ 没拿到 totalPoints 就别画这一格：num() 会给 0，编一张"剩余 0 点"比不显示更害人。
      if (points.totalPoints != null) {
        const breakdown = [
          points.freePoints != null ? `免费 ${num(points.freePoints)}` : null,
          num(points.purchasedPoints)
            ? `购买 ${num(points.purchasedPoints)}`
            : null,
          num(points.giftPoints) ? `赠送 ${num(points.giftPoints)}` : null,
          num(points.compstPoints) ? `补偿 ${num(points.compstPoints)}` : null,
        ].filter(Boolean);
        const remain = num(points.totalPoints);
        const obs = observe(bucket, "membership", remain);
        bucket = obs.bucket;
        windows.push(
          pointsWindow({
            name: `会员积分（${membership.skuGroupName || "小艺"}）`,
            remain,
            total: obs.total,
            note: breakdown.length ? `（${breakdown.join(" / ")}）` : "",
          }),
        );
      }

      for (const p of privileges) {
        const detail = Array.isArray(p.privilegeDetail)
          ? p.privilegeDetail.join(" ")
          : p.privilegeDetail;
        const remain = parsePrivilegeDetail(detail);
        const expire = parseCompactTime(p.expireTime);
        const when = expire ? fmtDate(expire.epoch) : null;
        const label2 = p.privilegeName || "权益包";
        const obs = observe(bucket, `priv:${p.privilegeId || label2}`, remain);
        bucket = obs.bucket;
        windows.push(
          pointsWindow({
            name: when ? `${label2}（${when} 到期）` : label2,
            remain,
            total: obs.total,
            note: when ? ` · ${when} 到期` : "",
            ...(expire ? { runsOutAt: expire.iso } : {}),
          }),
        );
      }

      const subExpire = parseCompactTime(subscription?.expireTime);
      const error =
        !celia && !privileges.length
          ? "两类查询都没拿到数据，可能是凭据过期或网络问题"
          : [
              premium ? null : "会员/积分查询失败",
              platform ? null : "权益包查询失败",
            ]
              .filter(Boolean)
              .join("；");

      const result = {
        plan: membership.skuGroupName || undefined,
        user: label,
        // until 只表达"套餐到期"；没有 subscription 就不给，免得拿权益包作废时间冒充
        ...(subExpire ? { until: subExpire.iso } : {}),
        renew:
          subscription?.autoRenew === true
            ? "auto"
            : subscription
              ? "off"
              : undefined,
        windows,
        ...(error ? { error } : {}),
      };

      const built = buildUsage(result);
      if (built.windows.length) {
        // ⚠ 存的是**校验过**的窗口。存原始声明的话，回落时它们没有 used，
        //   宿主会把账号当成「不参与路由」或「0% 已用」。
        writeState(state.uid, {
          bucket,
          lastGood: {
            at: new Date().toISOString(),
            plan: built.plan,
            windows: built.windows,
            until: built.until,
          },
        });
        return built;
      }
      // ⚠ 一次上游抖动不能把上一次的成功结果删掉。以前这里先 writeState({ bucket })，
      //   lastGood 跟着就没了：下一次抖动连回落都没有，卡片直接变成「没有额度」，
      //   账号还会被路由当成「剩余额度未知」排到最后。
      if (stored.lastGood?.windows?.length) {
        writeState(state.uid, { bucket, lastGood: stored.lastGood });
        return buildUsage({
          ...stored.lastGood,
          user: label,
          error: `${error || "上游暂时没返回额度"}；显示的是 ${stored.lastGood.at} 读到的上一次结果`,
        });
      }
      writeState(state.uid, { bucket });
      return built;
    } catch (err) {
      // 窗口构造错了是**我们的** bug，必须炸出来；吞成 usage.error 就又变成「GUI 坏了但日志里什么都没有」
      if (err instanceof QuotaShapeError) throw err;
      try {
        const auth = await getAuth();
        const uid = auth?.uid;
        const good = uid ? readState(uid).lastGood : null;
        if (good?.windows?.length) {
          return buildUsage({
            ...good,
            user: auth?.accountId || uid,
            error: `读取失败：${err?.message || err}；显示上次结果`,
          });
        }
      } catch {
        /* 连账号都拿不到，下面统一报错 */
      }
      return { error: `读取额度失败：${err?.message || err}`, windows: [] };
    }
  };
}

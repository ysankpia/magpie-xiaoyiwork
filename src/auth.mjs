// auth 对象装配 —— 各钩子摆到一起
//
//   refreshLead   凭据 7 天，提前 12 小时续
//   checkin       上游没有签到接口（2api WEB_RESEARCH 实锤：主进程 grep「签到」零命中），
//                 恒回 ineligible，永不 throw
//   options       编辑页「插件选项」里的开关；声明在这里 magpie 才会渲染成开关

import { PROVIDER, REFRESH_LEAD_MS } from "./context.mjs";
import { methods } from "./hooks/methods.mjs";
import { refreshHook } from "./hooks/refresh.mjs";
import { loaderHook } from "./hooks/loader.mjs";
import { usageHook } from "./hooks/usage.mjs";

/**
 * @param {{ configDir?: string|null, option?: (provider: string, key: string) => boolean }} [deps]
 */
export function authHooks({ configDir = null, option = () => false } = {}) {
  return {
    provider: PROVIDER,
    maxConcurrency: 2,
    refreshLead: REFRESH_LEAD_MS,
    // 值必须用到时再读：magpie 是插件工厂跑完之后才把选项灌进来的
    methods: methods({
      configDir,
      allowDuplicate: () => option(PROVIDER, "allow_duplicate") === true,
    }),
    refresh: refreshHook(),
    loader: loaderHook(),
    usage: usageHook(),
    options: [
      {
        key: "allow_duplicate",
        label: "Allow the same account twice",
        description:
          "By default one Huawei account can be added once: signing in again is refused with the slot it already has. Turn this on only if you really want two slots for the same uid — both share one credential, and signing one in invalidates the other's ticket.",
        labels: { zh: "允许同一账号重复添加", "zh-TW": "允許同一帳號重複新增" },
        descriptions: {
          zh: "默认同一个华为账号只允许一个槽位，再登会提示已存在的槽位名。只有确实想让同一个 uid 占两个槽位时才打开 —— 两个槽位共用一份凭据，其中一个签票会让另一个的票立刻失效。",
          "zh-TW":
            "預設同一個華為帳號只允許一個槽位，再登會提示已存在的槽位名。只有確實想讓同一個 uid 佔兩個槽位時才打開 —— 兩個槽位共用一份憑證，其中一個簽票會讓另一個的票立刻失效。",
        },
      },
    ],
    async checkin() {
      return { outcome: "ineligible", message: "小艺Work 上游没有签到接口" };
    },
  };
}

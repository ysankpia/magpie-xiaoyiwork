# 交接文档 — 2026-11-26

给接手这个仓库的 agent。**先读 `README.md` 的「与上游的差异」和 `CHANGELOG.md` 的 0.2.0 一节**，那里面是改动的完整理由，本文不重复。

## 一句话状态

`小艺Work`（华为小艺）的 magpie 供应商插件，已从上游 `Sliverkiss/magpie-xiaoyiwork` 分支出来、与上游断开，发布在 <https://github.com/ysankpia/magpie-xiaoyiwork>，magpie 里以 `github:ysankpia/magpie-xiaoyiwork` 安装，两个账号在线且可用。

## 关键决策（以及为什么）

1. **在两个候选插件里选了 Sliverkiss 的**，删掉了 `xuediner-source/magpie-xiaoyiwork-auth`。理由：模块化、`quota.mjs` 把额度窗口的写法错误变成运行时异常、loader 锁目标源并禁止重定向。xuediner 版本多两个补丁（`$ref` 归一化、4.5 MiB 413），但单文件 1900 行、loader 不校验 origin、401/403 都当登录失效。
2. **fork 而不是等上游**：上游 2026-11-24 建库、0 star、单人维护；我们要的 `$ref` 修复上游明确不做（它认为 gray 不是可用性信号，优先级不同）。
3. **与上游断开**：`gh repo create` 建的独立仓库，没有 fork 关系、没有 upstream remote。LICENSE 保留原版权，README 顶部写明来源。

## 已完成（都在 git 里，看 commit 别看本文）

基线 `f1e7061` → 当前 `c9d22cd`，三个 commit：

- `b9cfb36` 五项修复 + 20 个测试
- `312c328` 去重提示改成人能读的槽位名
- `c9d22cd` 去重只拒「旧票还活着」的情况

五项修复：回调页可重复访问、同一账号去重、额度 `lastGood` 不再被清空、工具 Schema 内联 `$ref`、4.5 MiB 前置 413。

## 实测证据（不是推断）

| 项                     | 结果                                               |
| ---------------------- | -------------------------------------------------- |
| `npm test`             | 25 通过 / 0 失败                                   |
| Kimi + `$ref` 工具调用 | 改前 502、37 秒 → 改后 200、3.4 秒                 |
| 回调页第二次访问       | 改前 `ECONNREFUSED` → 改后 200「这次登录已经结束」 |
| 去重                   | 真实登录被拒，提示已存在的槽位                     |
| 非流式 / 流式对话      | 200，`reasoning_content` 正确分离，`[DONE]` 补齐   |
| 额度                   | 两个账号各 200 点                                  |

**未实测**：4.5 MiB 前置 413 只有单测（`test/loader.test.mjs`），没在真机上发过 5 MB 请求（会白烧点数）。

## 当前环境状态

- 本地仓库：`/Volumes/WorkDrive/repos/magpie-xiaoyiwork`
- magpie 加载的是 `~/.config/magpie/plugins/node_modules/magpie-xiaoyiwork`（从 GitHub 拉的副本），**不是**上面那个目录
- 改代码生效流程：`git push origin main` → `magpie plugin update`
- 账号：两个，均 `alive`，uid 已脱敏。插件按 uid 分文件存额度状态在 `~/.cache/magpie/xiaoyiwork-points.*.json`

## 未解决 / 下次要小心的

1. **一个未复现的 401**。某次签入账号 B 之后，账号 A 的凭据和 refreshToken 同时变成 `401 authFailed`；之后重新登录 A，两个账号又都正常了。原因不明，**不要在只有一次观察的情况下把它归因成「一台机器只能一个号」**（我这么判断过，是错的）。
   若再次复现：改 `src/xiaoyi/protocol.mjs` 的 `deviceIdFor`，给每个账号派生独立的 deviceId 盐值，让上游把它们当不同设备，然后验证。
2. **华为的硬约束**（已实测，别再试）：
   - `redirect_uri` 必须是注册过的 `http://127.0.0.1:17355/auth/callback`。随机端口直接回 `{"error":1101,"error_description":"redirect_uri not registered","sub_error":20023}`。
   - authorize 页面没有强制登录 / 切换账号参数：`prompt`、`prompt=select_account`、`login_hint` 一律被静默忽略，返回字节数完全相同（14581）。加第二个账号只能靠无痕窗口。
3. **不要直接改 `plugin-auth.json` 删账号**。运行中的 magpie 内存里还有那份数据，下次保存会把整份文件覆盖回去（我删过一次，被写回来了）。要删就在插件页点，或者 `magpie plugin logout xiaoyiwork` 全清后重登。
4. **Chrome 的预连接会短暂占住 17355**。上一轮登录结束后会留下 `FIN_WAIT_2` / `CLOSE_WAIT`，此时 `portFree()` 报端口被占，等十几秒到一分钟自己释放。日志里看到「端口 17355 被占用」先确认是不是这个，别急着怀疑小艺Work。
5. **`plugin-auth.json` 有个备份** `plugin-auth.json.bak-agent-20261126-*`，确认无事后可删。

## 下一步可做的

- 给上游提 PR：这五项里至少 `$ref` 内联和 4.5 MiB 413 对所有人都有用。
- 真机验证一次 4.5 MiB 分支（用 `x-prd-pkg-name` 那种大请求，或者直接构造超限 body 看 magpie 的 `body_cap` 是否真的裁图重试）。
- 上游接口一变就按 README「逆向要点」重抓，那 13 条都是踩过的坑。

## 建议调用的技能

- `diagnosing-bugs` —— 401 那条复发时用，先复现再归因。
- `code-review` —— 再往上推改动之前，按仓库标准过一遍。
- `use-modern-node` —— 这个插件跑在 Node 26 / Bun 上，加新代码时确认写法。

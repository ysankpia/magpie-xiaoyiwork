<p align="center"><img src="icon.png" width="88" height="88" alt=""></p>

# magpie-xiaoyiwork

[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![author](https://img.shields.io/badge/author-Sliverkiss-8A2BE2)](https://github.com/Sliverkiss)
[![magpie](https://img.shields.io/badge/magpie-插件-00ADD8)](https://usemagpie.ai)

**小艺Work 供应商插件** —— [magpie](https://usemagpie.ai) / OpenCode 专用。

一个账号，六个模型，AI 点倍率、积分额度和套餐状态直接显示在 magpie 的账号卡片上。

非官方插件。

> **这个仓库是 [Sliverkiss/magpie-xiaoyiwork](https://github.com/Sliverkiss/magpie-xiaoyiwork) 的独立分支**
> （基线 `f1e7061`，已与上游断开，不再同步）。改动见下面的「与上游的差异」和 [CHANGELOG.md](./CHANGELOG.md)。

---

## 与上游的差异

| 改动                                          | 为什么                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 回调页可重复访问，结算后延迟 3 秒才关服务器   | 上游一结算就 `closeAllConnections()`，用户刷新或浏览器重试会拿到 `ECONNREFUSED`，只看到一个打不开的地址，以为登录没成功              |
| 同一账号去重（可在插件选项里关掉）            | 签票会作废旧票，同一个 uid 再加一次只会得到一个死槽位；判断放在签票之前，而且只拒「旧票还活着」的情况 —— 凭据过期后重新登录会放行    |
| 额度回落不再被自己删掉                        | 上游一次抖动后 `lastGood` 被覆盖，下一次抖动就没有回落，卡片变成「没有额度」                                                         |
| 工具 Schema 内联 `$ref` / 补 `enum` 的 `type` | Kimi 后端拒收 `$ref`，返回 `11115 / server inner`（magpie 记成 502，要等 37 秒）。其他模型带 `$ref` 正常，所以只在有 `$ref` 时才动手 |
| 4.5 MiB 请求体前置 413                        | 上游超过 5 MiB 不返回 413，而是挂起约 56 秒再回 408；提前回标准 413 让 magpie 裁掉最早的历史图片后重试                               |

**加第二个华为账号**：华为的授权页没有任何强制登录 / 切换账号的参数（实测 `prompt`、
`prompt=select_account`、`login_hint` 一律被静默忽略，返回的页面字节数完全相同），
浏览器里已登录哪个华为账号就直接拿哪个授权。所以**第二个账号要用无痕窗口打开授权链接**。
回调端口也必须是被注册过的 `17355`（换成随机端口上游直接回
`redirect_uri not registered`），所以登录期间仍然要让小艺Work 桌面端退出。

---

## 装

```bash
magpie plugin install github:ysankpia/magpie-xiaoyiwork
```

或者从源码：

```bash
git clone https://github.com/Sliverkiss/magpie-xiaoyiwork
cd magpie-xiaoyiwork
magpie plugin link .
```

## 登录

一条路：浏览器。

magpie 打开授权页 → 登录 → 回到 `127.0.0.1:17355` → 完成。

回调端口被别的程序占着时插件会提前报错，而不是开一个打不开的浏览器页。遇到就退出占端口的程序再试。

登录后凭据 7 天有效，到期前 12 小时自动续期，不需要重新登录。

**加第二个账号**：把授权链接复制到无痕窗口打开。普通窗口会直接用已登录的那个华为账号授权，
于是又拿到同一个账号 —— 插件会提示「已经添加过了」并拒绝。同一个账号真要占两个槽位，
在编辑页的「插件选项」里打开「允许同一账号重复添加」，但两个槽位共用一份凭据，其中一个签票会让另一个立刻失效。

## 模型

目录从账号实时拉，带 AI 点倍率。目录拉不到时回落到内置表，不会出现「0 个模型」。

| 模型                | 倍率 | 图片 |
| ------------------- | ---- | ---- |
| DeepSeek-V4-Flash   | x1   |      |
| DeepSeek-V4.1-Flash | x1   | ✓    |
| GLM-5.3             | x8   |      |
| GLM-5.3-Flash       | x0.8 | ✓    |
| MiniMax M3.1 Flash  | x1   | ✓    |
| openPangu-2.1-Pro   | x1   |      |
| Auto-Model          | —    |      |

倍率写进显示名（`GLM-5.3 · x8`），因为宿主只搬固定字段，单独的 `rate` 会被丢掉。

上游标灰的模型也照列 —— 灰度不是可用性信号，实测可用。

## 额度

两个互不相干的桶，分别显示，不合成一个数字：

- **会员积分** —— 免费 / 购买 / 赠送 / 补偿四类之和
- **权益包** —— 每个包单独一格，带作废时间

上游不发放总量字段。所以：

- 观测到过更高的余额 → 显示「剩余 X / 总计 Y」并参与路由
- 还没观测到 → 显示「剩余 X」，不声称百分比

不知道总量时说还剩多少，比编一个 0% 已用更诚实 —— 后者会让路由把账号当成池子里最空的，把所有请求压过去。

上游偶发超时：一个窗口都没拿到时回落上次成功的结果，并注明这是哪一次读到的。

## 签到

上游没有签到接口，`checkin` 恒回 `ineligible`。这不是故障。

## 对话

只走流式。上游只吃 SSE，客户端要非流式时本地聚合。

流式与非流式输出同一套字段，两条路径的字段映射只有一份实现。

- `reasoning_content` —— 思考单独一路，不混进正文；数组形式 content 里的 `thinking` 段也归到这里
- `tool_calls` —— 分片按 index 跨帧对齐；没有名字的调用不算调用
- `usage` —— 上游不给就整个省略，不补零
- `finish_reason` —— 上游不给时补一个，否则客户端会把已经看到的回复判成失败

客户端按停会真的停上游，不是只关掉自己这一端。

## 支持的客户端协议

只实现 Chat Completions。Anthropic Messages、OpenAI Responses、Gemini 由 magpie 网关转换，插件侧不需要各写一份。

## 已知边界

- 上游静默忽略 `max_tokens` / `temperature` / `stop` / `n` / `thinking`，插件把这些参数删掉，免得调用方以为生效了。实际上限由模型自己定。
- 模型名不能带供应商前缀发给上游 —— 会静默降级成通用助手，回答看起来正常但用的不是这个模型。插件在发出前剥掉前缀。
- 只读额度接口，不改任何账号状态。

## License

MIT

> 更新记录：[CHANGELOG.md](./CHANGELOG.md)

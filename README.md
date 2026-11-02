# dsh-peak-guard

> 给 DeepSeek Harness 的「峰谷价自动停启」插件：高峰计价前提醒、到点停掉你勾选的会话、低谷回来自动接着干。

[English](#english) · [安装](#安装) · [快速上手](#快速上手) · [配置](#配置) · [工作原理](#工作原理)

---

## 背景

DeepSeek 按**峰谷价**计费（官方价目见 <https://api-docs.deepseek.com/quick_start/pricing>）：

| 时段（北京时间） | 计费 |
| --- | --- |
| 工作日 09:00–12:00、14:00–18:00 | 高峰价（约为低谷价 2 倍） |
| 工作日 12:00–14:00、18:00–次日 09:00 | 低谷价 |
| 周末、法定节假日全天 | 低谷价 |

原生规则是 **UTC 01:00–04:00 与 06:00–10:00，周一至周五，且排除中国法定节假日**。

Agent 常常一口气跑几个小时，很容易在高峰时段持续烧钱。本插件把「什么时候提醒、什么时候停、停哪些会话、什么时候继续」做成一套可配置的状态机，并且**只作用于你勾选过的会话**——不是所有任务都该被自动停/启。

## 功能

- ⏰ **高峰前预告**：默认提前 30 分钟，给勾选的会话发一条提示（可关闭）
- ⛔ **高峰开始时停止**：先发停止提示（要求把进度写进 `NEXT.md` 并收尾），宽限期（默认 3 分钟）后仍未结束就强制中断回合
- ▶️ **低谷开始时恢复**：给勾选的会话发恢复提示，读完 `NEXT.md` 接着做
- ✅ **按会话授权**：每个会话两个独立开关——「高峰停止」「低谷恢复」，可只勾其一
- 🗂 **工作区树 + 批量选择**：会话按工作区分组折叠；停止与恢复各自独立开/关——工作区行内「停止开/停止关/恢复开/恢复关」，顶部「高峰停止：全部开/全部关」+「低谷恢复：全部开/全部关」
- 📅 **节假日与调休**：内置 `chinese-days` 日历，法定节假日不算高峰；支持手动覆盖某一天（`2026-10-01=holiday` / `2026-10-11=workday`）
- 🧪 **手动测试**：设置页三个按钮可立即触发一次预告/停止/恢复，不必等到时间点
- 🌐 全程本地：只读本地配置与会话索引，不联网、不上报

## 环境要求

- DeepSeek Harness（桌面客户端或带宿主服务的 web 部署）**>= 0.2.1-rc.2**
- Node.js `^22.19.0 || >=24.0.0`
- 宿主进程必须保持运行（插件跑在宿主里）

## 安装

### 从 GitHub 安装（推荐）

```bash
# 用 DSH 自带 CLI（桌面客户端自带的那个）
cd "/d/Program Files/DeepSeek Harness/resources/runtime/cli/bin"
./dsh.cmd plugin --profile desktop add "git+https://github.com/Aily-DSH/dsh-peak-guard.git"
```

`dsh` 已在 PATH 时等价写法：

```bash
dsh plugin --profile desktop add "git+https://github.com/Aily-DSH/dsh-peak-guard.git"
```

### 本地开发安装

```bash
dsh plugin --profile desktop add "file:/D:/path/to/dsh-peak-guard"
```

安装会写入 profile 的 `package.json`（`dependencies` + `dsh.profile.bundles`），并把文件复制进 `node_modules`。

### 首次启用需要重启

**装完必须重启一次 DeepSeek Harness 客户端**：宿主半（`lib/index.js`）只在启动时挂载，客户端半的注入清单也只在启动时计算。重启后打开 **设置 → 峰谷价自动停启** 即可看到面板。

> 之后修改插件源码同样需要重启（cordis 已挂载的行不会热重载）。若改了源码，先把文件同步到
> `~/.dsh/profiles/desktop/node_modules/dsh-peak-guard/lib/`，再重启。

## 快速上手

1. 打开 **设置 → 峰谷价自动停启**，确认顶部状态徽章（高峰价时段 / 即将进入高峰 / 低谷价时段）
2. 在「会话」列表里，为要托管的任务勾上 **高峰停止**、**低谷恢复**
   - 速选：顶部两组按钮（高峰停止：全部开 / 全部关；低谷恢复：全部开 / 全部关），每个工作区行内四个小按钮（停止开 / 停止关 / 恢复开 / 恢复关）——勾选与取消勾选分开，互不影响
3. 点 **测试：发预告** 看一眼效果（会给勾选会话发一条消息）
4. 就绪：下一次进入高峰会自动预告并停止，回到低谷自动恢复

## 配置

配置文件：`~/.dsh/dsh-peak-guard/config.json`（首次启动自动生成，也可在设置页改）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关闭后只显示状态、不执行任何动作 |
| `warnMinutes` | `30` | 高峰前多少分钟发预告；`0` 表示不预告 |
| `graceMinutes` | `3` | 停止提示发出后，宽限多少分钟再强制中断回合 |
| `notifyOnWarn` | `true` | 是否发送高峰预告消息 |
| `stopPrompt` | 中文提示 | 高峰开始时发给会话的内容（要求写 `NEXT.md` 并收尾） |
| `warnPrompt` | 中文提示 | 预告内容，支持 `{minutes}` 占位符 |
| `resumePrompt` | 中文提示 | 低谷恢复时发给会话的内容（读 `NEXT.md` 续做） |
| `sessions` | `{}` | `{ "<sessionId>": { "autoStop": true, "autoResume": true } }` |
| `days` | `{}` | 日期覆盖：`{ "2026-10-01": "holiday", "2026-10-11": "workday" }` |

宿主只监听回环地址，路由：

| 路由 | 用途 |
| --- | --- |
| `GET /api/dsh-peak-guard/state` | 当前阶段、日历信息、下次切换时间、配置与会话列表 |
| `POST /api/dsh-peak-guard/config` | 增量更新配置（`sessions` 里传 `null` 删除该条） |
| `POST /api/dsh-peak-guard/action` | 手动触发：`kind=warn｜stop｜resume｜cancel-now` |

## 工作原理

```
每 20 秒 tick
   ├─ evaluate(now): 高峰？ 预告窗口？ 低谷？  + 北京时间日期是否工作日（chinese-days）
   ├─ 阶段变化时 runTransition()
   │     warn    → 给 autoStop 会话发预告
   │     peak    → 发停止提示；graceMinutes 后对仍未结束的会话强制中断
   │     offpeak → 给 autoResume 会话发恢复提示
   └─ 状态写入内存，供 /state 与设置页读取
```

- **投递消息**用宿主 `schedule.create(sessionId, { prompt, after_seconds: 1 })`——它会创建一条 `source.kind = "schedule"` 的用户消息并 `followup`，因此能唤醒冷会话
- **中断回合**用宿主 `agents.get(sessionId)?.cancel({ kind: "user" }, { keepInbox: true })`，与 GUI 上的「停止」按钮同一条路径
- 会话列表来自 `~/.dsh/storages/session_projcache/sessions/*.json`（标题取投影缓存，缺省回退首条用户消息），并隐藏内部子 Agent 会话（`orchestrator-*` 与 `.dsh/state/` 下的会话）
- 节假日：优先读配置 `days` 覆盖，其次 `chinese-days` 工作日判定，再次退化为「周一至周五」

## 注意事项与已知限制

- **「停止」是两段式**：先发消息请它收尾，宽限期后才 `cancel`。若会话正卡在长工具调用里，消息要等到下一个步边界才会被读到
- **插件只在宿主运行时生效**：DSH 关掉就不会停/启
- **恢复会消耗 token**：低谷恢复本身也要跑一轮，请只勾选值得继续的任务
- 状态机按**北京时间的日期**判断节假日，跨时区部署请自行确认
- 手动改 `package.json` 里的会话开关不会立即生效，需通过设置页或 `/config` 写入

## 卸载

```bash
dsh plugin --profile desktop remove dsh-peak-guard
```

再删除配置目录 `~/.dsh/dsh-peak-guard/`（可选）。

## 目录结构

```
lib/index.js      宿主半：状态机、节假日判定、HTTP 路由
lib/client.js     客户端半：设置页（状态徽章、会话树、批量开关、测试按钮）
cordis.patch.yml  把插件行插入 profile 的 cordis 配置
```

## 赞赏

如果这个插件帮你省了钱，欢迎扫码请作者喝一杯 ☕（纯属自愿，不影响使用和更新）

<p align="center">
  <img src="assets/reward-qr.png" alt="赞赏码" width="260">
</p>

## English

**dsh-peak-guard** is a DeepSeek Harness plugin that cuts spend on peak-priced hours. DeepSeek bills weekday 09:00–12:00 and 14:00–18:00 (Asia/Shanghai) at roughly double the off-peak rate, and everything else — lunch break, nights, weekends, Chinese public holidays — at half price.

The plugin warns the sessions you hand-pick 30 minutes before peak starts, asks them to wrap up (writing `NEXT.md`), cancels any turn still running after a grace period, and resumes those sessions when off-peak returns. Sessions are grouped by workspace and can be toggled in bulk. Holiday and make-up-workday handling comes from [`chinese-days`](https://www.npmjs.com/package/chinese-days); any day can be overridden.

```bash
dsh plugin --profile desktop add "git+https://github.com/Aily-DSH/dsh-peak-guard.git"
# restart the DeepSeek Harness client, then open Settings → 峰谷价自动停启
```

Requires DeepSeek Harness `>= 0.2.1-rc.2` and Node `^22.19.0 || >=24.0.0`.

**Sponsor:** if this plugin saved you money, you can buy the author a coffee — scan `assets/reward-qr.png`.

## License

[MIT](./LICENSE)

# 架构

系统怎么跑起来的：每个模块负责什么、一次升级的数据怎么流、哪些规则不能违反。

## 模块

| 模块 | 路径 | 职责 | 谁调用它 |
|---|---|---|---|
| 入口 | `src/index.ts` | 导出 `name` / `inject` / `apply`；挂路由、注册 agent 工具、启动时补发升级通知，每一步独立 try/catch，单步失败不影响其它步 | 宿主插件加载器（`dsh web`） |
| 版本 | `src/server/versions.ts` | 解析与比较版本、判定 stable / rc / alpha 频道、按 Node 要求筛目标版本、生成 engines 不满足时的中文说明 | `host`、`releases`、`survey`、`upgrade` |
| 状态 | `src/server/state.ts` | 读写 `~/.dsh/dsh-upgrade/` 下的 cache / pending / last，给出备份目录路径 | `host`、`notify`、`routes`、`tools`、`upgrade` |
| 宿主 | `src/server/host.ts` | 找本机全局安装的 dsh（12 层祖先 + 额外目录），拉 npmmirror 的 registry 元数据，读目标版本 manifest 里的 engines | `routes`、`tools`、`index` |
| 发布 | `src/server/releases.ts` | 拉 GitHub releases 并抽出中文更新内容（`<h3 id="cn-…">` 段），失败只降级、不阻塞升级 | `routes` |
| 升级 | `src/server/upgrade.ts` | 升级状态机：precheck（engines / 磁盘）→ backup → install（npm i -g）→ verify → rollback；engines 校验在备份之前 | `routes`、`tools` |
| 通知 | `src/server/notify.ts` | 升级完成后写 pending，下一次启动用 osascript 发「DSH 已升级」并结算，7 天过期；对调用方永不抛 | `routes`（markPending）、`index`（settlePending） |
| 调查 | `src/server/survey.ts` | 路由和 agent 工具共用的一份判定：当前版本、目标版本、可升级列表、是否被 engines 拦住 | `routes`、`tools` |
| 单飞锁 | `src/server/lock.ts` | 进程内单飞：HTTP 与 agent 工具同一时刻只允许一个升级在跑 | `routes`、`tools` |
| 路由 | `src/server/routes.ts` | 四个端点（status / check / releases / upgrade）+ 请求门（方法、`x-dsh-upgrade:1`、同源 Origin）+ NDJSON 进度；注册走 `ctx.effect` + `webServer.register` | `index`；页面与 agent 经 HTTP 调用 |
| 工具 | `src/server/tools.ts` | 两个 agent 工具：`dsh_upgrade_check`（只读）与 `dsh_upgrade`（会动安装目录并重启）；不写 pending、不自己重启 | `index` 注册；agent 调用 |
| 市场适配 | `src/client/market.ts` | 浏览器侧适配 dshmarket v1 的 summary / start / poll 协议，纯映射，按 code 区分市场不可用 / 操作用未知 / 未授权 / 更新失败 | `panel` |
| 注入 | `src/client/inject.ts` | 在底栏挂升级图标：三级退路（dshmarket 底栏 → sidebar.footer → settings.launcher）+ MutationObserver 重挂 | `src/client/index.ts` |
| 面板 | `src/client/panel.ts` | 两段式面板：当前 / 可升级版本、更新内容折叠、NDJSON 进度；升级完成后调 dsh-restart 的 precheck → restart，404 时提示手动重启 | `src/client/index.ts` |
| 客户端入口 | `src/client/index.ts` | 浏览器入口 `apply`：挂图标 → 拉一次 status 决定提示 → 打开面板；卸载时 teardown | 宿主客户端插件加载器 |

## 数据流

### 浏览器 → 服务端

点底栏图标 → `panel` 先 GET `/dsh-upgrade/api/status`（带 `x-dsh-upgrade:1`）拿当前 / 目标版本；POST `/check` 与 GET `/releases` 只刷新展示；点「升级」POST `/upgrade`，读回 NDJSON 进度（precheck / backup / install / verify / done / fail）。

### 服务端 → 本机安装目录

`routes` → `survey`（经 `host` + `versions`）算目标版本；确认升级后抢单飞锁 → `upgrade.runUpgrade` → `state` 把结果写进 `~/.dsh/dsh-upgrade/`；安装动作落在 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`，失败按 removeDir → moveDir 回滚。

### 服务端 → registry / GitHub

`host` 拉 npmmirror registry 的版本号与 engines，`releases` 拉 GitHub releases 的中文更新内容。前者决定「能不能升」，后者只决定「升级说明好不好看」：GitHub 挂了照常升级，说明降级为空。

### 服务端 → dsh-restart

升级成功后 `panel` 先 POST `/dsh-restart/api/precheck`（NDJSON）再 POST `/dsh-restart/api/restart`，让服务带着新版本重启；404（没装 dsh-restart）则显示「已升级，需手动重启」，不假装成功。

## 关键约束

- engines 校验必须在备份之前（`src/server/upgrade.ts`）：顺序反了会先复制一份用不上的备份，再报 Node 不满足。
- 安装脚本三步顺序固定：依赖 → 软链 → patch。patch 最后写，中途失败最坏只留「链在配置没认领」，重跑自愈。
- 所有 HTTP 路由必须过请求门：方法对、带 `x-dsh-upgrade:1`、有 Origin 时与 Host 同源。这是和 dsh-restart 一起硬化的门，改一处要同步另一处。
- 升级单飞：HTTP 与 agent 工具共用一把锁，第二个请求回 409 BUSY。
- 备份没成功就不进入安装；回滚顺序固定 removeDir → moveDir。
- 运行期零第三方依赖：服务端只用 Node 内置与宿主注入能力，客户端只用浏览器 API 与 dshmarket v1 协议。

## 维护

- 改了上面提到的任一模块，同批改这张表。
- 表里出现的路径必须真实存在，`check.sh` 会验。
- 与代码冲突时以代码为准，改这份文档，不要改代码迁就它。

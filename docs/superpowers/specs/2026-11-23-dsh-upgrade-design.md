# dsh-upgrade 设计（2026-11-23）

给 dsh web 加一个「升级」板块：检测 DSH 本体与 profile 插件的新版本、执行升级、用 dsh-restart 预检并重启、重启后发系统通知。替代「手动 `npm i -g` + 手动重启」和「自己盯 registry 版本号」。

## 1. 目标 / 非目标

**目标**

- 底栏一颗图标兼角标；点开是面板，分「DSH 本体」「插件」两段，各自能出升级按钮。
- 本体升级走服务端（`npm i -g` + clonefile 备份 + 校验 + 回滚）。
- 插件升级借 dshmarket 的 v1 API（页面内同源 fetch），自己不装包。
- 装完自动接 `/dsh-restart/api/precheck` → `/dsh-restart/api/restart`。
- 重启回来后由服务端发 macOS 系统通知。
- 顺便给 agent 两个工具：`dsh_upgrade_check`、`dsh_upgrade`。

**非目标**

- 不做插件安装/卸载/启停（那是 dshmarket 与宿主自带 Plugins 面板的事）。
- 不自己实现预检与重启（硬依赖 dsh-restart，它不在就降级成"只装不重启"）。
- 不抓插件的 changelog，只为本体拉 release 正文。
- 不做 Windows/Linux 的通知与 GUI 适配（只服务这一台 macOS）。

## 2. 实测约束（设计依据，别当成假设）

| 事实 | 影响 |
|---|---|
| 宿主在 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`，属主是当前用户，**无需 sudo** | 服务端可以直接写全局目录 |
| 安装目录 **1.3 GB / 95,699 文件** | 备份必须用 clonefile（`cp -c`），不能整目录复制 |
| `~/.npmrc` 指向 registry.npmmirror.com | 升级沿用用户配置，**不显式指定 registry** |
| 本机 node **v26.7.0**；0.2.3-alpha.2 的 `engines.node` = `^24.22.3 || >=26.13.1` | **升级到 alpha.2 会不满足 engines**，必须在装之前拦住并说明原因 |
| dshmarket 所有 v1 端点都要 DSH 登录 cookie | 插件升级**只能**由页面内同源 fetch 发起，服务端与 agent 工具拿不到 |
| 更新的 changelog 只在 GitHub Releases（tag `dsh-v*`），包里没有 CHANGELOG | 更新内容从 `api.github.com` 拉，匿名限流 60 次/小时，必须缓存 |
| release 正文是中英双份，中文段在 `<h3 id="cn-*">` 与 `<h3 id="en-*">` 之间 | 只取中文段，去 HTML 标签 |
| dsh-restart 的路由要 `x-dsh-restart: 1` + Origin 与 Host 一致 | 页面内 fetch 天然满足；服务端工具不调它 |

## 3. 用户看到的行为

1. 页面加载后静默查一次（命中 6 小时缓存就不发请求）。任一有更新 → 底栏图标换成「有新版本」样并带角标；没有 → 图标仍是入口，但无角标。
2. 点图标 → 面板：
   - 上段「DSH 本体」：`0.2.2-rc.5 → 0.2.3-alpha.2`、通道标签、升级按钮；按钮下面是「更新内容」折叠区（跨版本时逐版列出，默认只展开最新一版）。
   - 下段「插件（N 个可更新）」：逐行 `1.5.0 → 1.7.2` + 发布日期，点开跳 npm/仓库。没有更新就显示「已是最新」，段落不消失。
3. 点本体升级 → 面板里走一条进度流：检查磁盘 → 备份 → 安装 → 校验 → （失败则回滚）→ 预检 → 重启。中途可关闭面板，进度写进状态文件，再打开还在。
4. 重启回来 → 桌面右上角一条系统通知：「DSH 已升级到 x.y.z」。面板结果条写「已升级到 x，重启后生效」直到重启为止。

## 4. 模块

| 路径 | 职责 | 谁调用它 |
|---|---|---|
| `src/index.ts` | 服务端入口：注册路由、注册 agent 工具、启动时做「待通知」检查 | 宿主加载插件时 |
| `src/server/host.ts` | 定位宿主安装目录、读当前版本、读 registry 元数据、拉 GitHub release | routes/tools |
| `src/server/versions.ts` | semver 比较（含预发布）、通道判定、目标版本候选、engines 校验 | host/upgrade/routes |
| `src/server/upgrade.ts` | 升级状态机：磁盘检查 → clonefile 备份 → `npm i -g` → 校验 → 回滚或收尾 | routes/tools |
| `src/server/notify.ts` | 写/读「待通知」marker，重启后调 `osascript display notification` | index/upgrade |
| `src/server/state.ts` | `~/.dsh/dsh-upgrade/` 下的 cache / pending / last 读写 | 全服务端 |
| `src/server/routes.ts` | `/dsh-upgrade/api/*` 四个端点 + 请求门 | 浏览器 |
| `src/server/tools.ts` | `dsh_upgrade_check`、`dsh_upgrade` | agent |
| `src/client/index.ts` | 客户端插件注册：注入图标、挂面板 | 外壳 |
| `src/client/inject.ts` | DOM 注入 + MutationObserver 补挂 + 三级退路 | index |
| `src/client/panel.ts` | 面板渲染：两段、进度流、更新内容折叠 | index |
| `src/client/market.ts` | 同源 fetch 包 dshmarket v1 API | panel |

## 5. 数据流

```
页面 ──同源 fetch──> /dsh-upgrade/api/*  ──> host.ts ──> npm registry / api.github.com
  │                                        └──> upgrade.ts ──> cp -c 备份 + npm i -g + 校验
  ├──同源 fetch──> /dsh-market/api/v1/*  （插件升级，服务端不参与）
  └──同源 fetch──> /dsh-restart/api/*    （预检 NDJSON + 重启 202）

重启后：插件加载 ──> notify.ts 读 pending ──> 版本对上了 ──> osascript 通知 ──> 删 marker
```

## 6. 服务端 API

统一请求门（与 dsh-restart 同风格）：路径精确匹配 + 方法精确匹配 + 头 `x-dsh-upgrade: 1` + Origin 与 Host 一致；不满足一律 403，不泄露内部状态。

| 端点 | 入 | 出 |
|---|---|---|
| `GET /dsh-upgrade/api/status` | — | `{ current, dir, channels: { latest, next, alpha }, newest, checkedAt, cached }` |
| `POST /dsh-upgrade/api/check` | `{ includePrerelease?: boolean, force?: boolean }` | 同上 + `{ candidates: [{ version, channel, publishedAt, blocked?: { reason } }] }` |
| `GET /dsh-upgrade/api/releases` | `?from=<ver>&to=<ver>` | `{ releases: [{ version, channel, publishedAt, items: string[], url }], degraded: boolean }` |
| `POST /dsh-upgrade/api/upgrade` | `{ target: string }` | NDJSON 流，每行 `{ phase, message, done?, error? }`，phase ∈ backup / install / verify / rollback / done / fail |

- `upgrade` 是长活（安装约 30–120 s），用 NDJSON 推进度，不用轮询表。
- 同一时刻只允许一个升级在跑：进程内锁 + `last.json` 里的 `running` 标记，第二个请求直接 409。
- 目标版本只接受 **registry 里真实存在的版本号**；不接受 tag 名进到 npm（tag 会解析成版本，用户看到的必须是确定版本号）。

## 7. agent 工具

| 工具 | 入 | 出 |
|---|---|---|
| `dsh_upgrade_check` | `{ includePrerelease?: boolean }` | 当前版本、各通道版本、可升目标、被 engines 拦住的原因 |
| `dsh_upgrade` | `{ target: string }` | 升级结果（装了哪个版本、备份路径、是否需要重启） |

`dsh_upgrade` **不自动重启**：重启交给已有的 `dsh_restart` 工具，两个工具各自单一职责，服务端也不用去猜自己的监听端口。

## 8. 升级状态机

```
idle
 └─ POST upgrade {target}
     ├─ 1. 校验目标版本在 registry 存在，读它的 engines.node 与本机 node 比对 → 不满足则 fail(RUNTIME_UNSUPPORTED)，不进下一步
     ├─ 2. statfs 检查可用空间 ≥ 2.5 GB → 不足则 fail(NO_SPACE)
     ├─ 3. 写 pending-notify.json {from, to, startedAt}
     ├─ 4. cp -c -R <installDir> ~/.dsh/dsh-upgrade/backup/<from>
     ├─ 5. npm i -g @deepseek-ai/dsh@<target>（cwd 用临时目录，超时 15 分钟）
     ├─ 6. 校验：读 <installDir>/package.json 的 version === target；再 `<installDir>/lib/bin.js --version` 输出对得上
     ├─ 7a. 不符 → rm -rf <installDir> && mv backup → restore → fail(ROLLED_BACK)
     └─ 7b. 相符 → 删备份 → done { restartRequired: true }
```

- 备份目录名用**旧版本号**，同一次失败回滚后删掉；升级成功也删。
- `npm` 用 `process.env.PATH` 里的那个，超时或非 0 退出统一按失败回滚。
- 回滚是「删新目录 + 搬回备份」，不是覆盖写；失败要留下 `last.json` 说明考了个什么方向。

## 9. 通知与状态文件

`~/.dsh/dsh-upgrade/` 下：

| 文件 | 内容 | 生命周期 |
|---|---|---|
| `cache.json` | `{ registry: { checkedAt, channels, versions[] }, releases: { checkedAt, byVersion } }` | TTL 6 小时；`force` 时重拉 |
| `pending-notify.json` | `{ from, to, startedAt }` | 版本对上了 → 发通知 → 删；超过 7 天 → 删 |
| `last.json` | `{ running, lastResult, lastError }` | 常驻，供面板与工具读 |
| `backup/<ver>/` | 克隆出来的安装目录 | 升级成功后删 |

通知命令：`osascript -e 'display notification "<正文>" with title "DSH 已升级"' `。失败只记日志，不阻塞插件加载。

## 10. 失败与降级

| 情况 | 行为 |
|---|---|
| dsh-restart 未安装/被禁用 | 装完停住，面板显示「已升级到 x，需手动重启」，按钮换成「重启 DSH」（点了直接 fetch `/dsh-restart/api/restart`，404 就提示去设置里启用） |
| dshmarket 不可用（旧版/关掉/未登录） | 插件段显示「插件更新不可用」，本体段照常工作 |
| GitHub API 限流或断网 | 更新内容降级成「版本 + 发布日期 + 打开 release 的链接」，不显空白 |
| 目标版本 engines 不满足 | 升级按钮置灰，写明「需要 Node ≥ 26.13.1，本机 26.7.0」 |
| 安装后版本不符 | 自动回滚到备份，面板红条写明回滚完成、哪个校验没过 |
| 升级中再点 | 409 + 进度条继续走到结束 |

## 11. 测试与验收

- 单测（vitest）：`versions.ts` 的比较/通道/engines 判定、`upgrade.ts` 的状态机（用假 npm 与假 fs）、`notify.ts` 的 marker 生命周期、`market.ts` 的 fetch 映射。
- 集成测试不碰真安装目录：所有路径经 `DSH_UPGRADE_ROOT` 注入，测试用临时目录 + 假 npm 脚本。
- `check.sh` 第 ④ 段补成：`npm run build && npx tsc --noEmit && npm test`。
- 人工验收一条：把 `upgrade.ts` 的 npm 调用换成 `npm view`，跑一遍完整进度流，确认不写全局目录。

## 12. 未决 / 风险

- dshmarket v1 是 beta，字段可能变；`market.ts` 只依赖 `updates/summary`、`updates`、`operations` 三个端点，解析容忍缺字段。
- 面板与图标注入依赖外壳 DOM；外壳改版会让锚点失效。已按 dsh-restart / dsh-mobile-plugin 的三级退路处理，失效时退到「更多」菜单。
- `npm i -g` 期间运行时仍在旧代码上跑，此时若有其它页面操作属于旧版本行为，不额外处理。

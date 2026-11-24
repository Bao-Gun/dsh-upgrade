# 架构

系统怎么跑起来的：每个模块负责什么、一次升级的数据怎么流、哪些规则不能违反。

## 模块

| 模块 | 路径 | 职责 | 谁调用它 |
|---|---|---|---|
| 入口 | `src/index.ts` | 导出 `name` / `inject` / `apply`；挂路由、注册 agent 工具、启动时补发升级通知并清掉已兑现的「需重启」标记，每一步独立 try/catch，单步失败不影响其它步 | 宿主插件加载器（`dsh web`） |
| 版本 | `src/server/versions.ts` | 解析与比较版本、判定 stable / rc / alpha 频道、按 Node 要求筛目标版本、生成 engines 不满足时的中文说明 | `host`、`releases`、`survey`、`upgrade` |
| 状态 | `src/server/state.ts` | 读写 `~/.dsh/dsh-upgrade/` 下的 cache / pending / last，给出备份目录路径；维护 last 里的「已升级待重启」标记（`readRestartRequired` / `clearRestartRequired`） | `host`、`notify`、`routes`、`tools`、`upgrade`、`index` |
| 宿主 | `src/server/host.ts` | 找本机全局安装的 dsh（12 层祖先 + 额外目录），拉 npmmirror 的 registry 元数据，读目标版本 manifest 里的 engines | `routes`、`tools`、`index` |
| 发布 | `src/server/releases.ts` | 拉 GitHub releases 并抽出中文更新内容（`<h3 id="cn-…">` 段），失败只降级、不阻塞升级 | `routes` |
| 升级 | `src/server/upgrade.ts` | 升级状态机：precheck（engines / 磁盘 / 安装前缀可写）→ backup（cp 走 `clone` 候选表）→ install（`npm i -g --prefix <prefix>`，前缀从 installDir 推）→ verify → rollback；engines 与可写性校验都在备份之前，写不进去就早退成 `INSTALL_DIR_NOT_WRITABLE`（唯一产物是两行可复制命令），不猜密码、不提权 | `routes`、`tools` |
| 克隆 | `src/server/clone.ts` | 备份安装目录的 cp 候选表：darwin `-c`（APFS clonefile）→ linux `--reflink=auto`（btrfs/xfs 真 CoW，ext4 自动退化为整拷，GNU cp 没有 `-c`）→ 任何平台兜底 `-R`；绝不硬链接（共享 inode，试跑会写穿线上安装目录）；`upgrade.ts` 的 `moveDirDefault` 是回滚搬回备份的最后兜底，仍硬编码 `cp -R`（有意保留：只求把已存在的树搬回来，不再按平台挑参数） | `upgrade` |
| npm 前缀 | `src/server/npm.ts` | 从安装目录反推 npm 全局前缀（只认绝对路径且落在 `<prefix>/lib/node_modules/@deepseek-ai/dsh`，相对路径一律 null）、定位 npm 可执行、给子进程 PATH 补 node 目录；平台判定只收在 `clone` / `notify` 两处，本模块只做纯路径推导（平台差异交给 `node:path`）；由 `clone` / `notify` 的调用方把 `process.platform` 传进来，`npm` 的调用方不传 | `upgrade` |
| 通知 | `src/server/notify.ts` | 升级开始前写 pending（R22），下一次启动发「DSH 已升级」并结算，7 天过期；通知这一处的平台分支：darwin → `osascript` + AppleScript（标题与正文都做双引号转义）、linux → `notify-send`、其它 → 空 argv 静默返回 false；对调用方永不抛 | `routes`（markPending）、`index`（settlePending） |
| 调查 | `src/server/survey.ts` | 路由和 agent 工具共用的一份判定：当前版本、目标版本、可升级列表、是否被 engines 拦住 | `routes`、`tools` |
| 单飞锁 | `src/server/lock.ts` | 进程内单飞：HTTP 与 agent 工具同一时刻只允许一个升级在跑 | `routes`、`tools` |
| 路由 | `src/server/routes.ts` | 四个端点（status / check / releases / upgrade）+ 请求门（方法、`x-dsh-upgrade:1`、同源 Origin）+ NDJSON 进度；status 与 check 都读 last.json，把「装完没重启」报成 `restartRequired`（重查不会把它抹掉）；注册走 `ctx.effect` + `webServer.register` | `index`；页面与 agent 经 HTTP 调用 |
| 工具 | `src/server/tools.ts` | 两个 agent 工具：`dsh_upgrade_check`（只读）与 `dsh_upgrade`（会动安装目录）；成功后写 last.json 的 `restartRequired` 并只回这个标记，不写 pending、不自己重启 | `index` 注册；agent 调用 |
| 市场适配 | `src/client/market.ts` | 浏览器侧适配 dshmarket v1 的 summary / start / poll 协议，纯映射，按 code 区分市场不可用 / 操作用未知 / 未授权 / 更新失败；running 时带回 `progress`（percent/detail，只给 done/total 时自己折算）与 `wait`（排队原因）；兜底文案 `UNAVAILABLE_MESSAGE` 对外导出，批量队列复用同一句 | `panel`、`batch` |
| 批量升级 | `src/client/batch.ts` | 串行执行全部可更新插件：按顺序 POST 起包、GET 轮询、3 分钟没有推进就判卡住、单包失败 / 回滚 / 卡住后继续下一个，宿主 409 或叫停时把剩余记成 skipped 提前收尾，汇总 succeeded / failed / skipped 与 restartRequired；只发事件，不碰 DOM | `panel` |
| 注入 | `src/client/inject.ts` | 在底栏挂升级图标：三级退路（dshmarket 底栏 → sidebar.footer → settings.launcher）+ MutationObserver 重挂；`setEntryState` 按状态切角标 / 忙碌态，**没更新时整颗隐藏**（`known === false` 即查询失败时保持可见，别把面板锁死） | `src/client/index.ts` |
| 面板 | `src/client/panel.ts` | 两段式面板：当前 / 可升级版本、更新内容折叠、NDJSON 进度；外壳不滚，`.dshu-head` 固定、只有 `.dshu-body` 滚动；本体阶段条按 `PHASE_LABELS` 顺序折算百分比；插件段一个「全部升级」按钮 + 两行式插件行（第一行名字 / 版本，第二行自己的进度条与**行内**文案，单包升级按钮已移除）+ 结束后的「重启 DSH」按钮（二次确认）；行内失败原因不往底部抛红条，长文压成中文首句、全文进 title；版本对是 40 位 commit 时只显示前 7 位、全文进 title（索引装的插件被市场按 commit 比较，见 `docs/gotchas.md`）；操作 3 分钟没有任何推进就解锁按钮并写明卡在哪（等会话结束 / 还在后台跑），不把按钮钉死；升级完成后调 dsh-restart 的 precheck → restart，404 时提示手动重启；status 报 `restartRequired` 时提示「需重启」而不是「已是最新」 | `src/client/index.ts` |
| 客户端入口 | `src/client/index.ts` | 浏览器入口 `apply`：挂图标 → `probeEntryState` 拉一次决定图标显隐 → 每 5 分钟（`ENTRY_REFRESH_MS`）静默复查，出新版本时图标自己冒出来 → 打开面板；卸载时 teardown 并清掉定时器 | 宿主客户端插件加载器 |

## 数据流

### 浏览器 → 服务端

点底栏图标 → `panel` 先 GET `/dsh-upgrade/api/status`（带 `x-dsh-upgrade:1`）拿当前 / 目标版本；POST `/check` 与 GET `/releases` 只刷新展示；点「升级」POST `/upgrade`，读回 NDJSON 进度（precheck / backup / install / verify / done / fail）。

### 插件：全部升级 → runBatch → dshmarket → 汇总 → 可选重启

点「全部升级」→ `panel.startBatch` 先把这一轮名单里的每行按 `pending` 清空（上一轮文案不残留；不在名单里的行保持原样，「继续升级」不会把上一轮已升级的结论刷掉）→ 名单优先取 `view.retryNames`（上一轮失败 / 跳过的包），没有才取整张可更新表 → `runBatch(names)` 串行：`POST /dsh-market/api/v1/updates {packageName}` 拿 operationId，随后每 `DEFAULT_POLL_INTERVAL_MS`（800ms）`GET /dsh-market/api/v1/operations?operationId=<id>`；非终态发 `running`（percent / detail / 排队原因），终态发 `settled`，一个包到终态才起下一个 → `panel` 只按 `item.name` 把事件画到对应行（`paintBatchItem`）→ 结束后把成功的包从 `plugins.updatable` 摘掉，`paintPluginsHead` 重算标题与按钮：全升完则按钮收起、标题回「插件」；有失败 / 跳过则按钮写「继续升级」（只重试那些包，成功的不再动）→ 写汇总「n 个已升级，m 个失败，k 个跳过（，需重启生效）」，并按 `summary.skipped` 给对应行补「已跳过」（batch 对跳过项不发事件）→ 有成功项时 `offerRestart`：`GET /dsh-restart/api/status` 200 露出「重启 DSH」，404 提示手动重启，其它状态码写明 HTTP 码 → 点按钮第一下只进「确认重启？」，第二下才走 status → precheck → restart。

### 服务端 → 本机安装目录

`routes` → `survey`（经 `host` + `versions`）算目标版本；确认升级后抢单飞锁 → `upgrade.runUpgrade` → `state` 把结果写进 `~/.dsh/dsh-upgrade/`；安装动作落在宿主发现的全局 dsh 目录（本机为 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`，由 `host` 向上找，不写死），失败按 removeDir → moveDir 回滚。

### 服务端 → registry / GitHub

`host` 拉 npmmirror registry 的版本号与 engines，`releases` 拉 GitHub releases 的中文更新内容。前者决定「能不能升」，后者只决定「升级说明好不好看」：GitHub 挂了照常升级，说明降级为空。

### 服务端 → dsh-restart

本体升级成功后 `panel` 先 GET `/dsh-restart/api/status` 确认插件在（404 或连不上则显示「已升级，需手动重启」，不假装成功），再 POST `/dsh-restart/api/precheck`（NDJSON，必须读到 done 才继续），最后 POST `/dsh-restart/api/restart`，让服务带着新版本重启。插件批量走同一条链：有成功项时先 GET status 决定露不露「重启 DSH」按钮（404「没装」、网络失败「连不上」、其它状态码分别提示）；点了按钮后再走一次 status → precheck → restart。

## 关键约束

- engines 校验必须在备份之前（`src/server/upgrade.ts`）：顺序反了会先复制一份用不上的备份，再报 Node 不满足。
- 安装前缀可写性也要在备份之前（`src/server/upgrade.ts`）：npm 全局安装会写三处 —— installDir、`<prefix>/lib/node_modules`、`<prefix>/bin`（bin 链接），按这个顺序第一个写不进去就报 `INSTALL_DIR_NOT_WRITABLE`。漏查 bin 会在 NAS 上照样晚失败 + 整轮回滚（`npm i -g --prefix` 装包成功、写链接时才 EACCES）。消息固定两行：哪一处不可写 + `sudo npm i -g --prefix <prefix> @deepseek-ai/dsh@<target>`，版本号用本次 target（不是「latest」），面板靠 `.dshu-error` 的 `white-space:pre-line` 保住换行、自己不拼串也不截断。不可写就当场失败，不尝试 `sudo -n`、不读密码、不改安装目录属主。
- 安装前缀只从 installDir 反推（`src/server/npm.ts`），推不出来就 `INSTALL_FAILED`，绝不退回 npm 自己的 `prefix -g`：NAS 上 `npm prefix -g` 是 `~/.local`，而 dsh 在 `/usr/local`，照 npm 的全局前缀装必然装到别处再被版本校验逮住。推得出的前缀与 installDir 都不是可写性检查的替代品，两者都要过。
- 安装脚本三步顺序固定：依赖 → 软链 → patch。patch 最后写，中途失败最坏只留「链在配置没认领」，重跑自愈。
- 所有 HTTP 路由必须过请求门：方法对、带 `x-dsh-upgrade:1`、有 Origin 时与 Host 同源。这是和 dsh-restart 一起硬化的门，改一处要同步另一处。
- 升级单飞：HTTP 与 agent 工具共用一把锁，第二个请求回 409 BUSY。
- 备份没成功就不进入安装；回滚顺序固定 removeDir → moveDir。备份的 cp 参数只从 `src/server/clone.ts` 的候选表来（政策：平台差异只准出现在 `npm` / `clone` / `notify` 三处；当前实现只有 `clone` / `notify` 收 `process.platform`，`npm` 走 `node:path`）；`scripts/install.mjs` 的 `cloneCandidateList` 是纯 JS 副本，由 `test/clone.test.ts` 动态 import 逐项比对钉住，改表必须同批改两边。
- 通知是尽力而为（`src/server/notify.ts`）：写 marker、spawn 通知程序、marker 过期或损坏，任何一步失败都只降级成静默，绝不抛、也不影响升级结果；平台差异只在 `notifyCommand` 收口（darwin `osascript`、linux `notify-send`、其它空 argv → false）。
- 运行期零第三方依赖：服务端只用 Node 内置与宿主注入能力，客户端只用浏览器 API 与 dshmarket v1 协议。
- 插件批量只串行：dshmarket 没有批量端点，同一时刻只允许一个活动操作 —— 一个包到终态才起下一个；单包失败 / 回滚 / 卡住只记在自己名下，继续后面的包；只有 `cancelled()` 或宿主 `OPERATION_BUSY` 才把剩余记成 skipped 并立即收尾（R32/R40，409 不连报 N 次）。
- 文案归数据层，样式归视图层（R30）：`batch.ts` 决定 `message` 与 `unavailable`，`paintBatchItem` 只做 `compactReason` 与红字判定（`failed && !unavailable`）；running 文案按 `message ?? detail ?? '正在升级…N%'`（R36），终态 `message` 已是完整句时不再补「升级失败：」（R38/R42），排队 / 卡住不上红字。
- 行内进度的显隐必须切整个 `.dshu-plugin-progress`（R41）：只切 `.dshu-bar` 会让进度永远不可见；`percent === null` 时画不确定进度，不假装 0%。
- `runBatch` 自身不抛：网络异常由 `pollPluginOperation` 收敛成结果对象，`onEvent` 抛错由 `emit` 内部吞掉 —— 单行绘制失败不能打断整批。
- 批量收尾就地更新可更新表（R52/R53）：成功的包从 `plugins.updatable` 里摘掉再 `paintPluginsHead`，所以「全升完按钮收起、标题回『插件』」不依赖重新查询；失败 / 跳过的包记进 `view.retryNames`，按钮变「继续升级」且只重试这批，已升好的不再 POST，它们那几行的「已升级」也原地留着（清 `pending` 只按这一轮名单走）。重画列表（新一次查询）会清空 `retryNames`。
- 关闭面板只叫停队列（`cancelled: () => view.closed` 只在每包起包前查一次）：在飞的包仍轮询到终态，结果因 `live()` 为假被丢弃；立刻重开可能撞宿主 `OPERATION_BUSY`。
- 重启是危险动作，宁可不动：确认要两次分开的点击（首次进入 confirm 态并记 `restartArmedAt`，800ms 内的点击一律忽略，R48）；预检必须读到 `done` 才算通过，空 body / 半截流一律不重启（R49）；非 2xx 的原因依次取 `body.error ?? body.message ?? 纯文本 ?? 「HTTP n」`（R50，dsh-restart 真实契约是 `{ ok:false, error }`）；status 的「404 没装」与「连不上」分开提示。
- 预检阶段一次只显示一项（R54）：`runRestartChain` 收到 stage 就用 `setNotice` 整段替换蓝色提示框，不往 `.dshu-progress` 追加历史行；读到 `done` 写「重启预检完成」。`POST restart` 成功后立刻 `close(view)`（R55）：服务马上重启，不留一块点不动的面板。
- 底栏入口平时是藏着的（R56）：只有确认「有更新」或「查询失败（known=false）」才可见，`busy` 也保持可见；`src/client/index.ts` 每 5 分钟静默复查一次，否则升完一次就再也打不开面板。
- 状态必须跟着座位走（R57）：`setEntryState` 把状态记进 `inject.ts` 的 `entryStates`（WeakMap<Document, EntryState>），`mountFooterEntry` 每次把按钮插进座位时立刻 `paintEntry` 重画一次 —— 第一次静默查询常在底栏画出来之前就返回（实测：查询 t≈100ms 完成、按钮 t≈420ms 才落座），不补这一下入口会以默认可见的样子留在底栏，直到五分钟后的下一次复查；外壳重渲染后补挂同理。`teardown` 要 `entryStates.delete(doc)`，否则重挂会带上一轮的旧状态。
- 发布契约（R58）：`package.json` 的 `dsh` 段必须带 `manifestVersion: 1` 与 `bundle.patch: ./cordis.patch.yml`（该文件是往宿主插 `id: upgrade-button, name: dsh-upgrade` 的 insert 补丁）。安装器只认这一处——拿不到 `dsh.bundle.patch` 就直接报 not-a-bundle，声明了但路径拼错同样装不上，所以 `check.sh` ③.5 两条都验。产物 `lib/*.js` 必须入库（git 源安装只取那个 commit 的 tar，不跑构建），`.gitignore` 用 `/lib/*` + `!/lib/*.js`，sourcemap 不进库。
- 重启链在途时按住所有能起新工作的入口（R51）：`startBatch`、`runHostUpgrade`、`hostUpgradeDisabled` 都看 `restartRunning`，`setRestartBusy` 同时禁用「全部升级 / 重新检查 / 预发布 / 本体升级」——否则 `POST restart` 可能落在安装中途，留下半装。

## 维护

- 改了上面提到的任一模块，同批改这张表。
- 表里出现的路径必须真实存在，`check.sh` 会验。
- 与代码冲突时以代码为准，改这份文档，不要改代码迁就它。

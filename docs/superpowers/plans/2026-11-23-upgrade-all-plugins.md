# 插件「全部升级」+ 行内进度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把插件段从「每个包一个升级按钮」改成「一个『全部升级』按钮串行升完所有可更新插件」，每个插件行下方显示自己的进度，全部结束后出现「重启 DSH」按钮。

**Architecture:** dshmarket 的 v1 接口一次只接受一个包（`POST /dsh-market/api/v1/updates {packageName}`），没有批量端点，也不能并发（同一时刻只允许一个活动操作）。所以「全部升级」在客户端做成串行队列：新增 `src/client/batch.ts` 只管「按顺序起包、轮询、发事件、汇总」，`panel.ts` 只负责把事件画到对应行上，并在结束后把重启按钮亮出来。

**Tech Stack:** TypeScript（strict + noUncheckedIndexedAccess）、原生 DOM、vitest + jsdom、tsup 打包出 IIFE 客户端产物。

**Spec:** `docs/superpowers/specs/2026-11-23-dsh-upgrade-design.md`（本体/插件升级的既有设计）。本次增量需求原文（用户 m01245）：

1. 把插件的单个更新改成全部更新，全部更新完成之后显示重启按钮
2. 在单个插件下面显示自己的进度

## Global Constraints

- 只动 `src/client/*`、`test/*`、`docs/*`；服务端（`src/server/*`）、路由契约、agent 工具本轮不改。
- 相对 import 不写扩展名（`from './market'`），与仓库其余文件一致。
- 不新增第三方依赖，不 import `@deepseek-ai/*`。
- 市场没有批量端点：**必须串行**，一个操作到终态才起下一个。
- 进度与卡住判定沿用现有值：`DEFAULT_POLL_INTERVAL_MS = 800`、`MAX_POLLS = 1500`、`DEFAULT_STALLED_WAIT_MS = 180_000`（3 分钟无推进判卡住）。
- 失败原因写在插件自己那一行（红字、中文首句、全文进 `title`），不往面板底部抛红条。
- 请求头：`/dsh-upgrade/*` 用 `x-dsh-upgrade: 1`，`/dsh-restart/*` 用 `x-dsh-restart: 1`；一律 `credentials: 'same-origin'`。
- 验收唯一标准：`bash check.sh` 全绿（`npm run build` + `npx tsc --noEmit` + `npx vitest run`）。
- 改了 `src/client/panel.ts` 或在模块表里加了文件，必须同批更新 `docs/architecture.md`（pre-commit 钩子会拦文档漂移）。

## Review Focus

1. **中间一个包失败**：必须继续升后面的包，最终摘要能数清「3 个已升级，1 个失败」；一个失败吞掉剩下六个是这个功能最容易出的错。
2. **请求层失败被误报成安装失败**：`MARKET_UNAVAILABLE` / `OPERATION_UNKNOWN` / `MARKET_UNAUTHORIZED` 要走「插件更新不可用」（不红字、不说回滚），只有宿主给的安装失败才红字（Task 3 用例 6）。
3. **AGENTS_RUNNING**：有会话在跑时市场会拒每个包；行里必须是一句能读懂的中文（「有 agent 正在运行…」），不能是 400 字中英双语（Task 3 用例 5）。
4. **关面板 / 叫停**：批量必须停下（`cancelled()`），不能继续往已销毁节点写状态，也不能留下灰着不动的按钮。
5. **重启按钮的诚实性**：`GET /dsh-restart/api/status` 404（没装）时不显示按钮、改为「需手动重启」提示；预检失败要说清是预检这一步失败，不是升级失败。

---

## File Structure

| 文件 | 职责 | 谁用 |
|---|---|---|
| `src/client/batch.ts`（新建） | 串行升级队列：起包、轮询、卡住判定、事件与汇总；不碰 DOM、不读全局状态 | `panel.ts`、`test/batch.test.ts` |
| `src/client/panel.ts`（改） | 插件段 UI：全部升级按钮、两行式插件行、行内进度与失败原因、结束后的重启按钮 | `src/client/index.ts` |
| `src/client/market.ts`（不改） | 市场协议适配 | `batch.ts`、`panel.ts` |
| `test/batch.test.ts`（新建） | 队列的顺序、失败继续、卡住、汇总、叫停 | —— |
| `test/panel.test.ts`（改） | 行的两行结构、全部升级的界面行为、重启按钮 | —— |
| `docs/architecture.md`（改） | 模块表加 `batch.ts`，改写 `panel.ts` 那行 | —— |

---

### Task 1: 串行升级队列 `src/client/batch.ts`

**Files:**
- Create: `src/client/batch.ts`
- Test: `test/batch.test.ts`

**Interfaces:**
- Consumes: `startPluginUpdate(packageName: string, f: typeof fetch, base?: string): Promise<StartedPluginUpdate>`、`pollPluginOperation(operationId: string, f: typeof fetch, base?: string): Promise<PluginOperation>`、`isPluginUnavailableCode(code: string | undefined): boolean`（都来自 `./market`，已存在）。
- Produces:
  - `export type BatchItemState = 'pending' | 'running' | 'succeeded' | 'failed'`
  - `export type BatchItem = { name: string; state: BatchItemState; percent: number | null; detail: string | null; message: string | null; unavailable: boolean }`
  - `export type BatchEvent = { kind: 'running' | 'settled'; item: BatchItem }`
  - `export type BatchSummary = { succeeded: string[]; failed: string[]; skipped: string[]; restartRequired: boolean }`
  - `export type BatchOptions = { pollIntervalMs?: number; stalledWaitMs?: number; cancelled?(): boolean; onEvent?(event: BatchEvent): void }`
  - `export async function runBatch(names: string[], f: typeof fetch, base: string, options: BatchOptions = {}): Promise<BatchSummary>`

行为规格（实现按此写，测试按此钉）：

- 按 `names` 顺序，一个包到终态才起下一个。
- 起包前若 `options.cancelled?.() === true`：当前包与其余全部进 `skipped`，立即返回。
- `startPluginUpdate` 返回空 `operationId`：`isPluginUnavailableCode(code)` 为真 → `{ state:'failed', unavailable:true, message:'插件更新不可用' }`；否则 `unavailable:false`、`message` 用宿主给的 message，缺失时用 `'升级失败'`。
- 轮询：`status` 是 `queued`/`running` 时发 `{ kind:'running', item:{ percent, detail, message } }`，`message` 在 queued 且有 `wait.activeAgentIds` 时是 `'等 ' + n + ' 个运行中的会话结束'`，否则 `null`。
- 推进指纹 = 状态 + percent + done + detail；连续 `stalledWaitMs` 没有变化 → 该包 `failed`，`message` 为 `'还没开始升级：等 ' + n + ' 个运行中的会话结束后再点'`（有等待会话）或 `'升级还在后台跑，先不等了：稍后打开面板看结果'`（在跑）或 `'一直在排队，稍后再点'`（queued 无会话）；然后继续下一个包。
- 终态：`succeeded` → `succeeded` 列表 + `restartRequired ||= operation.restartRequired`；`failed` → 可用性 code 走 `unavailable:true`，否则 `unavailable:false` 且 `message = operation.message ?? '升级失败'`；`rolled-back` → `message = operation.message === undefined ? '已回滚' : '已回滚：' + operation.message`；`cancelled` → `message = '已取消'`。
- 每个包结束时发 `{ kind:'settled', item }`；函数本身不抛异常（`pollPluginOperation` 已把网络异常收敛成结果对象）。

- [ ] **Step 1: 写失败测试**

在 `test/batch.test.ts` 写 6 个用例（复用 `test/market.test.ts` 里的 `fakeFetch`/`jsonResponse` 写法，每个用例自带一份小拷贝，不跨文件 import 测试助手）：

1. `按顺序一个包一个包升，第二个 POST 发生在第一个 succeeded 之后`：两个包，记录 `POST` 顺序与每次 `GET operations` 的返回（第一次 `succeeded` 之后才允许出现第二次 `POST`），断言 `summary.succeeded` 为两个名字、`restartRequired` 为 false。
2. `中间一个包失败后继续升后面的`：三个包，第二个 `failure: { code: 'INSTALL_FAILED', message: '磁盘写满' }`，断言 `failed === ['b']`、`succeeded === ['a','c']`，且第三个包真的被 POST 过。
3. `任一成功操作说需要重启就汇总成 restartRequired`：单包 `succeeded` + `outcome.restartRequired: true`，断言 `summary.restartRequired === true`。
4. `市场不可用时标成 unavailable，不冒充安装失败`：`POST` 返 500，断言该包 `state:'failed'`、`unavailable:true`、`message:'插件更新不可用'`。
5. `排队一直没推进就判卡住，接着升下一个`：两个包，第一个始终 `queued` + `wait.activeAgentIds: ['s1','s2']`，`stalledWaitMs: 0`、`pollIntervalMs: 1`，断言 `failed` 含第一个包、它的 `message` 含 `'等 2 个运行中的会话结束'`，且第二个包仍被 `POST`。
6. `叫停时剩下的包进 skipped，不再发请求`：三个包，第一包成功后 `cancelled()` 返回 true，断言 `skipped === ['b','c']` 且 `POST` 只发生过一次。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/batch.test.ts`
Expected: FAIL，`Cannot find module '../src/client/batch'`（或 `runBatch is not a function`）。

- [ ] **Step 3: 实现 `runBatch`**

在 `src/client/batch.ts` 写上面 Interfaces 里的签名与行为规格。内部实现要点：

- `sleep(ms)` 与面板里同款（`new Promise(resolve => setTimeout(resolve, ms))`），写在文件内，不导出。
- 一个包一个包的 `for (const name of names)` 循环；`for (let round = 0; round < MAX_POLLS; round += 1)` 轮询，每轮先 `await pollPluginOperation(...)`，非终态才 `await sleep(interval)`。
- 指纹与卡住判定抽成文件内两个小函数 `moveKey(operation: PluginOperation): string` 与 `stalledReason(operation: PluginOperation): string`（面板里现有的同名函数在这一轮不动，Task 2 删掉它们，避免两处逻辑漂移）。
- 常量 `DEFAULT_POLL_INTERVAL_MS = 800`、`MAX_POLLS = 1500`、`DEFAULT_STALLED_WAIT_MS = 180_000` 从 `batch.ts` 导出，面板 Task 2 起改为 import 这三个值，不再各留一份。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/batch.test.ts`
Expected: PASS，6 passed。

- [ ] **Step 5: 提交**

```bash
git add src/client/batch.ts test/batch.test.ts
git commit -m "feat(client): 串行批量升级队列（顺序、失败继续、卡住与汇总）"
```

---

### Task 2: 插件行改成两行式，删掉单包升级路径

**Files:**
- Modify: `src/client/panel.ts`（`createPluginRow` 845-863、`PluginRowView` 837-843、CSS 124-131、`runPluginUpdate` 1172-1215、`paintPluginRunning` 1217-1240、`moveKey`/`stalledReason`、`handlePluginStartFailure`/`handlePluginOperation`、常量 63-67）
- Test: `test/panel.test.ts`

**Interfaces:**
- Consumes: `runBatch` 在 Task 1 产出的 `BatchItem` 类型；`DEFAULT_POLL_INTERVAL_MS`、`DEFAULT_STALLED_WAIT_MS` 从 `./batch` 导出。
- Produces:
  - `type PluginRowView = { root: HTMLElement; name: HTMLElement; version: HTMLElement; state: HTMLElement; bar: HTMLElement; fill: HTMLElement; progressText: HTMLElement }`（**没有 button 字段**）
  - `function paintBatchItem(row: PluginRowView, item: BatchItem): void`（用例在 Task 3）—— 把 `BatchItem` 画到这一行：`running` 时按 `percent` 画条（null → 不确定进度）并把 `detail ?? '正在升级…N%'` 写进 `progressText`；`succeeded` 收起条写「已升级」（`restartRequired` 由批量层决定是否改文案，这里只画行内终态）；`failed` 且 `unavailable` 写「插件更新不可用」（不红）；`failed` 且非 unavailable 写「升级失败：」+ 压缩后的 message（红字 + `title` 存全文）；`pending` 收起进度条清空文字。

- [ ] **Step 1: 写失败测试**

本任务只剩两条纯 DOM 契约（`paintBatchItem` 与失败/不可用文案的用例放在 Task 3，那里才有「全部升级」这个驱动路径）：

1. 加 `插件行是两行结构：第一行名字与版本，第二行自己的进度`：行内存在 `.dshu-plugin-line`，其中含 `.dshu-plugin-name` 与 `.dshu-plugin-version`；`.dshu-plugin-progress` 是 `.dshu-plugin` 的最后一个直接子节点且默认 `hidden`。
2. 改 `插件行不再自带升级按钮`：`document.querySelector('.dshu-plugin-upgrade')` 为 `null`；原来点行内按钮升级的用例整体删掉（它的后继是 Task 3 的「全部升级」用例），不要把旧断言改成必然为真的空断言。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/panel.test.ts`
Expected: FAIL（`.dshu-plugin-line` 为 null、`.dshu-plugin-upgrade` 仍存在）。

- [ ] **Step 3: 改行结构并删掉单包路径**

- `createPluginRow` 产出的 DOM 变成：`root(.dshu-plugin)[data-name=<包名>] > line(.dshu-plugin-line)[name, version], state(.dshu-plugin-state), progress(.dshu-plugin-progress)[bar(.dshu-bar) > fill(.dshu-bar-fill), progressText(.dshu-plugin-progress-text)]`；`progress.hidden = true`，`root.dataset.name = update.name`（Task 3 的用例按 `[data-name="a"]` 定位）。
- CSS：`.dshu-plugin` 由 grid 改成 `display:flex;flex-direction:column;gap:4px`；新增 `.dshu-plugin-line{display:flex;justify-content:space-between;gap:10px;align-items:baseline}`、`.dshu-plugin-progress{display:flex;flex-direction:column;gap:4px}`、`.dshu-plugin-progress-text{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}`；删掉 `.dshu-plugin-upgrade` 相关的 grid 规则（`grid-row`/`grid-column`）与按钮 disabled 规则里的 `.dshu-plugin-upgrade` 选择器。
- 删掉 `runPluginUpdate`、`paintPluginRunning`、`handlePluginStartFailure`、`handlePluginOperation`、面板内的 `moveKey`/`stalledReason`，以及 `setRowProgress` 改成被 `paintBatchItem` 内部使用的私有函数（签名保持 `(row, percent, visible)`）。
- `compactReason` 保留，`setRowState` 保留。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/panel.test.ts && npx tsc --noEmit`
Expected: PASS，且 tsc 干净。

- [ ] **Step 5: 提交**

```bash
git add src/client/panel.ts test/panel.test.ts
git commit -m "refactor(client): 插件行改两行式，删掉单包升级路径"
```

---

### Task 3: 「全部升级」按钮与界面接线

**Files:**
- Modify: `src/client/panel.ts`（`buildView` 493-498 的插件段、`renderPlugins` 812-834、`View` 173-205、`openPanel` 初始化 511-541）
- Test: `test/panel.test.ts`

**Interfaces:**
- Consumes: `runBatch(names, f, base, options)`、`BatchItem`、`BatchSummary`（Task 1）；`paintBatchItem`（Task 2）。
- Produces（`View` 新增字段）：
  - `rows: Map<string, PluginRowView>`
  - `upgradeAllButton: HTMLButtonElement`
  - `pluginSummary: HTMLElement`（批量结束后的一行汇总，默认 hidden）
  - `batchBusy: boolean`
  - `restartButton: HTMLButtonElement`（Task 4 用，本任务先建好并隐藏）

- [ ] **Step 1: 写失败测试**

在 `test/panel.test.ts` 加 7 个用例（用例 1-4 用真实 DOM 驱动，市场侧用 `fakeFetch` 桩成「POST 立刻 202、GET operations 第 N 次返回 succeeded」）：

1. `全部升级按钮与「插件（N 个可更新）」标题同一行`：断言 `.dshu-upgrade-all` 存在、文案「全部升级」，且 `button.parentElement` 就是包含 `.dshu-plugin-head` 的那个 `.dshu-plugins-head`、`document.querySelector('.dshu-plugin-list')` 不是按钮的兄弟之一；点击后对 `POST /dsh-market/api/v1/updates` 依次收到两个包名。
2. `升级中按钮禁用且文案变化，结束恢复`：让第一个包停在 `running`，断言按钮 `disabled === true`、文案「升级中…」；放行到全部结束后 `disabled === false`、文案回到「全部升级」。
3. `每个插件把自己的进度画在自己那一行`：第一包 `progress.percent = 42.6` 时，`[data-name="a"] .dshu-bar-fill` 的 `style.width` 是 `'43%'`，且 `[data-name="b"] .dshu-bar` 仍 `hidden`。
4. `中途失败继续，最后一行汇总数得清`：三个包、第二个 `failure: { code: 'INSTALL_FAILED', message: '磁盘写满' }`，断言 `[data-name="b"] .dshu-plugin-state` 有 `data-error` 且文案含「磁盘写满」、`[data-name="c"]` 最终「已升级」、`.dshu-plugin-summary` 文案含「2 个已升级」与「1 个失败」。
5. `AGENTS_RUNNING 的 400 字中英双语只留中文首句`：失败 message 用实测那句（`有 agent 正在运行（session-…）。更新会直接替换插件文件… / Agents are running (…). Updating replaces plugin files in place…`），断言行内文案含「有 agent 正在运行」、不含 `Agents are running`，而 `.dshu-plugin-state` 的 `title` 含 `Agents are running`。
6. `请求层不可用不画红字`：`POST` 返 500（`MARKET_UNAVAILABLE`），断言该行文案是「插件更新不可用」且没有 `data-error`。
7. `批量进行中关闭面板，剩下的包不再发请求`：两个包，第一个成功后关闭面板，断言 `POST` 只发生过一次、且后续 ticking 不抛错（`view.closed` → `cancelled()`）。

再加 1 条（可并入用例 2）：`升级期间本体升级按钮、重新检查、预发布开关都按住` —— 批量进行中断言 `.dshu-refresh`、`.dshu-prerelease`、`.dshu-upgrade-btn`（存在时）的 `disabled === true`，结束后恢复。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/panel.test.ts`
Expected: FAIL（`.dshu-upgrade-all` 为 null）。

- [ ] **Step 3: 实现按钮与接线**

- `buildView`：插件段的 `h3.dshu-plugin-head`（现在 `panel.ts:495-496`）包进一行 `div.dshu-plugins-head`，同一行右侧放按钮——`pluginsSection.append(pluginsHead, pluginList, pluginSummary)`，`pluginsHead = [pluginHead, upgradeAll, restartButton]`（用户 m01298 要求按钮与「插件（N 个可更新）」标题同一行）。`.dshu-upgrade-all` 文案「全部升级」，`.dshu-restart` 文案「重启 DSH」且 `hidden = true`；`pluginSummary` 仍是列表下方的汇总行，`hidden = true`。
- CSS 新增：`.dshu-plugins-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0}`、`.dshu-plugins-head h3{margin:0}`、`.dshu-plugins-head .dshu-upgrade-all{margin-left:auto}`、`.dshu-upgrade-all{padding:4px 10px;font-size:12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font:inherit;cursor:pointer}`、`.dshu-plugin-summary{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}`；`.dshu-upgrade-all:disabled{opacity:.5;cursor:default}`。
- `renderPlugins`：重建 `view.rows`（`rows.set(update.name, row)`）；`updatable.length === 0` 或 `!available` 时隐藏 `.dshu-upgrade-all`、清空 `rows`、隐藏 `pluginSummary`。
- 点击处理：`startBatch(view)` —— `batchBusy = true`、`setBatchBusy(view, true)`（禁用全部升级/本体升级/重新检查/预发布，文案「升级中…」，隐藏 `pluginSummary`）、`await runBatch(names, fetchOf(doc), base, { pollIntervalMs, stalledWaitMs, cancelled: () => view.closed, onEvent })`，`onEvent` 里 `const row = view.rows.get(item.name)`，有才 `paintBatchItem(row, item)`；结束后写汇总 `n 个已升级，m 个失败`（只在 m > 0 时带失败数），`setBatchBusy(view, false)`，`live(view, token)` 为假时后面什么都不做。
- `setBatchBusy` 与既有 `setHostBusy`/`setHostIdle` 互斥：本体忙时禁用全部升级，批量忙时禁用本体升级按钮与重查/预发布。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/panel.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/client/panel.ts test/panel.test.ts
git commit -m "feat(client): 插件段改成全部升级，逐行显示自己的进度与汇总"
```

---

### Task 4: 全部升级完成后显示「重启 DSH」

**Files:**
- Modify: `src/client/panel.ts`（`continueToRestart` 1079-1170、`View`）
- Test: `test/panel.test.ts`

**Interfaces:**
- Consumes: `RESTART_STATUS_PATH`、`RESTART_PRECHECK_PATH`、`RESTART_PATH`、`RESTART_HEADERS`（已存在）；Task 3 的 `view.restartButton`。
- Produces:
  - `function runRestartChain(view: View, token: number, onManual: (reason: string) => void): Promise<void>` —— status → precheck → restart 三段，任何一步不可用都调 `onManual(一句话原因)`，成功时 `setNotice(view, '正在重启…')`。
  - `continueToRestart(view, token, target)` 改为薄封装：`runRestartChain(view, token, reason => setNotice(view, '已升级到 ' + target + '，' + reason + '，需手动重启'))`。
  - `async function offerRestart(view: View, token: number): Promise<void>` —— 批量结束且有成功项时调用：`GET /dsh-restart/api/status` 200 → `view.restartButton.hidden = false`；404 → 不显示按钮，`setNotice(view, '插件已升级，需手动重启 dsh web 才生效')`；其它状态码 → 记一句「重启不可用（HTTP n）」提示。

- [ ] **Step 1: 写失败测试**

在 `test/panel.test.ts` 加 4 个用例：

1. `全部升级完成后出现重启按钮`：全流程成功、`/dsh-restart/api/status` 200，断言 `.dshu-restart` 的 `hidden === false`。
2. `没装 dsh-restart 时不显示按钮，只提示手动重启`：status 返 404，断言 `.dshu-restart` 仍 hidden、`.dshu-notice` 文案含「需手动重启」。
3. `点重启后依次发预检与重启请求`：点击后断言 `POST /dsh-restart/api/precheck` 与 `POST /dsh-restart/api/restart` 各一次、都带 `x-dsh-restart: 1`，且提示「正在重启…」。
4. `预检失败时说是预检失败，不冒充升级失败`：precheck 返 500，断言提示含「预检失败」且不含「升级失败」。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/panel.test.ts`
Expected: FAIL（`.dshu-restart` 不存在或一直 hidden）。

- [ ] **Step 3: 实现重启链与按钮**

按 Interfaces 抽 `runRestartChain`、改 `continueToRestart`、加 `offerRestart`；`startBatch` 在汇总之后调 `offerRestart`（`summary.succeeded.length > 0` 时），并给 `.dshu-restart` 绑点击：`runRestartChain(view, view.token, reason => setNotice(view, '重启不可用：' + reason))`，点击期间按钮 disabled 直到发出 restart 请求。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/panel.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/client/panel.ts test/panel.test.ts
git commit -m "feat(client): 全部升级完成后提供重启 DSH 按钮"
```

---

### Task 5: 文档与整体验收

**Files:**
- Modify: `docs/architecture.md`（模块表 20-22 行附近、数据流小节）
- Modify: `README.md`（若「怎么用」里写了「每个插件单独升级」，改成全部升级）

**Interfaces:**
- Consumes: Task 1–4 的产物；不需要新代码。

- [ ] **Step 1: 更新模块表**

在 `docs/architecture.md` 模块表加一行：`| 批量升级 | src/client/batch.ts | 串行执行全部可更新插件：顺序起包、轮询、3 分钟无推进判卡住、失败继续、汇总成功/失败/跳过与 restartRequired | src/client/panel.ts |`；把 `panel.ts` 那行改写成「插件段一个『全部升级』按钮 + 两行式插件行（第一行名字/版本，第二行自己的进度条与 pnpm 说明）+ 结束后的『重启 DSH』按钮；单包升级按钮已移除」。

- [ ] **Step 2: 全量验收**

Run: `bash check.sh`
Expected: 输出 `✓ 全部通过`，退出码 0；测试数比改动前（208）多，至少 +14。

- [ ] **Step 3: 真机复核（人工，不算验收）**

`npm run build` 后刷新 `http://127.0.0.1:3080/`：底栏升级按钮 → 面板 → 插件段只有「全部升级」；点一次能看到每一行自己的百分比；全部结束后出现「重启 DSH」。

- [ ] **Step 4: 提交**

```bash
git add docs/architecture.md README.md
git commit -m "docs: 记录全部升级与行内进度"
```

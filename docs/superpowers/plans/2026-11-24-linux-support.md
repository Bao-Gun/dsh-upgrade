# Linux 适配 + NAS 真机验收 + 发版 0.2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 dsh-upgrade 在 Linux（飞牛 NAS）上不再「装到别处再回滚」：把平台差异收进三处（npm 前缀与可执行、cp 候选表、桌面通知），装不进去时当场说清并给出可复制的命令；然后在 NAS 上真装一遍、真跑一遍能跑的部分，最后发 0.2.0 并让 NAS 通过索引装。

**Architecture:** 现在三处副作用都默认「这台是 macOS，npm 全局前缀就是装着 dsh 的那个前缀」。NAS 上这个假设两头都错：dsh 在 `/usr/local/lib/node_modules`（root 所有），而 `npm prefix -g` 是 `/home/admin/.local`（可写）。所以升级流程必须**从 installDir 反推前缀**，并在动手前先问「这个前缀我写得进去吗」。写不进去不是 bug 而是环境事实（root 装的 dsh），插件的能力边界到此为止：立刻失败、给出 `sudo npm i -g --prefix /usr/local …`，不猜密码、不自动提权。

**Tech Stack:** TypeScript（strict + noUncheckedIndexedAccess）、`node:fs/promises`、vitest、tsup。

**Spec:** 无独立 spec；需求原文（m02321）：「/writing-plans 适配linux系统，使用nas测试，最后更新索引，在nas上通过索引安装」，补充（m02361）「可以参考 dsh-restart 的经验」。

## Global Constraints

- 平台差异**只准出现在三处**：`src/server/npm.ts`（npm 前缀/可执行/PATH）、`src/server/clone.ts`（cp 候选表）、`src/server/notify.ts`（桌面通知）。别处出现 `process.platform` 就是跑偏（`scripts/install.mjs` 的 `cloneArgs` 是纯 JS 副本，例外且由测试钉住）。
- 不新增运行时依赖；`scripts/nas-selftest.ts` 只在 NAS 上经 `npx tsx` 跑，不进 `lib/`、不进 `package.json` 的 exports。
- 不自动提权：不用 `sudo -n`、不读密码、不改 dsh 的安装位置与属主。装不进去就失败并给命令。
- 相对 import 不写扩展名；注释写「为什么」，与仓库既有风格一致。
- 改了 `src/server/*` 必须同批改 `docs/architecture.md` 模块表 / 约束（`.githooks/pre-commit` 的 doc-drift 会拦）。
- 改了 `src/` 必须 `npm run build` 后把变了的 `lib/*.js` 点名叫进同一提交（git 源安装不跑构建）。
- 验收唯一标准：`bash check.sh` 全绿（build + tsc + vitest + 用例数下限）。
- 非标准前缀（版本化目录、自建安装）允许推导失败：那种情况下**必须**在可写性检查或安装后的版本校验上失败并回滚，绝不静默成功。

## Review Focus

1. **前缀推导错一个字符就等于装到别人家**：`npmPrefixOf` 只认 `<prefix>/lib/node_modules/@deepseek-ai/dsh` 这一种形状，别用「往上数三层」这种猜法；推不出来要失败，不要退回「让 npm 自己决定」。
2. **可写性检查必须在备份之前**：备份是 300 MB 级整目录拷贝，权限问题不该先拷一遍再说。
3. **PATH 陷阱**：NAS 上 dsh web 由 systemd 用户级服务拉起，`PATH` 里未必有 node/npm（dsh-restart 已踩过，见其 `docs/gotchas.md:38`）。npm 必须用绝对路径 + 子进程 PATH 头部补 node 目录。
4. **`cp -c` 在 GNU coreutils 上是非法参数**：Linux 上不能靠「先试 `-c`、失败再退」蒙过去（白跑一次、日志留噪声），要按平台给候选表。
5. **失败文案是这次唯一的产物**：NAS 上本体升级永远会失败，「安装目录不可写 + 那行 sudo 命令」必须一眼看懂、能直接复制，不能被压缩成一行红字。

---

## File Structure

| 文件 | 职责 | 谁用 |
|---|---|---|
| `src/server/npm.ts`（新建） | 从 installDir 推 npm 前缀、定位 npm 可执行、拼子进程 PATH | `src/server/upgrade.ts` |
| `src/server/clone.ts`（新建） | `cloneCandidates(platform, src, dst)`：cp 参数候选表，纯函数无 IO | `src/server/upgrade.ts`、`test/clone.test.ts` |
| `src/server/upgrade.ts`（改） | 状态机：加可写性早退、`runNpmInstall(target, prefix, timeoutMs)`、clone 走候选表 | `src/server/routes.ts` |
| `src/server/notify.ts`（改） | 通知命令按平台给 argv（darwin osascript / linux notify-send） | `src/index.ts`、`src/server/routes.ts` |
| `src/client/panel.ts`（改） | 红条支持换行（两行命令要能读） | `src/client/index.ts` |
| `scripts/install.mjs`（改） | `cloneArgs` 与 clone.ts 同表（纯 JS 副本） | 安装脚本自身 |
| `scripts/nas-selftest.ts`（新建） | NAS 上用 `npx tsx` 跑：沙箱前缀里真升一次 + 真回滚一次 | 人工（Task 7） |
| `docs/architecture.md` / `docs/gotchas.md` / `README.md` / `docs/nas.md`（改/新建） | 模块表、坑、平台支持、真机记录 | —— |

---

### Task 1: npm 前缀与可执行（`src/server/npm.ts`）

**Files:**
- Create: `src/server/npm.ts`
- Test: `test/npm.test.ts`
- Modify: `src/server/upgrade.ts`、`test/upgrade.test.ts`

**Interfaces:**
- `npmPrefixOf(installDir: string): string | null`：`/usr/local/lib/node_modules/@deepseek-ai/dsh` → `/usr/local`；形状不符返回 `null`。
- `npmBin(nodeDir: string, exists: (p: string) => boolean): string`：`<nodeDir>/npm` 存在就用绝对路径，否则 `npm`。
- `npmEnv(env: NodeJS.ProcessEnv, nodeDir: string, delimiter?: string): NodeJS.ProcessEnv`：PATH 头部补 `nodeDir`，已在 PATH 里就不重复加（按分隔符切段比较）。
- `UpgradeDeps.runNpmInstall(target: string, prefix: string, timeoutMs: number)`（签名变更）。

**Steps:**
- [ ] `npmPrefixOf`：只用 `path` 拼出后缀 `/lib/node_modules/@deepseek-ai/dsh`，`endsWith` 命中后切掉后缀；切完为空或等于自身返回 null（不用「往上数三层」的猜法）。
- [ ] `npmBin` / `npmEnv` 按上面接口实现，`exists` 与 `delimiter` 都是注入缝（测试用假实现，不碰真文件系统）。
- [ ] `upgrade.ts`：给私有 `run()` 加 `env?: NodeJS.ProcessEnv` 选项，原样传给 `spawn`。
- [ ] `npmInstall(target, prefix, timeoutMs)` 改成 `run(npmBin(dirname(process.execPath), existsSync), ["i","-g","--prefix",prefix,"@deepseek-ai/dsh@"+target], { cwd: tmpdir(), timeoutMs, env: npmEnv(process.env, dirname(process.execPath)) })`。
- [ ] 状态机在 `readInstalledVersion` 之前算 `const prefix = npmPrefixOf(installDir)`；为 null 时 `fail({ code: "INSTALL_FAILED", message: "无法从安装目录推导 npm 全局前缀：" + installDir + "（期望 <prefix>/lib/node_modules/@deepseek-ai/dsh）" })`，此时还没备份、没装。
- [ ] `test/npm.test.ts`：三种能推出来的路径（homebrew、`/usr/local`、版本化 Cellar 路径也按形状推出）、两种非匹配（相对路径、少了 `/lib/node_modules`）；npmBin 有/无；npmEnv 补头、已存在不重复、空 PATH。
- [ ] `test/upgrade.test.ts`：注入的 `runNpmInstall` 断言收到推导出的 `--prefix`；installDir 形状不符时断言 `INSTALL_FAILED` 且 `cloneDir` / `removeDir` 一次都没被调用。

### Task 2: 目录不可写就早退（`INSTALL_DIR_NOT_WRITABLE`）

**Files:**
- Modify: `src/server/upgrade.ts`、`src/client/panel.ts`（第 151 行 `.dshu-error` 样式）
- Test: `test/upgrade.test.ts`、`test/panel.test.ts`

**Interfaces:**
- `UpgradeDeps.checkWritable(path: string): Promise<boolean>`（默认 `access(path, W_OK)`，ENOENT / EACCES 一律 false）。
- 新增错误码 `INSTALL_DIR_NOT_WRITABLE`；`error.message` 是两行：第一行说事实，第二行是可直接复制的命令。

**Steps:**
- [ ] 状态机在 `readInstalledVersion` 成功后、`cloneDir` 之前，依次检查 `installDir`、`join(prefix,"lib","node_modules")`、`join(prefix,"bin")`（npm 全局安装三处都要写）；第一个不可写的路径进消息。
- [ ] 消息形状（版本号取本次 target）：第一行 `安装目录不可写：<path>（属主不是你），插件无法升级本体。`，第二行 `手动执行：sudo npm i -g --prefix <prefix> @deepseek-ai/dsh@<target>`。
- [ ] `panel.ts`：`.dshu-error` 的样式字符串补 `white-space:pre-line`（换行只在多行消息里出现，不影响单行红条）。
- [ ] `test/upgrade.test.ts`：不可写 → `ok:false`、code 正确、消息含两行且含 `sudo npm i -g --prefix`、`cloneDir` 未被调用；三处检查的短路顺序（第一处不可写就不查第二处）。
- [ ] `test/panel.test.ts`：红条 `textContent` 保留换行（jsdom 里断言 `\n` 仍在），并断言样式字符串里出现 `pre-line`。

### Task 3: cp 候选表（`src/server/clone.ts`）

**Files:**
- Create: `src/server/clone.ts`、`test/clone.test.ts`
- Modify: `src/server/upgrade.ts`（`cloneDirDefault`）、`scripts/install.mjs`（`cloneArgs` 与 `runVerify` 的回退分支）

**Interfaces:**
- `cloneCandidates(platform: NodeJS.Platform, source: string, dest: string): string[][]`
  - darwin：`[["-c","-R",src,dst], ["-R",src,dst]]`
  - linux：`[["--reflink=auto","-R",src,dst], ["-R",src,dst]]`
  - 其它：`[["-R",src,dst]]`

**Steps:**
- [ ] 新模块写候选表 + 文档注释（照 dsh-restart `src/server/clone.ts:1-14` 的理由：`-c` 只有 macOS/BSD 有，`--reflink=auto` 在 btrfs/xfs 真 CoW、ext4 自动退化成整拷，绝不硬链接）。
- [ ] `cloneDirDefault`：先 `rm -rf dst`，再按 `cloneCandidates(process.platform, src, dst)` 逐条 `run("cp", args)`，任一条 0 就返回；全失败抛最后一条的 stderr（空则 `复制安装目录失败`）。
- [ ] `scripts/install.mjs` 的 `cloneArgs`：darwin `["-c","-R"]`、linux `["--reflink=auto","-R"]`、其它 `["-R"]`；`runVerify` 里「darwin 失败再试 linux 候选」的分支保留，日志里的 clone 标签跟着改。
- [ ] `test/clone.test.ts`：darwin/linux/win32 三张表逐项断言；**并且**动态 `import("../../scripts/install.mjs")` 断言 `cloneArgs(src,dst,p)` 与 `cloneCandidates(p,src,dst)[0]` 完全一致（两边漂移就红）。
- [ ] `cloneDirDefault` 的默认实现不做假 run 的单测（默认 run 不可注入）：它由 Task 7 在 Linux 真机上验证，这一点写进任务报告。

### Task 4: 通知的平台分支

**Files:**
- Modify: `src/server/notify.ts`、`test/notify.test.ts`

**Interfaces:**
- `NotifyDeps = { runNotify(argv: string[]): Promise<boolean> }`（原 `runOsascript(script)` 的破坏性改名，调用点只有本文件与测试）。
- `notifyCommand(platform: NodeJS.Platform, title: string, body: string): string[]`：darwin → `["osascript","-e", AppleScript]`；linux → `["notify-send", title, body]`；其它 → `[]`。

**Steps:**
- [ ] `notificationScript` 保留（AppleScript 双引号转义），但只给 darwin 分支用；通知正文文案不变。
- [ ] `runNotifyDefault(argv)`：`argv.length === 0` 直接 false；否则 `spawn(argv[0], argv.slice(1))`，error/非 0 一律 false，绝不抛。
- [ ] `notifyUpgraded` 改成先用 `notifyCommand(process.platform, …)` 再调 `runNotify`——语义仍是「尽力而为，失败静默」，`settlePending` 的三种终局不变。
- [ ] `test/notify.test.ts`：darwin 拿到的 argv 是 osascript + 转义后的脚本；linux 是 `["notify-send","DSH 已升级","<正文>"]`；win32 返回空数组时不 spawn 且返回 false；注入实现抛错时 `notifyUpgraded` 仍返回 false。

### Task 5: 文档与验收

**Files:**
- Modify: `docs/architecture.md`、`docs/gotchas.md`、`README.md`、`check.sh`
- Create: `docs/nas.md`（真机验收记录，Task 7 填）

**Steps:**
- [ ] `docs/architecture.md` 模块表加 `src/server/npm.ts`、`src/server/clone.ts` 两行，改 `upgrade.ts` 那行（可写性早退 + 候选表 + prefix 签名）；「关键约束」补：平台差异只在这三处、不可写就失败不猜密码、前缀只从 installDir 推。
- [ ] `docs/gotchas.md` 追加（只追加）：① NAS 上 `npm prefix -g` 是 `~/.local` 而 dsh 在 `/usr/local`，用全局 prefix 会装到别处并被版本校验逮住 → 从 installDir 推 `--prefix`；② GNU cp 没有 `-c`；③ root 所有的安装目录永远升级不了，只能给 sudo 命令；④ systemd 拉起的进程 PATH 里没有 node/npm → npm 用绝对路径 + 补 PATH。
- [ ] `README.md` 加平台支持表（macOS arm64：全功能；Linux：插件升级/提醒/重启链可用，本体升级在 root 装的场合按提示手动 sudo）。
- [ ] `docs/nas.md` 先占位（验收清单 + 待填表格），Task 7 填实测数字。
- [ ] `bash check.sh` 全绿后，把用例数下限改成实际条数（注释写清「208 + 批量/重启 44 + Linux 适配 N 条」）。

### Task 6: 发版 0.2.0 + 更新索引

**Files:**
- Modify: `package.json`（version）、`lib/*.js`（构建产物）
- 外部：`~/Desktop/dsh/plugin/dsh-plugins` 的 `site/index.json`

**Steps:**
- [ ] `package.json` version → `0.2.0`；`npm run build`；`bash check.sh` 全绿。
- [ ] 提交（源码 + 文档 + `lib/*.js` 同批）、打 tag `v0.2.0`、push `main` 与 tag 到 `git@github.com:Bao-Gun/dsh-upgrade.git`。
- [ ] 索引仓 `npm run index`（`scripts/build-index.mjs` 会 clone 插件仓库、读 package.json 与 HEAD commit）；确认输出里是 `dsh-upgrade 0.2.0 …#<新 commit>`。
- [ ] 提交并 push `dsh-plugins`（Pages workflow 会重建，但 ghproxy 读的是 `main` 上的 `site/index.json`，必须把重扫结果提交进去）。
- [ ] 验证：`curl -s https://ghproxy.net/https://raw.githubusercontent.com/Bao-Gun/dsh-plugins/main/site/index.json` 里能看到 dsh-upgrade 的 `0.2.0` 与新 commit。

### Task 7: NAS 真机验收

**Files:**
- Create: `scripts/nas-selftest.ts`（沙箱里真升一次 + 真回滚一次，打印 JSON）
- Modify: `docs/nas.md`（填实测）

**Steps:**
- [ ] 快照现状（ssh alias `nas`）：`node -v`、`npm -v`、`npm prefix -g`、`ls -ld /usr/local/lib/node_modules/@deepseek-ai/dsh`、`dsh plugin --profile web list`、`cat ~/.dsh/profiles/web/package.json`。
- [ ] 拿认证：`journalctl --user -u dsh-watchdog -n 100 | grep "dsh web:"` 取带 token 的启动 URL，`curl -i -s <url>` 取 `Set-Cookie`（与 `scripts/install.mjs` 的 bootstrapCookie 同法）；确认 `/health` 200。
- [ ] **通过索引安装**：用索引里的 spec `dsh plugin --profile web add "github:Bao-Gun/dsh-upgrade#<commit>"`（与「发现」页背后同一条路径；CLI 形态以 `dsh plugin --help` 为准并记录）；装完确认 profile `package.json` 里是 `github:…#commit`、`node_modules/dsh-upgrade` 就位。
- [ ] 重启 dsh web（`systemctl --user restart dsh-watchdog` 或 dsh-restart 的 API），等 `/health` 200；`curl -H "x-dsh-upgrade: 1" …/dsh-upgrade/api/status` 返回 200 且 `current` 是 `0.2.2-rc.5`；页面 HTML 里 grep 到 dsh-upgrade 的 client 资源并 curl 200（记录实际路径）。
- [ ] **本体升级的拒绝路径**：`POST /dsh-upgrade/api/upgrade` body `{"target":"<registry 里存在的版本>"}`（带 `x-dsh-upgrade: 1`）→ NDJSON 里有 `phase:fail` + `code: INSTALL_DIR_NOT_WRITABLE`，消息两行且含 `sudo npm i -g --prefix /usr/local`；确认 `~/.dsh/dsh-upgrade/` 下没有新备份、本体版本没变。
- [ ] **沙箱真升一次**（Linux 上真正走到 cp / npm / 校验）：`git clone --depth 1 https://github.com/Bao-Gun/dsh-upgrade /tmp/dshup-src`，`npm i -g --prefix /home/admin/.dshup-sandbox @deepseek-ai/dsh@0.2.1-rc.2` 造一个旧版本，再 `npx --yes tsx /tmp/dshup-src/scripts/nas-selftest.ts` → 断言 `ok:true`、沙箱里 package.json 版本变了、`--version` 探针通过、备份目录已被删。
- [ ] **沙箱回滚一次**：selftest 第二个场景注入「探针永远返回错版本」，断言 `VERSION_MISMATCH` + `rolledBack:true`、沙箱目录回到旧版本、`root` 下没有残留备份。
- [ ] **重启链**：`POST /dsh-restart/api/precheck`（`x-dsh-restart: 1`）读到 `done` 且无 `ok:false` → `POST /dsh-restart/api/restart` → 等 `/health` 200 且 `/dsh-upgrade/api/status` 仍 200（插件在重启后还在）。
- [ ] 把实测写进 `docs/nas.md`：耗时、真实错误文案、cp 实际用的候选（日志）、磁盘占用、`notify-send` 在 NAS 上到底能否出声。

---

## 自审

1. **每个任务的产物都能独立验收？** Task 1/2/3/4 各有单测；Task 5 靠 `check.sh`；Task 6 靠索引里的 commit + ghproxy curl；Task 7 靠 JSON 断言与状态码。✅
2. **任务之间有隐藏依赖？** Task 2 复用 Task 1 的 `prefix` 与 `npmPrefixOf`（顺序执行，Task 1 先落地）；Task 7 依赖 Task 6 发版（索引里的 commit 决定 NAS 装到哪一版）。其余互相独立。✅
3. **平台差异是否只落三处？** 是；`scripts/install.mjs` 的副本由 `test/clone.test.ts` 钉住。✅
4. **有没有「测不到就假装通过」？** `cloneDirDefault` 的默认实现不在单测里造假 run，交给 Task 7 真机；已在 Task 3 明说。✅
5. **NAS 上注定失败的部分有没有被说成成功？** 本体升级在 NAS 上是「明确失败 + 给命令」，Task 7 把它写成验收项而不是功能项。✅

## 执行方式

- **subagent-driven**：每个任务一个 subagent，任务间做一次定向评审（这个仓库前几轮都是这么跑的）。
- **executing-plans**：我在本会话里逐条做，节奏慢一点但上下文连续。

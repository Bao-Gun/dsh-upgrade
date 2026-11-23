# dsh-upgrade 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 dsh web 加「升级」板块：检测并升级 DSH 本体与 profile 插件，装完复用 dsh-restart 预检+重启，重启回来后发 macOS 系统通知。

**Architecture:** 一个 DSH web 插件，两个入口。服务端（src/server/*）提供 /dsh-upgrade/api/* 四个端点和两个 agent 工具，负责本体升级（clonefile 备份 + npm i -g + 校验 + 回滚）与重启后通知。客户端（src/client/*）往底栏注入一颗图标并渲染两段面板；插件升级由页面内同源 fetch 调 dshmarket v1 API，预检/重启由页面调 dsh-restart。

**Tech Stack:** TypeScript + tsup（esm 服务端 / iife 客户端 / 无第三方运行期依赖）+ vitest + jsdom；HTTP 用 node:http 内建。

**Spec:** docs/superpowers/specs/2026-11-23-dsh-upgrade-design.md

## Global Constraints

- 运行期零第三方依赖；@deepseek-ai/* 一律 external。
- engines.node >= 22，engines.dsh ">=0.2.2-rc.5"；private: true、type: module。
- 产物固定两份：lib/index.js（esm/node）、lib/client.js（iife，banner 自注册 __ModuleLoader__）；不产 helper。
- 所有路径经 DSH_UPGRADE_ROOT 可覆盖，默认 ~/.dsh/dsh-upgrade；测试绝不写真实安装目录与真实 root。
- 服务端请求门：路径与方法精确匹配 + 头 x-dsh-upgrade: 1 + Origin 与 Host 一致，否则 403。
- 目标版本必须是 registry 里真实存在的版本号；不接受把 tag 名交给 npm。
- 面向用户的一切文案用中文；错误对象 { code, message }，code 用大写常量。
- 提交信息用中文，feat:/test:/fix:/docs:/chore: 前缀。

## Review Focus

最可能咬到人的五种情况，各自在对应任务的测试里钉住：

1. **engines.node 不满足仍被装上**：本机 node v26.7.0，alpha.2 要 ^24.22.3 || >=26.13.1。装之前必须拦，且要说出「需要 X，本机 Y」。（Task 2、Task 6、Task 9 各有一条）
2. **安装失败把安装目录留成半装状态**：1.3 GB / 95,699 文件，npm 中途失败必须整目录换回备份，而不是让 dsh 起不来。（Task 6）
3. **空间不足**：备份要再占 1.3 GB。装之前算空间，不足就拒绝，不能装一半。（Task 6）
4. **重复触发**：两次点击同时跑 npm 会互相踩。第二个请求必须 409 且不写盘。（Task 8）
5. **GitHub 限流 / 断网 / dsh-restart 缺失**：面板不能空白、升级不能被 changelog 拖住、重启这步缺失时要明说「需手动重启」。（Task 5、Task 8、Task 12）

---

### Task 1: 工程骨架与构建链

**Files:**
- Create: package.json, tsconfig.json, tsup.config.ts, vitest.config.ts
- Create: src/index.ts（空入口）, src/client/index.ts（占位）
- Create: test/package.test.ts
- Modify: check.sh 第 ④ 段

**Interfaces:**
- Produces: 构建产物 lib/index.js、lib/client.js；npm run build、npx tsc --noEmit、npm test 三条命令可用。

- [ ] **Step 1: 写失败的配置测试**（test/package.test.ts）

```ts
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('包声明了服务端与客户端入口', () => {
  expect(pkg.name).toBe('dsh-upgrade')
  expect(pkg.main).toBe('lib/index.js')
  expect(pkg.exports['.']).toBe('./lib/index.js')
  expect(pkg.exports['./client']).toBe('./lib/client.js')
  expect(pkg.dsh.client.platform).toBe('web')
  expect(pkg.dsh.client.immediately).toBe(true)
})

test('运行期没有第三方依赖', () => {
  expect(pkg.dependencies ?? {}).toEqual({})
})
```

- [ ] **Step 2: 跑一遍确认失败**

Run: npx vitest run test/package.test.ts
Expected: FAIL —— 找不到 package.json（或字段对不上）

- [ ] **Step 3: 建 package.json / tsconfig / tsup / vitest 配置**

package.json 字段：name dsh-upgrade、version 0.1.0、private true、type module、main lib/index.js、exports {".":"./lib/index.js","./client":"./lib/client.js","./package.json":"./package.json"}、dsh.client={platform:'web',immediately:true}、engines={node:'>=22',dsh:'>=0.2.2-rc.5'}、scripts build:"rm -rf lib && tsup"、test:"vitest run"、typecheck:"tsc --noEmit"；devDependencies 与 dsh-restart 同构（@types/node ^26.6.6、jsdom ^31.0.1、tsup ^9.0.0、typescript ^7.0.2、vitest ^5.1.1）。不写 dependencies 段（测试断言空对象）。

tsup.config.ts 两个 entry：src/index.ts → lib/index.js（format esm、platform node、external 全部 @deepseek-ai/*）、src/client/index.ts → lib/client.js（format iife、platform browser、banner 用外壳的 __ModuleLoader__ 自注册写法，与 dsh-restart 的 lib/client.js 头几行同形）。tsconfig.json 抄 dsh-restart（ES2022 / Bundler / strict / noUncheckedIndexedAccess / noEmit / include 含 src+test+配置文件）。

- [ ] **Step 4: 跑测试与构建**

Run: npx vitest run test/package.test.ts && npm run build && npx tsc --noEmit
Expected: 2 passed；lib/index.js 与 lib/client.js 都在；tsc 无输出

- [ ] **Step 5: 把 check.sh 第 ④ 段换成真命令**

删掉 ④ 段的两个 echo 与 fail=1，改成 npm run build || bad "构建失败"、npx tsc --noEmit || bad "类型检查失败"、npm test || bad "测试失败"。

- [ ] **Step 6: 提交**

```bash
git add package.json tsconfig.json tsup.config.ts vitest.config.ts src test check.sh
git commit -m "chore: 工程骨架（tsup 双产物 + vitest + check.sh 接上验收命令）"
```

---

### Task 2: 版本比较、通道判定与 engines 校验

**Files:**
- Create: src/server/versions.ts
- Test: test/versions.test.ts

**Interfaces:**
- Produces（后续任务按这些签名调用）：
  - type Channel = 'stable' | 'rc' | 'alpha'
  - parseVersion(v: string): { major: number; minor: number; patch: number; prerelease: string[] } | null
  - compareVersions(a: string, b: string): number（a>b 正数，相等 0，不可比抛 Error）
  - channelOf(v: string): Channel（含 -alpha. → alpha，含 -rc. → rc，否则 stable）
  - isNewer(candidate: string, current: string): boolean
  - pickNewest(candidates: string[], opts: { includePrerelease: boolean }): string | null
  - satisfiesNodeRange(range: string, current: string): boolean
  - describeEnginesFailure(range: string, current: string): string（中文一句：「需要 Node X，本机 Y」）

- [ ] **Step 1: 写失败的测试**（test/versions.test.ts）

```ts
import { describe, expect, test } from 'vitest'
import { channelOf, compareVersions, isNewer, pickNewest, satisfiesNodeRange, describeEnginesFailure } from '../src/server/versions.js'

describe('compareVersions', () => {
  test('按 semver 比较主次补丁', () => {
    expect(compareVersions('0.2.3', '0.2.2')).toBeGreaterThan(0)
    expect(compareVersions('0.2.2-rc.5', '0.2.2')).toBeLessThan(0)
  })
  test('预发布按标识符逐段比，数字段当数字', () => {
    expect(compareVersions('0.2.3-alpha.2', '0.2.3-alpha.1')).toBeGreaterThan(0)
    expect(compareVersions('0.2.3-alpha.10', '0.2.3-alpha.9')).toBeGreaterThan(0)
    expect(compareVersions('0.2.2-rc.5', '0.2.2-rc.4')).toBeGreaterThan(0)
  })
  test('相等', () => {
    expect(compareVersions('0.2.2-rc.5', '0.2.2-rc.5')).toBe(0)
  })
})

describe('channelOf', () => {
  test('三种通道', () => {
    expect(channelOf('0.2.2-rc.5')).toBe('rc')
    expect(channelOf('0.2.3-alpha.2')).toBe('alpha')
    expect(channelOf('0.2.2')).toBe('stable')
  })
})

describe('pickNewest', () => {
  const versions = ['0.2.1', '0.2.2-rc.5', '0.2.3-alpha.1', '0.2.3-alpha.2']
  test('不含预发布时只在稳定版里挑', () => {
    expect(pickNewest(versions, { includePrerelease: false })).toBe('0.2.1')
  })
  test('含预发布时挑全局最大', () => {
    expect(pickNewest(versions, { includePrerelease: true })).toBe('0.2.3-alpha.2')
  })
  test('空列表返回 null', () => {
    expect(pickNewest([], { includePrerelease: true })).toBeNull()
  })
})

describe('isNewer', () => {
  test('本机 0.2.2-rc.5 对 alpha.2 为真，对 rc.5 为假', () => {
    expect(isNewer('0.2.3-alpha.2', '0.2.2-rc.5')).toBe(true)
    expect(isNewer('0.2.2-rc.5', '0.2.2-rc.5')).toBe(false)
  })
})

describe('satisfiesNodeRange', () => {
  test('^ 与 >= 的或组合（alpha.2 的真实要求）', () => {
    const range = '^24.22.3 || >=26.13.1'
    expect(satisfiesNodeRange(range, '26.7.0')).toBe(false)   // 本机真实情况
    expect(satisfiesNodeRange(range, '26.13.1')).toBe(true)
    expect(satisfiesNodeRange(range, '24.22.3')).toBe(true)
    expect(satisfiesNodeRange(range, '24.23.0')).toBe(true)
    expect(satisfiesNodeRange(range, '27.0.0')).toBe(true)
    expect(satisfiesNodeRange(range, '24.22.2')).toBe(false)
  })
  test('>= 单条与空串', () => {
    expect(satisfiesNodeRange('>=22', '22.0.0')).toBe(true)
    expect(satisfiesNodeRange('>=22', '21.9.9')).toBe(false)
    expect(satisfiesNodeRange('', '20.0.0')).toBe(true)
  })
})

describe('describeEnginesFailure', () => {
  test('说清需要什么、本机是什么', () => {
    expect(describeEnginesFailure('^24.22.3 || >=26.13.1', '26.7.0')).toBe('需要 Node ^24.22.3 || >=26.13.1，本机 26.7.0')
  })
})
```

- [ ] **Step 2: 跑一遍确认失败**

Run: npx vitest run test/versions.test.ts
Expected: FAIL —— 无法解析 ../src/server/versions.js

- [ ] **Step 3: 实现 src/server/versions.ts**

compareVersions 按 semver 规则：先比主次补丁；再比预发布——无预发布的大于有预发布的；都有则逐段比，纯数字段按数值、其余按 ASCII，数字段小于字符串段，前缀相等时短的小。satisfiesNodeRange 用 || 切分，每段支持 ^、~、>=、>、<=、<、精确值，段内空白忽略、去 v 前缀；解析不了的范围按**满足**处理（宁可放行，也不因解析失败误拦），但 describeEnginesFailure 只在返回 false 时调用。

- [ ] **Step 4: 跑测试确认通过**

Run: npx vitest run test/versions.test.ts
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/server/versions.ts test/versions.test.ts
git commit -m "feat: semver 比较、通道判定与 engines.node 校验"
```

---

### Task 3: 状态目录（缓存 / 待通知 / 上次结果）

**Files:**
- Create: src/server/state.ts
- Test: test/state.test.ts

**Interfaces:**
- Produces:
  - rootDir(): string —— process.env.DSH_UPGRADE_ROOT 优先，否则 ~/.dsh/dsh-upgrade
  - type Cache = { registry?: { checkedAt: number; channels: Record<string,string|undefined>; versions: string[]; publishedAt: Record<string,string> }; releases?: { checkedAt: number; byVersion: Record<string, ReleaseEntry[]> } }
  - readCache(now: number, ttlMs?: number): Promise<Cache | null>（TTL 默认 6 小时，过期返回 null）
  - writeCache(delta: Partial<Cache>): Promise<void>
  - type Pending = { from: string; to: string; startedAt: number }
  - readPending() / writePending(p) / clearPending()
  - type Last = { running: boolean; lastResult?: { to: string; at: number; restartRequired: boolean }; lastError?: { code: string; message: string; at: number } }
  - readLast() / writeLast(patch: Partial<Last>)（浅合并）
  - backupDir(root: string, version: string): string → <root>/backup/<version>
  - ensureDir(path: string): Promise<void>

- [ ] **Step 1: 写失败的测试**（test/state.test.ts）

用 mkdtemp 建临时目录并 process.env.DSH_UPGRADE_ROOT = dir（每个 test 前设、后还原）。断言：rootDir() 取环境变量；写好 cache 后 readCache(now) 拿到、readCache(now + 6h + 1) 返回 null；writePending 后能读回、clearPending 后为 null；writeLast({running:true}) 后 writeLast({running:false}) 保留其它字段（浅合并）；缺文件时 readLast() 返回 null 而不是抛。

- [ ] **Step 2: 跑一遍确认失败**

Run: npx vitest run test/state.test.ts
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 src/server/state.ts**

读用 readFile + JSON.parse，任何异常（不存在、坏 JSON）一律返回 null；写用 ensureDir + 先写 <file>.tmp 再 rename（防半截文件）。writeCache 是浅合并 {...old, ...delta}，两个子对象各自整体替换。

- [ ] **Step 4: 跑测试确认通过**

Run: npx vitest run test/state.test.ts
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/server/state.ts test/state.test.ts
git commit -m "feat: 状态目录（缓存 TTL、待通知 marker、上次结果，原子写）"
```

---

### Task 4: 定位宿主安装目录、读版本、拉 registry

**Files:**
- Create: src/server/host.ts
- Test: test/host.test.ts

**Interfaces:**
- Produces:
  - type HostInfo = { dir: string; version: string }
  - findHostInstallDir(candidates?: string[]): string | null —— 候选顺序：process.argv[1] 的真身逐级上溯（最多 12 层）→ dirname(process.execPath)/../lib/node_modules/@deepseek-ai/dsh → /opt/homebrew/lib/node_modules/@deepseek-ai/dsh → /usr/local/lib/node_modules/@deepseek-ai/dsh；判定条件是该目录 package.json 的 name === '@deepseek-ai/dsh'
  - readHostInfo(dir?: string): Promise<HostInfo> —— 读不到就抛 Error('找不到 DSH 安装目录')
  - type RegistryInfo = { versions: string[]; channels: { latest?: string; next?: string; alpha?: string }; publishedAt: Record<string,string> }
  - fetchRegistry(opts: { force?: boolean; fetchImpl?: typeof fetch; now?: number }): Promise<{ info: RegistryInfo; cached: boolean }>（命中 cache 6 小时返回 cached: true）
  - readTargetManifest(target: string, fetchImpl?): Promise<{ engines?: { node?: string } }>

- [ ] **Step 1: 写失败的测试**（test/host.test.ts）

findHostInstallDir：在临时目录里建 a/lib/node_modules/@deepseek-ai/dsh/package.json（name 对），传该路径应命中；传一个只有空目录的候选应返回 null。
readHostInfo：临时目录 + 手写 package.json {"name":"@deepseek-ai/dsh","version":"0.2.2-rc.5"} → 返回该版本；目录不存在 → 抛错。
fetchRegistry：注入假 fetchImpl 返回 {"dist-tags":{latest:"0.2.2-rc.5",next:"0.2.2-rc.5",alpha:"0.2.3-alpha.2"},versions:{"0.2.2-rc.5":{},"0.2.3-alpha.2":{}},time:{"0.2.2-rc.5":"2026-11-18T13:17:23.604Z"}} → versions 是键数组、publishedAt 取自 time；第二次调用不再打 fetch（计数桩断言只被调 1 次）且 cached === true。
readTargetManifest('0.2.3-alpha.2')：假 fetch 返回 { engines: { node: '^24.22.3 || >=26.13.1' } } → 原样带回。

- [ ] **Step 2: 跑一遍确认失败**

Run: npx vitest run test/host.test.ts
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 src/server/host.ts**

registry 基址 https://registry.npmmirror.com（与 ~/.npmrc 一致），包名走 URL 编码 @deepseek-ai%2fdsh；超时 15 秒（AbortSignal.timeout）；非 200 抛错。上溯函数与 dsh-restart 的 compat.ts 同形：先 realpathSync 解软链，再逐级 dirname，每级读 package.json 校验 name。缓存读写走 Task 3。

- [ ] **Step 4: 跑测试确认通过**

Run: npx vitest run test/host.test.ts
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/server/host.ts test/host.test.ts
git commit -m "feat: 定位宿主安装目录、读当前版本、拉 registry 元数据（6 小时缓存）"
```

---

### Task 5: 更新内容（GitHub Releases 中文段，带降级）

**Files:**
- Create: src/server/releases.ts
- Test: test/releases.test.ts

**Interfaces:**
- Produces:
  - type ReleaseEntry = { version: string; channel: Channel; publishedAt: string; items: string[]; url: string }
  - extractChineseItems(body: string): string[]
  - fetchReleases(range: { from: string; to: string; fetchImpl?: typeof fetch; now?: number; timeoutMs?: number }): Promise<{ releases: ReleaseEntry[]; degraded: boolean }>
  - 端点：https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=30，筛 tag_name 以 dsh-v 开头、版本在 (from, to] 区间，按新→旧排序

- [ ] **Step 1: 写失败的测试**（test/releases.test.ts）

extractChineseItems：喂真 release 正文（中文段 <h3 id="cn-v0.2.3-alpha.2">其他变更</h3> + 一条 "- 调整 Node.js 版本要求为 24.22.3，26.13.1 及以上版本。 @imccyu"）→ 返回 ['其他变更', '调整 Node.js 版本要求为 24.22.3，26.13.1 及以上版本。 @imccyu']（标题保留为一行）；无 cn- 标记的正文 → 返回空数组。
fetchReleases：假 fetch 返回三条 release（alpha.2 / alpha.1 / rc.5），from='0.2.2-rc.5'、to='0.2.3-alpha.2' → 返回两条（alpha.2、alpha.1），新→旧，degraded === false；假 fetch 抛错 → degraded === true 且仍返回区间内版本。
防「升级被 changelog 拖住」的断言：fetchImpl 是永不 resolve 的 Promise 时，传 timeoutMs: 50 应在 200 ms 内返回 degraded: true。

- [ ] **Step 2: 跑一遍确认失败**

Run: npx vitest run test/releases.test.ts
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 src/server/releases.ts**

区间判定用 Task 2 的 compareVersions（(from, to]：c > from && c <= to）。中文段截取用正则 /<h3[^>]*id="cn-[^"]*"[^>]*>([\s\S]*?)(?=<h3[^>]*id="en-|$)/；随后把 </h3>、<li> 换成换行，<[^>]+> 删掉，反转义 &amp; &lt; &gt; &quot; &#39;，再按行切、去空白、丢空行。超时用 AbortSignal.timeout(timeoutMs ?? 8000)，异常统一降级。

- [ ] **Step 4: 跑测试确认通过**

Run: npx vitest run test/releases.test.ts
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/server/releases.ts test/releases.test.ts
git commit -m "feat: 从 GitHub Releases 取更新内容（只取中文段，超时与失败降级）"
```

---

### Task 6: 升级状态机（备份 → 安装 → 校验 → 回滚）

**Files:**
- Create: src/server/upgrade.ts
- Test: test/upgrade.test.ts

**Interfaces:**
- Produces:
  - type UpgradePhase = 'precheck' | 'backup' | 'install' | 'verify' | 'rollback' | 'done' | 'fail'
  - type UpgradeEvent = { phase: UpgradePhase; message: string; done?: boolean; error?: { code: string; message: string } }
  - type UpgradeDeps = { statfs(p): Promise<{bavail:number;bsize:number}>; cloneDir(src,dst): Promise<void>; removeDir(p): Promise<void>; moveDir(src,dst): Promise<void>; runNpmInstall(target, timeoutMs): Promise<{code:number;stdout:string;stderr:string}>; readInstalledVersion(dir): Promise<string|null>; runVersionProbe(dir): Promise<string|null>; readTargetEngines(version): Promise<string|null>; nodeVersion(): string }
  - runUpgrade(input: { target: string; installDir: string; root: string; deps?: Partial<UpgradeDeps> }, emit: (e: UpgradeEvent) => void): Promise<{ ok: boolean; rolledBack?: boolean; error?: { code: string; message: string } }>
  - 错误码：RUNTIME_UNSUPPORTED、NO_SPACE、INSTALL_FAILED、VERSION_MISMATCH、ROLLBACK_FAILED

- [ ] **Step 1: 写失败的测试**（test/upgrade.test.ts）

全部注入假 deps（临时目录当 installDir，假 readInstalledVersion/runVersionProbe/runNpmInstall），把 events 的 phase 收集成数组断言顺序。五条关键断言：

1. engines 不满足时不备份不动盘：readTargetEngines 返回 '^24.22.3 || >=26.13.1'、nodeVersion 返回 '26.7.0' → 结果 {ok:false, error.code:'RUNTIME_UNSUPPORTED'}，phases 只有 ['precheck','fail']，cloneDir 与 runNpmInstall 都没被调用。
2. 空间不足时不安装：statfs 返回剩余 1 GB → error.code === 'NO_SPACE'，没调 runNpmInstall。
3. npm 失败要整目录换回：runNpmInstall 返回 {code:1, stderr:'EACCES'} → {ok:false, rolledBack:true}，phases 含 rollback，removeDir(installDir) 与 moveDir(backup, installDir) 各一次。
4. 装完版本不符也算失败并回滚：readInstalledVersion 返回 '0.2.2-rc.5'（没变）→ error.code === 'VERSION_MISMATCH'、rolledBack: true；runVersionProbe 返回 null（跑不起来）同样回滚。
5. 成功路径：三步正常 → {ok:true}，removeDir(backup) 被调用一次，phases 顺序为 precheck → backup → install → verify → done。

- [ ] **Step 2: 跑一遍确认失败**

Run: npx vitest run test/upgrade.test.ts
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 src/server/upgrade.ts**

默认 deps 用 node: 内建：statfs（fs.promises.statfs，可用空间 = bavail * bsize，要求 ≥ 2500 * 1024 * 1024 字节）、cloneDir = spawn('cp', ['-c','-R',src,dst])（失败回退 cp -R）、removeDir = rm -rf、moveDir = rename（跨设备回退 cp -R + rm -rf）、runNpmInstall = spawn('npm', ['i','-g','@deepseek-ai/dsh@'+target], { cwd: tmpdir() }) 15 分钟超时、runVersionProbe = spawn(process.execPath, [join(dir,'lib','bin.js'),'--version']) 60 秒超时取首行 trim、readInstalledVersion 读 package.json。nodeVersion 用 process.versions.node。备份目录用 backupDir(root, from)，from 从 readInstalledVersion 得到。回滚顺序固定：removeDir(installDir) → moveDir(backup, installDir)；回滚本身失败时 error.code 改 ROLLBACK_FAILED、message 里带两条原始错误。

- [ ] **Step 4: 跑测试确认通过**

Run: npx vitest run test/upgrade.test.ts
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/server/upgrade.ts test/upgrade.test.ts
git commit -m "feat: 升级状态机（engines/空间前置校验、clonefile 备份、失败整目录回滚）"
```

---

### Task 7: 待通知 marker 与系统通知

**Files:**
- Create: src/server/notify.ts
- Test: test/notify.test.ts

**Interfaces:**
- Produces:
  - markPending(from: string, to: string, now?: number): Promise<void>
  - resolvePending(current: string, now?: number): Promise<'notify' | 'wait' | 'clear' | 'none'>
  - notifyUpgraded(to: string, deps?: Partial<NotifyDeps>): Promise<boolean>
  - settlePending(current: string, now?: number, deps?: Partial<NotifyDeps>): Promise<void>
  - type NotifyDeps = { runOsascript(script: string): Promise<boolean> }

- [ ] **Step 1: 写失败的测试**（test/notify.test.ts）

用 Task 3 的临时 DSH_UPGRADE_ROOT。断言：markPending('0.2.2-rc.5','0.2.3-alpha.2') 后 resolvePending('0.2.3-alpha.2') 返回 notify、resolvePending('0.2.2-rc.5') 返回 wait；7 天后同一 marker → clear；无关版本 → clear；无 marker → none。settlePending 在 notify 分支调用注入的 runOsascript 一次，脚本里含目标版本字符串，之后 marker 被清、第二次调用返回 none（不重复通知）。runOsascript 抛错时 settlePending 不抛，但 marker 仍被清。

- [ ] **Step 2: 跑一遍确认失败**

Run: npx vitest run test/notify.test.ts
Expected: FAIL

- [ ] **Step 3: 实现 src/server/notify.ts**

默认 runOsascript：spawn('osascript', ['-e', script])，脚本形如 display notification "已升级到 0.2.3-alpha.2，进程已重启" with title "DSH 已升级"（正文双引号先转义）；非 0 退出返回 false。settlePending 用 try/finally 保证 marker 一定被清。

- [ ] **Step 4: 跑测试确认通过**

Run: npx vitest run test/notify.test.ts
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/server/notify.ts test/notify.test.ts
git commit -m "feat: 重启后系统通知（marker 生命周期 + osascript，失败不阻塞加载）"
```

---

### Task 8: HTTP 路由（请求门、NDJSON 进度、单飞锁）

**Files:**
- Create: src/server/routes.ts
- Test: test/routes.test.ts

**Interfaces:**
- Consumes：Task 2/3/4/5/6/7 的导出。
- Produces:
  - registerUpgradeRoutes(ctx: { route?: (method: string, path: string, handler: RouteHandler) => void; router?: any }): void
  - type RouteHandler = (req: { method: string; headers: Record<string,string|undefined>; url: string; body?: unknown }, res: RouteResponse) => Promise<void> | void
  - type RouteResponse = { status(code: number): RouteResponse; header(k: string, v: string): RouteResponse; write(chunk: string): void; end(body?: string): void }
  - 端点：GET /dsh-upgrade/api/status、POST /dsh-upgrade/api/check、GET /dsh-upgrade/api/releases、POST /dsh-upgrade/api/upgrade
  - checkGate(req, origin?, host?): boolean
  - 单飞：模块级 let running = false，第二请求 409 { code: 'BUSY' }

- [ ] **Step 1: 写失败的测试**（test/routes.test.ts）

用假 ctx 收集路由表（{method, path, handler}），直接调用 handler，用假 req/res 记录 status/body/写出分块。断言：
1. 缺 x-dsh-upgrade: 1 → 403，且 body 不含内部路径；Origin 与 Host 不一致 → 403。
2. GET status 正常 → 200，body 含 current、channels。
3. POST upgrade 正常 → 写出多行 JSON（每行可 JSON.parse），最后一行 done: true。BUSY：第一个 handler 的 Promise 未结束时再发一个 → 409 且假升级只被调 1 次。
4. GET releases 在 fetchReleases 降级时 → 200 且 degraded: true，不是 500。

- [ ] **Step 2: 跑一遍确认失败**

Run: npx vitest run test/routes.test.ts
Expected: FAIL

- [ ] **Step 3: 实现 src/server/routes.ts**

路由注册优先用 ctx.route；没有就退回 ctx.router 上能用的注册方式（实现时照抄 dsh-restart 的接线处）。upgrade handler：running 置位并 try/finally 复位；emit 把 UpgradeEvent 序列化成 JSON.stringify(e) + 换行写出；成功后 writeLast({ running:false, lastResult })。

- [ ] **Step 4: 跑测试确认通过**

Run: npx vitest run test/routes.test.ts
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/server/routes.ts test/routes.test.ts
git commit -m "feat: 四个 HTTP 端点（同源请求门、NDJSON 进度、单飞锁）"
```

---

### Task 9: agent 工具与插件入口

**Files:**
- Create: src/server/tools.ts
- Modify: src/index.ts（真实入口）
- Test: test/tools.test.ts

**Interfaces:**
- Produces:
  - dshUpgradeCheck(input: { includePrerelease?: boolean }, deps?): Promise<{ current: string; channels: Record<string,string|undefined>; target: string | null; blocked?: { code: 'RUNTIME_UNSUPPORTED'; message: string } }>
  - dshUpgrade(input: { target: string }, deps?): Promise<{ ok: boolean; to?: string; backup?: string; restartRequired?: boolean; error?: { code: string; message: string } }>
  - src/index.ts 默认导出插件对象：name 'dsh-upgrade'，apply(ctx) 做三件事——注册路由、注册两个工具、settlePending(readHostInfo().version)（失败只记日志）

- [ ] **Step 1: 写失败的测试**（test/tools.test.ts）

dshUpgradeCheck：注入假 host/registry（当前 0.2.2-rc.5、alpha 0.2.3-alpha.2、engines 要 ^24.22.3 || >=26.13.1、node 26.7.0）→ target === '0.2.2-rc.5'（稳定通道无新版）且 blocked.code === 'RUNTIME_UNSUPPORTED'（指 alpha）；includePrerelease: true 时 target === '0.2.3-alpha.2' 且仍带 blocked。
dshUpgrade：目标是被拦版本 → {ok:false, error.code:'RUNTIME_UNSUPPORTED'} 且没调安装；正常版本 → {ok:true, restartRequired:true}。
注册：假 ctx 断言注册了 dsh_upgrade_check、dsh_upgrade 两个名字，且 parameters 是合法 JSON Schema（含 properties.target 之类）。

- [ ] **Step 2: 跑一遍确认失败**

Run: npx vitest run test/tools.test.ts
Expected: FAIL

- [ ] **Step 3: 实现 src/server/tools.ts 与 src/index.ts**

工具描述用中文，dsh_upgrade 的描述里写明「不自动重启，重启请用 dsh_restart」。工具注册照抄 dsh-restart 的调用点（ctx.tool 或 ctx.agent 之类的实际签名）。

- [ ] **Step 4: 跑测试确认通过**

Run: npx vitest run test/tools.test.ts
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/server/tools.ts src/index.ts test/tools.test.ts
git commit -m "feat: agent 工具 dsh_upgrade_check / dsh_upgrade 与插件入口接线"
```

---

### Task 10: 客户端 dshmarket 适配层

**Files:**
- Create: src/client/market.ts
- Test: test/market.test.ts

**Interfaces:**
- Produces:
  - type PluginUpdate = { name: string; from: string; to: string; publishedAt?: string; repo?: string }
  - fetchPluginUpdates(fetchImpl?: typeof fetch, base?: string): Promise<{ available: boolean; updatable: PluginUpdate[] }>
  - startPluginUpdate(name: string, fetchImpl?): Promise<{ operationId: string }>
  - pollPluginOperation(operationId: string, fetchImpl?): Promise<{ status: 'queued'|'running'|'succeeded'|'failed'|'rolled-back'|'cancelled'; restartRequired: boolean; message?: string }>
  - 常量 SUMMARY='/dsh-market/api/v1/updates/summary'、UPDATES='/dsh-market/api/v1/updates'、OPERATIONS='/dsh-market/api/v1/operations'

- [ ] **Step 1: 写失败的测试**（test/market.test.ts）

假 fetch 按 URL 分派。断言：summary 返回 {packages:[{name:'dsh-better-sidebar', installedVersion:'0.32.1', latestVersion:'0.32.4', publishedAt:'2026-11-20T00:00:00Z'}]} → updatable[0] = {name, from:'0.32.1', to:'0.32.4'}、available: true。401（{error:'需要先登录 DSH'}）→ {available:false, updatable:[]} 且不抛。字段缺失（只有 name）→ 跳过该条而不是崩。startPluginUpdate 断言 POST body 是 {packageName:name} 且取回 operationId；pollPluginOperation 把 succeeded / rolled-back 与 restartRequired 原样带回。

- [ ] **Step 2: 跑一遍确认失败**

Run: npx vitest run test/market.test.ts
Expected: FAIL

- [ ] **Step 3: 实现 src/client/market.ts**

所有请求 credentials: 'same-origin'、Accept: application/json；任何非 2xx 或解析失败都收敛成 available:false，绝不抛到 UI。

- [ ] **Step 4: 跑测试确认通过**

Run: npx vitest run test/market.test.ts
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/client/market.ts test/market.test.ts
git commit -m "feat: 客户端 dshmarket v1 适配层（summary/updates/operations，失败一律降级）"
```

---

### Task 11: 底栏图标注入

**Files:**
- Create: src/client/inject.ts
- Test: test/inject.test.ts（文件顶写 // @vitest-environment jsdom）

**Interfaces:**
- Produces:
  - const MARK = 'data-dshu-entry'
  - mountFooterEntry(doc: Document, hooks: { onOpen(): void }): () => void（返回卸载函数）
  - setEntryState(doc: Document, state: { hasUpdate: boolean; busy: boolean }): void
  - 三级退路：① 插到 [data-dshm-footer-group] 之后 ② 找不到就 [data-slot="sidebar.footer.action"] 尾部 ③ 都没有就追加到 [data-slot="settings.launcher"] 所在行末尾

- [ ] **Step 1: 写失败的测试**（test/inject.test.ts）

三种 DOM 各建一次，断言元素落在正确父节点：有 data-dshm-footer-group 时新节点是它的 nextElementSibling；只有 sidebar.footer.action 时是它的 lastElementChild；两者都空但有 settings.launcher 行时追加到那行。外壳重渲染（footer.innerHTML = ''，等一拍）后图标重新出现且页面上只有一个。点击调用一次 onOpen。setEntryState({hasUpdate:true}) 后元素带 data-has-update="1"；{hasUpdate:false} 后属性消失。

- [ ] **Step 2: 跑一遍确认失败**

Run: npx vitest run test/inject.test.ts
Expected: FAIL

- [ ] **Step 3: 实现 src/client/inject.ts**

按钮做成 button.dshu-entry，内含 span.dshu-dot（角标）。样式用注入 <style> 一次（按 id 判重）。MutationObserver 观察 document.body 的 childList/subtree，回调用 requestAnimationFrame 合并；卸载函数 disconnect 并移除节点与样式。

- [ ] **Step 4: 跑测试确认通过**

Run: npx vitest run test/inject.test.ts
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/client/inject.ts test/inject.test.ts
git commit -m "feat: 底栏图标注入（三级退路 + MutationObserver 补挂 + 角标状态）"
```

---

### Task 12: 面板 UI 与客户端入口

**Files:**
- Create: src/client/panel.ts
- Modify: src/client/index.ts（真实入口）
- Test: test/panel.test.ts

**Interfaces:**
- Consumes：Task 10 的 fetchPluginUpdates/startPluginUpdate/pollPluginOperation、Task 11 的 mountFooterEntry/setEntryState。
- Produces:
  - openPanel(doc: Document, opts: { apiBase?: string; onClose?(): void }): Promise<void>
  - 面板 DOM 契约（测试按这些选择器断言）：.dshu-panel、.dshu-section[data-k="host"]、.dshu-section[data-k="plugins"]、.dshu-release（更新内容折叠）、.dshu-progress（进度区）、.dshu-error（红条）
  - 固定文案：无更新显示「已是最新」；engines 被拦的按钮文案含「需要 Node」；插件段不可用显示「插件更新不可用」

- [ ] **Step 1: 写失败的测试**（test/panel.test.ts）

注入假 api 后打开面板，断言：两个 section 都在；本体段含当前版本与目标版本；有更新内容时 .dshu-release 存在且有 button 折叠头；engines 被拦时升级按钮 disabled === true 且文案含「需要 Node」。无更新时（target 等于 current）本体段出现「已是最新」且按钮消失但 section 仍在。market 返回 available:false 时插件段出现「插件更新不可用」。进度流：假升级 API 依次写出 {"phase":"backup"}、{"phase":"done","done":true} → 面板文本最终含「完成」或「已升级」，且 .dshu-error 不存在。

- [ ] **Step 2: 跑一遍确认失败**

Run: npx vitest run test/panel.test.ts
Expected: FAIL

- [ ] **Step 3: 实现 src/client/panel.ts 与 src/client/index.ts**

面板用遮罩层 + 关闭逻辑（与 dsh-restart 的 dialog.ts 同形，实现时照抄它的遮罩与关闭）。client/index.ts：mountFooterEntry + 首次静默 fetch status（非强制）→ 有更新就 setEntryState({hasUpdate:true})；onOpen 里 openPanel。升级流程：POST /dsh-upgrade/api/upgrade 读 NDJSON 流 → 完成后若 /dsh-restart/api/status 可用就 POST /dsh-restart/api/precheck（NDJSON）→ 通过则 POST /dsh-restart/api/restart；任一步 404 就显示「已升级到 x，需手动重启」。

- [ ] **Step 4: 跑测试确认通过**

Run: npx vitest run test/panel.test.ts
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/client/panel.ts src/client/index.ts test/panel.test.ts
git commit -m "feat: 两段面板（本体/插件、更新内容折叠、NDJSON 进度、缺 dsh-restart 时降级）"
```

---

### Task 13: 安装脚本与文档

**Files:**
- Create: scripts/install.mjs
- Modify: docs/architecture.md、docs/gotchas.md、AGENTS.md
- Test: 手工跑 dry-run

**Interfaces:**
- Produces: node scripts/install.mjs（dry-run 打印将做的改动）、--apply（软链进 ~/.dsh/profiles/web/node_modules/dsh-upgrade 并改 profile 的 cordis patch）、--verify（临时 DSH_HOME 里重做并探 /dsh-upgrade/api/status 200）。

- [ ] **Step 1: 照 dsh-restart 的 scripts/install.mjs 写同构版本**

常量换成 PLUGIN_NAME='dsh-upgrade'、PLUGIN_ID='upgrade-button'、STATUS_ROUTE='/dsh-upgrade/api/status'、REQUIRED_ARTIFACTS=['lib/index.js','lib/client.js']（没有 helper）。

- [ ] **Step 2: 跑 dry-run 看改动项**

Run: node scripts/install.mjs
Expected: 列出「会建软链 / 会改 patch」两类改动，不写盘

- [ ] **Step 3: 更新文档**

docs/architecture.md 模块表按 12 个文件逐行写、数据流写成「浏览器 ↔ 服务端 ↔ registry/GitHub ↔ dsh-restart」四段；docs/gotchas.md 追加第一条：engines.node 是本机升级 alpha 的真门槛——v26.7.0 不满足 ^24.22.3 || >=26.13.1，升级前必须校验，否则装上去起不来；AGENTS.md 的启动命令补成 node scripts/install.mjs --apply。

- [ ] **Step 4: 跑 check.sh 必须全绿**

Run: bash check.sh
Expected: ✓ 全部通过

- [ ] **Step 5: 提交**

```bash
git add scripts/install.mjs docs AGENTS.md
git commit -m "feat: 安装脚本（dry-run/--apply/--verify）+ 文档补模块表与第一条坑"
```

---

### Task 14: 端到端人工验收（不写真实安装目录）

**Files:**
- Create: .work/e2e-check.md（不提交，.work/ 已在 .gitignore）

- [ ] **Step 1: 用假 npm 跑完整进度流**：临时 DSH_UPGRADE_ROOT + 把 runNpmInstall 换成 npm view @deepseek-ai/dsh version 的包装，从面板点「升级」→ 观察 NDJSON 六行 → 确认备份目录建了又删、安装目录未被动。
- [ ] **Step 2: 验证 engines 拦截**：目标改成 0.2.3-alpha.2，确认按钮置灰且文案含「需要 Node」与本机版本。
- [ ] **Step 3: 验证 dsh-restart 缺失降级**：临时改名软链，确认装完显示「已升级到 x，需手动重启」而不是报错。
- [ ] **Step 4: 结论写进 .work/e2e-check.md**，必要的坑追加到 docs/gotchas.md（单独一次 docs 提交）。

---

## 计划自检

- 规格覆盖：§3 用户行为 → Task 11/12；§4 模块表 → Task 1–12 一一对应；§6 端点 → Task 8；§7 工具 → Task 9；§8 状态机 → Task 6；§9 状态文件与通知 → Task 3/7；§10 降级 → Task 5（changelog 超时）、Task 8（BUSY 与 releases 降级）、Task 9（engines）、Task 12（dsh-restart 缺失）；§11 测试与 check.sh → Task 1/13；§12 风险 → Review Focus 五条各有测试。
- 类型一致：Channel 只在 Task 2 定义、Task 5 引用；ReleaseEntry 在 Task 3 与 Task 5 同形；UpgradeEvent.phase 与 Task 8 的 NDJSON 字段一致；setEntryState 的入参形状在 Task 11 定义、Task 12 使用。
- 比例：每任务 5 步左右，代码块只给测试与配置，不给实现正文。

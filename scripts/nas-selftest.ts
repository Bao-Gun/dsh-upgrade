/**
 * NAS / Linux 真机自测：在沙箱前缀里真跑两次 runUpgrade。
 *
 * 场景 A（成功升级）：把沙箱里的旧版本真的升到 target —— 真 cp 备份、真 npm 安装、真跑 --version 探针、成功后删备份。
 * 场景 B（失败回滚）：同一份安装再升一次，但注入一个永远返回错版本的探针，断言拿到 VERSION_MISMATCH + rolledBack，
 *              沙箱目录回到场景 A 之后的版本，备份不残留。
 *
 * 只碰 --prefix 指定的沙箱，绝不碰线上安装目录。用 tsx 直接跑 TS 源码——lib 产物是打包过的单文件，导不出 runUpgrade。
 *
 * 用法：
 *   npx --yes tsx scripts/nas-selftest.ts --prefix ~/.dshup-sandbox --target 0.2.2-rc.5
 * 退出码：0 = 两个场景都符合预期；1 = 有断言不符；2 = 用法或沙箱没准备好（JSON 里写清了是哪一条）。
 */
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { runUpgrade, type UpgradeEvent } from '../src/server/upgrade'

type Args = { prefix: string; root: string; target: string }

function parseArgs(argv: string[]): Args | string {
  const seen = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === undefined || value === undefined) return '参数要成对出现：--prefix <dir> --target <version>'
    seen.set(key, value)
  }
  const target = seen.get('--target')
  if (target === undefined || target === '') return '缺少 --target <version>'
  const prefix = resolve(seen.get('--prefix') ?? join(homedir(), '.dshup-sandbox'))
  return { prefix, root: resolve(seen.get('--root') ?? join(prefix, 'selftest-root')), target }
}

const installDirIn = (prefix: string): string =>
  join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh')

async function versionIn(dir: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const version = (parsed as Record<string, unknown>)['version']
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

/** 备份目录是 <root>/backup/<version>：收尾时这里必须是空的。 */
async function leftoverBackups(root: string): Promise<string[]> {
  try {
    return await readdir(join(root, 'backup'))
  } catch {
    return []
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (typeof args === 'string') {
    console.error(args)
    return 2
  }

  const installDir = installDirIn(args.prefix)
  const from = await versionIn(installDir)
  if (from === null) {
    console.error(`沙箱里没有安装：${installDir}`)
    console.error(`先造一个旧版本：npm i -g --prefix ${args.prefix} @deepseek-ai/dsh@<旧版本>` )
    return 2
  }

  const events: UpgradeEvent[] = []
  const log = (event: UpgradeEvent): void => {
    events.push(event)
    console.log(`[${event.phase}] ${event.message ?? ''}`)
  }

  console.log(`沙箱：${installDir}（当前 ${from} → 目标 ${args.target}）`)

  // 场景 A：真升一次
  const a = await runUpgrade({ target: args.target, installDir, root: args.root }, log)
  const afterA = await versionIn(installDir)
  const backupsA = await leftoverBackups(args.root)
  const aOk = a.ok && afterA === args.target && backupsA.length === 0

  // 场景 B：探针永远报错版本 ⇒ 必须回滚到 A 之后的版本
  const b = await runUpgrade(
    { target: args.target, installDir, root: args.root, deps: { runVersionProbe: async () => '0.0.0-rollback-probe' } },
    log,
  )
  const afterB = await versionIn(installDir)
  const backupsB = await leftoverBackups(args.root)
  const bOk =
    b.ok === false &&
    b.error?.code === 'VERSION_MISMATCH' &&
    b.rolledBack === true &&
    afterB === afterA &&
    backupsB.length === 0

  console.log(
    JSON.stringify(
      {
        ok: aOk && bOk,
        sandbox: { prefix: args.prefix, root: args.root, installDir },
        upgrade: { from, target: args.target, ok: a.ok, versionAfter: afterA, backupsLeft: backupsA, events: events.length },
        rollback: {
          ok: b.ok,
          code: b.error?.code ?? null,
          rolledBack: b.rolledBack ?? null,
          versionAfter: afterB,
          backupsLeft: backupsB,
        },
      },
      null,
      2,
    ),
  )
  return aOk && bOk ? 0 : 1
}

void main().then((code) => {
  process.exitCode = code
})
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, statfs as nodeStatfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readTargetManifest } from './host'
import { npmBin, npmEnv, npmPrefixOf } from './npm'
import { backupDir } from './state'
import { describeEnginesFailure, satisfiesNodeRange } from './versions'

export type UpgradePhase =
  | 'precheck'
  | 'backup'
  | 'install'
  | 'verify'
  | 'rollback'
  | 'done'
  | 'fail'

export type UpgradeEvent = {
  phase: UpgradePhase
  message: string
  done?: boolean
  error?: { code: string; message: string }
}

export type UpgradeDeps = {
  statfs(p: string): Promise<{ bavail: number; bsize: number }>
  cloneDir(src: string, dst: string): Promise<void>
  removeDir(p: string): Promise<void>
  moveDir(src: string, dst: string): Promise<void>
  runNpmInstall(
    target: string,
    prefix: string,
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string }>
  readInstalledVersion(dir: string): Promise<string | null>
  runVersionProbe(dir: string): Promise<string | null>
  readTargetEngines(version: string): Promise<string | null>
  nodeVersion(): string
}

/** 状态机自己的判定：code 大写，message 中文。 */
type CodedError = { code: string; message: string }

type RunResult = { code: number; stdout: string; stderr: string }

const MIN_FREE_BYTES = 2500 * 1024 * 1024
const NPM_TIMEOUT_MS = 15 * 60 * 1000
const PROBE_TIMEOUT_MS = 60 * 1000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** spawn 一个命令；超时直接 SIGKILL，返回非 0 退出码而不是抛错。 */
function run(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const spawnOptions: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
    if (options.cwd !== undefined) spawnOptions.cwd = options.cwd
    if (options.env !== undefined) spawnOptions.env = options.env
    const child = spawn(command, args, spawnOptions)

    const finish = (code: number): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }

    if (child.stdout !== null) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
    }
    if (child.stderr !== null) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })
    }

    child.on('error', (error) => {
      stderr += stderr === '' ? error.message : `\n${error.message}`
      finish(-1)
    })
    child.on('close', (code) => finish(code ?? -1))

    if (options.timeoutMs !== undefined) {
      const timeoutMs = options.timeoutMs
      timer = setTimeout(() => {
        const note = `命令超时（${timeoutMs} ms）`
        stderr += stderr === '' ? note : `\n${note}`
        child.kill('SIGKILL')
        finish(-1)
      }, timeoutMs)
      timer.unref()
    }
  })
}

async function statfsOf(path: string): Promise<{ bavail: number; bsize: number }> {
  const stats = await nodeStatfs(path)
  return { bavail: Number(stats.bavail), bsize: Number(stats.bsize) }
}

/**
 * APFS 上 cp -c 是秒级 clonefile；不支持时退回真复制。
 * 目标目录先删掉，避免残留目录把 cp 变成「往目录里再套一层」。
 */
async function cloneDirDefault(src: string, dst: string): Promise<void> {
  await mkdir(dirname(dst), { recursive: true })
  await rm(dst, { recursive: true, force: true })
  const cloned = await run('cp', ['-c', '-R', src, dst])
  if (cloned.code === 0) return
  await rm(dst, { recursive: true, force: true })
  const copied = await run('cp', ['-R', src, dst])
  if (copied.code !== 0) {
    throw new Error(copied.stderr.trim() === '' ? '复制安装目录失败' : copied.stderr.trim())
  }
}

/** 同盘 rename 是原子的；跨设备（EXDEV）才退回复制 + 删源。 */
async function moveDirDefault(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }
  await mkdir(dirname(dst), { recursive: true })
  const copied = await run('cp', ['-R', src, dst])
  if (copied.code !== 0) {
    throw new Error(copied.stderr.trim() === '' ? '移动安装目录失败' : copied.stderr.trim())
  }
  await rm(src, { recursive: true, force: true })
}

async function readPackageVersion(dir: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const version = (parsed as Record<string, unknown>)['version']
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

async function runProbe(dir: string): Promise<string | null> {
  const result = await run(process.execPath, [join(dir, 'lib', 'bin.js'), '--version'], {
    timeoutMs: PROBE_TIMEOUT_MS,
  })
  if (result.code !== 0) return null
  const first = result.stdout.split('\n')[0]?.trim() ?? ''
  return first === '' ? null : first
}

function npmInstall(target: string, prefix: string, timeoutMs: number): Promise<RunResult> {
  const nodeDir = dirname(process.execPath)
  // --prefix 必须显式给：让 npm 自己决定会在 NAS 上装到 ~/.local（原因见 npmPrefixOf）。
  // npm 用绝对路径、PATH 补 node 目录，因为 systemd 用户服务拉起的进程未必带着它们。
  // cwd 用临时目录：不在安装目录里跑 npm，免得 cwd 被删/搬走
  return run(npmBin(nodeDir, existsSync), ['i', '-g', '--prefix', prefix, `@deepseek-ai/dsh@${target}`], {
    cwd: tmpdir(),
    timeoutMs,
    env: npmEnv(process.env, nodeDir),
  })
}

async function targetEngines(version: string): Promise<string | null> {
  const manifest = await readTargetManifest(version)
  return manifest.engines?.node ?? null
}

const defaultDeps: UpgradeDeps = {
  statfs: statfsOf,
  cloneDir: cloneDirDefault,
  removeDir: async (path) => {
    await rm(path, { recursive: true, force: true })
  },
  moveDir: moveDirDefault,
  runNpmInstall: npmInstall,
  readInstalledVersion: readPackageVersion,
  runVersionProbe: runProbe,
  readTargetEngines: targetEngines,
  nodeVersion: () => process.versions.node,
}

/** 只覆盖确实传进来的 dep；显式传 undefined 也退回默认实现。 */
function mergeDeps(overrides?: Partial<UpgradeDeps>): UpgradeDeps {
  return {
    statfs: overrides?.statfs ?? defaultDeps.statfs,
    cloneDir: overrides?.cloneDir ?? defaultDeps.cloneDir,
    removeDir: overrides?.removeDir ?? defaultDeps.removeDir,
    moveDir: overrides?.moveDir ?? defaultDeps.moveDir,
    runNpmInstall: overrides?.runNpmInstall ?? defaultDeps.runNpmInstall,
    readInstalledVersion: overrides?.readInstalledVersion ?? defaultDeps.readInstalledVersion,
    runVersionProbe: overrides?.runVersionProbe ?? defaultDeps.runVersionProbe,
    readTargetEngines: overrides?.readTargetEngines ?? defaultDeps.readTargetEngines,
    nodeVersion: overrides?.nodeVersion ?? defaultDeps.nodeVersion,
  }
}

function describeFree(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知'
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

type UpgradeResult = { ok: boolean; rolledBack?: boolean; error?: CodedError }

/**
 * 升级状态机：engines/空间校验 → clonefile 备份 → npm 全局安装 → 版本校验 → 失败整目录回滚。
 * 只做编排：状态读写（Task 7）、HTTP（Task 8）都不在这里，所有副作用经 UpgradeDeps。
 */
export async function runUpgrade(
  input: { target: string; installDir: string; root: string; deps?: Partial<UpgradeDeps> },
  emit: (event: UpgradeEvent) => void,
): Promise<UpgradeResult> {
  const { target, installDir, root } = input
  const deps = mergeDeps(input.deps)

  const fail = (
    error: CodedError,
    options: { rolledBack?: boolean; message?: string } = {},
  ): UpgradeResult => {
    emit({ phase: 'fail', message: options.message ?? error.message, done: true, error })
    return options.rolledBack === undefined
      ? { ok: false, error }
      : { ok: false, rolledBack: options.rolledBack, error }
  }

  emit({ phase: 'precheck', message: '检查 Node 版本与磁盘可用空间' })

  const node = deps.nodeVersion()

  let engines: string | null
  try {
    engines = await deps.readTargetEngines(target)
  } catch (error) {
    return fail({ code: 'INSTALL_FAILED', message: `读取目标版本的 engines 失败：${errorMessage(error)}` })
  }
  if (engines !== null && !satisfiesNodeRange(engines, node)) {
    return fail({
      code: 'RUNTIME_UNSUPPORTED',
      message: `Node 版本不满足目标要求：${describeEnginesFailure(engines, node)}`,
    })
  }

  let free: number
  try {
    const stats = await deps.statfs(installDir)
    free = stats.bavail * stats.bsize
  } catch (error) {
    return fail({ code: 'INSTALL_FAILED', message: `读取磁盘可用空间失败：${errorMessage(error)}` })
  }
  if (!Number.isFinite(free) || free < MIN_FREE_BYTES) {
    return fail({
      code: 'NO_SPACE',
      message: `磁盘可用空间不足：需要 2.5 GB，当前 ${describeFree(free)}`,
    })
  }

  // 前缀纯推导、不碰盘；Task 2 的可写性检查接在这后面
  const prefix = npmPrefixOf(installDir)
  if (prefix === null) {
    return fail({
      code: 'INSTALL_FAILED',
      message: `无法从安装目录推导 npm 全局前缀：${installDir}（期望 <prefix>/lib/node_modules/@deepseek-ai/dsh）`,
    })
  }

  let from: string | null
  try {
    from = await deps.readInstalledVersion(installDir)
  } catch (error) {
    return fail({ code: 'INSTALL_FAILED', message: `读取当前安装版本失败：${errorMessage(error)}` })
  }
  if (from === null) {
    return fail({ code: 'INSTALL_FAILED', message: '读不到当前安装版本，未做任何改动' })
  }

  const backup = backupDir(root, from)

  emit({ phase: 'backup', message: `备份当前版本 ${from} 到 ${backup}` })
  try {
    await deps.cloneDir(installDir, backup)
  } catch (error) {
    return fail({ code: 'INSTALL_FAILED', message: `备份失败：${errorMessage(error)}` })
  }

  /**
   * R18：顺序固定 removeDir(installDir) → moveDir(backup, installDir)。
   * 两步都尝试，任何一步失败都要在消息里留下原始错误——留下没有可用 DSH 的机器
   * 是这里能犯的最重的错，必须说清楚。
   */
  const rollback = async (original: CodedError): Promise<UpgradeResult> => {
    emit({ phase: 'rollback', message: `升级失败，回滚到 ${from}` })
    const problems: string[] = []
    try {
      await deps.removeDir(installDir)
    } catch (error) {
      problems.push(`删除新安装失败（${errorMessage(error)}）`)
    }
    try {
      await deps.moveDir(backup, installDir)
    } catch (error) {
      problems.push(`恢复备份失败（${errorMessage(error)}）`)
    }
    if (problems.length > 0) {
      return fail(
        { code: 'ROLLBACK_FAILED', message: `回滚失败，DSH 可能已不可用：${problems.join('；')}` },
        { rolledBack: false },
      )
    }
    return fail(original, {
      rolledBack: true,
      message: `已回滚到 ${from}：${original.message}`,
    })
  }

  emit({ phase: 'install', message: `安装 @deepseek-ai/dsh@${target}` })

  let install: RunResult
  try {
    install = await deps.runNpmInstall(target, prefix, NPM_TIMEOUT_MS)
  } catch (error) {
    return await rollback({ code: 'INSTALL_FAILED', message: `安装失败：${errorMessage(error)}` })
  }
  if (install.code !== 0) {
    const detail = install.stderr.trim() === '' ? install.stdout.trim() : install.stderr.trim()
    const message =
      detail === ''
        ? `安装失败（退出码 ${install.code}）`
        : `安装失败（退出码 ${install.code}）：${detail}`
    return await rollback({ code: 'INSTALL_FAILED', message })
  }

  emit({ phase: 'verify', message: '校验安装后的版本' })

  let installed: string | null
  try {
    installed = await deps.readInstalledVersion(installDir)
  } catch (error) {
    return await rollback({
      code: 'VERSION_MISMATCH',
      message: `读取安装后版本失败：${errorMessage(error)}`,
    })
  }
  if (installed !== target) {
    return await rollback({
      code: 'VERSION_MISMATCH',
      message: `安装后版本不符：期望 ${target}，实际 ${installed ?? '未知'}`,
    })
  }

  let probed: string | null
  try {
    probed = await deps.runVersionProbe(installDir)
  } catch (error) {
    return await rollback({
      code: 'VERSION_MISMATCH',
      message: `运行 dsh --version 失败：${errorMessage(error)}`,
    })
  }
  if (probed !== target) {
    return await rollback({
      code: 'VERSION_MISMATCH',
      message:
        probed === null
          ? '安装后的 dsh 无法运行（版本探测失败）'
          : `安装后 dsh --version 输出不符：期望 ${target}，实际 ${probed}`,
    })
  }

  try {
    await deps.removeDir(backup)
  } catch {
    // 清理旧备份失败不影响升级结果；下次同名备份会先删再克隆
  }

  emit({ phase: 'done', message: `已升级到 ${target}，需重启生效`, done: true })
  return { ok: true }
}

/**
 * 把市场给的 40 位 commit 换成人看的版本号。
 *
 * 市场（dshmarket 的 updates.js）对 `github:…#<sha>` 这种钉死 ref 的安装只按 commit 比较，
 * 摘要把 current / latest 都填成 commit，面板照抄就成了两串哈希。这里补一步自己的解析：
 * 已装版本读 <profile>/node_modules/<name>/package.json，目标版本读该 commit 的
 * package.json（先 raw.githubusercontent，失败退 ghproxy 镜像）。
 *
 * 任何一步失败都只返回 null：面板回退到短哈希，升级本身不受影响。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** raw.githubusercontent 在国内多半连不上；第二站是索引也在用的 ghproxy 镜像。 */
export const RAW_BASES = [
  'https://raw.githubusercontent.com',
  'https://ghproxy.net/https://raw.githubusercontent.com',
]

const FETCH_TIMEOUT_MS = 8000

/** 包名只认 npm 的两种形状（无 scope / @scope/name），免得拼出越界的路径。 */
const PLUGIN_NAME = /^(?:@[\w.-]+\/)?[\w.-]+$/
const COMMIT = /^[0-9a-f]{7,64}$/i

export type PluginVersions = { installed: string | null, latest: string | null }

/** 测试注入缝：只覆盖碰文件与网络的部分。 */
export type PluginInfoDeps = {
  profileDir?: string
  readText?: (path: string) => Promise<string>
  fetchJson?: (url: string) => Promise<unknown>
  now?: () => number
}

type Resolved = {
  profileDir: string
  readText: (path: string) => Promise<string>
  fetchJson: (url: string) => Promise<unknown>
  now: () => number
}

/** 同一 commit 的版本号不会变，缓存挡掉重复的页面刷新。 */
const cache = new Map<string, { at: number, version: string }>()
const CACHE_TTL_MS = 10 * 60 * 1000

/** 从 pnpm 写法里认出 GitHub 仓库；认不出就返回 null（不猜）。 */
export function repoOfSpec(spec: string): string | null {
  const text = spec.trim()
  if (text === '') return null
  const short = /^github:([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#.*)?$/i.exec(text)
  if (short !== null) return short[1] + '/' + short[2]
  const url = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#.*)?$/i.exec(text)
  if (url !== null) return url[1] + '/' + url[2]
  return null
}

export async function pluginVersions(
  name: string,
  commit: string,
  overrides: PluginInfoDeps = {},
): Promise<PluginVersions> {
  if (!PLUGIN_NAME.test(name) || !COMMIT.test(commit)) return { installed: null, latest: null }
  const deps: Resolved = {
    profileDir: overrides.profileDir ?? process.cwd(),
    readText: overrides.readText ?? readTextDefault,
    fetchJson: overrides.fetchJson ?? fetchJsonDefault,
    now: overrides.now ?? (() => Date.now()),
  }
  const installed = await installedVersion(name, deps)
  const latest = await latestVersion(name, commit, deps)
  return { installed, latest }
}

async function readTextDefault(path: string): Promise<string> {
  return await readFile(path, 'utf8')
}

async function fetchJsonDefault(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  return await response.json()
}

function versionOf(doc: unknown): string | null {
  if (typeof doc !== 'object' || doc === null) return null
  const version = (doc as { version?: unknown }).version
  return typeof version === 'string' && version !== '' ? version : null
}

/** 已装版本：读 profile 里的 package.json。软链安装也能读通（只是穿过符号链接）。 */
async function installedVersion(name: string, deps: Resolved): Promise<string | null> {
  const path = join(deps.profileDir, 'node_modules', name, 'package.json')
  try {
    return versionOf(JSON.parse(await deps.readText(path)) as unknown)
  } catch {
    return null
  }
}

/** 目标版本：先看这个包在 profile 的 package.json 里是什么 spec，再按 commit 取远端 package.json。 */
async function latestVersion(name: string, commit: string, deps: Resolved): Promise<string | null> {
  const key = name + '@' + commit
  const hit = cache.get(key)
  if (hit !== undefined && deps.now() - hit.at < CACHE_TTL_MS) return hit.version
  const repo = await repoFor(name, deps)
  if (repo === null) return null
  for (const base of RAW_BASES) {
    try {
      const version = versionOf(await deps.fetchJson(base + '/' + repo + '/' + commit + '/package.json'))
      if (version !== null) {
        cache.set(key, { at: deps.now(), version })
        return version
      }
    } catch {
      // 这一站不通就换下一站
    }
  }
  return null
}

async function repoFor(name: string, deps: Resolved): Promise<string | null> {
  let doc: unknown
  try {
    doc = JSON.parse(await deps.readText(join(deps.profileDir, 'package.json'))) as unknown
  } catch {
    return null
  }
  if (typeof doc !== 'object' || doc === null) return null
  const declared = (doc as { dependencies?: unknown }).dependencies
  if (typeof declared !== 'object' || declared === null) return null
  const spec = (declared as Record<string, unknown>)[name]
  return typeof spec === 'string' ? repoOfSpec(spec) : null
}

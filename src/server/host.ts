import { readFileSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readCache, writeCache } from './state'

const DSH_PACKAGE = '@deepseek-ai/dsh'
const REGISTRY_BASE = 'https://registry.npmmirror.com'
const TIMEOUT_MS = 15_000
const MAX_ANCESTOR_DEPTH = 12

/** 兜底：node 与全局 node_modules 通常同层，homebrew 与 /usr/local 都是这个形状。 */
const EXTRA_INSTALL_DIRS = [
  '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh',
  '/usr/local/lib/node_modules/@deepseek-ai/dsh',
]

export type HostInfo = { dir: string; version: string }

export type RegistryInfo = {
  versions: string[]
  channels: { latest?: string; next?: string; alpha?: string }
  publishedAt: Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function realpathOf(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

/** 从入口往上找安装目录：全局安装的入口是 bin 里的软链，所以先解真身。 */
function ancestorsOf(file: string): string[] {
  if (file === '') return []
  const dirs: string[] = []
  let dir = dirname(realpathOf(file))
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    dirs.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirs
}

function readJsonSync(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 判定条件是 package.json 的 name，而不是目录名——后者在软链/自建安装里不可靠。 */
function isDshInstall(dir: string): boolean {
  return readJsonSync(join(dir, 'package.json'))?.name === DSH_PACKAGE
}

export function findHostInstallDir(candidates?: string[]): string | null {
  const dirs =
    candidates ??
    [
      ...ancestorsOf(process.argv[1] ?? ''),
      join(dirname(process.execPath), '..', 'lib', 'node_modules', DSH_PACKAGE),
      ...EXTRA_INSTALL_DIRS,
    ]
  for (const dir of dirs) {
    if (dir !== '' && isDshInstall(dir)) return dir
  }
  return null
}

type HostErrorCode =
  | 'HOST_NOT_FOUND'
  | 'REGISTRY_FETCH_FAILED'
  | 'REGISTRY_HTTP_ERROR'
  | 'REGISTRY_INVALID_JSON'
  | 'REGISTRY_INVALID_SHAPE'

/** 错误码挂在 Error 自身属性上；共享错误类型由 Task 6 收拢，这里不新增导出。 */
function codedError(code: HostErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** 文案固定：调用方只需要「找不到」，候选列表属于内部实现。 */
function notFoundError(): Error {
  return codedError('HOST_NOT_FOUND', '找不到 DSH 安装目录')
}

export async function readHostInfo(dir?: string): Promise<HostInfo> {
  const target = dir ?? findHostInstallDir()
  if (target === null) throw notFoundError()
  const manifest = await readJson(join(target, 'package.json'))
  const version = manifest?.version
  if (
    manifest === null ||
    manifest.name !== DSH_PACKAGE ||
    typeof version !== 'string' ||
    version === ''
  ) {
    throw notFoundError()
  }
  return { dir: target, version }
}

/** npm 的 scoped 包路径习惯写法：只把斜杠编码成 %2f，保留 @（如 @babel%2fcore）。 */
function packagePath(name: string): string {
  return name.replace(/\//g, '%2f')
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const networkMessage = '拉取 registry 元数据失败（网络不通或请求超时）'
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    // fetch 本身失败（拒连、DNS、超时/abort）：统一成中文文案，不让英文 TypeError 漏出去。
    throw codedError('REGISTRY_FETCH_FAILED', networkMessage)
  }
  if (!response.ok) {
    throw codedError('REGISTRY_HTTP_ERROR', `拉取 registry 元数据失败（HTTP ${response.status}）`)
  }
  try {
    return (await response.json()) as unknown
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw codedError('REGISTRY_INVALID_JSON', 'registry 返回的内容不是合法 JSON')
    }
    // 读 body 途中被 abort/超时：不是 JSON 语法问题，按网络失败报。
    throw codedError('REGISTRY_FETCH_FAILED', '拉取 registry 元数据失败（读取响应内容时中断或超时）')
  }
}

const CHANNEL_KEYS = ['latest', 'next', 'alpha'] as const

/** 只收录确实存在的 tag；缺的键直接不出现，绝不拿别的版本顶上。 */
function channelsOf(tags: Record<string, unknown>): RegistryInfo['channels'] {
  const channels: RegistryInfo['channels'] = {}
  for (const key of CHANNEL_KEYS) {
    const value = tags[key]
    if (typeof value === 'string' && value !== '') channels[key] = value
  }
  return channels
}

function parseRegistry(payload: unknown): RegistryInfo {
  if (!isRecord(payload)) throw codedError('REGISTRY_INVALID_SHAPE', 'registry 返回的结构无法识别')
  const rawVersions = isRecord(payload.versions) ? payload.versions : {}
  const rawTime = isRecord(payload.time) ? payload.time : {}
  const rawTags = isRecord(payload['dist-tags']) ? payload['dist-tags'] : {}
  const versions = Object.keys(rawVersions)
  const publishedAt: Record<string, string> = {}
  for (const version of versions) {
    const at = rawTime[version]
    if (typeof at === 'string' && at !== '') publishedAt[version] = at
  }
  return { versions, channels: channelsOf(rawTags), publishedAt }
}

export async function fetchRegistry(
  opts: { force?: boolean; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<{ info: RegistryInfo; cached: boolean }> {
  const now = opts.now ?? Date.now()

  if (opts.force !== true) {
    const cached = (await readCache(now))?.registry
    if (cached !== undefined) {
      return {
        info: {
          versions: cached.versions,
          channels: channelsOf(cached.channels),
          publishedAt: cached.publishedAt,
        },
        cached: true,
      }
    }
  }

  const payload = await fetchJson(
    `${REGISTRY_BASE}/${packagePath(DSH_PACKAGE)}`,
    opts.fetchImpl ?? fetch,
  )
  const info = parseRegistry(payload)
  // 只写 registry 分区：writeCache 是浅合并，带进 undefined 的 releases 会把它删掉。
  await writeCache({
    registry: {
      checkedAt: now,
      channels: info.channels,
      versions: info.versions,
      publishedAt: info.publishedAt,
    },
  })
  return { info, cached: false }
}

export async function readTargetManifest(
  target: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ engines?: { node?: string } }> {
  const payload = await fetchJson(
    `${REGISTRY_BASE}/${packagePath(DSH_PACKAGE)}/${encodeURIComponent(target)}`,
    fetchImpl,
  )
  if (!isRecord(payload)) return {}
  const engines = payload.engines
  if (!isRecord(engines)) return {}
  const node = engines.node
  if (typeof node !== 'string' || node === '') return {}
  return { engines: { node } }
}

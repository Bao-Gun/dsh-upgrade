/**
 * 两个 agent 工具：查更新（只读）与升级（会动安装目录）。
 *
 * 判定全部复用 survey.ts，工具与页面因此永远报同一个目标版本；
 * 真正的副作用（备份、安装、回滚）都在 upgrade.ts，这里只做
 * 「请求 → 状态机 → agent 能读的中文结果」这一层映射。
 * 工具不写 pending 标记，也不重启任何东西：重启是 dsh_restart 的事。
 * 升级成功会写 last.json 的 restartRequired，让面板在页面刷新后仍能提示「需重启」。
 */
import { fetchRegistry, readHostInfo, readTargetManifest, type HostInfo } from './host'
import { releaseUpgrade, tryAcquireUpgrade } from './lock'
import { rootDir, writeLast } from './state'
import { enginesBlockedOf, surveyOf, type Blocked, type Survey } from './survey'
import { runUpgrade, type UpgradeEvent } from './upgrade'

/** 测试注入缝：只覆盖会碰真实安装目录 / 网络 / 子进程的依赖。 */
export type ToolDeps = {
  readHostInfo?: typeof readHostInfo
  fetchRegistry?: typeof fetchRegistry
  readTargetManifest?: typeof readTargetManifest
  runUpgrade?: typeof runUpgrade
  nodeVersion?: () => string
}

type ResolvedToolDeps = Required<ToolDeps>

export type UpgradeCheckValue = {
  current: string
  channels: Record<string, string | undefined>
  target: string | null
  blocked?: { code: 'RUNTIME_UNSUPPORTED'; message: string }
}

export type UpgradeValue = {
  ok: boolean
  to?: string
  restartRequired?: boolean
  error?: { code: string; message: string }
}

type ToolTextBlock = { type: 'text'; text: string }

/** 宿主 tools.register 的入参形状；只声明用到的成员，避免 import 宿主包。 */
export type ToolDefinitionLike = {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): ToolTextBlock[]
  }
  execute(args: unknown, exec: unknown): Promise<unknown>
}

/** 只声明用到的宿主成员：tools 服务用 ctx.get('tools') 取，清理句柄走 ctx.effect。 */
export interface ToolContextLike {
  get?(service: string): unknown
  effect?(callback: () => void | (() => void), label?: string): void
}

const CHECK_TOOL = 'dsh_upgrade_check'
const UPGRADE_TOOL = 'dsh_upgrade'

const CHECK_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    includePrerelease: {
      type: 'boolean',
      description: '是否把 alpha / rc 这类预发布版也算作候选，默认 false',
    },
  },
  additionalProperties: false,
}

const UPGRADE_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    target: {
      type: 'string',
      description: '要装的目标版本号，必须是 registry 里存在的版本（先用 dsh_upgrade_check 查）',
    },
  },
  required: ['target'],
  additionalProperties: false,
}

const CHECK_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    current: { type: 'string', description: '当前安装的版本' },
    channels: {
      type: 'object',
      properties: {
        latest: { type: 'string' },
        next: { type: 'string' },
        alpha: { type: 'string' },
      },
      additionalProperties: false,
    },
    target: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      description: '可升级的目标版本；与 current 相同表示没有更新',
    },
    blocked: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['code', 'message'],
      additionalProperties: false,
    },
  },
  required: ['current', 'channels', 'target'],
  additionalProperties: false,
}

const UPGRADE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '升级是否成功' },
    to: { type: 'string', description: '升级后的版本' },
    restartRequired: { type: 'boolean', description: '是否需要重启 dsh web 才生效' },
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['code', 'message'],
      additionalProperties: false,
    },
  },
  required: ['ok'],
  additionalProperties: false,
}

/**
 * 查更新：只读，不装东西。
 * 契约里没有 error 字段，宿主/registry 读不到时直接抛（错误码 + 中文文案由 host.ts 给），
 * 让宿主把这次工具调用标成失败，而不是编一个「一切正常」的结果。
 */
export async function dshUpgradeCheck(
  input: { includePrerelease?: boolean },
  overrides: ToolDeps = {},
): Promise<UpgradeCheckValue> {
  const deps = resolveDeps(overrides)
  const [host, registry] = await Promise.all([
    deps.readHostInfo(),
    deps.fetchRegistry({ force: false }),
  ])
  const survey: Survey = await surveyOf(
    host.version,
    registry.info,
    input?.includePrerelease === true,
    deps,
  )

  return {
    current: survey.current,
    channels: channelsOf(survey.channels),
    // 契约允许 null（目标未知）；survey 总是给出一个具体版本，这里原样透传。
    target: survey.target,
    ...(survey.blocked === undefined ? {} : { blocked: runtimeBlocked(survey.blocked) }),
  }
}

/**
 * 升级：会动安装目录，所以永不抛，所有失败都翻译成 { ok:false, error }。
 * 顺序是刻意的：先抢升级锁（R24：页面与 agent 共用同一把，杜绝两轮 npm install），
 * 再把目标定死、确认 engines，最后才允许状态机碰文件。锁由 finally 释放。
 */
export async function dshUpgrade(
  input: { target: string },
  overrides: ToolDeps = {},
): Promise<UpgradeValue> {
  const deps = resolveDeps(overrides)
  const target = typeof input?.target === 'string' ? input.target.trim() : ''
  if (target === '') {
    return { ok: false, error: { code: 'INVALID_TARGET', message: '没有给目标版本' } }
  }
  // 锁被占时连 registry 都不查：页面正在装包，这里多问一句只会让人误以为能升。
  if (!tryAcquireUpgrade()) {
    return { ok: false, error: { code: 'BUSY', message: '已有升级在进行中' } }
  }
  try {
    return await performUpgrade(target, deps)
  } finally {
    releaseUpgrade()
  }
}

async function performUpgrade(target: string, deps: ResolvedToolDeps): Promise<UpgradeValue> {
  let host: HostInfo
  let versions: string[]
  try {
    const [hostInfo, registry] = await Promise.all([
      deps.readHostInfo(),
      deps.fetchRegistry({ force: false }),
    ])
    host = hostInfo
    versions = registry.info.versions
  } catch (error) {
    return { ok: false, error: failureOf(error) }
  }

  if (!versions.includes(target)) {
    return { ok: false, error: { code: 'INVALID_TARGET', message: `registry 里没有版本 ${target}` } }
  }

  // 被 engines 拦住的版本在这里就停住：状态机一次都不会被调用。
  const blocked = await enginesBlockedOf(target, deps)
  if (blocked !== undefined) {
    return { ok: false, error: { code: 'RUNTIME_UNSUPPORTED', message: blocked.message } }
  }

  let result: Awaited<ReturnType<typeof runUpgrade>>
  try {
    result = await deps.runUpgrade({ target, installDir: host.dir, root: rootDir() }, ignoreEvent)
  } catch (error) {
    return { ok: false, error: failureOf(error) }
  }
  if (!result.ok) {
    return { ok: false, error: result.error ?? { code: 'UPGRADE_FAILED', message: '升级失败' } }
  }
  // 装完还没重启：这个标记是页面刷新后唯一还知道该提示「需重启」的凭据。
  // 这里不写 running：工具路径没有 NDJSON 流，面板看到 running:true 会误以为能在进度条里等它。
  await writeLast({
    lastResult: { to: target, at: Date.now(), restartRequired: true },
    lastError: undefined,
  }).catch(() => {})
  return { ok: true, to: target, restartRequired: true }
}

/**
 * 把两个工具注册进宿主（R6）。宿主没有 tools 服务时只警告一次、什么都不注册。
 * 返回注册进去的工具数，方便调用方（和测试）确认接线了。
 */
export function registerTools(ctx: ToolContextLike, overrides: ToolDeps = {}): number {
  const tools = toolsOf(ctx)
  if (tools === undefined) {
    console.warn('[dsh-upgrade] 宿主没有 tools 服务，两个 agent 工具都没注册')
    return 0
  }

  const deps = resolveDeps(overrides)
  const definitions = [checkDefinition(deps), upgradeDefinition(deps)]
  for (const definition of definitions) {
    if (typeof ctx.effect === 'function') {
      ctx.effect(
        () => {
          const dispose = tools.register(definition)
          return () => dispose()
        },
        `dsh-upgrade: ${definition.name}`,
      )
      continue
    }
    // 畸形 ctx：没有 effect 就没有清理句柄，但工具本身仍然可用，不该连注册都不做。
    tools.register(definition)
  }
  return definitions.length
}

function checkDefinition(deps: ResolvedToolDeps): ToolDefinitionLike {
  return {
    name: CHECK_TOOL,
    description:
      '查 DSH 有没有新版本：当前版本、各通道最新版本、可升级目标，以及目标是否被本机 Node 版本拦住。只读，不安装任何东西。',
    parameters: CHECK_PARAMETERS,
    output: {
      schema: CHECK_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: describeCheck(value as UpgradeCheckValue) }],
    },
    execute: async (args) =>
      dshUpgradeCheck({ includePrerelease: inputOf(args).includePrerelease === true }, deps),
  }
}

function upgradeDefinition(deps: ResolvedToolDeps): ToolDefinitionLike {
  return {
    name: UPGRADE_TOOL,
    description:
      '把 DSH 升级到指定版本：先备份，安装失败会回滚。不自动重启，重启请用 dsh_restart；目标版本先用 dsh_upgrade_check 查。',
    parameters: UPGRADE_PARAMETERS,
    output: {
      schema: UPGRADE_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: describeUpgrade(value as UpgradeValue) }],
    },
    execute: async (args) => {
      const target = inputOf(args).target
      return dshUpgrade({ target: typeof target === 'string' ? target : '' }, deps)
    },
  }
}

type ToolsService = { register(definition: ToolDefinitionLike): () => void }

/** 取宿主的 tools 服务；没有、抛错、形状不对都当没有（R6：不注册，也不让 apply 炸）。 */
function toolsOf(ctx: ToolContextLike): ToolsService | undefined {
  if (typeof ctx?.get !== 'function') return undefined
  try {
    const service: unknown = ctx.get('tools')
    if (typeof service !== 'object' || service === null) return undefined
    const register = (service as { register?: unknown }).register
    if (typeof register !== 'function') return undefined
    return { register: register.bind(service) as ToolsService['register'] }
  } catch {
    return undefined
  }
}

function resolveDeps(overrides: ToolDeps): ResolvedToolDeps {
  return {
    readHostInfo: overrides.readHostInfo ?? readHostInfo,
    fetchRegistry: overrides.fetchRegistry ?? fetchRegistry,
    readTargetManifest: overrides.readTargetManifest ?? readTargetManifest,
    runUpgrade: overrides.runUpgrade ?? runUpgrade,
    nodeVersion: overrides.nodeVersion ?? (() => process.versions.node),
  }
}

/** 工具调用拿不到进度流，事件照收不误、不往外抛。 */
const ignoreEvent: (event: UpgradeEvent) => void = () => {}

/** execute 的参数由宿主校验过；这里再兜一层，畸形入参也走「拒绝」而不是崩。 */
function inputOf(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}

/** enginesBlockedOf 只产出这一个码；这里显式落类型，别让契约悄悄放宽。 */
function runtimeBlocked(blocked: Blocked): NonNullable<UpgradeCheckValue['blocked']> {
  return { code: 'RUNTIME_UNSUPPORTED', message: blocked.message }
}

/** 只报确实存在的通道：JSON 里没有 undefined 这种值。 */
function channelsOf(channels: Survey['channels']): Record<string, string | undefined> {
  const out: Record<string, string> = {}
  if (channels.latest !== null) out.latest = channels.latest
  if (channels.next !== null) out.next = channels.next
  if (channels.alpha !== null) out.alpha = channels.alpha
  return out
}

/** 状态机的错误码都是大写 + 中文文案；没带码的意外异常统一兜成中文，不漏英文堆栈。 */
function failureOf(error: unknown): { code: string; message: string } {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
  const message = error instanceof Error ? error.message : ''
  if (code !== '') return { code, message: message === '' ? '升级失败' : message }
  return { code: 'INTERNAL_ERROR', message: '升级失败：读取宿主或 registry 时出错' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function describeCheck(value: UpgradeCheckValue): string {
  const parts: string[] = [`当前版本 ${value.current}`]
  const channels = Object.entries(value.channels ?? {})
    .filter(([, version]) => typeof version === 'string' && version !== '')
    .map(([name, version]) => `${name} ${version}`)
  if (channels.length > 0) parts.push(`通道：${channels.join('，')}`)
  if (value.target === value.current) parts.push('没有比当前更新的版本')
  else if (typeof value.target === 'string') parts.push(`可升级到 ${value.target}`)
  if (value.blocked !== undefined) parts.push(`注意：${value.blocked.message}，这个版本现在装不上`)
  return parts.join('；')
}

function describeUpgrade(value: UpgradeValue): string {
  if (value.ok) {
    const to = typeof value.to === 'string' && value.to !== '' ? value.to : '新版本'
    return `已升级到 ${to}，需要重启 dsh web 才会生效；重启请用 dsh_restart。`
  }
  const error = value.error
  if (error === undefined) return '升级失败'
  return `升级失败（${error.code}）：${error.message}`
}

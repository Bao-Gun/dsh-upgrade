/**
 * 四个 HTTP 端点 + 请求门 + 单飞锁。
 *
 * 这里是插件唯一的网络面：页面（同源 fetch）读状态、查更新、拉更新内容、发升级。
 * 请求门与 dsh-restart 同风格——方法只收 GET/POST、必须带 x-dsh-upgrade: 1，
 * 带 Origin 时必须与 Host 一致；不合格一律 403，且不回显任何内部路径。
 *
 * 升级是长活：用 NDJSON 逐事件推进度，模块级 running 保证同一时刻只跑一轮。
 * 升级状态机的副作用都在 upgrade.ts，这里只做请求映射与状态落盘。
 */
import {
  fetchRegistry,
  readHostInfo,
  readTargetManifest,
  type HostInfo,
  type RegistryInfo,
} from './host'
import { markPending } from './notify'
import { fetchReleases, type ReleaseEntry } from './releases'
import { rootDir, writeLast } from './state'
import { runUpgrade, type UpgradeEvent } from './upgrade'
import {
  channelOf,
  compareVersions,
  describeEnginesFailure,
  pickNewest,
  satisfiesNodeRange,
  type Channel,
} from './versions'

export const STATUS_PATH = '/dsh-upgrade/api/status'
export const CHECK_PATH = '/dsh-upgrade/api/check'
export const RELEASES_PATH = '/dsh-upgrade/api/releases'
export const UPGRADE_PATH = '/dsh-upgrade/api/upgrade'

/** 跨站请求带不上这个头（会触发预检，宿主不认 OPTIONS）。 */
const GUARD_HEADER = 'x-dsh-upgrade'
const ALLOWED_METHODS = new Set(['GET', 'POST'])
const MAX_BODY_BYTES = 64 * 1024

export type RouteRequest = {
  method: string
  headers: Record<string, string | undefined>
  url: string
  body?: unknown
}

export type RouteResponse = {
  status(code: number): RouteResponse
  header(key: string, value: string): RouteResponse
  write(chunk: string): void
  end(body?: string): void
}

export type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<void> | void

/** 宿主 handler 的真实入参是 IncomingMessage/ServerResponse；这里用宽签名，测试与宿主都能接。 */
type HostRouteHandler = (req: unknown, res: unknown) => Promise<void> | void

/**
 * 只声明用到的宿主成员：真实宿主走 effect + webServer.register（R5），
 * 结构上可被测试的假 ctx 满足；ctx.route 仅作兼容退路。
 */
export interface UpgradeRouteContext {
  effect?(callback: () => void | (() => void), label?: string): void
  webServer?: {
    register(route: { kind: 'exact'; path: string; handler: HostRouteHandler }): () => void
  }
  route?(method: string, path: string, handler: RouteHandler): void
}

/** 测试注入缝：只覆盖会碰真实安装目录 / 网络 / 子进程的依赖。 */
export type RouteDeps = {
  readHostInfo?: typeof readHostInfo
  fetchRegistry?: typeof fetchRegistry
  readTargetManifest?: typeof readTargetManifest
  fetchReleases?: typeof fetchReleases
  runUpgrade?: typeof runUpgrade
  nodeVersion?: () => string
  now?: () => number
}

type ResolvedDeps = Required<RouteDeps>

type Blocked = { code: string; message: string }

type Candidate = {
  version: string
  channel: Channel
  publishedAt: string | null
  blocked?: Blocked
}

type Survey = {
  current: string
  channels: { latest: string | null; next: string | null; alpha: string | null }
  target: string
  blocked?: Blocked
  includePrerelease: boolean
  candidates: Candidate[]
}

/** 宿主错误码白名单：只有这些文案是我们自己写的，能安全回给页面。 */
const SAFE_ERROR_CODES = new Set([
  'HOST_NOT_FOUND',
  'REGISTRY_FETCH_FAILED',
  'REGISTRY_HTTP_ERROR',
  'REGISTRY_INVALID_JSON',
  'REGISTRY_INVALID_SHAPE',
])

/** 解析不了的请求体：用哨兵和「没传 body」区分开。 */
const INVALID_JSON = Symbol('invalid-json')

export function registerUpgradeRoutes(ctx: UpgradeRouteContext, overrides: RouteDeps = {}): void {
  const deps = resolveDeps(overrides)
  const handlers: Array<[string, 'GET' | 'POST', RouteHandler]> = [
    [STATUS_PATH, 'GET', statusHandler(deps)],
    [CHECK_PATH, 'POST', checkHandler(deps)],
    [RELEASES_PATH, 'GET', releasesHandler(deps)],
    [UPGRADE_PATH, 'POST', upgradeHandler(deps)],
  ]

  for (const [path, method, handler] of handlers) {
    const webServer = ctx.webServer
    if (typeof ctx.effect === 'function' && webServer !== undefined) {
      ctx.effect(
        () => webServer.register({ kind: 'exact', path, handler: adapt(handler) }),
        `dsh-upgrade: ${path}`,
      )
      continue
    }
    if (typeof ctx.route === 'function') {
      ctx.route(method, path, handler)
      continue
    }
    throw new Error('宿主没有提供可用的路由注册接口')
  }
}

function resolveDeps(overrides: RouteDeps): ResolvedDeps {
  return {
    readHostInfo: overrides.readHostInfo ?? readHostInfo,
    fetchRegistry: overrides.fetchRegistry ?? fetchRegistry,
    readTargetManifest: overrides.readTargetManifest ?? readTargetManifest,
    fetchReleases: overrides.fetchReleases ?? fetchReleases,
    runUpgrade: overrides.runUpgrade ?? runUpgrade,
    nodeVersion: overrides.nodeVersion ?? (() => process.versions.node),
    now: overrides.now ?? (() => Date.now()),
  }
}

/**
 * 请求门：方法只收 GET/POST、必须带 x-dsh-upgrade: 1；缺 Origin 放行
 * （curl / 探针），带 Origin 时必须与 Host 同源。与 dsh-restart 同一套判定。
 */
export function checkGate(
  req: Pick<RouteRequest, 'method' | 'headers'>,
  origin?: string,
  host?: string,
): boolean {
  if (!ALLOWED_METHODS.has(req.method.toUpperCase())) return false
  if (headerOf(req.headers, GUARD_HEADER) !== '1') return false

  const actualOrigin = origin ?? headerOf(req.headers, 'origin')
  if (actualOrigin === undefined) return true
  const actualHost = host ?? headerOf(req.headers, 'host')
  if (actualHost === undefined || actualHost === '') return false
  try {
    const parsed = new URL(actualOrigin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return parsed.host.toLowerCase() === actualHost.toLowerCase()
  } catch {
    return false
  }
}

function statusHandler(deps: ResolvedDeps): RouteHandler {
  return async (req, res) => {
    if (!guard(req, res, 'GET')) return
    try {
      const [host, registry] = await Promise.all([
        deps.readHostInfo(),
        deps.fetchRegistry({ force: false }),
      ])
      const survey = await surveyOf(host.version, registry.info, false, deps)
      respondJson(res, 200, {
        current: survey.current,
        channels: survey.channels,
        target: survey.target,
        ...(survey.blocked === undefined ? {} : { blocked: survey.blocked }),
        includePrerelease: survey.includePrerelease,
      })
    } catch (error) {
      respondJson(res, 500, errorBodyOf(error))
    }
  }
}

function checkHandler(deps: ResolvedDeps): RouteHandler {
  return async (req, res) => {
    if (!guard(req, res, 'POST')) return
    const body = bodyOf(req)
    if (body === null) {
      respondJson(res, 400, { code: 'INVALID_BODY', message: '请求体必须是 JSON 对象' })
      return
    }
    const includePrerelease = body.includePrerelease === true
    const force = body.force === true
    try {
      const [host, registry] = await Promise.all([
        deps.readHostInfo(),
        deps.fetchRegistry({ force }),
      ])
      const survey = await surveyOf(host.version, registry.info, includePrerelease, deps)
      respondJson(res, 200, survey)
    } catch (error) {
      respondJson(res, 500, errorBodyOf(error))
    }
  }
}

function releasesHandler(deps: ResolvedDeps): RouteHandler {
  return async (req, res) => {
    if (!guard(req, res, 'GET')) return
    const query = queryOf(req.url)
    const from = query.get('from') ?? ''
    const to = query.get('to') ?? ''
    if (from === '' || to === '') {
      respondJson(res, 400, { code: 'INVALID_RANGE', message: '缺少 from 或 to 参数' })
      return
    }
    try {
      const result = await deps.fetchReleases({ from, to })
      respondJson(res, 200, { releases: result.releases, degraded: result.degraded })
    } catch {
      // fetchReleases 自己永不抛；万一注入的实现抛了，更新内容也只是装饰，降级不报错。
      respondJson(res, 200, { releases: [] as ReleaseEntry[], degraded: true })
    }
  }
}

/**
 * 单飞：检查与置位必须是同步的（中间没有 await），否则两个并发请求都能过门。
 * 任何出口都走 finally 复位，升级抛错不会把锁永久占住。
 */
let running = false

function upgradeHandler(deps: ResolvedDeps): RouteHandler {
  return async (req, res) => {
    if (!guard(req, res, 'POST')) return
    if (running) {
      respondJson(res, 409, { code: 'BUSY', message: '已有一轮升级在进行，等它结束再试' })
      return
    }
    running = true

    try {
      const body = bodyOf(req)
      if (body === null) {
        respondJson(res, 400, { code: 'INVALID_BODY', message: '请求体必须是 JSON 对象' })
        return
      }
      const target = typeof body.target === 'string' ? body.target.trim() : ''
      if (target === '') {
        respondJson(res, 400, { code: 'INVALID_TARGET', message: '缺少目标版本' })
        return
      }

      let host: HostInfo
      let versions: string[]
      try {
        // 目标版本只接受 registry 里真实存在的版本号，绝不把 tag 名塞给 npm
        const [hostInfo, registry] = await Promise.all([
          deps.readHostInfo(),
          deps.fetchRegistry({ force: false }),
        ])
        host = hostInfo
        versions = registry.info.versions
      } catch (error) {
        respondJson(res, 500, errorBodyOf(error))
        return
      }
      if (!versions.includes(target)) {
        respondJson(res, 400, {
          code: 'INVALID_TARGET',
          message: `目标版本 ${target} 不在 registry 里`,
        })
        return
      }

      startNdjson(res)
      const emit = (event: UpgradeEvent): void => {
        try {
          res.write(JSON.stringify(event) + '\n')
        } catch {
          // 页面断开后升级继续跑完：状态落盘与锁释放不能因为写不出去而中断。
        }
      }

      // R22：先落 marker 再动手。进程若死在安装中，重启后还能补通知。
      await markPending(host.version, target)

      let result: Awaited<ReturnType<typeof runUpgrade>>
      try {
        result = await deps.runUpgrade({ target, installDir: host.dir, root: rootDir() }, emit)
      } catch (error) {
        const failure = {
          code: 'UPGRADE_FAILED',
          message: `升级失败：${messageOf(error)}`,
        }
        emit({ phase: 'fail', message: failure.message, done: true, error: failure })
        result = { ok: false, error: failure }
      }

      // 状态写盘失败不能把已经结束的升级变成请求失败。
      await settleLast(result, target, deps.now()).catch(() => {})
      safeEnd(res)
    } finally {
      running = false
    }
  }
}

async function settleLast(
  result: Awaited<ReturnType<typeof runUpgrade>>,
  target: string,
  now: number,
): Promise<void> {
  if (result.ok) {
    // R10：显式传 undefined，删掉上一次失败留下的 lastError
    await writeLast({
      running: false,
      lastResult: { to: target, at: now, restartRequired: true },
      lastError: undefined,
    })
    return
  }
  const error = result.error ?? { code: 'UPGRADE_FAILED', message: '升级失败' }
  await writeLast({
    running: false,
    lastError: { code: error.code, message: error.message, at: now },
  })
}

/** 只挑出确实比当前新的版本；读不懂的版本号按不存在处理。 */
function newerVersions(versions: string[], current: string): string[] {
  const newer: string[] = []
  for (const version of versions) {
    try {
      if (compareVersions(version, current) > 0) newer.push(version)
    } catch {
      // 坏版本号不影响其它候选
    }
  }
  return newer
}

/**
 * 状态与 check 共用同一套判定：稳定通道优先；没有更新就留在当前版本。
 * blocked 说的是「比当前新的那个版本」被 engines 拦住，与 target 是否选中它无关，
 * 这样 includePrerelease=false 时页面仍能解释清为什么升级按钮不可点。
 */
async function surveyOf(
  current: string,
  info: RegistryInfo,
  includePrerelease: boolean,
  deps: ResolvedDeps,
): Promise<Survey> {
  const channels = {
    latest: info.channels.latest ?? null,
    next: info.channels.next ?? null,
    alpha: info.channels.alpha ?? null,
  }
  const newer = newerVersions(info.versions, current)
  const target = pickNewest(newer, { includePrerelease }) ?? current
  const probe = target !== current ? target : pickNewest(newer, { includePrerelease: true })

  let blocked: Blocked | undefined
  if (probe !== null && probe !== current) {
    try {
      const engines = (await deps.readTargetManifest(probe)).engines?.node ?? null
      const node = deps.nodeVersion()
      if (engines !== null && !satisfiesNodeRange(engines, node)) {
        blocked = {
          code: 'RUNTIME_UNSUPPORTED',
          message: describeEnginesFailure(engines, node),
        }
      }
    } catch {
      // 读不到 engines 不等于被拦：升级状态机在安装前还会再校验一次。
    }
  }

  const candidates: Candidate[] = newer
    .slice()
    .sort((a, b) => compareVersions(b, a))
    .map((version) => ({
      version,
      channel: channelOf(version),
      publishedAt: info.publishedAt[version] ?? null,
    }))
  if (blocked !== undefined && probe !== null) {
    const candidate = candidates.find((item) => item.version === probe)
    if (candidate !== undefined) candidate.blocked = blocked
  }

  return {
    current,
    channels,
    target,
    ...(blocked === undefined ? {} : { blocked }),
    includePrerelease,
    candidates,
  }
}

function guard(req: RouteRequest, res: RouteResponse, expected: 'GET' | 'POST'): boolean {
  if (!checkGate(req)) {
    respondJson(res, 403, { code: 'FORBIDDEN', message: '请求未通过来源检查' })
    return false
  }
  if (req.method.toUpperCase() !== expected) {
    respondJson(res, 403, { code: 'METHOD_NOT_ALLOWED', message: `该路由只收 ${expected}` })
    return false
  }
  return true
}

function bodyOf(req: RouteRequest): Record<string, unknown> | null {
  if (req.body === undefined) return {}
  if (req.body === INVALID_JSON) return null
  if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) return null
  return req.body as Record<string, unknown>
}

function startNdjson(res: RouteResponse): void {
  try {
    res.status(200)
    res.header('content-type', 'application/x-ndjson; charset=utf-8')
    res.header('cache-control', 'no-store')
    res.header('x-accel-buffering', 'no')
  } catch {
    // 连接已断开：后续 write 也会被吞掉，升级照常跑完
  }
}

function respondJson(res: RouteResponse, status: number, payload: unknown): void {
  try {
    res.status(status)
    res.header('content-type', 'application/json; charset=utf-8')
    res.header('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  } catch {
    // 写响应失败不影响状态落盘与锁释放
  }
}

function safeEnd(res: RouteResponse): void {
  try {
    res.end()
  } catch {
    // 已结束或连接断开都无需处理
  }
}

function errorBodyOf(error: unknown): Blocked {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && SAFE_ERROR_CODES.has(code)) {
      return { code, message: error.message }
    }
  }
  return { code: 'INTERNAL_ERROR', message: '升级插件内部错误' }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function queryOf(url: string): URLSearchParams {
  try {
    return new URL(url, 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function headerOf(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name]
  if (direct !== undefined) return direct
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value
  }
  return undefined
}

function headersOf(raw: unknown): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {}
  if (typeof raw !== 'object' || raw === null) return headers
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') headers[key.toLowerCase()] = value
    else if (Array.isArray(value)) {
      headers[key.toLowerCase()] = value.filter((item) => typeof item === 'string').join(',')
    }
  }
  return headers
}

type IncomingLike = {
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown
  body?: unknown
  method?: unknown
  url?: unknown
  headers?: unknown
}

/**
 * 宿主若已解析 body 就直接用；否则从请求流里读（带上限）。
 * 空 body 返回 undefined，坏 JSON / 超限返回哨兵，交给 bodyOf 报 400。
 */
async function requestOf(raw: unknown): Promise<RouteRequest> {
  const incoming = (raw ?? {}) as IncomingLike
  const method = typeof incoming.method === 'string' ? incoming.method : ''
  const url = typeof incoming.url === 'string' ? incoming.url : ''
  const headers = headersOf(incoming.headers)
  if (incoming.body !== undefined) return { method, headers, url, body: incoming.body }
  const body = await readBodyOf(incoming)
  return body === undefined ? { method, headers, url } : { method, headers, url, body }
}

function readBodyOf(stream: IncomingLike): Promise<unknown> {
  const on = stream.on
  if (typeof on !== 'function') return Promise.resolve(undefined)
  return new Promise((resolve) => {
    let text = ''
    let settled = false
    const finish = (value: unknown): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    on.call(stream, 'data', (chunk: unknown) => {
      if (settled) return
      text += chunkText(chunk)
      if (text.length > MAX_BODY_BYTES) finish(INVALID_JSON)
    })
    on.call(stream, 'end', () => {
      if (settled) return
      const trimmed = text.trim()
      if (trimmed === '') {
        finish(undefined)
        return
      }
      try {
        finish(JSON.parse(trimmed) as unknown)
      } catch {
        finish(INVALID_JSON)
      }
    })
    on.call(stream, 'error', () => finish(undefined))
  })
}

function chunkText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (chunk instanceof Uint8Array) return new TextDecoder().decode(chunk)
  return ''
}

type RawResponseLike = {
  status?: unknown
  header?: unknown
  setHeader?: unknown
  statusCode?: number
  write?: unknown
  end?: unknown
}

/**
 * 把宿主真实的 Node ServerResponse 包成 brief 约定的链式接口；
 * 测试的假 res 已经是链式接口时原样返回。
 */
function respondableOf(raw: unknown): RouteResponse {
  const target = (raw ?? {}) as RawResponseLike
  if (
    typeof target.status === 'function' &&
    typeof target.header === 'function' &&
    typeof target.write === 'function' &&
    typeof target.end === 'function'
  ) {
    return target as unknown as RouteResponse
  }
  const res: RouteResponse = {
    status(code) {
      target.statusCode = code
      return res
    },
    header(key, value) {
      if (typeof target.setHeader === 'function') {
        ;(target.setHeader as (k: string, v: string) => void)(key, value)
      }
      return res
    },
    write(chunk) {
      if (typeof target.write === 'function') (target.write as (c: string) => void)(chunk)
    },
    end(body) {
      if (typeof target.end === 'function') (target.end as (b?: string) => void)(body)
    },
  }
  return res
}

function adapt(handler: RouteHandler): HostRouteHandler {
  return (rawReq, rawRes) =>
    (async () => {
      const res = respondableOf(rawRes)
      try {
        await handler(await requestOf(rawReq), res)
      } catch {
        respondJson(res, 500, { code: 'INTERNAL_ERROR', message: '升级插件内部错误' })
      }
    })()
}

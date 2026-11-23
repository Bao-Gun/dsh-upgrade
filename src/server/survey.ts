/**
 * 版本调查：当前版本 + registry 元数据 → 候选、目标、engines 拦截判定。
 *
 * 页面（routes.ts）与 agent 工具（tools.ts）共用这一份：两边必须报同一个目标版本，
 * 也必须在同一处判断「这个版本本机跑不跑得起来」。判定规则只能有一份。
 */
import type { RegistryInfo } from './host'
import {
  channelOf,
  compareVersions,
  describeEnginesFailure,
  pickNewest,
  satisfiesNodeRange,
  type Channel,
} from './versions'

export type Blocked = { code: string; message: string }

export type SurveyCandidate = {
  version: string
  channel: Channel
  publishedAt: string | null
  blocked?: Blocked
}

export type Survey = {
  current: string
  channels: { latest: string | null; next: string | null; alpha: string | null }
  target: string
  blocked?: Blocked
  includePrerelease: boolean
  candidates: SurveyCandidate[]
}

/** engines 判定只用这两个依赖；页面与工具的注入缝都满足它。 */
export type EnginesDeps = {
  readTargetManifest(target: string): Promise<{ engines?: { node?: string } }>
  nodeVersion(): string
}

/** 只挑出确实比当前新的版本；读不懂的版本号按不存在处理。 */
export function newerVersions(versions: string[], current: string): string[] {
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
 * 判定一个具体版本本机跑不跑得起来。
 * 读不到 engines 不算拦截：安装前的状态机还会再校验一次，这里只负责早点说清楚。
 */
export async function enginesBlockedOf(
  version: string,
  deps: EnginesDeps,
): Promise<Blocked | undefined> {
  try {
    const engines = (await deps.readTargetManifest(version)).engines?.node ?? null
    if (engines === null) return undefined
    const node = deps.nodeVersion()
    if (satisfiesNodeRange(engines, node)) return undefined
    return { code: 'RUNTIME_UNSUPPORTED', message: describeEnginesFailure(engines, node) }
  } catch {
    return undefined
  }
}

/**
 * 状态与 check 共用同一套判定：稳定通道优先；没有更新就留在当前版本。
 * blocked 说的是「比当前新的那个版本」被 engines 拦住，与 target 是否选中它无关，
 * 这样 includePrerelease=false 时页面仍能解释清为什么升级按钮不可点。
 */
export async function surveyOf(
  current: string,
  info: RegistryInfo,
  includePrerelease: boolean,
  deps: EnginesDeps,
): Promise<Survey> {
  const channels = {
    latest: info.channels.latest ?? null,
    next: info.channels.next ?? null,
    alpha: info.channels.alpha ?? null,
  }
  const newer = newerVersions(info.versions, current)
  const target = pickNewest(newer, { includePrerelease }) ?? current
  const probe = target !== current ? target : pickNewest(newer, { includePrerelease: true })
  const blocked = probe !== null && probe !== current ? await enginesBlockedOf(probe, deps) : undefined

  const candidates: SurveyCandidate[] = newer
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

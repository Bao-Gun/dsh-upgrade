import type { CachedRelease } from './state'
import { channelOf, compareVersions, parseVersion } from './versions'

/** 缓存里一条 release 记录的形状由 Task 3 的 state.ts 定义，这里只做别名 */
export type ReleaseEntry = CachedRelease

const RELEASES_URL =
  'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=30'
const RELEASE_PAGE_BASE = 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/'
const TAG_PREFIX = 'dsh-v'
const DEFAULT_TIMEOUT_MS = 8_000

/** 中文段：<h3 id="cn-..."> 之后，到英文段开头或正文结束 */
const CN_SECTION_RE = /<h3[^>]*id="cn-[^"]*"[^>]*>([\s\S]*?)(?=<h3[^>]*id="en-|$)/

/** 先删标签再反转义：正文里的 &lt;b&gt; 是字面文本，不能变成标签被吃掉 */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * 只取中文段。release 正文可能是 Markdown 列表（接口原样），也可能是
 * 渲染后的 <li>（页面形态），两种都按行拆。
 */
export function extractChineseItems(body: string): string[] {
  const section = CN_SECTION_RE.exec(body)
  if (section === null) return []
  const text = decodeEntities(
    (section[1] ?? '')
      .replace(/<\/h3>/g, '\n')
      .replace(/<li[^>]*>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
  const items: string[] = []
  for (const line of text.split('\n')) {
    const item = line
      .trim()
      .replace(/^[-*+]\s+/, '')
      .trim()
    if (item !== '') items.push(item)
  }
  return items
}

type ReleaseQuery = {
  from: string
  to: string
  fetchImpl?: typeof fetch
  /** 调用方的时间基准；本模块不读写缓存，留着是为了和 routes 共用一个时钟 */
  now?: number
  timeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 一条 release 读不懂就跳过它自己，绝不拖垮整次拉取 */
function releaseOf(raw: unknown): ReleaseEntry | null {
  if (!isRecord(raw)) return null
  const tag = raw.tag_name
  if (typeof tag !== 'string' || !tag.startsWith(TAG_PREFIX)) return null
  const version = tag.slice(TAG_PREFIX.length)
  if (parseVersion(version) === null) return null
  const publishedAt = raw.published_at
  const htmlUrl = raw.html_url
  const body = raw.body
  return {
    version,
    channel: channelOf(version),
    publishedAt: typeof publishedAt === 'string' ? publishedAt : '',
    items: typeof body === 'string' ? extractChineseItems(body) : [],
    url:
      typeof htmlUrl === 'string' && htmlUrl !== '' ? htmlUrl : `${RELEASE_PAGE_BASE}${tag}`,
  }
}

/**
 * 两条腿兜超时：signal 让真 fetch 尽早收手；race 兜住「传进来的 fetchImpl
 * 根本不理 signal」（注入的假 fetch 与永不 resolve 的 Promise 就是这种）。
 * 计时器必须在 finally 清掉，否则测试进程被它吊着不退。
 */
async function fetchWithTimeout(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fetchImpl(url, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-upgrade' },
        signal: AbortSignal.timeout(timeoutMs),
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('拉取 release 超时')), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 拉取 (from, to] 区间内的 release，按版本新→旧排序。
 * 任何异常（断网、限流、超时、结构不对）都收敛成 degraded: true，绝不抛：
 * 更新内容只是装饰，不能把升级拖住。
 */
export async function fetchReleases(
  range: ReleaseQuery,
): Promise<{ releases: ReleaseEntry[]; degraded: boolean }> {
  // compareVersions 读不懂就抛，所以区间端点先过 parseVersion；读不懂按降级处理，
  // 不当作「这段版本没有更新内容」。
  if (parseVersion(range.from) === null || parseVersion(range.to) === null) {
    return { releases: [], degraded: true }
  }

  let payload: unknown
  try {
    const response = await fetchWithTimeout(
      RELEASES_URL,
      range.fetchImpl ?? fetch,
      range.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    if (!response.ok) return { releases: [], degraded: true }
    payload = await response.json()
  } catch {
    return { releases: [], degraded: true }
  }

  if (!Array.isArray(payload)) return { releases: [], degraded: true }

  const releases: ReleaseEntry[] = []
  for (const raw of payload) {
    const release = releaseOf(raw)
    if (release === null) continue
    // 区间判定用 Task 2 的 compareVersions：(from, to]，version 已过 parseVersion
    if (compareVersions(release.version, range.from) <= 0) continue
    if (compareVersions(release.version, range.to) > 0) continue
    releases.push(release)
  }
  releases.sort((a, b) => compareVersions(b.version, a.version))
  return { releases, degraded: false }
}

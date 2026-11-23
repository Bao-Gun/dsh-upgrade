import { describe, expect, test, vi } from 'vitest'
import { extractChineseItems, fetchReleases } from '../src/server/releases'

const RELEASES_URL =
  'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=30'

const ALPHA2_TAG = 'dsh-v0.2.3-alpha.2'
const ALPHA1_TAG = 'dsh-v0.2.3-alpha.1'
const RC5_TAG = 'dsh-v0.2.2-rc.5'

/** 真 release 正文：api.github.com 的 body 字段原文（dsh-v0.2.3-alpha.2），中文段是 Markdown 列表 */
const REAL_BODY_ALPHA2 = `[中文](#cn-v0.2.3-alpha.2) | [English](#en-v0.2.3-alpha.2)

<h3 id="cn-v0.2.3-alpha.2">其他变更</h3>

- 调整 Node.js 版本要求为 24.22.3，26.13.1 及以上版本。 @imccyu

<h3 id="en-v0.2.3-alpha.2">Chores</h3>

- DSH now requires Node.js 24.22.3 or later in the 24.x series, or 26.13.1 or later. by @imccyu

Full Changelog: https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.3-alpha.1...dsh-v0.2.3-alpha.2`

/** 真 release 正文的第二种形态：GitHub 渲染出的 HTML（<li> + 实体），也要能取 */
const REAL_BODY_RC5 = `[中文](#cn-v0.2.2-rc.5) | [English](#en-v0.2.2-rc.5)

<h3 id="cn-v0.2.2-rc.5">体验优化</h3>

- DeepSeek 模型使用 DeepSeek 服务端搜索，搜索不按次收费；其他模型默认使用 DeepSeek Search API。 @LegGasai

<h3 id="en-v0.2.2-rc.5">Improvements</h3>

- DeepSeek models use DeepSeek server-side search with no per-search charge; other models default to DeepSeek Search API. by @LegGasai

Full Changelog: https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.2-rc.4...dsh-v0.2.2-rc.5`

function releasePage(tag: string): string {
  return `https://github.com/deepseek-ai/deepseek-harness/releases/tag/${tag}`
}

/** 故意按旧→新的顺序给，顺手钉住「排序看版本，不看接口顺序」 */
function releasePayload(): unknown[] {
  return [
    {
      tag_name: ALPHA1_TAG,
      published_at: '2026-11-22T03:19:36Z',
      html_url: releasePage(ALPHA1_TAG),
      body: '<h3 id="cn-v0.2.3-alpha.1">新功能</h3>\n\n- 会话支持导出为 Markdown。 @imccyu\n\n<h3 id="en-v0.2.3-alpha.1">Features</h3>\n\n- Sessions can be exported. by @imccyu',
    },
    {
      tag_name: RC5_TAG,
      published_at: '2026-11-18T12:51:39Z',
      html_url: releasePage(RC5_TAG),
      body: REAL_BODY_RC5,
    },
    {
      tag_name: ALPHA2_TAG,
      published_at: '2026-11-22T11:00:39Z',
      html_url: releasePage(ALPHA2_TAG),
      body: REAL_BODY_ALPHA2,
    },
  ]
}

function stubFetch(payload: unknown, status = 200) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  )
}

describe('extractChineseItems', () => {
  test('真正文只取中文段，标题保留为单独一行，条目去掉列表符号', () => {
    expect(extractChineseItems(REAL_BODY_ALPHA2)).toEqual([
      '其他变更',
      '调整 Node.js 版本要求为 24.22.3，26.13.1 及以上版本。 @imccyu',
    ])
  })

  test('渲染后的 HTML 形态（<li> 与实体）同样能取，实体反转义', () => {
    const body = `<div class="markdown-body">
<h3 id="cn-v0.2.2-rc.5">体验优化</h3>
<ul>
<li>修好 &quot;模型切换&quot; 失败的提示。</li>
<li>修复 A &amp; B 冲突时 &lt;空&gt; 的显示。</li>
</ul>
<h3 id="en-v0.2.2-rc.5">Improvements</h3>
<ul><li>Fixed &amp; improved.</li></ul>
</div>`
    expect(extractChineseItems(body)).toEqual([
      '体验优化',
      '修好 "模型切换" 失败的提示。',
      '修复 A & B 冲突时 <空> 的显示。',
    ])
  })

  test('中文段后面没有英文段时取到正文末尾', () => {
    const body = `<h3 id="cn-v0.2.2-rc.5">体验优化</h3>

- 漏跑的重启预检补上了。 @imccyu`
    expect(extractChineseItems(body)).toEqual(['体验优化', '漏跑的重启预检补上了。 @imccyu'])
  })

  test('没有 cn- 标记的正文返回空数组', () => {
    expect(
      extractChineseItems(`<h3 id="en-v0.2.2-rc.5">Improvements</h3>

- DeepSeek models use server-side search.`),
    ).toEqual([])
  })

  test('空正文返回空数组', () => {
    expect(extractChineseItems('')).toEqual([])
  })
})

describe('fetchReleases', () => {
  test('筛 dsh-v tag、只留 (from, to]、按新→旧排序，并把请求打到 releases 端点', async () => {
    const stub = stubFetch(releasePayload())
    const result = await fetchReleases({
      from: '0.2.2-rc.5',
      to: '0.2.3-alpha.2',
      fetchImpl: stub as unknown as typeof fetch,
    })

    expect(result.degraded).toBe(false)
    // rc.5 落在开区间外；alpha.1 / alpha.2 都在区间内，且不看接口顺序
    expect(result.releases.map((release) => release.version)).toEqual([
      '0.2.3-alpha.2',
      '0.2.3-alpha.1',
    ])
    expect(result.releases[0]).toEqual({
      version: '0.2.3-alpha.2',
      channel: 'alpha',
      publishedAt: '2026-11-22T11:00:39Z',
      items: ['其他变更', '调整 Node.js 版本要求为 24.22.3，26.13.1 及以上版本。 @imccyu'],
      url: releasePage(ALPHA2_TAG),
    })
    expect(result.releases[1]?.items).toEqual(['新功能', '会话支持导出为 Markdown。 @imccyu'])

    expect(stub).toHaveBeenCalledTimes(1)
    expect(stub.mock.calls[0]?.[0]).toBe(RELEASES_URL)
    expect(stub.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  test('区间内没有版本时 degraded 仍是 false（没有更新内容不等于拿不到）', async () => {
    const result = await fetchReleases({
      from: '0.2.3-alpha.2',
      to: '0.2.3-alpha.2',
      fetchImpl: stubFetch(releasePayload()) as unknown as typeof fetch,
    })
    expect(result).toEqual({ releases: [], degraded: false })
  })

  test('怪 tag 与区间外的版本逐条跳过，不影响其它条目', async () => {
    const stub = stubFetch([
      { tag_name: 'dsh-vnot-a-version', body: REAL_BODY_ALPHA2 },
      { tag_name: 'other-v9.9.9', body: REAL_BODY_ALPHA2 },
      { tag_name: 'dsh-v0.2.1', body: REAL_BODY_ALPHA2 },
      { tag_name: ALPHA2_TAG, body: REAL_BODY_ALPHA2, published_at: '2026-11-22T11:00:39Z' },
    ])
    const result = await fetchReleases({
      from: '0.2.2-rc.5',
      to: '0.2.3-alpha.2',
      fetchImpl: stub as unknown as typeof fetch,
    })
    expect(result.degraded).toBe(false)
    expect(result.releases.map((release) => release.version)).toEqual(['0.2.3-alpha.2'])
  })

  test('缺 body / published_at / html_url 的条目不编造：items 空、日期空、url 退回 tag 页', async () => {
    const result = await fetchReleases({
      from: '0.2.2-rc.5',
      to: '0.2.3-alpha.2',
      fetchImpl: stubFetch([{ tag_name: ALPHA2_TAG }]) as unknown as typeof fetch,
    })
    expect(result.releases).toEqual([
      {
        version: '0.2.3-alpha.2',
        channel: 'alpha',
        publishedAt: '',
        items: [],
        url: releasePage(ALPHA2_TAG),
      },
    ])
    expect(result.degraded).toBe(false)
  })

  test('假 fetch 抛错时降级，不把异常抛给调用方', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const result = await fetchReleases({
      from: '0.2.2-rc.5',
      to: '0.2.3-alpha.2',
      fetchImpl: failing as unknown as typeof fetch,
    })
    expect(result).toEqual({ releases: [], degraded: true })
  })

  test('HTTP 非 200（例如限流 403）同样降级', async () => {
    const result = await fetchReleases({
      from: '0.2.2-rc.5',
      to: '0.2.3-alpha.2',
      fetchImpl: stubFetch({ message: 'API rate limit exceeded' }, 403) as unknown as typeof fetch,
    })
    expect(result).toEqual({ releases: [], degraded: true })
  })

  test('返回的不是数组时降级', async () => {
    const result = await fetchReleases({
      from: '0.2.2-rc.5',
      to: '0.2.3-alpha.2',
      fetchImpl: stubFetch({ message: 'Not Found' }) as unknown as typeof fetch,
    })
    expect(result).toEqual({ releases: [], degraded: true })
  })

  test('区间端点读不懂时降级，不抛也不当成「没有更新」', async () => {
    const stub = stubFetch(releasePayload())
    const result = await fetchReleases({
      from: 'latest',
      to: '0.2.3-alpha.2',
      fetchImpl: stub as unknown as typeof fetch,
    })
    expect(result).toEqual({ releases: [], degraded: true })
    expect(stub).not.toHaveBeenCalled()
  })

  test('fetch 永不 resolve 时按 timeoutMs 降级返回，不把升级拖住', async () => {
    const hanging = vi.fn(() => new Promise<Response>(() => {}))
    const startedAt = Date.now()
    const result = await fetchReleases({
      from: '0.2.2-rc.5',
      to: '0.2.3-alpha.2',
      fetchImpl: hanging as unknown as typeof fetch,
      timeoutMs: 50,
    })
    const elapsed = Date.now() - startedAt

    expect(result).toEqual({ releases: [], degraded: true })
    expect(elapsed).toBeLessThan(200)
  })
})

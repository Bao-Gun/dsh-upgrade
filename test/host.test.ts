import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fetchRegistry,
  findHostInstallDir,
  readHostInfo,
  readTargetManifest,
} from '../src/server/host'
import { readCache, writeCache } from '../src/server/state'

const DSH_PACKAGE = '@deepseek-ai/dsh'
const REGISTRY_URL = 'https://registry.npmmirror.com/@deepseek-ai%2fdsh'
const NOW = 1_700_000_000_000
const HOUR = 60 * 60 * 1000

let dir: string
const originalRoot = process.env.DSH_UPGRADE_ROOT

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-upgrade-host-'))
  process.env.DSH_UPGRADE_ROOT = dir
})

afterEach(async () => {
  if (originalRoot === undefined) delete process.env.DSH_UPGRADE_ROOT
  else process.env.DSH_UPGRADE_ROOT = originalRoot
  await rm(dir, { recursive: true, force: true })
})

async function writeManifest(path: string, value: unknown): Promise<string> {
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'package.json'), JSON.stringify(value), 'utf8')
  return path
}

function stubFetch(body: unknown, status = 200) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  )
}

function registryPayload() {
  return {
    'dist-tags': { latest: '0.2.2-rc.5', next: '0.2.2-rc.5', alpha: '0.2.3-alpha.2' },
    versions: { '0.2.2-rc.5': {}, '0.2.3-alpha.2': {} },
    time: { '0.2.2-rc.5': '2026-11-18T13:17:23.604Z' },
  }
}

describe('findHostInstallDir', () => {
  test('按候选顺序返回第一个 name 为 @deepseek-ai/dsh 的目录', async () => {
    const empty = join(dir, 'empty')
    await mkdir(empty)
    const first = await writeManifest(join(dir, 'a', 'lib', 'node_modules', '@deepseek-ai', 'dsh'), {
      name: DSH_PACKAGE,
      version: '0.2.2-rc.5',
    })
    const second = await writeManifest(join(dir, 'b', 'lib', 'node_modules', '@deepseek-ai', 'dsh'), {
      name: DSH_PACKAGE,
      version: '0.2.2',
    })
    expect(findHostInstallDir([empty, first, second])).toBe(first)
  })

  test('空目录与 name 不对的候选都不算命中', async () => {
    const empty = join(dir, 'empty')
    await mkdir(empty)
    const wrong = await writeManifest(join(dir, 'wrong'), { name: 'dsh-upgrade', version: '0.1.0' })
    expect(findHostInstallDir([empty, wrong])).toBeNull()
  })

  test('process.argv[1] 缺失时不抛', () => {
    const original = process.argv
    process.argv = [original[0] ?? 'node']
    try {
      expect(() => findHostInstallDir()).not.toThrow()
    } finally {
      process.argv = original
    }
  })
})

describe('readHostInfo', () => {
  test('读临时目录里的 package.json 版本', async () => {
    const install = await writeManifest(join(dir, 'install'), {
      name: DSH_PACKAGE,
      version: '0.2.2-rc.5',
    })
    await expect(readHostInfo(install)).resolves.toEqual({ dir: install, version: '0.2.2-rc.5' })
  })

  test('目录不存在时抛「找不到 DSH 安装目录」', async () => {
    await expect(readHostInfo(join(dir, 'missing'))).rejects.toThrow('找不到 DSH 安装目录')
  })

  test('package.json 不是 dsh 的也抛同一个错', async () => {
    const wrong = await writeManifest(join(dir, 'wrong'), { name: 'dsh-upgrade', version: '0.1.0' })
    await expect(readHostInfo(wrong)).rejects.toThrow('找不到 DSH 安装目录')
  })
})

describe('fetchRegistry', () => {
  test('首次拉取映射 versions / channels / publishedAt，包名按 npm 约定编码', async () => {
    const stub = stubFetch(registryPayload())
    const result = await fetchRegistry({ fetchImpl: stub as unknown as typeof fetch, now: NOW })

    expect(result.cached).toBe(false)
    expect(result.info.versions).toEqual(['0.2.2-rc.5', '0.2.3-alpha.2'])
    expect(result.info.channels).toEqual({
      latest: '0.2.2-rc.5',
      next: '0.2.2-rc.5',
      alpha: '0.2.3-alpha.2',
    })
    expect(result.info.publishedAt).toEqual({ '0.2.2-rc.5': '2026-11-18T13:17:23.604Z' })
    expect(stub).toHaveBeenCalledTimes(1)
    expect(stub.mock.calls[0]?.[0]).toBe(REGISTRY_URL)
    expect(stub.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  test('6 小时内的第二次调用走缓存，不再打网络', async () => {
    const stub = stubFetch(registryPayload())
    const fetchImpl = stub as unknown as typeof fetch
    await fetchRegistry({ fetchImpl, now: NOW })

    const again = await fetchRegistry({ fetchImpl, now: NOW + HOUR })
    expect(again.cached).toBe(true)
    expect(again.info.versions).toEqual(['0.2.2-rc.5', '0.2.3-alpha.2'])
    expect(stub).toHaveBeenCalledTimes(1)
  })

  test('force: true 绕过新鲜缓存并覆盖缓存', async () => {
    await writeCache({
      registry: { checkedAt: NOW, channels: { latest: '0.2.1' }, versions: ['0.2.1'], publishedAt: {} },
    })
    const stub = stubFetch(registryPayload())
    const result = await fetchRegistry({
      force: true,
      fetchImpl: stub as unknown as typeof fetch,
      now: NOW,
    })

    expect(result.cached).toBe(false)
    expect(result.info.versions).toEqual(['0.2.2-rc.5', '0.2.3-alpha.2'])
    expect(stub).toHaveBeenCalledTimes(1)
    const cached = await readCache(NOW)
    expect(cached?.registry?.versions).toEqual(['0.2.2-rc.5', '0.2.3-alpha.2'])
  })

  test('写 registry 缓存时不碰已有的 releases 分区', async () => {
    await writeCache({
      releases: {
        checkedAt: NOW,
        byVersion: {
          '0.2.2-rc.5': [
            {
              version: '0.2.2-rc.5',
              channel: 'rc',
              publishedAt: '2026-11-18T13:17:23.604Z',
              items: ['修了点东西'],
              url: 'https://example.test/0.2.2-rc.5',
            },
          ],
        },
      },
    })

    await fetchRegistry({
      fetchImpl: stubFetch(registryPayload()) as unknown as typeof fetch,
      now: NOW,
    })

    const cached = await readCache(NOW)
    expect(cached?.registry?.versions).toEqual(['0.2.2-rc.5', '0.2.3-alpha.2'])
    expect(cached?.releases?.byVersion['0.2.2-rc.5']?.[0]?.items).toEqual(['修了点东西'])
  })

  test('缺 next / alpha 与 time 条目时不编造也不抛', async () => {
    const stub = stubFetch({
      'dist-tags': { latest: '0.2.2-rc.5' },
      versions: { '0.2.2-rc.5': {}, '0.2.3-alpha.2': {} },
      time: { '0.2.3-alpha.2': '2026-11-20T00:00:00.000Z', created: '2026-01-01T00:00:00.000Z' },
    })
    const result = await fetchRegistry({ fetchImpl: stub as unknown as typeof fetch, now: NOW })

    expect(result.info.channels).toEqual({ latest: '0.2.2-rc.5' })
    expect(result.info.publishedAt).toEqual({ '0.2.3-alpha.2': '2026-11-20T00:00:00.000Z' })
  })

  test('dist-tags 与 time 整个缺失时给空对象', async () => {
    const result = await fetchRegistry({
      fetchImpl: stubFetch({ versions: {} }) as unknown as typeof fetch,
      now: NOW,
    })
    expect(result.info).toEqual({ versions: [], channels: {}, publishedAt: {} })
  })

  test('HTTP 非 200 抛错', async () => {
    const stub = stubFetch({ error: 'not found' }, 404)
    await expect(
      fetchRegistry({ fetchImpl: stub as unknown as typeof fetch, now: NOW }),
    ).rejects.toThrow('404')
  })

  test('拉取失败不写缓存，下一次还会重试', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    await expect(
      fetchRegistry({ fetchImpl: failing as unknown as typeof fetch, now: NOW }),
    ).rejects.toThrow('fetch failed')
    expect(await readCache(NOW)).toBeNull()
  })
})

describe('readTargetManifest', () => {
  test('engines.node 原样带回，版本号进 URL', async () => {
    const stub = stubFetch({ engines: { node: '^24.22.3 || >=26.13.1' } })
    const manifest = await readTargetManifest('0.2.3-alpha.2', stub as unknown as typeof fetch)

    expect(manifest).toEqual({ engines: { node: '^24.22.3 || >=26.13.1' } })
    expect(stub.mock.calls[0]?.[0]).toBe(`${REGISTRY_URL}/0.2.3-alpha.2`)
  })

  test('没有 engines 或没有 node 时返回空对象', async () => {
    const noEngines = stubFetch({ version: '0.2.2' })
    await expect(
      readTargetManifest('0.2.2', noEngines as unknown as typeof fetch),
    ).resolves.toEqual({})

    const noNode = stubFetch({ engines: { npm: '>=10' } })
    await expect(
      readTargetManifest('0.2.2', noNode as unknown as typeof fetch),
    ).resolves.toEqual({})
  })

  test('HTTP 非 200 抛错', async () => {
    const stub = stubFetch({ error: 'not found' }, 404)
    await expect(
      readTargetManifest('9.9.9', stub as unknown as typeof fetch),
    ).rejects.toThrow('404')
  })
})

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  backupDir,
  clearPending,
  ensureDir,
  readCache,
  readLast,
  readPending,
  rootDir,
  writeCache,
  writeLast,
  writePending,
} from '../src/server/state'

const HOUR = 60 * 60 * 1000
const NOW = 1_700_000_000_000

let dir: string
const originalRoot = process.env.DSH_UPGRADE_ROOT

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-upgrade-state-'))
  process.env.DSH_UPGRADE_ROOT = dir
})

afterEach(async () => {
  if (originalRoot === undefined) delete process.env.DSH_UPGRADE_ROOT
  else process.env.DSH_UPGRADE_ROOT = originalRoot
  await rm(dir, { recursive: true, force: true })
})

function registry(checkedAt: number = NOW) {
  return {
    checkedAt,
    channels: { stable: '0.2.2', rc: '0.2.2-rc.5' },
    versions: ['0.2.2', '0.2.2-rc.5'],
    publishedAt: { '0.2.2': '2026-11-20T00:00:00.000Z' },
  }
}

describe('rootDir', () => {
  test('优先取 DSH_UPGRADE_ROOT，且每次调用都重新读', () => {
    expect(rootDir()).toBe(dir)
    process.env.DSH_UPGRADE_ROOT = join(dir, 'second')
    expect(rootDir()).toBe(join(dir, 'second'))
  })

  test('未设置时回落到 ~/.dsh/dsh-upgrade', () => {
    delete process.env.DSH_UPGRADE_ROOT
    expect(rootDir()).toBe(join(homedir(), '.dsh', 'dsh-upgrade'))
  })
})

describe('ensureDir / backupDir', () => {
  test('ensureDir 递归建目录且可重复调用', async () => {
    const nested = join(dir, 'a', 'b')
    await ensureDir(nested)
    await ensureDir(nested)
    expect(await readdir(nested)).toEqual([])
  })

  test('backupDir 拼出 <root>/backup/<version>', () => {
    expect(backupDir('/data/dsh-upgrade', '0.2.2')).toBe(
      join('/data/dsh-upgrade', 'backup', '0.2.2'),
    )
  })
})

describe('缓存', () => {
  test('目录还不存在时读取为 null，不抛', async () => {
    process.env.DSH_UPGRADE_ROOT = join(dir, 'not', 'yet')
    await expect(readCache(NOW)).resolves.toBeNull()
    await expect(readPending()).resolves.toBeNull()
    await expect(readLast()).resolves.toBeNull()
  })

  test('TTL 内可读，超过 6 小时返回 null', async () => {
    await writeCache({ registry: registry() })
    const cached = await readCache(NOW)
    expect(cached?.registry?.channels.stable).toBe('0.2.2')
    expect(cached?.registry?.versions).toEqual(['0.2.2', '0.2.2-rc.5'])
    expect(await readCache(NOW + 6 * HOUR)).not.toBeNull()
    expect(await readCache(NOW + 6 * HOUR + 1)).toBeNull()
  })

  test('ttlMs 可覆盖默认 TTL', async () => {
    await writeCache({ registry: registry() })
    expect(await readCache(NOW + 2 * HOUR, 1 * HOUR)).toBeNull()
    expect(await readCache(NOW + 2 * HOUR, 3 * HOUR)).not.toBeNull()
  })

  test('writeCache 是浅合并，子对象整体替换', async () => {
    await writeCache({ registry: registry() })
    await writeCache({
      releases: {
        checkedAt: NOW,
        byVersion: {
          '0.2.2': [
            {
              version: '0.2.2',
              channel: 'stable',
              publishedAt: '2026-11-20T00:00:00.000Z',
              items: ['修复退出码'],
              url: 'https://example.test/0.2.2',
            },
          ],
        },
      },
    })
    const merged = await readCache(NOW)
    expect(merged?.registry?.versions).toEqual(['0.2.2', '0.2.2-rc.5'])
    expect(merged?.releases?.byVersion['0.2.2']?.[0]?.items).toEqual(['修复退出码'])

    await writeCache({ registry: { checkedAt: NOW, channels: {}, versions: [], publishedAt: {} } })
    const replaced = await readCache(NOW)
    expect(replaced?.registry?.versions).toEqual([])
    expect(replaced?.releases?.byVersion['0.2.2']?.[0]?.items).toEqual(['修复退出码'])
  })

  test('writeCache({ registry: undefined }) 从文件里删掉 registry', async () => {
    await writeCache({ registry: registry(), releases: { checkedAt: NOW, byVersion: {} } })
    await writeCache({ registry: undefined })
    const raw = JSON.parse(await readFile(join(dir, 'cache.json'), 'utf8')) as Record<string, unknown>
    expect('registry' in raw).toBe(false)
    const cached = await readCache(NOW)
    expect(cached?.registry).toBeUndefined()
    expect(cached?.releases).not.toBeUndefined()
  })

  test('registry 与 releases 各自按 TTL 过期', async () => {
    await writeCache({
      registry: registry(NOW - 7 * HOUR),
      releases: { checkedAt: NOW, byVersion: {} },
    })
    const cached = await readCache(NOW)
    expect(cached?.registry).toBeUndefined()
    expect(cached?.releases).not.toBeUndefined()
  })
})

describe('待通知 marker', () => {
  test('写入后可读回，clear 后为 null', async () => {
    expect(await readPending()).toBeNull()
    await writePending({ from: '0.2.1', to: '0.2.2', startedAt: 123 })
    expect(await readPending()).toEqual({ from: '0.2.1', to: '0.2.2', startedAt: 123 })
    await clearPending()
    expect(await readPending()).toBeNull()
  })

  test('文件不存在时 clearPending 不抛', async () => {
    await expect(clearPending()).resolves.toBeUndefined()
  })

  test('from / to 为空串的 marker 读成 null', async () => {
    await writePending({ from: '', to: '0.2.2', startedAt: 1 })
    expect(await readPending()).toBeNull()
    await writePending({ from: '0.2.1', to: '', startedAt: 1 })
    expect(await readPending()).toBeNull()
  })

  test('形状不对的 marker 读成 null', async () => {
    await writePending({ from: '0.2.1', to: '0.2.2', startedAt: 123 })
    await writeFile(join(dir, 'pending.json'), '{"from":"0.2.1"}', 'utf8')
    expect(await readPending()).toBeNull()
  })
})

describe('上次结果', () => {
  test('缺文件返回 null，不抛', async () => {
    expect(await readLast()).toBeNull()
  })

  test('浅合并保留其它字段', async () => {
    await writeLast({ running: true })
    await writeLast({ running: false })
    expect(await readLast()).toEqual({ running: false })

    await writeLast({ lastResult: { to: '0.2.2', at: 111, restartRequired: true } })
    await writeLast({ lastError: { code: 'UPGRADE_FAILED', message: '网络不通', at: 222 } })
    expect(await readLast()).toEqual({
      running: false,
      lastResult: { to: '0.2.2', at: 111, restartRequired: true },
      lastError: { code: 'UPGRADE_FAILED', message: '网络不通', at: 222 },
    })
  })

  test('writeLast({ lastError: undefined }) 从文件里删掉错误字段', async () => {
    await writeLast({ running: true, lastError: { code: 'UPGRADE_FAILED', message: '网络不通', at: 222 } })
    await writeLast({
      running: false,
      lastResult: { to: '0.2.2', at: 111, restartRequired: true },
      lastError: undefined,
    })
    const raw = JSON.parse(await readFile(join(dir, 'last.json'), 'utf8')) as Record<string, unknown>
    expect('lastError' in raw).toBe(false)
    expect(await readLast()).toEqual({
      running: false,
      lastResult: { to: '0.2.2', at: 111, restartRequired: true },
    })
  })
})

describe('磁盘上的坏数据', () => {
  test('截断、空文件、非对象 JSON 一律读成 null', async () => {
    await writeFile(join(dir, 'cache.json'), '{"registry":{"checkedAt":', 'utf8')
    await writeFile(join(dir, 'pending.json'), '', 'utf8')
    await writeFile(join(dir, 'last.json'), '[]', 'utf8')
    expect(await readCache(NOW)).toBeNull()
    expect(await readPending()).toBeNull()
    expect(await readLast()).toBeNull()
  })
})

describe('原子写', () => {
  test('写完不留 .tmp 临时文件', async () => {
    await writeCache({ registry: registry() })
    await writePending({ from: '0.2.1', to: '0.2.2', startedAt: 1 })
    await writeLast({ running: true })
    const names = await readdir(dir)
    expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(names.sort()).toEqual(['cache.json', 'last.json', 'pending.json'])
  })
})

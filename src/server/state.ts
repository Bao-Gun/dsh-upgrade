import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Channel } from './versions'

/** 缓存里的一条版本记录；Task 5 的 ReleaseEntry 就是它的别名 */
export type CachedRelease = {
  version: string
  channel: Channel
  publishedAt: string
  items: string[]
  url: string
}

export type Cache = {
  registry?: {
    checkedAt: number
    channels: Record<string, string | undefined>
    versions: string[]
    publishedAt: Record<string, string>
  }
  releases?: {
    checkedAt: number
    byVersion: Record<string, CachedRelease[]>
  }
}

export type Pending = { from: string; to: string; startedAt: number }

export type Last = {
  running: boolean
  lastResult?: { to: string; at: number; restartRequired: boolean }
  lastError?: { code: string; message: string; at: number }
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_FILE = 'cache.json'
const PENDING_FILE = 'pending.json'
const LAST_FILE = 'last.json'

let tmpSeq = 0

export function rootDir(): string {
  const fromEnv = process.env.DSH_UPGRADE_ROOT
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh', 'dsh-upgrade')
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

export function backupDir(root: string, version: string): string {
  return join(root, 'backup', version)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读失败一律 null：文件不存在、读不了、坏 JSON、JSON 不是对象都算 */
async function readJsonRecord(file: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 先写临时文件再 rename，避免进程中途死掉留下半截 JSON */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.${(tmpSeq += 1)}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
    await rename(tmp, file)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

function isFreshSection(section: unknown, now: number, ttlMs: number): boolean {
  if (!isRecord(section)) return false
  const checkedAt = section.checkedAt
  if (typeof checkedAt !== 'number' || !Number.isFinite(checkedAt)) return false
  return now - checkedAt <= ttlMs
}

/**
 * registry 与 releases 各有自己的 checkedAt，因此各自判 TTL；
 * 两块都过期（或文件缺失/损坏）时返回 null。
 */
export async function readCache(
  now: number,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<Cache | null> {
  const raw = await readJsonRecord(join(rootDir(), CACHE_FILE))
  if (raw === null) return null
  const cache: Cache = {}
  if (isFreshSection(raw.registry, now, ttlMs)) {
    cache.registry = raw.registry as Cache['registry']
  }
  if (isFreshSection(raw.releases, now, ttlMs)) {
    cache.releases = raw.releases as Cache['releases']
  }
  if (cache.registry === undefined && cache.releases === undefined) return null
  return cache
}

/** 浅合并：只替换传进来的顶层分区，两个子对象各自整体替换 */
export async function writeCache(delta: Partial<Cache>): Promise<void> {
  const file = join(rootDir(), CACHE_FILE)
  const previous = (await readJsonRecord(file)) ?? {}
  const next: Record<string, unknown> = { ...previous }
  if (delta.registry !== undefined) next.registry = delta.registry
  if (delta.releases !== undefined) next.releases = delta.releases
  await writeJsonAtomic(file, next)
}

export async function readPending(): Promise<Pending | null> {
  const raw = await readJsonRecord(join(rootDir(), PENDING_FILE))
  if (raw === null) return null
  const { from, to, startedAt } = raw
  if (typeof from !== 'string' || typeof to !== 'string') return null
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null
  return { from, to, startedAt }
}

export async function writePending(pending: Pending): Promise<void> {
  await writeJsonAtomic(join(rootDir(), PENDING_FILE), pending)
}

export async function clearPending(): Promise<void> {
  await unlink(join(rootDir(), PENDING_FILE)).catch(() => {})
}

/** running 缺省按 false 读，其余字段原样带回 */
export async function readLast(): Promise<Last | null> {
  const raw = await readJsonRecord(join(rootDir(), LAST_FILE))
  if (raw === null) return null
  return { ...raw, running: raw.running === true } as Last
}

/** 浅合并：没传的字段保持不变 */
export async function writeLast(patch: Partial<Last>): Promise<void> {
  const file = join(rootDir(), LAST_FILE)
  const previous = (await readJsonRecord(file)) ?? {}
  const next: Record<string, unknown> = { ...previous }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value
  }
  await writeJsonAtomic(file, next)
}

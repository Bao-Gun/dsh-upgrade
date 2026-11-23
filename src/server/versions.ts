export type Channel = 'stable' | 'rc' | 'alpha'

type ParsedVersion = {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

const VERSION_RE = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(v: string): ParsedVersion | null {
  const m = VERSION_RE.exec(v.trim())
  if (!m) return null
  const major = m[1]
  const minor = m[2]
  const patch = m[3]
  if (major === undefined || minor === undefined || patch === undefined) return null
  const prerelease = m[4] === undefined ? [] : m[4].split('.')
  if (prerelease.some((part) => part === '')) return null
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease,
  }
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined || y === undefined) break
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff > 0 ? 1 : -1
      continue
    }
    if (xNumeric) return -1
    if (yNumeric) return 1
    if (x !== y) return x > y ? 1 : -1
  }
  if (a.length === b.length) return 0
  return a.length > b.length ? 1 : -1
}

function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1
  return comparePrerelease(a.prerelease, b.prerelease)
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) {
    throw new Error(`无法比较版本：${left === null ? a : b}`)
  }
  return compareParsed(left, right)
}

export function channelOf(v: string): Channel {
  const s = v.trim().toLowerCase()
  if (s.includes('-alpha.')) return 'alpha'
  if (s.includes('-rc.')) return 'rc'
  return 'stable'
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

export function pickNewest(
  candidates: string[],
  opts: { includePrerelease: boolean },
): string | null {
  let best: string | null = null
  let bestParsed: ParsedVersion | null = null
  for (const candidate of candidates) {
    const parsed = parseVersion(candidate)
    if (parsed === null) continue
    if (!opts.includePrerelease && parsed.prerelease.length > 0) continue
    if (bestParsed === null || compareParsed(parsed, bestParsed) > 0) {
      best = candidate
      bestParsed = parsed
    }
  }
  return best
}

type RangeVersion = ParsedVersion & { parts: 1 | 2 | 3 }

type Comparator = {
  operator: '^' | '~' | '>=' | '>' | '<=' | '<' | '='
  version: RangeVersion
}

const RANGE_VERSION_RE =
  /^[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseRangeVersion(raw: string): RangeVersion | null {
  const m = RANGE_VERSION_RE.exec(raw)
  if (!m) return null
  const major = m[1]
  if (major === undefined) return null
  const minor = m[2]
  const patch = m[3]
  const prerelease = m[4] === undefined ? [] : m[4].split('.')
  if (prerelease.some((part) => part === '')) return null
  const parts = patch !== undefined ? 3 : minor !== undefined ? 2 : 1
  return {
    major: Number(major),
    minor: minor === undefined ? 0 : Number(minor),
    patch: patch === undefined ? 0 : Number(patch),
    prerelease,
    parts,
  }
}

function parseComparator(token: string): Comparator | null {
  const m = /^(>=|<=|>|<|\^|~|=)?(.+)$/.exec(token)
  if (!m) return null
  const operator = m[1] === undefined ? '=' : (m[1] as Comparator['operator'])
  const version = parseRangeVersion(m[2] ?? '')
  if (version === null) return null
  return { operator, version }
}

function plain(major: number, minor: number, patch: number): ParsedVersion {
  return { major, minor, patch, prerelease: [] }
}

function caretUpper(v: RangeVersion): ParsedVersion {
  if (v.major > 0) return plain(v.major + 1, 0, 0)
  if (v.minor > 0) return plain(0, v.minor + 1, 0)
  return plain(0, 0, v.patch + 1)
}

function tildeUpper(v: RangeVersion): ParsedVersion {
  if (v.parts >= 2) return plain(v.major, v.minor + 1, 0)
  return plain(v.major + 1, 0, 0)
}

function matchesComparator(c: Comparator, current: ParsedVersion): boolean {
  switch (c.operator) {
    case '>':
      return compareParsed(current, c.version) > 0
    case '>=':
      return compareParsed(current, c.version) >= 0
    case '<':
      return compareParsed(current, c.version) < 0
    case '<=':
      return compareParsed(current, c.version) <= 0
    case '^':
      return (
        compareParsed(current, c.version) >= 0 &&
        compareParsed(current, caretUpper(c.version)) < 0
      )
    case '~':
      return (
        compareParsed(current, c.version) >= 0 &&
        compareParsed(current, tildeUpper(c.version)) < 0
      )
    case '=':
      return compareParsed(current, c.version) === 0
  }
}

function satisfiesSegment(segment: string, current: ParsedVersion): boolean {
  const normalized = segment.replace(/([<>~^=]+)\s+/g, '$1').trim()
  if (normalized === '') return true
  for (const token of normalized.split(/\s+/)) {
    if (token === '') continue
    const comparator = parseComparator(token)
    // 解析不了的范围宁可放行，也不因解析失败误拦升级
    if (comparator === null) return true
    if (!matchesComparator(comparator, current)) return false
  }
  return true
}

export function satisfiesNodeRange(range: string, current: string): boolean {
  const wanted = range.trim()
  if (wanted === '') return true
  const parsedCurrent = parseVersion(current)
  if (parsedCurrent === null) return true
  return wanted.split('||').some((segment) => satisfiesSegment(segment, parsedCurrent))
}

export function describeEnginesFailure(range: string, current: string): string {
  return `需要 Node ${range}，本机 ${current}`
}

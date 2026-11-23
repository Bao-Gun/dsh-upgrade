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

type RangeVersion = ParsedVersion & {
  /** 通配符之前的具体段数，`*` 为 0 */
  parts: number
  wildcard: boolean
}

type Comparator = {
  operator: '^' | '~' | '>=' | '>' | '<=' | '<' | '='
  version: RangeVersion
}

const RANGE_VERSION_RE =
  /^[vV]?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function isWildcardPart(part: string): boolean {
  return part === 'x' || part === 'X' || part === '*'
}

function parseRangeVersion(raw: string): RangeVersion | null {
  const m = RANGE_VERSION_RE.exec(raw)
  if (!m) return null
  const numbers: number[] = []
  let wildcard = false
  for (const group of [m[1], m[2], m[3]]) {
    if (group === undefined) break
    if (isWildcardPart(group)) {
      wildcard = true
      break
    }
    numbers.push(Number(group))
  }
  const prerelease = m[4] === undefined ? [] : m[4].split('.')
  if (prerelease.some((part) => part === '')) return null
  return {
    major: numbers[0] ?? 0,
    minor: numbers[1] ?? 0,
    patch: numbers[2] ?? 0,
    prerelease,
    parts: numbers.length,
    wildcard,
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

function floorOf(v: RangeVersion): ParsedVersion {
  return { major: v.major, minor: v.minor, patch: v.patch, prerelease: v.prerelease }
}

type Bounds = {
  lower: ParsedVersion
  upper: ParsedVersion | null
  upperInclusive: boolean
}

function boundsOf(v: RangeVersion): Bounds {
  const lower = floorOf(v)
  if (!v.wildcard && v.parts === 3) return { lower, upper: lower, upperInclusive: true }
  if (v.parts === 0) return { lower, upper: null, upperInclusive: false }
  const upper = v.parts === 1 ? plain(v.major + 1, 0, 0) : plain(v.major, v.minor + 1, 0)
  return { lower, upper, upperInclusive: false }
}

function caretUpper(v: RangeVersion): ParsedVersion | null {
  if (v.parts === 0) return null
  if (v.major > 0) return plain(v.major + 1, 0, 0)
  if (v.minor > 0) return plain(0, v.minor + 1, 0)
  if (v.patch > 0) return plain(0, 0, v.patch + 1)
  if (v.parts === 1) return plain(1, 0, 0)
  if (v.parts === 2) return plain(0, 1, 0)
  return plain(0, 0, 1)
}

function tildeUpper(v: RangeVersion): ParsedVersion | null {
  if (v.parts === 0) return null
  if (v.parts >= 2) return plain(v.major, v.minor + 1, 0)
  return plain(v.major + 1, 0, 0)
}

function matchesComparator(c: Comparator, current: ParsedVersion): boolean {
  const v = c.version
  if (v.parts === 0 && v.wildcard) return true
  const b = boundsOf(v)
  switch (c.operator) {
    case '=':
      if (b.upper === null) return true
      return (
        compareParsed(current, b.lower) >= 0 &&
        (b.upperInclusive
          ? compareParsed(current, b.upper) <= 0
          : compareParsed(current, b.upper) < 0)
      )
    case '>':
      if (b.upper === null) return false
      if (b.upperInclusive) return compareParsed(current, b.lower) > 0
      return compareParsed(current, b.upper) >= 0
    case '>=':
      return compareParsed(current, b.lower) >= 0
    case '<':
      return compareParsed(current, b.lower) < 0
    case '<=':
      if (b.upper === null) return true
      if (b.upperInclusive) return compareParsed(current, b.lower) <= 0
      return compareParsed(current, b.upper) < 0
    case '^': {
      const upper = caretUpper(v)
      if (upper === null) return true
      return compareParsed(current, b.lower) >= 0 && compareParsed(current, upper) < 0
    }
    case '~': {
      const upper = tildeUpper(v)
      if (upper === null) return true
      return compareParsed(current, b.lower) >= 0 && compareParsed(current, upper) < 0
    }
  }
}

function satisfiesHyphen(segment: string, current: ParsedVersion): boolean | null {
  const m = /^(\S+)\s+-\s+(\S+)$/.exec(segment)
  if (m === null) return null
  const left = parseRangeVersion(m[1] ?? '')
  const right = parseRangeVersion(m[2] ?? '')
  // 看得出是连字符范围但端点读不懂：按无法解析处理，放行
  if (left === null || right === null) return true
  if (left.parts > 0 && compareParsed(current, floorOf(left)) < 0) return false
  if (right.parts === 0) return true
  if (!right.wildcard && right.parts === 3) {
    return compareParsed(current, floorOf(right)) <= 0
  }
  const upper =
    right.parts === 1 ? plain(right.major + 1, 0, 0) : plain(right.major, right.minor + 1, 0)
  return compareParsed(current, upper) < 0
}

function satisfiesSegment(segment: string, current: ParsedVersion): boolean {
  const raw = segment.trim()
  if (raw === '') return true
  const hyphen = satisfiesHyphen(raw, current)
  if (hyphen !== null) return hyphen
  const normalized = raw.replace(/([<>~^=]+)\s+/g, '$1')
  for (const token of normalized.split(/\s+/)) {
    if (token === '') continue
    const comparator = parseComparator(token)
    // 真正无法解析的文本宁可放行，也不因解析失败误拦升级
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

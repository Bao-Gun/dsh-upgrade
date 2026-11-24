// src/server/host.ts
import { readFileSync, realpathSync } from "fs";
import { readFile as readFile2 } from "fs/promises";
import { dirname as dirname2, join as join2 } from "path";

// src/server/state.ts
import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
var DEFAULT_TTL_MS = 6 * 60 * 60 * 1e3;
var CACHE_FILE = "cache.json";
var PENDING_FILE = "pending.json";
var LAST_FILE = "last.json";
var tmpSeq = 0;
function rootDir() {
  const fromEnv = process.env.DSH_UPGRADE_ROOT;
  if (fromEnv !== void 0 && fromEnv !== "") return fromEnv;
  return join(homedir(), ".dsh", "dsh-upgrade");
}
async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}
function backupDir(root, version) {
  return join(root, "backup", version);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function readJsonRecord(file) {
  try {
    const text = await readFile(file, "utf8");
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
async function writeJsonAtomic(file, value) {
  await ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.${tmpSeq += 1}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => {
    });
    throw error;
  }
}
function isFreshSection(section, now, ttlMs) {
  if (!isRecord(section)) return false;
  const checkedAt = section.checkedAt;
  if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) return false;
  return now - checkedAt <= ttlMs;
}
async function readCache(now, ttlMs = DEFAULT_TTL_MS) {
  const raw = await readJsonRecord(join(rootDir(), CACHE_FILE));
  if (raw === null) return null;
  const cache = {};
  if (isFreshSection(raw.registry, now, ttlMs)) {
    cache.registry = raw.registry;
  }
  if (isFreshSection(raw.releases, now, ttlMs)) {
    cache.releases = raw.releases;
  }
  if (cache.registry === void 0 && cache.releases === void 0) return null;
  return cache;
}
async function writeCache(delta) {
  const file = join(rootDir(), CACHE_FILE);
  const previous = await readJsonRecord(file) ?? {};
  const next = { ...previous, ...delta };
  await writeJsonAtomic(file, next);
}
async function readPending() {
  const raw = await readJsonRecord(join(rootDir(), PENDING_FILE));
  if (raw === null) return null;
  const { from, to, startedAt } = raw;
  if (typeof from !== "string" || from === "" || typeof to !== "string" || to === "") {
    return null;
  }
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  return { from, to, startedAt };
}
async function writePending(pending) {
  await writeJsonAtomic(join(rootDir(), PENDING_FILE), pending);
}
async function clearPending() {
  await unlink(join(rootDir(), PENDING_FILE)).catch(() => {
  });
}
async function readLast() {
  const raw = await readJsonRecord(join(rootDir(), LAST_FILE));
  if (raw === null) return null;
  return { ...raw, running: raw.running === true };
}
async function writeLast(patch) {
  const file = join(rootDir(), LAST_FILE);
  const previous = await readJsonRecord(file) ?? {};
  const next = { ...previous, ...patch };
  await writeJsonAtomic(file, next);
}
async function readRestartRequired(current) {
  const last = await readLast();
  const result = last?.lastResult;
  return result !== void 0 && result.restartRequired === true && result.to === current;
}
async function clearRestartRequired(current) {
  try {
    const last = await readLast();
    const result = last?.lastResult;
    if (result === void 0 || result.restartRequired !== true || result.to !== current) return;
    await writeLast({ lastResult: { ...result, restartRequired: false } });
  } catch {
  }
}

// src/server/host.ts
var DSH_PACKAGE = "@deepseek-ai/dsh";
var REGISTRY_BASE = "https://registry.npmmirror.com";
var TIMEOUT_MS = 15e3;
var MAX_ANCESTOR_DEPTH = 12;
var EXTRA_INSTALL_DIRS = [
  "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh",
  "/usr/local/lib/node_modules/@deepseek-ai/dsh"
];
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function realpathOf(file) {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}
function ancestorsOf(file) {
  if (file === "") return [];
  const dirs = [];
  let dir = dirname2(realpathOf(file));
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    dirs.push(dir);
    const parent = dirname2(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}
function readJsonSync(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return isRecord2(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
async function readJson(file) {
  try {
    const parsed = JSON.parse(await readFile2(file, "utf8"));
    return isRecord2(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function isDshInstall(dir) {
  return readJsonSync(join2(dir, "package.json"))?.name === DSH_PACKAGE;
}
function findHostInstallDir(candidates) {
  const dirs = candidates ?? [
    ...ancestorsOf(process.argv[1] ?? ""),
    join2(dirname2(process.execPath), "..", "lib", "node_modules", DSH_PACKAGE),
    ...EXTRA_INSTALL_DIRS
  ];
  for (const dir of dirs) {
    if (dir !== "" && isDshInstall(dir)) return dir;
  }
  return null;
}
function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}
function notFoundError() {
  return codedError("HOST_NOT_FOUND", "\u627E\u4E0D\u5230 DSH \u5B89\u88C5\u76EE\u5F55");
}
async function readHostInfo(dir) {
  const target = dir ?? findHostInstallDir();
  if (target === null) throw notFoundError();
  const manifest = await readJson(join2(target, "package.json"));
  const version = manifest?.version;
  if (manifest === null || manifest.name !== DSH_PACKAGE || typeof version !== "string" || version === "") {
    throw notFoundError();
  }
  return { dir: target, version };
}
function packagePath(name2) {
  return name2.replace(/\//g, "%2f");
}
async function fetchJson(url, fetchImpl) {
  const networkMessage = "\u62C9\u53D6 registry \u5143\u6570\u636E\u5931\u8D25\uFF08\u7F51\u7EDC\u4E0D\u901A\u6216\u8BF7\u6C42\u8D85\u65F6\uFF09";
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch {
    throw codedError("REGISTRY_FETCH_FAILED", networkMessage);
  }
  if (!response.ok) {
    throw codedError("REGISTRY_HTTP_ERROR", `\u62C9\u53D6 registry \u5143\u6570\u636E\u5931\u8D25\uFF08HTTP ${response.status}\uFF09`);
  }
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw codedError("REGISTRY_INVALID_JSON", "registry \u8FD4\u56DE\u7684\u5185\u5BB9\u4E0D\u662F\u5408\u6CD5 JSON");
    }
    throw codedError("REGISTRY_FETCH_FAILED", "\u62C9\u53D6 registry \u5143\u6570\u636E\u5931\u8D25\uFF08\u8BFB\u53D6\u54CD\u5E94\u5185\u5BB9\u65F6\u4E2D\u65AD\u6216\u8D85\u65F6\uFF09");
  }
}
var CHANNEL_KEYS = ["latest", "next", "alpha"];
function channelsOf(tags) {
  const channels = {};
  for (const key of CHANNEL_KEYS) {
    const value = tags[key];
    if (typeof value === "string" && value !== "") channels[key] = value;
  }
  return channels;
}
function parseRegistry(payload) {
  if (!isRecord2(payload)) throw codedError("REGISTRY_INVALID_SHAPE", "registry \u8FD4\u56DE\u7684\u7ED3\u6784\u65E0\u6CD5\u8BC6\u522B");
  const rawVersions = isRecord2(payload.versions) ? payload.versions : {};
  const rawTime = isRecord2(payload.time) ? payload.time : {};
  const rawTags = isRecord2(payload["dist-tags"]) ? payload["dist-tags"] : {};
  const versions = Object.keys(rawVersions);
  const publishedAt = {};
  for (const version of versions) {
    const at = rawTime[version];
    if (typeof at === "string" && at !== "") publishedAt[version] = at;
  }
  return { versions, channels: channelsOf(rawTags), publishedAt };
}
async function fetchRegistry(opts = {}) {
  const now = opts.now ?? Date.now();
  if (opts.force !== true) {
    const cached = (await readCache(now))?.registry;
    if (cached !== void 0) {
      return {
        info: {
          versions: cached.versions,
          channels: channelsOf(cached.channels),
          publishedAt: cached.publishedAt
        },
        cached: true
      };
    }
  }
  const payload = await fetchJson(
    `${REGISTRY_BASE}/${packagePath(DSH_PACKAGE)}`,
    opts.fetchImpl ?? fetch
  );
  const info = parseRegistry(payload);
  await writeCache({
    registry: {
      checkedAt: now,
      channels: info.channels,
      versions: info.versions,
      publishedAt: info.publishedAt
    }
  });
  return { info, cached: false };
}
async function readTargetManifest(target, fetchImpl = fetch) {
  const payload = await fetchJson(
    `${REGISTRY_BASE}/${packagePath(DSH_PACKAGE)}/${encodeURIComponent(target)}`,
    fetchImpl
  );
  if (!isRecord2(payload)) return {};
  const engines = payload.engines;
  if (!isRecord2(engines)) return {};
  const node = engines.node;
  if (typeof node !== "string" || node === "") return {};
  return { engines: { node } };
}

// src/server/notify.ts
import { spawn } from "child_process";
var PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var NOTIFICATION_TITLE = "DSH \u5DF2\u5347\u7EA7";
function escapeForAppleScript(text) {
  return text.replace(/"/g, '\\"');
}
function notificationScript(title, body) {
  return `display notification "${escapeForAppleScript(body)}" with title "${escapeForAppleScript(title)}"`;
}
function notifyCommand(platform, title, body) {
  switch (platform) {
    case "darwin":
      return ["osascript", "-e", notificationScript(title, body)];
    case "linux":
      return ["notify-send", title, body];
    default:
      return [];
  }
}
function runNotifyDefault(argv) {
  if (argv.length === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(argv[0], argv.slice(1), { stdio: "ignore" });
      child.on("error", () => finish(false));
      child.on("close", (code) => finish(code === 0));
    } catch {
      finish(false);
    }
  });
}
async function markPending(from, to, now = Date.now()) {
  await writePending({ from, to, startedAt: now }).catch(() => {
  });
}
function decide(pending, current, now) {
  if (now - pending.startedAt > PENDING_TTL_MS) return "clear";
  if (current === pending.to) return "notify";
  if (current === pending.from) return "wait";
  return "clear";
}
async function notifyUpgraded(to, deps) {
  const run2 = deps?.runNotify ?? runNotifyDefault;
  try {
    const argv = notifyCommand(process.platform, NOTIFICATION_TITLE, `\u5DF2\u5347\u7EA7\u5230 ${to}\uFF0C\u8FDB\u7A0B\u5DF2\u91CD\u542F`);
    return await run2(argv) === true;
  } catch {
    return false;
  }
}
async function settlePending(current, now = Date.now(), deps) {
  const pending = await readPending();
  if (pending === null) return;
  const outcome = decide(pending, current, now);
  if (outcome === "wait") return;
  try {
    if (outcome === "notify") await notifyUpgraded(pending.to, deps);
  } finally {
    await clearPending();
  }
}

// src/server/lock.ts
var running = false;
function tryAcquireUpgrade() {
  if (running) return false;
  running = true;
  return true;
}
function releaseUpgrade() {
  running = false;
}

// src/server/versions.ts
var VERSION_RE = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
function parseVersion(v) {
  const m = VERSION_RE.exec(v.trim());
  if (!m) return null;
  const major = m[1];
  const minor = m[2];
  const patch = m[3];
  if (major === void 0 || minor === void 0 || patch === void 0) return null;
  const prerelease = m[4] === void 0 ? [] : m[4].split(".");
  if (prerelease.some((part) => part === "")) return null;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease
  };
}
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const x = a[i];
    const y = b[i];
    if (x === void 0 || y === void 0) break;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff > 0 ? 1 : -1;
      continue;
    }
    if (xNumeric) return -1;
    if (yNumeric) return 1;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (a.length === b.length) return 0;
  return a.length > b.length ? 1 : -1;
}
function compareParsed(a, b) {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) {
    throw new Error(`\u65E0\u6CD5\u6BD4\u8F83\u7248\u672C\uFF1A${left === null ? a : b}`);
  }
  return compareParsed(left, right);
}
function channelOf(v) {
  const s = v.trim().toLowerCase();
  if (s.includes("-alpha.")) return "alpha";
  if (s.includes("-rc.")) return "rc";
  return "stable";
}
function pickNewest(candidates, opts) {
  let best = null;
  let bestParsed = null;
  for (const candidate of candidates) {
    const parsed = parseVersion(candidate);
    if (parsed === null) continue;
    if (!opts.includePrerelease && parsed.prerelease.length > 0) continue;
    if (bestParsed === null || compareParsed(parsed, bestParsed) > 0) {
      best = candidate;
      bestParsed = parsed;
    }
  }
  return best;
}
var RANGE_VERSION_RE = /^[vV]?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
function isWildcardPart(part) {
  return part === "x" || part === "X" || part === "*";
}
function parseRangeVersion(raw) {
  const m = RANGE_VERSION_RE.exec(raw);
  if (!m) return null;
  const numbers = [];
  let wildcard = false;
  for (const group of [m[1], m[2], m[3]]) {
    if (group === void 0) break;
    if (isWildcardPart(group)) {
      wildcard = true;
      break;
    }
    numbers.push(Number(group));
  }
  const prerelease = m[4] === void 0 ? [] : m[4].split(".");
  if (prerelease.some((part) => part === "")) return null;
  return {
    major: numbers[0] ?? 0,
    minor: numbers[1] ?? 0,
    patch: numbers[2] ?? 0,
    prerelease,
    parts: numbers.length,
    wildcard
  };
}
function parseComparator(token) {
  const m = /^(>=|<=|>|<|\^|~|=)?(.+)$/.exec(token);
  if (!m) return null;
  const operator = m[1] === void 0 ? "=" : m[1];
  const version = parseRangeVersion(m[2] ?? "");
  if (version === null) return null;
  return { operator, version };
}
function plain(major, minor, patch) {
  return { major, minor, patch, prerelease: [] };
}
function floorOf(v) {
  return { major: v.major, minor: v.minor, patch: v.patch, prerelease: v.prerelease };
}
function boundsOf(v) {
  const lower = floorOf(v);
  if (!v.wildcard && v.parts === 3) return { lower, upper: lower, upperInclusive: true };
  if (v.parts === 0) return { lower, upper: null, upperInclusive: false };
  const upper = v.parts === 1 ? plain(v.major + 1, 0, 0) : plain(v.major, v.minor + 1, 0);
  return { lower, upper, upperInclusive: false };
}
function caretUpper(v) {
  if (v.parts === 0) return null;
  if (v.major > 0) return plain(v.major + 1, 0, 0);
  if (v.minor > 0) return plain(0, v.minor + 1, 0);
  if (v.patch > 0) return plain(0, 0, v.patch + 1);
  if (v.parts === 1) return plain(1, 0, 0);
  if (v.parts === 2) return plain(0, 1, 0);
  return plain(0, 0, 1);
}
function tildeUpper(v) {
  if (v.parts === 0) return null;
  if (v.parts >= 2) return plain(v.major, v.minor + 1, 0);
  return plain(v.major + 1, 0, 0);
}
function matchesComparator(c, current) {
  const v = c.version;
  if (v.parts === 0 && v.wildcard) return true;
  const b = boundsOf(v);
  switch (c.operator) {
    case "=":
      if (b.upper === null) return true;
      return compareParsed(current, b.lower) >= 0 && (b.upperInclusive ? compareParsed(current, b.upper) <= 0 : compareParsed(current, b.upper) < 0);
    case ">":
      if (b.upper === null) return false;
      if (b.upperInclusive) return compareParsed(current, b.lower) > 0;
      return compareParsed(current, b.upper) >= 0;
    case ">=":
      return compareParsed(current, b.lower) >= 0;
    case "<":
      return compareParsed(current, b.lower) < 0;
    case "<=":
      if (b.upper === null) return true;
      if (b.upperInclusive) return compareParsed(current, b.lower) <= 0;
      return compareParsed(current, b.upper) < 0;
    case "^": {
      const upper = caretUpper(v);
      if (upper === null) return true;
      return compareParsed(current, b.lower) >= 0 && compareParsed(current, upper) < 0;
    }
    case "~": {
      const upper = tildeUpper(v);
      if (upper === null) return true;
      return compareParsed(current, b.lower) >= 0 && compareParsed(current, upper) < 0;
    }
  }
}
function satisfiesHyphen(segment, current) {
  const m = /^(\S+)\s+-\s+(\S+)$/.exec(segment);
  if (m === null) return null;
  const left = parseRangeVersion(m[1] ?? "");
  const right = parseRangeVersion(m[2] ?? "");
  if (left === null || right === null) return true;
  if (left.parts > 0 && compareParsed(current, floorOf(left)) < 0) return false;
  if (right.parts === 0) return true;
  if (!right.wildcard && right.parts === 3) {
    return compareParsed(current, floorOf(right)) <= 0;
  }
  const upper = right.parts === 1 ? plain(right.major + 1, 0, 0) : plain(right.major, right.minor + 1, 0);
  return compareParsed(current, upper) < 0;
}
function satisfiesSegment(segment, current) {
  const raw = segment.trim();
  if (raw === "") return true;
  const hyphen = satisfiesHyphen(raw, current);
  if (hyphen !== null) return hyphen;
  const normalized = raw.replace(/([<>~^=]+)\s+/g, "$1");
  for (const token of normalized.split(/\s+/)) {
    if (token === "") continue;
    const comparator = parseComparator(token);
    if (comparator === null) return true;
    if (!matchesComparator(comparator, current)) return false;
  }
  return true;
}
function satisfiesNodeRange(range, current) {
  const wanted = range.trim();
  if (wanted === "") return true;
  const parsedCurrent = parseVersion(current);
  if (parsedCurrent === null) return true;
  return wanted.split("||").some((segment) => satisfiesSegment(segment, parsedCurrent));
}
function describeEnginesFailure(range, current) {
  return `\u9700\u8981 Node ${range}\uFF0C\u672C\u673A ${current}`;
}

// src/server/releases.ts
var RELEASES_URL = "https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=30";
var RELEASE_PAGE_BASE = "https://github.com/deepseek-ai/deepseek-harness/releases/tag/";
var TAG_PREFIX = "dsh-v";
var DEFAULT_TIMEOUT_MS = 8e3;
var CN_SECTION_RE = /<h3[^>]*id="cn-[^"]*"[^>]*>([\s\S]*?)(?=<h3[^>]*id="en-|$)/;
function decodeEntities(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
function extractChineseItems(body) {
  const section = CN_SECTION_RE.exec(body);
  if (section === null) return [];
  const text = decodeEntities(
    (section[1] ?? "").replace(/<\/h3>/g, "\n").replace(/<li[^>]*>/g, "\n").replace(/<[^>]+>/g, "")
  );
  const items = [];
  for (const line of text.split("\n")) {
    const item = line.trim().replace(/^[-*+]\s+/, "").trim();
    if (item !== "") items.push(item);
  }
  return items;
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function releaseOf(raw) {
  if (!isRecord3(raw)) return null;
  const tag = raw.tag_name;
  if (typeof tag !== "string" || !tag.startsWith(TAG_PREFIX)) return null;
  const version = tag.slice(TAG_PREFIX.length);
  if (parseVersion(version) === null) return null;
  const publishedAt = raw.published_at;
  const htmlUrl = raw.html_url;
  const body = raw.body;
  return {
    version,
    channel: channelOf(version),
    publishedAt: typeof publishedAt === "string" ? publishedAt : "",
    items: typeof body === "string" ? extractChineseItems(body) : [],
    url: typeof htmlUrl === "string" && htmlUrl !== "" ? htmlUrl : `${RELEASE_PAGE_BASE}${tag}`
  };
}
async function fetchWithTimeout(url, fetchImpl, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      fetchImpl(url, {
        headers: { accept: "application/vnd.github+json", "user-agent": "dsh-upgrade" },
        signal: AbortSignal.timeout(timeoutMs)
      }),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("\u62C9\u53D6 release \u8D85\u65F6")), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== void 0) clearTimeout(timer);
  }
}
async function fetchReleases(range) {
  if (parseVersion(range.from) === null || parseVersion(range.to) === null) {
    return { releases: [], degraded: true };
  }
  let payload;
  try {
    const response = await fetchWithTimeout(
      RELEASES_URL,
      range.fetchImpl ?? fetch,
      range.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    if (!response.ok) return { releases: [], degraded: true };
    payload = await response.json();
  } catch {
    return { releases: [], degraded: true };
  }
  if (!Array.isArray(payload)) return { releases: [], degraded: true };
  const releases = [];
  for (const raw of payload) {
    const release = releaseOf(raw);
    if (release === null) continue;
    if (compareVersions(release.version, range.from) <= 0) continue;
    if (compareVersions(release.version, range.to) > 0) continue;
    releases.push(release);
  }
  releases.sort((a, b) => compareVersions(b.version, a.version));
  return { releases, degraded: false };
}

// src/server/survey.ts
function newerVersions(versions, current) {
  const newer = [];
  for (const version of versions) {
    try {
      if (compareVersions(version, current) > 0) newer.push(version);
    } catch {
    }
  }
  return newer;
}
async function enginesBlockedOf(version, deps) {
  try {
    const engines = (await deps.readTargetManifest(version)).engines?.node ?? null;
    if (engines === null) return void 0;
    const node = deps.nodeVersion();
    if (satisfiesNodeRange(engines, node)) return void 0;
    return { code: "RUNTIME_UNSUPPORTED", message: describeEnginesFailure(engines, node) };
  } catch {
    return void 0;
  }
}
async function surveyOf(current, info, includePrerelease, deps) {
  const channels = {
    latest: info.channels.latest ?? null,
    next: info.channels.next ?? null,
    alpha: info.channels.alpha ?? null
  };
  const newer = newerVersions(info.versions, current);
  const target = pickNewest(newer, { includePrerelease }) ?? current;
  const probe = target !== current ? target : pickNewest(newer, { includePrerelease: true });
  const blocked = probe !== null && probe !== current ? await enginesBlockedOf(probe, deps) : void 0;
  const candidates = newer.slice().sort((a, b) => compareVersions(b, a)).map((version) => ({
    version,
    channel: channelOf(version),
    publishedAt: info.publishedAt[version] ?? null
  }));
  if (blocked !== void 0 && probe !== null) {
    const candidate = candidates.find((item) => item.version === probe);
    if (candidate !== void 0) candidate.blocked = blocked;
  }
  return {
    current,
    channels,
    target,
    ...blocked === void 0 ? {} : { blocked },
    includePrerelease,
    candidates
  };
}

// src/server/upgrade.ts
import { spawn as spawn2 } from "child_process";
import { constants, existsSync } from "fs";
import { access, mkdir as mkdir2, readFile as readFile3, rename as rename2, rm, statfs as nodeStatfs } from "fs/promises";
import { tmpdir } from "os";
import { dirname as dirname3, join as join4 } from "path";

// src/server/clone.ts
function cloneCandidates(platform, source, dest) {
  if (platform === "darwin") {
    return [
      ["-c", "-R", source, dest],
      ["-R", source, dest]
    ];
  }
  if (platform === "linux") {
    return [
      ["--reflink=auto", "-R", source, dest],
      ["-R", source, dest]
    ];
  }
  return [["-R", source, dest]];
}

// src/server/npm.ts
import { delimiter as pathDelimiter, isAbsolute, join as join3, sep } from "path";
var INSTALL_SUFFIX = join3("lib", "node_modules", "@deepseek-ai", "dsh");
function npmPrefixOf(installDir) {
  if (!isAbsolute(installDir)) return null;
  const suffix = sep + INSTALL_SUFFIX;
  if (!installDir.endsWith(suffix)) return null;
  const prefix = installDir.slice(0, -suffix.length);
  return prefix === "" ? null : prefix;
}
function npmBin(nodeDir, exists) {
  const candidate = join3(nodeDir, "npm");
  return exists(candidate) ? candidate : "npm";
}
function npmEnv(env, nodeDir, delimiter = pathDelimiter) {
  const current = env.PATH ?? "";
  if (current === "") return { ...env, PATH: nodeDir };
  if (current.split(delimiter).includes(nodeDir)) return { ...env };
  return { ...env, PATH: nodeDir + delimiter + current };
}

// src/server/upgrade.ts
var MIN_FREE_BYTES = 2500 * 1024 * 1024;
var NPM_TIMEOUT_MS = 15 * 60 * 1e3;
var PROBE_TIMEOUT_MS = 60 * 1e3;
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const spawnOptions = {};
    if (options.cwd !== void 0) spawnOptions.cwd = options.cwd;
    if (options.env !== void 0) spawnOptions.env = options.env;
    const child = spawn2(command, args, spawnOptions);
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer !== void 0) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    if (child.stdout !== null) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    if (child.stderr !== null) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", (error) => {
      stderr += stderr === "" ? error.message : `
${error.message}`;
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
    if (options.timeoutMs !== void 0) {
      const timeoutMs = options.timeoutMs;
      timer = setTimeout(() => {
        const note = `\u547D\u4EE4\u8D85\u65F6\uFF08${timeoutMs} ms\uFF09`;
        stderr += stderr === "" ? note : `
${note}`;
        child.kill("SIGKILL");
        finish(-1);
      }, timeoutMs);
      timer.unref();
    }
  });
}
async function statfsOf(path) {
  const stats = await nodeStatfs(path);
  return { bavail: Number(stats.bavail), bsize: Number(stats.bsize) };
}
async function removeDirDefault(path) {
  await rm(path, { recursive: true, force: true });
}
async function cloneDirDefault(src, dst) {
  await mkdir2(dirname3(dst), { recursive: true });
  let lastStderr = "";
  for (const args of cloneCandidates(process.platform, src, dst)) {
    await removeDirDefault(dst);
    const result = await run("cp", args);
    if (result.code === 0) return;
    lastStderr = result.stderr.trim();
  }
  throw new Error(lastStderr === "" ? "\u590D\u5236\u5B89\u88C5\u76EE\u5F55\u5931\u8D25" : lastStderr);
}
async function moveDirDefault(src, dst) {
  try {
    await rename2(src, dst);
    return;
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
  }
  await mkdir2(dirname3(dst), { recursive: true });
  const copied = await run("cp", ["-R", src, dst]);
  if (copied.code !== 0) {
    throw new Error(copied.stderr.trim() === "" ? "\u79FB\u52A8\u5B89\u88C5\u76EE\u5F55\u5931\u8D25" : copied.stderr.trim());
  }
  await rm(src, { recursive: true, force: true });
}
async function pathWritable(path) {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
async function readPackageVersion(dir) {
  try {
    const parsed = JSON.parse(await readFile3(join4(dir, "package.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const version = parsed["version"];
    return typeof version === "string" && version !== "" ? version : null;
  } catch {
    return null;
  }
}
async function runProbe(dir) {
  const result = await run(process.execPath, [join4(dir, "lib", "bin.js"), "--version"], {
    timeoutMs: PROBE_TIMEOUT_MS
  });
  if (result.code !== 0) return null;
  const first = result.stdout.split("\n")[0]?.trim() ?? "";
  return first === "" ? null : first;
}
function npmInstall(target, prefix, timeoutMs) {
  const nodeDir = dirname3(process.execPath);
  return run(npmBin(nodeDir, existsSync), ["i", "-g", "--prefix", prefix, `@deepseek-ai/dsh@${target}`], {
    cwd: tmpdir(),
    timeoutMs,
    env: npmEnv(process.env, nodeDir)
  });
}
async function targetEngines(version) {
  const manifest = await readTargetManifest(version);
  return manifest.engines?.node ?? null;
}
var defaultDeps = {
  statfs: statfsOf,
  checkWritable: pathWritable,
  cloneDir: cloneDirDefault,
  removeDir: removeDirDefault,
  moveDir: moveDirDefault,
  runNpmInstall: npmInstall,
  readInstalledVersion: readPackageVersion,
  runVersionProbe: runProbe,
  readTargetEngines: targetEngines,
  nodeVersion: () => process.versions.node
};
function mergeDeps(overrides) {
  return {
    statfs: overrides?.statfs ?? defaultDeps.statfs,
    checkWritable: overrides?.checkWritable ?? defaultDeps.checkWritable,
    cloneDir: overrides?.cloneDir ?? defaultDeps.cloneDir,
    removeDir: overrides?.removeDir ?? defaultDeps.removeDir,
    moveDir: overrides?.moveDir ?? defaultDeps.moveDir,
    runNpmInstall: overrides?.runNpmInstall ?? defaultDeps.runNpmInstall,
    readInstalledVersion: overrides?.readInstalledVersion ?? defaultDeps.readInstalledVersion,
    runVersionProbe: overrides?.runVersionProbe ?? defaultDeps.runVersionProbe,
    readTargetEngines: overrides?.readTargetEngines ?? defaultDeps.readTargetEngines,
    nodeVersion: overrides?.nodeVersion ?? defaultDeps.nodeVersion
  };
}
function describeFree(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "\u672A\u77E5";
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
async function runUpgrade(input, emit) {
  const { target, installDir, root } = input;
  const deps = mergeDeps(input.deps);
  const fail = (error, options = {}) => {
    emit({ phase: "fail", message: options.message ?? error.message, done: true, error });
    return options.rolledBack === void 0 ? { ok: false, error } : { ok: false, rolledBack: options.rolledBack, error };
  };
  emit({ phase: "precheck", message: "\u68C0\u67E5 Node \u7248\u672C\u4E0E\u78C1\u76D8\u53EF\u7528\u7A7A\u95F4" });
  const node = deps.nodeVersion();
  let engines;
  try {
    engines = await deps.readTargetEngines(target);
  } catch (error) {
    return fail({ code: "INSTALL_FAILED", message: `\u8BFB\u53D6\u76EE\u6807\u7248\u672C\u7684 engines \u5931\u8D25\uFF1A${errorMessage(error)}` });
  }
  if (engines !== null && !satisfiesNodeRange(engines, node)) {
    return fail({
      code: "RUNTIME_UNSUPPORTED",
      message: `Node \u7248\u672C\u4E0D\u6EE1\u8DB3\u76EE\u6807\u8981\u6C42\uFF1A${describeEnginesFailure(engines, node)}`
    });
  }
  let free;
  try {
    const stats = await deps.statfs(installDir);
    free = stats.bavail * stats.bsize;
  } catch (error) {
    return fail({ code: "INSTALL_FAILED", message: `\u8BFB\u53D6\u78C1\u76D8\u53EF\u7528\u7A7A\u95F4\u5931\u8D25\uFF1A${errorMessage(error)}` });
  }
  if (!Number.isFinite(free) || free < MIN_FREE_BYTES) {
    return fail({
      code: "NO_SPACE",
      message: `\u78C1\u76D8\u53EF\u7528\u7A7A\u95F4\u4E0D\u8DB3\uFF1A\u9700\u8981 2.5 GB\uFF0C\u5F53\u524D ${describeFree(free)}`
    });
  }
  const prefix = npmPrefixOf(installDir);
  if (prefix === null) {
    return fail({
      code: "INSTALL_FAILED",
      message: `\u65E0\u6CD5\u4ECE\u5B89\u88C5\u76EE\u5F55\u63A8\u5BFC npm \u5168\u5C40\u524D\u7F00\uFF1A${installDir}\uFF08\u671F\u671B <prefix>/lib/node_modules/@deepseek-ai/dsh\uFF09`
    });
  }
  let from;
  try {
    from = await deps.readInstalledVersion(installDir);
  } catch (error) {
    return fail({ code: "INSTALL_FAILED", message: `\u8BFB\u53D6\u5F53\u524D\u5B89\u88C5\u7248\u672C\u5931\u8D25\uFF1A${errorMessage(error)}` });
  }
  if (from === null) {
    return fail({ code: "INSTALL_FAILED", message: "\u8BFB\u4E0D\u5230\u5F53\u524D\u5B89\u88C5\u7248\u672C\uFF0C\u672A\u505A\u4EFB\u4F55\u6539\u52A8" });
  }
  for (const path of [installDir, join4(prefix, "lib", "node_modules"), join4(prefix, "bin")]) {
    let writable;
    try {
      writable = await deps.checkWritable(path);
    } catch {
      writable = false;
    }
    if (writable) continue;
    return fail({
      code: "INSTALL_DIR_NOT_WRITABLE",
      message: `\u5B89\u88C5\u76EE\u5F55\u4E0D\u53EF\u5199\uFF1A${path}\uFF08\u5C5E\u4E3B\u4E0D\u662F\u4F60\uFF09\uFF0C\u63D2\u4EF6\u65E0\u6CD5\u5347\u7EA7\u672C\u4F53\u3002
\u624B\u52A8\u6267\u884C\uFF1Asudo npm i -g --prefix ${prefix} @deepseek-ai/dsh@${target}`
    });
  }
  const backup = backupDir(root, from);
  emit({ phase: "backup", message: `\u5907\u4EFD\u5F53\u524D\u7248\u672C ${from} \u5230 ${backup}` });
  try {
    await deps.cloneDir(installDir, backup);
  } catch (error) {
    return fail({ code: "INSTALL_FAILED", message: `\u5907\u4EFD\u5931\u8D25\uFF1A${errorMessage(error)}` });
  }
  const rollback = async (original) => {
    emit({ phase: "rollback", message: `\u5347\u7EA7\u5931\u8D25\uFF0C\u56DE\u6EDA\u5230 ${from}` });
    const problems = [];
    try {
      await deps.removeDir(installDir);
    } catch (error) {
      problems.push(`\u5220\u9664\u65B0\u5B89\u88C5\u5931\u8D25\uFF08${errorMessage(error)}\uFF09`);
    }
    try {
      await deps.moveDir(backup, installDir);
    } catch (error) {
      problems.push(`\u6062\u590D\u5907\u4EFD\u5931\u8D25\uFF08${errorMessage(error)}\uFF09`);
    }
    if (problems.length > 0) {
      return fail(
        { code: "ROLLBACK_FAILED", message: `\u56DE\u6EDA\u5931\u8D25\uFF0CDSH \u53EF\u80FD\u5DF2\u4E0D\u53EF\u7528\uFF1A${problems.join("\uFF1B")}` },
        { rolledBack: false }
      );
    }
    return fail(original, {
      rolledBack: true,
      message: `\u5DF2\u56DE\u6EDA\u5230 ${from}\uFF1A${original.message}`
    });
  };
  emit({ phase: "install", message: `\u5B89\u88C5 @deepseek-ai/dsh@${target}` });
  let install;
  try {
    install = await deps.runNpmInstall(target, prefix, NPM_TIMEOUT_MS);
  } catch (error) {
    return await rollback({ code: "INSTALL_FAILED", message: `\u5B89\u88C5\u5931\u8D25\uFF1A${errorMessage(error)}` });
  }
  if (install.code !== 0) {
    const detail = install.stderr.trim() === "" ? install.stdout.trim() : install.stderr.trim();
    const message = detail === "" ? `\u5B89\u88C5\u5931\u8D25\uFF08\u9000\u51FA\u7801 ${install.code}\uFF09` : `\u5B89\u88C5\u5931\u8D25\uFF08\u9000\u51FA\u7801 ${install.code}\uFF09\uFF1A${detail}`;
    return await rollback({ code: "INSTALL_FAILED", message });
  }
  emit({ phase: "verify", message: "\u6821\u9A8C\u5B89\u88C5\u540E\u7684\u7248\u672C" });
  let installed;
  try {
    installed = await deps.readInstalledVersion(installDir);
  } catch (error) {
    return await rollback({
      code: "VERSION_MISMATCH",
      message: `\u8BFB\u53D6\u5B89\u88C5\u540E\u7248\u672C\u5931\u8D25\uFF1A${errorMessage(error)}`
    });
  }
  if (installed !== target) {
    return await rollback({
      code: "VERSION_MISMATCH",
      message: `\u5B89\u88C5\u540E\u7248\u672C\u4E0D\u7B26\uFF1A\u671F\u671B ${target}\uFF0C\u5B9E\u9645 ${installed ?? "\u672A\u77E5"}`
    });
  }
  let probed;
  try {
    probed = await deps.runVersionProbe(installDir);
  } catch (error) {
    return await rollback({
      code: "VERSION_MISMATCH",
      message: `\u8FD0\u884C dsh --version \u5931\u8D25\uFF1A${errorMessage(error)}`
    });
  }
  if (probed !== target) {
    return await rollback({
      code: "VERSION_MISMATCH",
      message: probed === null ? "\u5B89\u88C5\u540E\u7684 dsh \u65E0\u6CD5\u8FD0\u884C\uFF08\u7248\u672C\u63A2\u6D4B\u5931\u8D25\uFF09" : `\u5B89\u88C5\u540E dsh --version \u8F93\u51FA\u4E0D\u7B26\uFF1A\u671F\u671B ${target}\uFF0C\u5B9E\u9645 ${probed}`
    });
  }
  try {
    await deps.removeDir(backup);
  } catch {
  }
  emit({ phase: "done", message: `\u5DF2\u5347\u7EA7\u5230 ${target}\uFF0C\u9700\u91CD\u542F\u751F\u6548`, done: true });
  return { ok: true };
}

// src/server/routes.ts
var STATUS_PATH = "/dsh-upgrade/api/status";
var CHECK_PATH = "/dsh-upgrade/api/check";
var RELEASES_PATH = "/dsh-upgrade/api/releases";
var UPGRADE_PATH = "/dsh-upgrade/api/upgrade";
var GUARD_HEADER = "x-dsh-upgrade";
var ALLOWED_METHODS = /* @__PURE__ */ new Set(["GET", "POST"]);
var MAX_BODY_BYTES = 64 * 1024;
var SAFE_ERROR_CODES = /* @__PURE__ */ new Set([
  "HOST_NOT_FOUND",
  "REGISTRY_FETCH_FAILED",
  "REGISTRY_HTTP_ERROR",
  "REGISTRY_INVALID_JSON",
  "REGISTRY_INVALID_SHAPE"
]);
var INVALID_JSON = /* @__PURE__ */ Symbol("invalid-json");
function registerUpgradeRoutes(ctx, overrides = {}) {
  const deps = resolveDeps(overrides);
  const handlers = [
    [STATUS_PATH, "GET", statusHandler(deps)],
    [CHECK_PATH, "POST", checkHandler(deps)],
    [RELEASES_PATH, "GET", releasesHandler(deps)],
    [UPGRADE_PATH, "POST", upgradeHandler(deps)]
  ];
  for (const [path, method, handler] of handlers) {
    const webServer = ctx.webServer;
    if (typeof ctx.effect === "function" && webServer !== void 0) {
      ctx.effect(
        () => webServer.register({ kind: "exact", path, handler: adapt(handler) }),
        `dsh-upgrade: ${path}`
      );
      continue;
    }
    if (typeof ctx.route === "function") {
      ctx.route(method, path, handler);
      continue;
    }
    throw new Error("\u5BBF\u4E3B\u6CA1\u6709\u63D0\u4F9B\u53EF\u7528\u7684\u8DEF\u7531\u6CE8\u518C\u63A5\u53E3");
  }
}
function resolveDeps(overrides) {
  return {
    readHostInfo: overrides.readHostInfo ?? readHostInfo,
    fetchRegistry: overrides.fetchRegistry ?? fetchRegistry,
    readTargetManifest: overrides.readTargetManifest ?? readTargetManifest,
    fetchReleases: overrides.fetchReleases ?? fetchReleases,
    runUpgrade: overrides.runUpgrade ?? runUpgrade,
    nodeVersion: overrides.nodeVersion ?? (() => process.versions.node),
    now: overrides.now ?? (() => Date.now())
  };
}
function checkGate(req, origin, host) {
  if (!ALLOWED_METHODS.has(req.method.toUpperCase())) return false;
  if (headerOf(req.headers, GUARD_HEADER) !== "1") return false;
  const actualOrigin = origin ?? headerOf(req.headers, "origin");
  if (actualOrigin === void 0) return true;
  const actualHost = host ?? headerOf(req.headers, "host");
  if (actualHost === void 0 || actualHost === "") return false;
  try {
    const parsed = new URL(actualOrigin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return parsed.host.toLowerCase() === actualHost.toLowerCase();
  } catch {
    return false;
  }
}
function statusHandler(deps) {
  return async (req, res) => {
    if (!guard(req, res, "GET")) return;
    try {
      const [host, registry] = await Promise.all([
        deps.readHostInfo(),
        deps.fetchRegistry({ force: false })
      ]);
      const survey = await surveyOf(host.version, registry.info, false, deps);
      const restartRequired = await readRestartRequired(host.version);
      respondJson(res, 200, {
        current: survey.current,
        channels: survey.channels,
        target: survey.target,
        // R3：状态接口键集稳定，没有拦因也显式给 null，前端不用判 key 是否存在。
        blocked: survey.blocked ?? null,
        includePrerelease: survey.includePrerelease,
        restartRequired
      });
    } catch (error) {
      respondJson(res, 500, errorBodyOf(error));
    }
  };
}
function checkHandler(deps) {
  return async (req, res) => {
    if (!guard(req, res, "POST")) return;
    const body = bodyOf(req);
    if (body === null) {
      respondJson(res, 400, { code: "INVALID_BODY", message: "\u8BF7\u6C42\u4F53\u5FC5\u987B\u662F JSON \u5BF9\u8C61" });
      return;
    }
    const includePrerelease = body.includePrerelease === true;
    const force = body.force === true;
    try {
      const [host, registry] = await Promise.all([
        deps.readHostInfo(),
        deps.fetchRegistry({ force })
      ]);
      const survey = await surveyOf(host.version, registry.info, includePrerelease, deps);
      const restartRequired = await readRestartRequired(host.version);
      respondJson(res, 200, { ...survey, restartRequired });
    } catch (error) {
      respondJson(res, 500, errorBodyOf(error));
    }
  };
}
function releasesHandler(deps) {
  return async (req, res) => {
    if (!guard(req, res, "GET")) return;
    const query = queryOf(req.url);
    const from = query.get("from") ?? "";
    const to = query.get("to") ?? "";
    if (from === "" || to === "") {
      respondJson(res, 400, { code: "INVALID_RANGE", message: "\u7F3A\u5C11 from \u6216 to \u53C2\u6570" });
      return;
    }
    try {
      const result = await deps.fetchReleases({ from, to });
      respondJson(res, 200, { releases: result.releases, degraded: result.degraded });
    } catch {
      respondJson(res, 200, { releases: [], degraded: true });
    }
  };
}
function upgradeHandler(deps) {
  return async (req, res) => {
    if (!guard(req, res, "POST")) return;
    if (!tryAcquireUpgrade()) {
      respondJson(res, 409, { code: "BUSY", message: "\u5DF2\u6709\u4E00\u8F6E\u5347\u7EA7\u5728\u8FDB\u884C\uFF0C\u7B49\u5B83\u7ED3\u675F\u518D\u8BD5" });
      return;
    }
    let markedRunning = false;
    try {
      const body = bodyOf(req);
      if (body === null) {
        respondJson(res, 400, { code: "INVALID_BODY", message: "\u8BF7\u6C42\u4F53\u5FC5\u987B\u662F JSON \u5BF9\u8C61" });
        return;
      }
      const target = typeof body.target === "string" ? body.target.trim() : "";
      if (target === "") {
        respondJson(res, 400, { code: "INVALID_TARGET", message: "\u7F3A\u5C11\u76EE\u6807\u7248\u672C" });
        return;
      }
      let host;
      let versions;
      try {
        const [hostInfo, registry] = await Promise.all([
          deps.readHostInfo(),
          deps.fetchRegistry({ force: false })
        ]);
        host = hostInfo;
        versions = registry.info.versions;
      } catch (error) {
        respondJson(res, 500, errorBodyOf(error));
        return;
      }
      if (!versions.includes(target)) {
        respondJson(res, 400, {
          code: "INVALID_TARGET",
          message: `\u76EE\u6807\u7248\u672C ${target} \u4E0D\u5728 registry \u91CC`
        });
        return;
      }
      startNdjson(res);
      const emit = (event) => {
        try {
          res.write(JSON.stringify(event) + "\n");
        } catch {
        }
      };
      await writeLast({ running: true }).catch(() => {
      });
      markedRunning = true;
      await markPending(host.version, target);
      let result;
      try {
        result = await deps.runUpgrade({ target, installDir: host.dir, root: rootDir() }, emit);
      } catch (error) {
        const failure = {
          code: "UPGRADE_FAILED",
          message: `\u5347\u7EA7\u5931\u8D25\uFF1A${messageOf(error)}`
        };
        emit({ phase: "fail", message: failure.message, done: true, error: failure });
        result = { ok: false, error: failure };
      }
      await settleLast(result, target, deps.now()).catch(() => {
      });
      safeEnd(res);
    } finally {
      releaseUpgrade();
      if (markedRunning) await writeLast({ running: false }).catch(() => {
      });
    }
  };
}
async function settleLast(result, target, now) {
  if (result.ok) {
    await writeLast({
      lastResult: { to: target, at: now, restartRequired: true },
      lastError: void 0
    });
    return;
  }
  const error = result.error ?? { code: "UPGRADE_FAILED", message: "\u5347\u7EA7\u5931\u8D25" };
  await writeLast({
    lastError: { code: error.code, message: error.message, at: now }
  });
}
function guard(req, res, expected) {
  if (!checkGate(req)) {
    respondJson(res, 403, { code: "FORBIDDEN", message: "\u8BF7\u6C42\u672A\u901A\u8FC7\u6765\u6E90\u68C0\u67E5" });
    return false;
  }
  if (req.method.toUpperCase() !== expected) {
    respondJson(res, 403, { code: "METHOD_NOT_ALLOWED", message: `\u8BE5\u8DEF\u7531\u53EA\u6536 ${expected}` });
    return false;
  }
  return true;
}
function bodyOf(req) {
  if (req.body === void 0) return {};
  if (req.body === INVALID_JSON) return null;
  if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) return null;
  return req.body;
}
function startNdjson(res) {
  try {
    res.status(200);
    res.header("content-type", "application/x-ndjson; charset=utf-8");
    res.header("cache-control", "no-store");
    res.header("x-accel-buffering", "no");
  } catch {
  }
}
function respondJson(res, status, payload) {
  try {
    res.status(status);
    res.header("content-type", "application/json; charset=utf-8");
    res.header("cache-control", "no-store");
    res.end(JSON.stringify(payload));
  } catch {
  }
}
function safeEnd(res) {
  try {
    res.end();
  } catch {
  }
}
function errorBodyOf(error) {
  if (error instanceof Error) {
    const code = error.code;
    if (typeof code === "string" && SAFE_ERROR_CODES.has(code)) {
      return { code, message: error.message };
    }
  }
  return { code: "INTERNAL_ERROR", message: "\u5347\u7EA7\u63D2\u4EF6\u5185\u90E8\u9519\u8BEF" };
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function queryOf(url) {
  try {
    return new URL(url, "http://localhost").searchParams;
  } catch {
    return new URLSearchParams();
  }
}
function headerOf(headers, name2) {
  const direct = headers[name2];
  if (direct !== void 0) return direct;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name2) return value;
  }
  return void 0;
}
function headersOf(raw) {
  const headers = {};
  if (typeof raw !== "object" || raw === null) return headers;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") headers[key.toLowerCase()] = value;
    else if (Array.isArray(value)) {
      headers[key.toLowerCase()] = value.filter((item) => typeof item === "string").join(",");
    }
  }
  return headers;
}
async function requestOf(raw) {
  const incoming = raw ?? {};
  const method = typeof incoming.method === "string" ? incoming.method : "";
  const url = typeof incoming.url === "string" ? incoming.url : "";
  const headers = headersOf(incoming.headers);
  if (incoming.body !== void 0) return { method, headers, url, body: incoming.body };
  const body = await readBodyOf(incoming);
  return body === void 0 ? { method, headers, url } : { method, headers, url, body };
}
function readBodyOf(stream) {
  const on = stream.on;
  if (typeof on !== "function") return Promise.resolve(void 0);
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    on.call(stream, "data", (chunk) => {
      if (settled) return;
      text += chunkText(chunk);
      if (text.length > MAX_BODY_BYTES) finish(INVALID_JSON);
    });
    on.call(stream, "end", () => {
      if (settled) return;
      const trimmed = text.trim();
      if (trimmed === "") {
        finish(void 0);
        return;
      }
      try {
        finish(JSON.parse(trimmed));
      } catch {
        finish(INVALID_JSON);
      }
    });
    on.call(stream, "error", () => finish(void 0));
  });
}
function chunkText(chunk) {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return new TextDecoder().decode(chunk);
  return "";
}
function respondableOf(raw) {
  const target = raw ?? {};
  if (typeof target.status === "function" && typeof target.header === "function" && typeof target.write === "function" && typeof target.end === "function") {
    return target;
  }
  const res = {
    status(code) {
      target.statusCode = code;
      return res;
    },
    header(key, value) {
      if (typeof target.setHeader === "function") {
        ;
        target.setHeader(key, value);
      }
      return res;
    },
    write(chunk) {
      if (typeof target.write === "function") target.write(chunk);
    },
    end(body) {
      if (typeof target.end === "function") target.end(body);
    }
  };
  return res;
}
function adapt(handler) {
  return (rawReq, rawRes) => (async () => {
    const res = respondableOf(rawRes);
    try {
      await handler(await requestOf(rawReq), res);
    } catch {
      respondJson(res, 500, { code: "INTERNAL_ERROR", message: "\u5347\u7EA7\u63D2\u4EF6\u5185\u90E8\u9519\u8BEF" });
    }
  })();
}

// src/server/tools.ts
var CHECK_TOOL = "dsh_upgrade_check";
var UPGRADE_TOOL = "dsh_upgrade";
var CHECK_PARAMETERS = {
  type: "object",
  properties: {
    includePrerelease: {
      type: "boolean",
      description: "\u662F\u5426\u628A alpha / rc \u8FD9\u7C7B\u9884\u53D1\u5E03\u7248\u4E5F\u7B97\u4F5C\u5019\u9009\uFF0C\u9ED8\u8BA4 false"
    }
  },
  additionalProperties: false
};
var UPGRADE_PARAMETERS = {
  type: "object",
  properties: {
    target: {
      type: "string",
      description: "\u8981\u88C5\u7684\u76EE\u6807\u7248\u672C\u53F7\uFF0C\u5FC5\u987B\u662F registry \u91CC\u5B58\u5728\u7684\u7248\u672C\uFF08\u5148\u7528 dsh_upgrade_check \u67E5\uFF09"
    }
  },
  required: ["target"],
  additionalProperties: false
};
var CHECK_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    current: { type: "string", description: "\u5F53\u524D\u5B89\u88C5\u7684\u7248\u672C" },
    channels: {
      type: "object",
      properties: {
        latest: { type: "string" },
        next: { type: "string" },
        alpha: { type: "string" }
      },
      additionalProperties: false
    },
    target: {
      oneOf: [{ type: "string" }, { type: "null" }],
      description: "\u53EF\u5347\u7EA7\u7684\u76EE\u6807\u7248\u672C\uFF1B\u4E0E current \u76F8\u540C\u8868\u793A\u6CA1\u6709\u66F4\u65B0"
    },
    blocked: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" }
      },
      required: ["code", "message"],
      additionalProperties: false
    }
  },
  required: ["current", "channels", "target"],
  additionalProperties: false
};
var UPGRADE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean", description: "\u5347\u7EA7\u662F\u5426\u6210\u529F" },
    to: { type: "string", description: "\u5347\u7EA7\u540E\u7684\u7248\u672C" },
    restartRequired: { type: "boolean", description: "\u662F\u5426\u9700\u8981\u91CD\u542F dsh web \u624D\u751F\u6548" },
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" }
      },
      required: ["code", "message"],
      additionalProperties: false
    }
  },
  required: ["ok"],
  additionalProperties: false
};
async function dshUpgradeCheck(input, overrides = {}) {
  const deps = resolveDeps2(overrides);
  const [host, registry] = await Promise.all([
    deps.readHostInfo(),
    deps.fetchRegistry({ force: false })
  ]);
  const survey = await surveyOf(
    host.version,
    registry.info,
    input?.includePrerelease === true,
    deps
  );
  return {
    current: survey.current,
    channels: channelsOf2(survey.channels),
    // 契约允许 null（目标未知）；survey 总是给出一个具体版本，这里原样透传。
    target: survey.target,
    ...survey.blocked === void 0 ? {} : { blocked: runtimeBlocked(survey.blocked) }
  };
}
async function dshUpgrade(input, overrides = {}) {
  const deps = resolveDeps2(overrides);
  const target = typeof input?.target === "string" ? input.target.trim() : "";
  if (target === "") {
    return { ok: false, error: { code: "INVALID_TARGET", message: "\u6CA1\u6709\u7ED9\u76EE\u6807\u7248\u672C" } };
  }
  if (!tryAcquireUpgrade()) {
    return { ok: false, error: { code: "BUSY", message: "\u5DF2\u6709\u5347\u7EA7\u5728\u8FDB\u884C\u4E2D" } };
  }
  try {
    return await performUpgrade(target, deps);
  } finally {
    releaseUpgrade();
  }
}
async function performUpgrade(target, deps) {
  let host;
  let versions;
  try {
    const [hostInfo, registry] = await Promise.all([
      deps.readHostInfo(),
      deps.fetchRegistry({ force: false })
    ]);
    host = hostInfo;
    versions = registry.info.versions;
  } catch (error) {
    return { ok: false, error: failureOf(error) };
  }
  if (!versions.includes(target)) {
    return { ok: false, error: { code: "INVALID_TARGET", message: `registry \u91CC\u6CA1\u6709\u7248\u672C ${target}` } };
  }
  const blocked = await enginesBlockedOf(target, deps);
  if (blocked !== void 0) {
    return { ok: false, error: { code: "RUNTIME_UNSUPPORTED", message: blocked.message } };
  }
  let result;
  try {
    result = await deps.runUpgrade({ target, installDir: host.dir, root: rootDir() }, ignoreEvent);
  } catch (error) {
    return { ok: false, error: failureOf(error) };
  }
  if (!result.ok) {
    return { ok: false, error: result.error ?? { code: "UPGRADE_FAILED", message: "\u5347\u7EA7\u5931\u8D25" } };
  }
  await writeLast({
    lastResult: { to: target, at: Date.now(), restartRequired: true },
    lastError: void 0
  }).catch(() => {
  });
  return { ok: true, to: target, restartRequired: true };
}
function registerTools(ctx, overrides = {}) {
  const tools = toolsOf(ctx);
  if (tools === void 0) {
    console.warn("[dsh-upgrade] \u5BBF\u4E3B\u6CA1\u6709 tools \u670D\u52A1\uFF0C\u4E24\u4E2A agent \u5DE5\u5177\u90FD\u6CA1\u6CE8\u518C");
    return 0;
  }
  const deps = resolveDeps2(overrides);
  const definitions = [checkDefinition(deps), upgradeDefinition(deps)];
  for (const definition of definitions) {
    if (typeof ctx.effect === "function") {
      ctx.effect(
        () => {
          const dispose = tools.register(definition);
          return () => dispose();
        },
        `dsh-upgrade: ${definition.name}`
      );
      continue;
    }
    tools.register(definition);
  }
  return definitions.length;
}
function checkDefinition(deps) {
  return {
    name: CHECK_TOOL,
    description: "\u67E5 DSH \u6709\u6CA1\u6709\u65B0\u7248\u672C\uFF1A\u5F53\u524D\u7248\u672C\u3001\u5404\u901A\u9053\u6700\u65B0\u7248\u672C\u3001\u53EF\u5347\u7EA7\u76EE\u6807\uFF0C\u4EE5\u53CA\u76EE\u6807\u662F\u5426\u88AB\u672C\u673A Node \u7248\u672C\u62E6\u4F4F\u3002\u53EA\u8BFB\uFF0C\u4E0D\u5B89\u88C5\u4EFB\u4F55\u4E1C\u897F\u3002",
    parameters: CHECK_PARAMETERS,
    output: {
      schema: CHECK_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: describeCheck(value) }]
    },
    execute: async (args) => dshUpgradeCheck({ includePrerelease: inputOf(args).includePrerelease === true }, deps)
  };
}
function upgradeDefinition(deps) {
  return {
    name: UPGRADE_TOOL,
    description: "\u628A DSH \u5347\u7EA7\u5230\u6307\u5B9A\u7248\u672C\uFF1A\u5148\u5907\u4EFD\uFF0C\u5B89\u88C5\u5931\u8D25\u4F1A\u56DE\u6EDA\u3002\u4E0D\u81EA\u52A8\u91CD\u542F\uFF0C\u91CD\u542F\u8BF7\u7528 dsh_restart\uFF1B\u76EE\u6807\u7248\u672C\u5148\u7528 dsh_upgrade_check \u67E5\u3002",
    parameters: UPGRADE_PARAMETERS,
    output: {
      schema: UPGRADE_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: describeUpgrade(value) }]
    },
    execute: async (args) => {
      const target = inputOf(args).target;
      return dshUpgrade({ target: typeof target === "string" ? target : "" }, deps);
    }
  };
}
function toolsOf(ctx) {
  if (typeof ctx?.get !== "function") return void 0;
  try {
    const service = ctx.get("tools");
    if (typeof service !== "object" || service === null) return void 0;
    const register = service.register;
    if (typeof register !== "function") return void 0;
    return { register: register.bind(service) };
  } catch {
    return void 0;
  }
}
function resolveDeps2(overrides) {
  return {
    readHostInfo: overrides.readHostInfo ?? readHostInfo,
    fetchRegistry: overrides.fetchRegistry ?? fetchRegistry,
    readTargetManifest: overrides.readTargetManifest ?? readTargetManifest,
    runUpgrade: overrides.runUpgrade ?? runUpgrade,
    nodeVersion: overrides.nodeVersion ?? (() => process.versions.node)
  };
}
var ignoreEvent = () => {
};
function inputOf(args) {
  return typeof args === "object" && args !== null ? args : {};
}
function runtimeBlocked(blocked) {
  return { code: "RUNTIME_UNSUPPORTED", message: blocked.message };
}
function channelsOf2(channels) {
  const out = {};
  if (channels.latest !== null) out.latest = channels.latest;
  if (channels.next !== null) out.next = channels.next;
  if (channels.alpha !== null) out.alpha = channels.alpha;
  return out;
}
function failureOf(error) {
  const code = isRecord4(error) && typeof error.code === "string" ? error.code : "";
  const message = error instanceof Error ? error.message : "";
  if (code !== "") return { code, message: message === "" ? "\u5347\u7EA7\u5931\u8D25" : message };
  return { code: "INTERNAL_ERROR", message: "\u5347\u7EA7\u5931\u8D25\uFF1A\u8BFB\u53D6\u5BBF\u4E3B\u6216 registry \u65F6\u51FA\u9519" };
}
function isRecord4(value) {
  return typeof value === "object" && value !== null;
}
function describeCheck(value) {
  const parts = [`\u5F53\u524D\u7248\u672C ${value.current}`];
  const channels = Object.entries(value.channels ?? {}).filter(([, version]) => typeof version === "string" && version !== "").map(([name2, version]) => `${name2} ${version}`);
  if (channels.length > 0) parts.push(`\u901A\u9053\uFF1A${channels.join("\uFF0C")}`);
  if (value.target === value.current) parts.push("\u6CA1\u6709\u6BD4\u5F53\u524D\u66F4\u65B0\u7684\u7248\u672C");
  else if (typeof value.target === "string") parts.push(`\u53EF\u5347\u7EA7\u5230 ${value.target}`);
  if (value.blocked !== void 0) parts.push(`\u6CE8\u610F\uFF1A${value.blocked.message}\uFF0C\u8FD9\u4E2A\u7248\u672C\u73B0\u5728\u88C5\u4E0D\u4E0A`);
  return parts.join("\uFF1B");
}
function describeUpgrade(value) {
  if (value.ok) {
    const to = typeof value.to === "string" && value.to !== "" ? value.to : "\u65B0\u7248\u672C";
    return `\u5DF2\u5347\u7EA7\u5230 ${to}\uFF0C\u9700\u8981\u91CD\u542F dsh web \u624D\u4F1A\u751F\u6548\uFF1B\u91CD\u542F\u8BF7\u7528 dsh_restart\u3002`;
  }
  const error = value.error;
  if (error === void 0) return "\u5347\u7EA7\u5931\u8D25";
  return `\u5347\u7EA7\u5931\u8D25\uFF08${error.code}\uFF09\uFF1A${error.message}`;
}

// src/index.ts
var name = "dsh-upgrade";
var inject = ["webServer"];
function apply(ctx) {
  try {
    registerUpgradeRoutes(ctx);
  } catch (error) {
    console.warn(`[dsh-upgrade] \u8DEF\u7531\u6CA1\u6302\u4E0A\uFF1A${messageOf2(error)}`);
  }
  try {
    registerTools(ctx);
  } catch (error) {
    console.warn(`[dsh-upgrade] agent \u5DE5\u5177\u6CA1\u6CE8\u518C\u4E0A\uFF1A${messageOf2(error)}`);
  }
  try {
    void readHostInfo().then(
      (host) => Promise.all([settlePending(host.version), clearRestartRequired(host.version)])
    ).catch((error) => {
      console.warn(`[dsh-upgrade] \u8865\u5347\u7EA7\u901A\u77E5\u5931\u8D25\uFF1A${messageOf2(error)}`);
    });
  } catch (error) {
    console.warn(`[dsh-upgrade] \u8865\u5347\u7EA7\u901A\u77E5\u5931\u8D25\uFF1A${messageOf2(error)}`);
  }
}
var src_default = { name, inject, apply };
function messageOf2(error) {
  return error instanceof Error ? error.message : String(error);
}
export {
  apply,
  src_default as default,
  inject,
  name
};
//# sourceMappingURL=index.js.map
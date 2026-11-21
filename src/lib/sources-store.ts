import fs from 'node:fs';
import path from 'node:path';
import type { SourceConfig } from './types';

/**
 * 点播源运行时配置（后台热更新）。
 *
 * 为什么要独立于 .env：
 * systemd 用 EnvironmentFile 读取 .env，改完必须 restart 才生效，
 * 而 restart 会中断所有在播会话。故源列表另存一份 JSON 文件，
 * 运行时按 mtime 缓存读取，改完即生效、无需重启。
 *
 * 与 .env 的关系：文件存在且内容有效 → 以文件为准（覆盖 DEFAULT_SOURCES）；
 * 文件不存在/为空 → 回退到 DEFAULT_SOURCES。
 * 这样首次部署行为不变，后台一旦保存就开始接管，且删掉文件即可回到 .env 基线。
 *
 * 存储位置：默认 <cwd>/data/sources.json，可用 SOURCES_FILE 覆盖。
 * 必须放在持久目录，不能放 .next 或 PrivateTmp（systemd 里 PrivateTmp=true 会隔离临时目录）。
 */

/** 落盘结构：比 env 多一个 savedAt，用于前端展示「最后更新时间」 */
export interface StoredSourcesFile {
  savedAt: number;
  sources: SourceConfig[];
}

const FILE_ENV = 'SOURCES_FILE';

export function sourcesFilePath(): string {
  const custom = process.env[FILE_ENV];
  if (custom && custom.trim()) return custom.trim();
  return path.join(process.cwd(), 'data', 'sources.json');
}

/**
 * 运行时缓存：按 mtime 判断文件是否变化。
 * 不依赖 fs.watch —— 容器/hostPath 挂载下 inotify 事件常丢失，mtime 比对更可靠。
 * 一次 stat 的成本远低于一次读文件 + JSON.parse，且热更新场景下绝大多数请求都命中缓存。
 */
let cache: { mtimeMs: number; value: SourceConfig[] } | null = null;

/** 单条校验：与 env-sources 保持同一把尺子，热更新不能放宽标准 */
function normalizeSource(item: unknown, index: number): SourceConfig {
  if (typeof item !== 'object' || item === null) {
    throw new Error(`第 ${index + 1} 项不是对象`);
  }
  const { key, name, url, detail, isAdult } = item as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(`第 ${index + 1} 项缺少 name`);
  }
  if (typeof url !== 'string' || !/^https?:\/\//.test(url.trim())) {
    throw new Error(`第 ${index + 1} 项的 url 必须以 http:// 或 https:// 开头`);
  }
  return {
    // 有 key 就沿用（前端已持久化的 selectedKeys 不会因重排而错位），否则按序号生成
    key: typeof key === 'string' && key.trim() ? key.trim() : `env_${index}`,
    name: name.trim(),
    url: url.trim().replace(/\/+$/, ''),
    detail: typeof detail === 'string' && detail.trim() ? detail.trim() : undefined,
    isAdult: isAdult === true,
  };
}

function normalizeList(parsed: unknown): SourceConfig[] {
  // 兼容两种写法：裸数组（与 DEFAULT_SOURCES 同格式）或 { savedAt, sources }
  const arr = Array.isArray(parsed) ? parsed : (parsed as { sources?: unknown })?.sources;
  if (!Array.isArray(arr)) throw new Error('必须是 JSON 数组或 {sources:[...]}');
  const list = arr.map((item, i) => normalizeSource(item, i));
  // 同一份列表里 key 重复会让 selectedKeys / sourceHealth 串味，直接拒绝
  const keys = new Set<string>();
  for (const s of list) {
    if (keys.has(s.key)) throw new Error(`key 重复：${s.key}`);
    keys.add(s.key);
  }
  return list;
}

/** 读取热更新文件；文件不存在返回 null（调用方回退到 env） */
export function readSourcesFile(): SourceConfig[] | null {
  const file = sourcesFilePath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    cache = null;
    return null;
  }
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.value;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) {
      cache = { mtimeMs: stat.mtimeMs, value: [] };
      return [];
    }
    const value = normalizeList(JSON.parse(raw));
    cache = { mtimeMs: stat.mtimeMs, value };
    return value;
  } catch (err) {
    // 文件损坏不能让整站挂掉：告警后回退到 env 基线，管理员可在后台重新保存修复
    console.warn(
      `[LibreTV] ${file} 解析失败，已回退 DEFAULT_SOURCES：`,
      err instanceof Error ? err.message : err
    );
    cache = null;
    return null;
  }
}

/** 写入热更新文件（原子替换，避免读到半截 JSON） */
export function writeSourcesFile(sources: SourceConfig[]): StoredSourcesFile {
  const file = sourcesFilePath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const payload: StoredSourcesFile = { savedAt: Date.now(), sources };
  // 先写同目录临时文件再 rename：同一文件系统内 rename 是原子的，
  // 进程被 kill 也不会留下半截文件让下次读取失败。
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  // 立即刷新缓存，保存后同一请求链路上的读取立刻拿到新值（不必等下一次 mtime 比对）
  const stat = fs.statSync(file);
  cache = { mtimeMs: stat.mtimeMs, value: sources };
  return payload;
}

/** 文件最后修改时间（无文件返回 null），用于前端展示 */
export function sourcesFileMtime(): number | null {
  try {
    return fs.statSync(sourcesFilePath()).mtimeMs;
  } catch {
    return null;
  }
}

/** 删除热更新文件，回到 DEFAULT_SOURCES 基线 */
export function clearSourcesFile(): boolean {
  try {
    fs.unlinkSync(sourcesFilePath());
    cache = null;
    return true;
  } catch {
    return false;
  }
}

/** 供诊断：当前是否由热更新文件接管 */
export function sourcesFileExists(): boolean {
  try {
    return fs.statSync(sourcesFilePath()).isFile();
  } catch {
    return false;
  }
}
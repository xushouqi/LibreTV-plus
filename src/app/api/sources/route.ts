import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { getEnvSources } from '@/lib/env-sources';
import { isValidProxyUrl } from '@/lib/ssrf';
import {
  clearSourcesFile,
  readSourcesFile,
  sourcesFileExists,
  sourcesFileMtime,
  sourcesFilePath,
  writeSourcesFile,
} from '@/lib/sources-store';
import { isBadVerdict, probeSources, PROBE_KEYWORDS } from '@/lib/source-health';
import type { SourceConfig } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 后台源管理接口：热更新点播源列表 + 一键健康探测。
 *
 * 全部要求已登录（guardRequest），未登录一律 401，避免外部随意改源。
 *
 * GET  → 当前生效的源（区分来源：热更新文件 / .env 基线）+ 存储信息
 * POST → 保存新的源列表（原子写文件，写完立即生效，无需重启）
 * DELETE → 删除热更新文件，回退到 DEFAULT_SOURCES
 *
 * 另有 action=probe：对当前生效的源跑健康探测，识别「最大资源」这类假活源。
 */

interface SaveBody {
  action?: string;
  sources?: unknown;
  /** probe 用：只探测指定 key，缺省探测全部 */
  keys?: unknown;
}

function effectiveSources(): { sources: SourceConfig[]; origin: 'file' | 'env' } {
  const fromFile = readSourcesFile();
  if (fromFile !== null) return { sources: fromFile, origin: 'file' };
  return { sources: getEnvSources(), origin: 'env' };
}

export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const { sources, origin } = effectiveSources();
  const url = new URL(req.url);

  // GET ?probe=1：直接返回探测结果，便于脚本调用（也支持 POST，见下）
  if (url.searchParams.get('probe') === '1') {
    const only = url.searchParams.get('keys');
    const targets = only
      ? sources.filter((s) => only.split(',').includes(s.key))
      : sources;
    const reports = await probeSources(targets);
    return NextResponse.json({
      reports,
      keywords: PROBE_KEYWORDS,
      badCount: reports.filter((r) => isBadVerdict(r.verdict)).length,
    });
  }

  return NextResponse.json({
    sources,
    origin,
    /** 热更新文件路径与时间，前端可展示「最后更新时间 / 正在由文件接管」 */
    filePath: sourcesFilePath(),
    fileActive: sourcesFileExists(),
    savedAt: sourcesFileMtime(),
    /** .env 基线，用于「恢复默认」时展示将恢复成什么 */
    envSources: getEnvSources(),
    keywords: PROBE_KEYWORDS,
  });
}

export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: SaveBody;
  try {
    body = (await req.json()) as SaveBody;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  // —— 动作：健康探测 ——
  if (body.action === 'probe') {
    const { sources } = effectiveSources();
    const keys = Array.isArray(body.keys) ? body.keys.map(String) : null;
    const targets = keys ? sources.filter((s) => keys.includes(s.key)) : sources;
    if (targets.length === 0) {
      return NextResponse.json({ error: '没有可探测的源' }, { status: 400 });
    }
    const reports = await probeSources(targets);
    return NextResponse.json({
      reports,
      keywords: PROBE_KEYWORDS,
      badCount: reports.filter((r) => isBadVerdict(r.verdict)).length,
    });
  }

  // —— 默认动作：保存源列表 ——
  if (!Array.isArray(body.sources)) {
    return NextResponse.json({ error: 'sources 必须是数组' }, { status: 400 });
  }
  if (body.sources.length === 0) {
    return NextResponse.json({ error: '至少保留一个源' }, { status: 400 });
  }
  if (body.sources.length > 100) {
    return NextResponse.json({ error: '源数量上限为 100' }, { status: 400 });
  }

  // 逐条校验：名称非空、URL 合法且必须为公网地址（与搜索路径同一把尺子）
  const list: SourceConfig[] = [];
  for (let i = 0; i < body.sources.length; i++) {
    const raw = body.sources[i];
    if (typeof raw !== 'object' || raw === null) {
      return NextResponse.json({ error: `第 ${i + 1} 项格式不正确` }, { status: 400 });
    }
    const { key, name, url, detail, isAdult } = raw as Record<string, unknown>;
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    const trimmedUrl = typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
    if (!trimmedName) {
      return NextResponse.json({ error: `第 ${i + 1} 项缺少名称` }, { status: 400 });
    }
    if (!isValidProxyUrl(trimmedUrl)) {
      return NextResponse.json(
        { error: `第 ${i + 1} 项地址无效（须为 http/https 公网地址）` },
        { status: 400 }
      );
    }
    list.push({
      key: typeof key === 'string' && key.trim() ? key.trim() : `env_${i}`,
      name: trimmedName,
      url: trimmedUrl,
      detail: typeof detail === 'string' && detail.trim() ? detail.trim() : undefined,
      isAdult: isAdult === true,
    });
  }

  // key 重复会让前端的 selectedKeys 与健康度串味
  const seen = new Set<string>();
  for (const s of list) {
    if (seen.has(s.key)) {
      return NextResponse.json({ error: `源标识重复：${s.key}` }, { status: 400 });
    }
    seen.add(s.key);
  }

  try {
    const saved = writeSourcesFile(list);
    return NextResponse.json({
      ok: true,
      count: list.length,
      savedAt: saved.savedAt,
      sources: list,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `写入失败：${err instanceof Error ? err.message : '未知错误'}` },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const removed = clearSourcesFile();
  const { sources, origin } = effectiveSources();
  return NextResponse.json({ ok: removed, sources, origin });
}
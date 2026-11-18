#!/usr/bin/env node
/**
 * 采集源定时健康探测（独立于 Next.js 运行，便于 systemd timer 调用）。
 *
 * 为什么独立成脚本而不是只做在 Web 里：
 * 后台按钮是「人想起来才点」，而假活源（如最大资源忽略 wd）不会报错，
 * 只会在无人察觉时持续污染搜索结果。定时任务才能在源站悄然变化时主动发现。
 *
 * 判定逻辑与 src/lib/source-health.ts 完全一致（同源实现，避免两套标准）：
 *   ① 相关性：返回片名含关键词  ② 区分度：不同关键词返回不同列表
 *
 * 用法：
 *   node scripts/source-health-check.mjs            # 探测并打印报告
 *   node scripts/source-health-check.mjs --json     # 机器可读输出
 *   node scripts/source-health-check.mjs --alert    # 仅在有坏源时输出（配合 cron 静默）
 *
 * 退出码：0 全部健康；1 存在坏源；2 执行异常
 *
 * 读取源优先级与站点一致：data/sources.json（后台保存的） > 环境变量 DEFAULT_SOURCES。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// —— 与 src/lib/source-health.ts 保持一致的配置 ——
const PROBE_KEYWORDS = ['流浪地球', '肖申克的救赎', '武林外传'];
const PROBE_TIMEOUT_MS = 12_000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const ROOT = process.cwd();
const SOURCES_FILE = process.env.SOURCES_FILE?.trim() || path.join(ROOT, 'data', 'sources.json');
const REPORT_DIR = process.env.HEALTH_REPORT_DIR?.trim() || path.join(ROOT, 'data');

/** 与 env-sources / sources-store 同一套归一化规则 */
function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[\s\u3000·・:：\-—_.,，。!！?？'"“”‘’()（）[\]【】]/g, '');
}

function relevantCount(names, keyword) {
  const k = normalize(keyword);
  if (!k) return 0;
  return names.filter((n) => normalize(n).includes(k)).length;
}

/** 读取生效源：文件优先，其次 env */
function loadSources() {
  // 文件优先
  try {
    const raw = fs.readFileSync(SOURCES_FILE, 'utf8');
    if (raw.trim()) {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : parsed?.sources;
      if (Array.isArray(arr) && arr.length) {
        return { sources: arr.map(normalizeSource), origin: 'file', file: SOURCES_FILE };
      }
    }
  } catch {
    // 文件不存在或损坏 → 回退 env
  }
  const envRaw = process.env.DEFAULT_SOURCES;
  if (envRaw && envRaw.trim()) {
    try {
      const arr = JSON.parse(envRaw);
      if (Array.isArray(arr) && arr.length) {
        return { sources: arr.map(normalizeSource), origin: 'env', file: '.env DEFAULT_SOURCES' };
      }
    } catch {
      /* 忽略 */
    }
  }
  return { sources: [], origin: 'none', file: '-' };
}

function normalizeSource(item, i) {
  return {
    key: typeof item?.key === 'string' && item.key.trim() ? item.key.trim() : `env_${i}`,
    name: String(item?.name ?? '').trim() || `源${i + 1}`,
    url: String(item?.url ?? '').trim().replace(/\/+$/, ''),
  };
}

async function probeKeyword(source, keyword) {
  const api = `${source.url}?ac=videolist&wd=${encodeURIComponent(keyword)}&pg=1`;
  const start = Date.now();
  try {
    const res = await fetch(api, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!res.ok) {
      return { keyword, ok: false, count: 0, relevant: 0, sample: [], signature: '', error: `HTTP ${res.status}`, ms: Date.now() - start };
    }
    const data = await res.json();
    const rawList = Array.isArray(data?.list) ? data.list : [];
    const names = rawList.map((it) => String(it?.vod_name ?? '')).filter(Boolean);
    return {
      keyword,
      ok: true,
      count: names.length,
      relevant: relevantCount(names, keyword),
      sample: names.slice(0, 3),
      signature: names.join('\u0001'),
      ms: Date.now() - start,
    };
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      keyword,
      ok: false,
      count: 0,
      relevant: 0,
      sample: [],
      signature: '',
      error: isTimeout ? '超时' : String(err?.message ?? '请求失败'),
      timedOut: isTimeout,
      ms: Date.now() - start,
    };
  }
}

async function probeSource(source) {
  const start = Date.now();
  const keywords = [];
  // 串行：并发打同一源站易被限流，返回空会被误判成"没内容"
  for (const kw of PROBE_KEYWORDS) keywords.push(await probeKeyword(source, kw));

  const okProbes = keywords.filter((k) => k.ok);
  const nonEmpty = okProbes.filter((k) => k.count > 0 && k.signature);
  const identical = nonEmpty.length >= 2 && nonEmpty.slice(1).every((p) => p.signature === nonEmpty[0].signature);

  let verdict;
  let summary;
  if (okProbes.length === 0) {
    verdict = 'unreachable';
    summary = `全部关键词请求失败（${keywords.find((k) => k.error)?.error ?? '请求失败'}）`;
  } else if (identical) {
    verdict = 'ignores-keyword';
    summary = '不同关键词返回相同列表，疑似忽略搜索参数（假活源）';
  } else if (okProbes.every((k) => k.relevant === 0)) {
    verdict = nonEmpty.length === 0 ? 'empty' : 'no-relevance';
    summary = nonEmpty.length === 0 ? '所有关键词均返回空列表' : '片名均不含关键词，搜索质量异常';
  } else {
    verdict = 'healthy';
    const rel = okProbes.reduce((s, k) => s + k.relevant, 0);
    const tot = okProbes.reduce((s, k) => s + k.count, 0);
    summary = `相关命中 ${rel}/${tot} 条`;
  }

  return {
    sourceKey: source.key,
    sourceName: source.name,
    url: source.url,
    verdict,
    summary,
    identicalAcrossKeywords: identical,
    keywords,
    ms: Date.now() - start,
    checkedAt: Date.now(),
  };
}

const BAD = new Set(['ignores-keyword', 'no-relevance', 'unreachable', 'empty']);

function fmt(report) {
  const icon = report.verdict === 'healthy' ? 'OK  ' : 'BAD ';
  const lines = [`${icon}${report.sourceName.padEnd(10)} ${report.summary}`];
  lines.push(`     ${report.url}`);
  for (const k of report.keywords) {
    if (!k.ok) {
      lines.push(`       "${k.keyword}" → 失败: ${k.error}`);
    } else {
      lines.push(
        `       "${k.keyword}" → ${k.count} 条, 相关 ${k.relevant}${k.sample.length ? `, 首个「${k.sample[0]}」` : ''}`
      );
    }
  }
  return lines.join('\n');
}

async function main() {
  const argv = new Set(process.argv.slice(2));
  const asJson = argv.has('--json');
  const alertOnly = argv.has('--alert');

  const { sources, origin, file } = loadSources();
  if (sources.length === 0) {
    const msg = `未读取到任何源（来源: ${origin}）`;
    if (asJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.error(msg);
    return 2;
  }

  const reports = [];
  for (const s of sources) reports.push(await probeSource(s));

  const bad = reports.filter((r) => BAD.has(r.verdict));
  const checkedAt = Date.now();

  // 落盘最近一次报告，供后台页面显示「上次定时检测」
  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(REPORT_DIR, 'health-last.json'),
      JSON.stringify({ checkedAt, origin, file, keywords: PROBE_KEYWORDS, reports }, null, 2),
      'utf8'
    );
  } catch {
    /* 写不了报告不影响结论输出 */
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: bad.length === 0, checkedAt, origin, badCount: bad.length, reports }, null, 2));
  } else if (bad.length > 0 || !alertOnly) {
    console.log(`源健康探测 · ${new Date(checkedAt).toISOString()} · 来源 ${file}`);
    console.log(`关键词: ${PROBE_KEYWORDS.join(' / ')}\n`);
    for (const r of reports) console.log(fmt(r) + '\n');
    console.log(
      bad.length === 0
        ? `结论：${reports.length} 个源全部正常。`
        : `结论：${bad.length}/${reports.length} 个源异常 → ${bad.map((b) => b.sourceName).join('、')}`
    );
  }

  return bad.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('探测脚本异常:', err);
    process.exit(2);
  });
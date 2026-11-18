import { cmsRequestHeaders, parseSearchList } from './cms-parser';
import { fetchUpstream } from './fetch-utils';
import { checkUpstreamAllowed } from './ssrf';
import type { SourceConfig } from './types';

/**
 * 采集源健康探测：识别「假活源」。
 *
 * 背景（2026-11-18 实测）：
 * 最大资源 api.zuidapi.com 的 ac=list 返回 200、total=125997，一切看着正常，
 * 但它完全不响应 wd 参数——搜「狂飙」「封神」和不带 wd，返回的 20 条完全相同
 * （首条恒为「罪恶拼图」）。它把最新列表冒充搜索结果，用户搜任何片
 * 都能「看到结果」，实际全是无关内容。这类坏源不报错、有结果、全错，
 * 只看 HTTP 200 与 total 非零永远发现不了。
 *
 * 因此判定必须同时满足两项：
 *   1. 相关性：返回片名里确实含关键词，而不只是「返回了 N 条」；
 *   2. 区分度：不同关键词返回的列表不同，排除「忽略 wd 恒返回最新列表」。
 *
 * 只有一项不达标即判为可疑。两项都不达标直接判死。
 */

/**
 * 固定探测关键词：必须是长期存在的经典片名，避免用新片
 * （新片下架后关键词自然搜不到，会造成误报）。
 * 三个词分属不同类别，能覆盖大部分片库结构。
 */
export const PROBE_KEYWORDS = ['流浪地球', '肖申克的救赎', '武林外传'] as const;

/** 关键词对比时忽略标点与空白，只留文字与数字 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u3000·・:：\-—_.,，。!！?？'"“”‘’()（）\[\]【】]/g, '');
}

/** 判断返回的片名是否真的与关键词相关（包含即算，采集站常带副标题） */
function relevantCount(names: string[], keyword: string): number {
  const k = normalize(keyword);
  if (!k) return 0;
  return names.filter((n) => normalize(n).includes(k)).length;
}

export type ProbeVerdict =
  /** 正常：有相关结果且不同关键词结果不同 */
  | 'healthy'
  /** 忽略 wd：不同关键词返回相同列表（如最大资源） */
  | 'ignores-keyword'
  /** 关键词无相关结果：接口活着但搜不到内容 */
  | 'no-relevance'
  /** 请求失败 */
  | 'unreachable'
  /** 返回空列表 */
  | 'empty';

export interface KeywordProbe {
  keyword: string;
  ok: boolean;
  count: number;
  /** 片名含关键词的条数 */
  relevant: number;
  /** 前若干片名，用于前端展示「它到底返回了什么」 */
  sample: string[];
  /**
   * 全量片名的指纹：用于「不同关键词是否返回同一份列表」的精确比对。
   * 不用 sample（只有 3 条）——太短容易巧合相同，会把真源误判成假活源。
   */
  signature: string;
  error?: string;
  timedOut?: boolean;
  ms?: number;
}

export interface SourceProbeReport {
  sourceKey: string;
  sourceName: string;
  url: string;
  verdict: ProbeVerdict;
  /** 一句话结论，直接展示给管理员 */
  summary: string;
  keywords: KeywordProbe[];
  /** 是否有任意两个关键词返回了完全相同的片名集合 */
  identicalAcrossKeywords: boolean;
  ms: number;
  checkedAt: number;
}

const PROBE_TIMEOUT_MS = 12_000;

async function probeKeyword(
  source: SourceConfig,
  keyword: string
): Promise<KeywordProbe> {
  const base = source.url.replace(/\/+$/, '');
  const api = `${base}?ac=videolist&wd=${encodeURIComponent(keyword)}&pg=1`;
  const start = Date.now();
  try {
    const res = await fetchUpstream(api, {
      timeoutMs: PROBE_TIMEOUT_MS,
      headers: cmsRequestHeaders(),
    });
    if (!res.ok) {
      return { keyword, ok: false, count: 0, relevant: 0, sample: [], signature: '', error: `HTTP ${res.status}`, ms: Date.now() - start };
    }
    const data = (await res.json()) as unknown;
    const list = parseSearchList(data, source);
    const names = list.map((i) => i.name).filter(Boolean);
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
    const isTimeout =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      keyword,
      ok: false,
      count: 0,
      relevant: 0,
      sample: [],
      signature: '',
      error: isTimeout ? '超时' : err instanceof Error ? err.message : '请求失败',
      timedOut: isTimeout,
      ms: Date.now() - start,
    };
  }
}

/** 单个源完整探测：跑完所有关键词后综合判定 */
export async function probeSource(source: SourceConfig): Promise<SourceProbeReport> {
  const start = Date.now();
  const base: Omit<SourceProbeReport, 'verdict' | 'summary' | 'identicalAcrossKeywords' | 'ms'> = {
    sourceKey: source.key,
    sourceName: source.name,
    url: source.url,
    keywords: [],
    checkedAt: Date.now(),
  };

  // SSRF 预检：与搜索路径同一把尺子，不能因为走探测就放宽
  const verdict = await checkUpstreamAllowed(source.url);
  if (!verdict.ok) {
    return {
      ...base,
      keywords: [],
      verdict: 'unreachable',
      summary: `地址被拒绝：${verdict.reason}`,
      identicalAcrossKeywords: false,
      ms: Date.now() - start,
    };
  }

  // 串行而非并发：并发会对同一源站瞬间打三个请求，部分源站会限流返回空
  const keywords: KeywordProbe[] = [];
  for (const kw of PROBE_KEYWORDS) {
    keywords.push(await probeKeyword(source, kw));
  }

  const okProbes = keywords.filter((k) => k.ok);
  const identicalAcrossKeywords = detectIdentical(okProbes);

  // 判定优先级：全失败 > 忽略关键词 > 无相关性 > 全空 > 健康
  let finalVerdict: ProbeVerdict;
  let summary: string;

  if (okProbes.length === 0) {
    finalVerdict = 'unreachable';
    const firstErr = keywords.find((k) => k.error)?.error ?? '请求失败';
    summary = `全部关键词请求失败（${firstErr}）`;
  } else if (identicalAcrossKeywords) {
    finalVerdict = 'ignores-keyword';
    summary = '不同关键词返回相同列表，疑似忽略搜索参数（假活源）';
  } else if (okProbes.every((k) => k.relevant === 0)) {
    const nonEmpty = okProbes.filter((k) => k.count > 0);
    if (nonEmpty.length === 0) {
      finalVerdict = 'empty';
      summary = '所有关键词均返回空列表';
    } else {
      finalVerdict = 'no-relevance';
      summary = '返回了结果但片名均不含关键词，搜索质量异常';
    }
  } else {
    finalVerdict = 'healthy';
    const rel = okProbes.reduce((s, k) => s + k.relevant, 0);
    const total = okProbes.reduce((s, k) => s + k.count, 0);
    summary = `相关命中 ${rel}/${total} 条`;
  }

  return {
    ...base,
    keywords,
    verdict: finalVerdict,
    summary,
    identicalAcrossKeywords,
    ms: Date.now() - start,
  };
}

/**
 * 是否有两个以上关键词返回了完全相同的列表。
 * 比对全量片名签名而非前几条样本：
 * 真源即使做 OR 模糊匹配，不同关键词的结果集也不会逐条同名同序；
 * 而忽略 wd 的源每次返回的都是同一份缓存列表，片名与顺序完全一致。
 */
function detectIdentical(probes: KeywordProbe[]): boolean {
  const nonEmpty = probes.filter((p) => p.ok && p.count > 0 && p.signature);
  if (nonEmpty.length < 2) return false;
  const first = nonEmpty[0].signature;
  return nonEmpty.slice(1).every((p) => p.signature === first);
}

/** 批量探测：并发受控，避免一次打爆多个源站 */
export async function probeSources(
  sources: SourceConfig[],
  concurrency = 3
): Promise<SourceProbeReport[]> {
  const results: SourceProbeReport[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, sources.length) }, async () => {
    while (cursor < sources.length) {
      const idx = cursor++;
      results[idx] = await probeSource(sources[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 判定是否为不可用（前端据此标红/建议摘除） */
export function isBadVerdict(v: ProbeVerdict): boolean {
  return v === 'ignores-keyword' || v === 'no-relevance' || v === 'unreachable' || v === 'empty';
}
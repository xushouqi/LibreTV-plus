'use client';

import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from './confirm-dialog';
import { Icon } from './icon';
import { EmptyState, LoadingState } from './states';
import { SectionTitle } from './settings-shared';
import { useToast } from './toast';
import { api } from '@/lib/client-api';
import { cn } from '@/lib/utils';
import type { SourceConfig } from '@/lib/types';

/**
 * 服务端点播源管理：热更新 + 健康探测。
 *
 * 与上方「点播源」面板的区别（必须在 UI 上说清，否则用户会混淆）：
 * - 上方「点播源」是**当前浏览器**的勾选与自定义，存 localStorage；
 * - 这里是**服务端预置源**，保存后对所有访问者生效（对应 .env 的 DEFAULT_SOURCES）。
 *
 * 保存走 data/sources.json 热更新，不重启服务——重启会切断正在播放的会话。
 */

interface ProbeKeywordResult {
  keyword: string;
  ok: boolean;
  count: number;
  relevant: number;
  sample: string[];
  error?: string;
  timedOut?: boolean;
  ms?: number;
}

type Verdict = 'healthy' | 'ignores-keyword' | 'no-relevance' | 'unreachable' | 'empty';

interface ProbeReport {
  sourceKey: string;
  sourceName: string;
  url: string;
  verdict: Verdict;
  summary: string;
  identicalAcrossKeywords: boolean;
  keywords: ProbeKeywordResult[];
  ms: number;
  checkedAt: number;
}

interface SourcesState {
  sources: SourceConfig[];
  origin: 'file' | 'env';
  filePath: string;
  fileActive: boolean;
  savedAt: number | null;
  envSources: SourceConfig[];
  keywords: string[];
}

const VERDICT_META: Record<Verdict, { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  healthy: { label: '正常', tone: 'ok' },
  'ignores-keyword': { label: '忽略搜索参数', tone: 'bad' },
  'no-relevance': { label: '结果不相关', tone: 'bad' },
  unreachable: { label: '不可达', tone: 'bad' },
  empty: { label: '无内容', tone: 'warn' },
};

const TONE_CLASS: Record<'ok' | 'warn' | 'bad', string> = {
  ok: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  warn: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  bad: 'bg-red-500/10 text-red-400 border-red-500/30',
};

/** 生成本地编辑用的行（带稳定 id，避免用数组下标做 key 导致输入框错位） */
interface EditRow extends SourceConfig {
  /** 仅前端使用的临时 id */
  uid: string;
}

let uidSeed = 0;
function toRows(list: SourceConfig[]): EditRow[] {
  return list.map((s) => ({ ...s, uid: `r${++uidSeed}` }));
}

export function ServerSourcesPanel() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<SourcesState | null>(null);
  const [rows, setRows] = useState<EditRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [reports, setReports] = useState<ProbeReport[] | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getSourcesConfig();
      setState(data);
      setRows(toRows(data.sources));
      setDirty(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : '读取服务端源失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (uid: string, patch: Partial<SourceConfig>) => {
    setRows((prev) => prev.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  const removeRow = (uid: string) => {
    setRows((prev) => prev.filter((r) => r.uid !== uid));
    setDirty(true);
  };

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      { uid: `r${++uidSeed}`, key: `env_${prev.length}`, name: '', url: '' },
    ]);
    setDirty(true);
  };

  const save = async () => {
    // 前置校验：空名称/空地址直接挡住，避免把半成品写进线上
    const cleaned = rows.map((r, i) => ({
      key: r.key?.trim() || `env_${i}`,
      name: r.name.trim(),
      url: r.url.trim(),
      detail: r.detail,
      isAdult: r.isAdult,
    }));
    if (cleaned.length === 0) {
      toast('至少保留一个源', 'warning');
      return;
    }
    const badIdx = cleaned.findIndex((r) => !r.name || !/^https?:\/\//.test(r.url));
    if (badIdx >= 0) {
      toast(`第 ${badIdx + 1} 行名称或地址不完整`, 'warning');
      return;
    }
    setSaving(true);
    try {
      const res = await api.saveSources(cleaned);
      setState((prev) =>
        prev
          ? { ...prev, sources: res.sources, origin: 'file', fileActive: true, savedAt: res.savedAt }
          : prev
      );
      setRows(toRows(res.sources));
      setDirty(false);
      // 已保存的源变了，旧的探测结论失效
      setReports(null);
      toast('已保存，立即生效（无需重启）', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const runProbe = async () => {
    setProbing(true);
    try {
      const res = await api.probeSources();
      setReports(res.reports);
      if (res.badCount > 0) {
        toast(`发现 ${res.badCount} 个异常源`, 'warning');
      } else {
        toast('全部源正常', 'success');
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : '探测失败', 'error');
    } finally {
      setProbing(false);
    }
  };

  const resetToEnv = async () => {
    setConfirmReset(false);
    try {
      const res = await api.resetSources();
      setState((prev) =>
        prev ? { ...prev, sources: res.sources, origin: res.origin, fileActive: res.origin === 'file' } : prev
      );
      setRows(toRows(res.sources));
      setDirty(false);
      setReports(null);
      toast(res.ok ? '已恢复为 .env 预置源' : '当前本就没有热更新文件', 'info');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : '恢复失败', 'error');
    }
  };

  if (loading) return <LoadingState label="读取服务端源…" />;
  if (!state) return <EmptyState title="无法读取" description="请确认已登录后重试。" />;

  const badReports = (reports ?? []).filter((r) => r.verdict !== 'healthy');
  const reportByKey = new Map((reports ?? []).map((r) => [r.sourceKey, r]));

  return (
    <div className="space-y-5">
      <section>
        <SectionTitle
          title="服务端预置源"
          hint={
            state.origin === 'file'
              ? `由热更新文件接管${state.savedAt ? `，最后保存 ${new Date(state.savedAt).toLocaleString('zh-CN')}` : ''}`
              : '当前使用 .env 的 DEFAULT_SOURCES'
          }
          extra={
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-content"
              title="重新读取"
            >
              <Icon name="refresh" className="w-3.5 h-3.5" />
              刷新
            </button>
          }
        />
        <p className="text-[11px] text-faint leading-relaxed mb-3">
          这里改的是<span className="text-muted">对所有访问者生效</span>的预置源，保存后即时生效、无需重启服务。
          与「点播源」面板不同，后者只影响当前浏览器。
        </p>

        <div className="space-y-2">
          {rows.length === 0 && (
            <p className="text-xs text-faint py-3 text-center">还没有源，点下方「添加源」。</p>
          )}
          {rows.map((row, i) => {
            const report = reportByKey.get(row.key?.trim() || `env_${i}`);
            return (
              <div key={row.uid} className="rounded-lg border border-line bg-surface p-2.5 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-faint w-4 shrink-0">{i + 1}</span>
                  <input
                    value={row.name}
                    onChange={(e) => update(row.uid, { name: e.target.value })}
                    placeholder="源名称，如 量子资源"
                    className="min-w-0 flex-1 bg-transparent text-xs text-content outline-none placeholder:text-faint"
                  />
                  {report && (
                    <span
                      className={cn(
                        'shrink-0 px-1.5 py-0.5 rounded border text-[10px]',
                        TONE_CLASS[VERDICT_META[report.verdict].tone]
                      )}
                      title={report.summary}
                    >
                      {VERDICT_META[report.verdict].label}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeRow(row.uid)}
                    className="shrink-0 p-1 text-faint hover:text-red-400"
                    title="删除该源"
                  >
                    <Icon name="trash" className="w-3.5 h-3.5" />
                  </button>
                </div>
                <input
                  value={row.url}
                  onChange={(e) => update(row.uid, { url: e.target.value })}
                  placeholder="https://example.com/api.php/provide/vod"
                  className="w-full bg-transparent text-[11px] text-muted outline-none placeholder:text-faint font-mono"
                  spellCheck={false}
                />
                {report && (
                  <div className="text-[10px] text-faint space-y-0.5 pt-1 border-t border-line/50">
                    <p className={report.verdict === 'healthy' ? 'text-emerald-400/80' : 'text-amber-400/90'}>
                      {report.summary}
                    </p>
                    {report.keywords.map((k) => (
                      <p key={k.keyword} className="truncate">
                        「{k.keyword}」→{' '}
                        {k.ok ? `${k.count} 条 / 相关 ${k.relevant}` : `失败：${k.error}`}
                        {k.ok && k.sample[0] ? ` · 首个「${k.sample[0]}」` : ''}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <button
          type="button"
          onClick={addRow}
          className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline"
        >
          <Icon name="plus" className="w-3.5 h-3.5" />
          添加源
        </button>
      </section>

      <section>
        <SectionTitle
          title="健康探测"
          hint={`用「${state.keywords.join('」「')}」三个固定关键词检测，可识别忽略搜索参数的假活源`}
        />
        <p className="text-[11px] text-faint leading-relaxed mb-3">
          只看接口是否返回 200 无法发现问题源：有的源不报错、有结果，但对任何关键词都返回同一份
          最新列表，等于污染搜索结果。探测会比对「不同关键词是否返回相同列表」和「片名是否真含关键词」。
        </p>
        <button
          type="button"
          onClick={() => void runProbe()}
          disabled={probing}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-colors',
            probing ? 'bg-chip text-faint cursor-wait' : 'bg-accent/10 text-accent hover:bg-accent/20'
          )}
        >
          <Icon name={probing ? 'refresh' : 'bolt'} className={cn('w-3.5 h-3.5', probing && 'animate-spin')} />
          {probing ? '探测中…' : '开始探测'}
        </button>
        {reports && (
          <p className="mt-2 text-[11px] text-faint">
            共 {reports.length} 个源，
            {badReports.length === 0 ? (
              <span className="text-emerald-400">全部正常</span>
            ) : (
              <span className="text-amber-400">
                {badReports.length} 个异常：{badReports.map((r) => r.sourceName).join('、')}
              </span>
            )}
            。结果已标在各源卡片上。
          </p>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving}
            className={cn(
              'px-3 py-1.5 rounded-md text-xs transition-colors',
              !dirty || saving
                ? 'bg-chip text-faint cursor-not-allowed'
                : 'bg-accent text-white hover:bg-accent/90'
            )}
          >
            {saving ? '保存中…' : dirty ? '保存并生效' : '已保存'}
          </button>
          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            className="px-3 py-1.5 rounded-md text-xs text-muted hover:text-content border border-line hover:bg-hover"
          >
            恢复 .env 预置
          </button>
        </div>
        <p className="text-[10px] text-faint leading-relaxed break-all">
          存储：<code className="text-muted">{state.filePath}</code>
          {state.fileActive ? '（生效中）' : '（未创建，当前以 .env 为准）'}
        </p>
      </section>

      <ConfirmDialog
        open={confirmReset}
        title="恢复 .env 预置源？"
        message={`将删除热更新文件，源列表回到 .env 的 ${state.envSources.length} 个预置源。此操作不可撤销。`}
        confirmLabel="确认恢复"
        danger
        onConfirm={() => void resetToEnv()}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}
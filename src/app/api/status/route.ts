import { NextResponse } from 'next/server';
import { isPasswordConfigured, sessionFromCookieHeader } from '@/lib/auth';
import { getEnvSources } from '@/lib/env-sources';
import { readSourcesFile } from '@/lib/sources-store';
import { getEnvLiveSources } from '@/lib/env-live-sources';
import { getEnvSubscriptions } from '@/lib/env-subscriptions';
import { getEnvRecommendSource } from '@/lib/env-recommend-source';
import { getEnvImageMode } from '@/lib/env-image-mode';

export const runtime = 'nodejs';
// 源列表可在后台热更新，不能被构建期静态化
export const dynamic = 'force-dynamic';

/**
 * 点播源：后台热更新的文件优先，未保存过则回退 DEFAULT_SOURCES。
 * 这样改源不必再改 .env + 重启（restart 会切断在播会话）。
 */
function resolveSources() {
  return readSourcesFile() ?? getEnvSources();
}

/** 站点状态：客户端据此决定是否弹出登录框 / 提示管理员配置密码，并获取预置采集站与预置直播源 */
export async function GET(req: Request) {
  const passwordRequired = isPasswordConfigured();
  const verified = passwordRequired && sessionFromCookieHeader(req.headers.get('cookie'));
  return NextResponse.json({
    passwordRequired,
    verified,
    // 构建时由 next.config.ts 从 package.json 注入
    version: process.env.APP_VERSION || 'dev',
    // 部署者通过 DEFAULT_SOURCES 预置的采集站（可被后台热更新文件覆盖）
    defaultSources: resolveSources(),
    // 部署者通过 DEFAULT_LIVE_SOURCES 预置的直播源（M3U 订阅）
    defaultLiveSources: getEnvLiveSources(),
    // 部署者通过 DEFAULT_SUBSCRIPTIONS 预置的 SourceList 订阅链接
    defaultSubscriptions: getEnvSubscriptions(),
    // 部署者通过 DEFAULT_RECOMMEND_SOURCE 指定的首页推荐数据源默认值（未配置时为 null）
    defaultRecommendSource: getEnvRecommendSource() ?? null,
    // 部署者通过 DEFAULT_IMAGE_MODE 指定的封面图加载方式默认值（未配置时为 null）
    defaultImageMode: getEnvImageMode() ?? null,
  });
}

/** 功能：聚合公开科技与 AI RSS，提供带来源和时间的同源资讯接口。时间：2026-10-09；作者：lq。 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

/** 功能：限定可请求的公开 RSS，接口不接受任意外部地址。时间：2026-10-09；作者：lq。 */
export const NEWS_SOURCES = [
  { name: 'IT之家', url: 'https://www.ithome.com/rss/', category: '科技' },
  { name: 'MIT News', url: 'https://news.mit.edu/rss/topic/artificial-intelligence2', category: 'AI' },
];

/** 功能：客户端只接收简短标题、来源、原文地址和发布时间。时间：2026-10-09；作者：lq。 */
export interface NewsItem { title: string; source: string; url: string; publishedAt: string; category: string }
export interface NewsPayload { items: NewsItem[]; fetchedAt: string | null; stale: boolean; unavailableSources: string[] }

/** 功能：移除 RSS 富文本并解码实体；新闻始终作为文字绘制，不作为 HTML 执行。时间：2026-10-09；作者：lq。 */
function plainText(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => {
      const number = code[0]!.toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
    }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, entity: string) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[entity] ?? '')
    .replace(/\s+/g, ' ').trim();
}

/** 功能：解析受控 RSS 的条目，丢弃缺日期、非法链接和重复新闻。时间：2026-10-09；作者：lq。 */
export function parseNewsRss(xml: string, source: typeof NEWS_SOURCES[number], now = Date.now()): NewsItem[] {
  const items: NewsItem[] = [];
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = match[1]!;
    const field = (name: string): string => plainText(block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] ?? '');
    const title = field('title').slice(0, 220);
    const url = field('link');
    const published = Date.parse(field('pubDate') || field('dc:date'));
    if (!title || !/^https?:\/\//i.test(url) || !Number.isFinite(published) || published > now + 86400000) continue;
    const category = source.category === 'AI' || /\bAI\b|人工智能|大模型|机器人|机器学习|智能体|算力|深度学习/i.test(title) ? 'AI' : '科技';
    items.push({ title, source: source.name, url, publishedAt: new Date(published).toISOString(), category });
  }
  return items;
}

/** 功能：五分钟缓存、合并并发请求；断网保留旧资讯并标注，失败后最多每三十秒重试。时间：2026-10-09；作者：lq。 */
export function createNewsService(fetcher: typeof fetch = fetch, clock = Date.now): () => Promise<NewsPayload> {
  let cached: NewsPayload = { items: [], fetchedAt: null, stale: true, unavailableSources: [] };
  let nextRefresh = 0;
  let pending: Promise<NewsPayload> | null = null;
  return async () => {
    if (clock() < nextRefresh) return cached;
    if (pending) return pending;
    pending = (async () => {
      const results = await Promise.allSettled(NEWS_SOURCES.map(async (source) => {
        const response = await fetcher(source.url, { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/rss+xml, application/xml, text/xml' } });
        if (!response.ok) throw new Error(`RSS HTTP ${response.status}`);
        // 功能：流式限制 RSS 为 2 MB，防止异常上游响应无限占用内存。时间：2026-10-09；作者：lq。
        const reader = response.body?.getReader();
        if (!reader) throw new Error('RSS empty body');
        const decoder = new TextDecoder();
        let xml = '';
        let size = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 2_000_000) { await reader.cancel(); throw new Error('RSS too large'); }
          xml += decoder.decode(chunk.value, { stream: true });
        }
        xml += decoder.decode();
        const items = parseNewsRss(xml, source, clock());
        if (!items.length) throw new Error('RSS has no valid items');
        return items;
      }));
      const unavailableSources = results.flatMap((result, index) => result.status === 'rejected' ? [NEWS_SOURCES[index]!.name] : []);
      const successful = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
      // 功能：部分源失败时保留该源上次标题，并以实际状态提示；全部失败不伪造更新时间。时间：2026-10-09；作者：lq。
      const combined = [...successful, ...cached.items.filter((item) => unavailableSources.includes(item.source))];
      const unique = [...new Map(combined.map((item) => [item.url, item])).values()]
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
      // 功能：保证 AI 来源有展示名额，避免高频科技快讯挤掉研究资讯。时间：2026-10-09；作者：lq。
      const selected = [...unique.filter((item) => item.source === 'IT之家').slice(0, 16),
        ...unique.filter((item) => item.source === 'MIT News').slice(0, 4)]
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
      cached = { items: selected, fetchedAt: successful.length ? new Date(clock()).toISOString() : cached.fetchedAt,
        stale: unavailableSources.length > 0, unavailableSources };
      nextRefresh = clock() + (successful.length ? 300000 : 30000);
      return cached;
    })();
    try { return await pending; } finally { pending = null; }
  };
}

/** 功能：开发和预览服务器均挂载资讯 API，浏览器不直接跨域读取 RSS。时间：2026-10-09；作者：lq。 */
export function techNewsPlugin(): Plugin {
  const getNews = createNewsService();
  const middleware = (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    if (request.url?.split('?')[0] !== '/api/tech-news') { next(); return; }
    if (request.method !== 'GET') { response.statusCode = 405; response.setHeader('Allow', 'GET'); response.end(); return; }
    void getNews().then((payload) => {
      response.statusCode = payload.items.length ? 200 : 503;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end(JSON.stringify(payload));
    }).catch(() => { response.statusCode = 503; response.end(JSON.stringify({ items: [], stale: true, fetchedAt: null, unavailableSources: [] })); });
  };
  return { name: 'tech-news', configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); } };
}

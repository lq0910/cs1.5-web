/** 功能：验证 RSS 解码、去重排序、并发缓存、掉线保留以及实际墙面定位。时间：2026-10-09；作者：lq。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createNewsService, parseNewsRss, NEWS_SOURCES } from '../server/techNews.ts';
import { findNewsScreenWall } from '../src/engine/render/newsScreen.ts';
import { parseBsp } from '../src/engine/bsp/reader.ts';

/** 功能：生成固定日期 RSS 测试数据，不依赖网络或实时标题。时间：2026-10-09；作者：lq。 */
const rss = (title: string, url = 'https://example.com/article'): string => `<rss><channel><item><title><![CDATA[${title}]]></title><link>${url}</link><pubDate>Fri, 09 Oct 2026 05:00:00 GMT</pubDate></item></channel></rss>`;
const now = Date.parse('2026-10-09T12:00:00Z');

// 功能：确保恶意 HTML 仅保留文字，实体正确解码，坏日期及脚本链接不展示。时间：2026-10-09；作者：lq。
test('RSS sanitizes titles and validates publication dates and links', () => {
  const item = parseNewsRss(rss('AI &amp; 科技 <b>新闻</b> &#x4E2D;'), NEWS_SOURCES[0]!, now)[0]!;
  assert.equal(item.title, 'AI & 科技 新闻 中');
  assert.equal(item.category, 'AI');
  assert.equal(parseNewsRss(rss('bad', 'javascript:alert(1)'), NEWS_SOURCES[0]!, now).length, 0);
  assert.equal(parseNewsRss(rss('future').replace('2026', '2099'), NEWS_SOURCES[0]!, now).length, 0);
});

// 功能：检查并发只触发一批请求，五分钟后失败保留旧新闻且不假报刷新时间。时间：2026-10-09；作者：lq。
test('news requests share cache and retain explicitly stale data after outages', async () => {
  let calls = 0;
  let time = now;
  let offline = false;
  const fetcher = (async (url: string | URL | Request) => {
    calls++;
    if (offline) throw new Error('offline');
    return new Response(rss(String(url).includes('mit') ? 'AI research' : '科技新闻', String(url)), { status: 200 });
  }) as typeof fetch;
  const getNews = createNewsService(fetcher, () => time);
  const results = await Promise.all([getNews(), getNews()]);
  assert.equal(calls, 2);
  assert.equal(results[0]!.items.length, 2);
  assert.equal(results[0]!.stale, false);
  await getNews();
  assert.equal(calls, 2);
  time += 300001;
  offline = true;
  const stale = await getNews();
  assert.equal(stale.items.length, 2);
  assert.equal(stale.stale, true);
  assert.equal(stale.fetchedAt, results[0]!.fetchedAt);
  assert.deepEqual(stale.unavailableSources, ['IT之家', 'MIT News']);
});

// 功能：首次断网不得生成虚构新闻，随后可从真实接口恢复。时间：2026-10-09；作者：lq。
test('initial news outage returns no fabricated items and recovers', async () => {
  let time = now;
  let online = false;
  const fetcher = (async () => { if (!online) throw new Error('offline'); return new Response(rss('恢复资讯')); }) as typeof fetch;
  const getNews = createNewsService(fetcher, () => time);
  const empty = await getNews();
  assert.equal(empty.items.length, 0);
  assert.equal(empty.fetchedAt, null);
  assert.equal(empty.stale, true);
  online = true;
  time += 30001;
  assert.equal((await getNews()).stale, false);
});

// 功能：原版素材验证屏幕定位在截图的 GAMEHELPER 墙面，法线朝场内且完整覆盖广告。时间：2026-10-09；作者：lq。
test('LED screen covers the Dust2 spawn-side GAMEHELPER banner', () => {
  const bytes = readFileSync(new URL('../public/cstrike/maps/de_dust2.bsp', import.meta.url));
  const bsp = parseBsp(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const placement = findNewsScreenWall(bsp, { x: 448, y: 2464, z: -87 });
  assert.ok(placement);
  assert.equal(placement.position.x, 1792);
  assert.equal(placement.position.y, 2048);
  assert.equal(placement.width, 512);
  assert.equal(placement.normal.x, -1);
  assert.ok(placement.position.z - placement.height / 2 <= 144);
  assert.ok(placement.position.z + placement.height / 2 >= 256);
});

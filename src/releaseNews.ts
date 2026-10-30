// 功能：从 GitHub Releases 读取版本更新公告，离线时回退到仓库内公告；时间：2026-10-30；作者：lq。
type Release = { tag_name?: string; name?: string; published_at?: string; body?: string; html_url?: string; draft?: boolean; prerelease?: boolean };

const RELEASES_URL = 'https://api.github.com/repos/lq0910/cs1.5-web/releases?per_page=8';
const RELEASES_PAGE = 'https://github.com/lq0910/cs1.5-web/releases';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

function summary(release: Release): string {
  const text = (release.body ?? release.name ?? '查看本次版本更新内容').replace(/[`*_#[\]()>]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, 62) || '查看本次版本更新内容';
}

function dateOf(release: Release): string {
  return release.published_at?.slice(0, 10) ?? '未发布';
}

async function readReleases(): Promise<Release[]> {
  try {
    const response = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } });
    if (response.ok) {
      const releases = await response.json() as Release[];
      const published = releases.filter((release) => !release.draft && !release.prerelease);
      if (published.length) return published;
    }
  } catch { /* 功能：网络不可用时读取本地公告。时间：2026-10-30；作者：lq。 */ }
  try {
    const response = await fetch('./releases.json', { cache: 'no-store' });
    if (response.ok) return await response.json() as Release[];
  } catch { /* 功能：离线公告也不可用时保留 HTML 中的提示。时间：2026-10-30；作者：lq。 */ }
  return [];
}

/** 功能：渲染首页版本更新列表，并把“更多”指向 Release 页面；时间：2026-10-30；作者：lq。 */
export async function loadReleaseNews(): Promise<void> {
  const list = document.querySelector<HTMLElement>('[data-purpose="news-list"]');
  if (!list) return;
  const releases = await readReleases();
  if (!releases.length) return;
  list.innerHTML = releases.slice(0, 4).map((release) => {
    const title = escapeHtml(release.name || release.tag_name || '版本更新');
    const detail = escapeHtml(summary(release));
    const href = escapeHtml(release.html_url || RELEASES_PAGE);
    return `<li class="flex items-baseline space-x-2.5 hover:text-white cursor-pointer group"><a class="flex items-baseline space-x-2.5 w-full" href="${href}" target="_blank" rel="noreferrer"><span class="text-gray-400 font-mono text-[11px] shrink-0">${escapeHtml(dateOf(release))}</span><span class="truncate group-hover:underline text-[11.5px] leading-tight text-gray-200">${title}：${detail}</span></a></li>`;
  }).join('');
  const more = document.querySelector<HTMLAnchorElement>('[data-purpose="news-announcements-card"] a');
  if (more) { more.href = RELEASES_PAGE; more.target = '_blank'; more.rel = 'noreferrer'; }
}

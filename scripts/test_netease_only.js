#!/usr/bin/env node
/**
 * test_netease_only.js — 端到端测试 netease-only 流程
 *
 * 不走 AI，直接喂 6 个真实歌名 + 歌手，看能不能跑通
 *   search → 拿 URL → 下载到 /home/zulin/Music/网易云收藏/
 *
 * 用法:  node scripts/test_netease_only.js
 *      或 DJ_NAMES="歌1|歌手1|歌2|歌手2" node scripts/test_netease_only.js
 */
const fs = require('fs');
const path = require('path');

// 直接 inline 复制 neteaseSearchAndDownload 函数（避免 require 时触发 main()）
const NETEASE_API = process.env.NETEASE_API || 'http://127.0.0.1:3001';
const NETEASE_DOWNLOAD_DIR = '/home/zulin/Music/网易云收藏';

function sanitizeFilename(s) {
  return s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function neteaseSearch(name, artist) {
  const q = encodeURIComponent(`${name} ${artist}`.trim());
  const r = await fetch(`${NETEASE_API}/search?keywords=${q}&limit=5`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`search HTTP ${r.status}`);
  const j = await r.json();
  const songs = j?.result?.songs || [];
  if (songs.length === 0) return null;
  const exact = songs.find(s => s.name === name && s.artists?.some(a => a.name === artist));
  return exact || songs[0];
}

async function neteaseGetSongUrl(id) {
  const r = await fetch(`${NETEASE_API}/song/url?id=${id}&br=320000`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`song/url HTTP ${r.status}`);
  const j = await r.json();
  const item = j?.data?.[0];
  return item?.url ? { url: item.url, size: item.size, br: item.br } : null;
}

async function downloadToFile(remoteUrl, destPath) {
  const r = await fetch(remoteUrl, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`download HTTP ${r.status}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const ws = fs.createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    r.body.pipeTo(new WritableStream({
      write(chunk) { ws.write(Buffer.from(chunk)); },
      close() { ws.end(); },
    })).then(resolve, reject);
  });
  await new Promise((resolve) => ws.on('finish', resolve));
  return fs.statSync(destPath).size;
}

async function neteaseSearchAndDownload(name, artist) {
  const hit = await neteaseSearch(name, artist);
  if (!hit) return { ok: false, reason: 'no_search_result' };
  const urlInfo = await neteaseGetSongUrl(hit.id);
  if (!urlInfo) return { ok: false, reason: 'no_url_likely_vip', id: hit.id };
  const safeName = sanitizeFilename(`${hit.name} - ${hit.artists?.[0]?.name || artist}`);
  const destPath = path.join(NETEASE_DOWNLOAD_DIR, `${safeName}.mp3`);
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 100_000) {
    return { ok: true, filePath: destPath, cached: true, size: fs.statSync(destPath).size };
  }
  const size = await downloadToFile(urlInfo.url, destPath);
  return { ok: true, filePath: destPath, cached: false, size, br: urlInfo.br };
}

// Test data — 6 picks spanning: 儿童 / 流行 / 经典 / 英文 / 高龄
const TEST_PICKS = [
  { name: '小星星', artist: '贝乐虎儿歌' },
  { name: '两只老虎', artist: '贝乐虎儿歌' },
  { name: '海阔天空', artist: 'Beyond' },
  { name: '童话', artist: '光良' },
  { name: 'Summer', artist: '久石让' },
  { name: '如烟-Live', artist: '周深' },
];

(async () => {
  console.log(`[test] NETEASE_API = ${NETEASE_API}`);
  console.log(`[test] download dir = ${NETEASE_DOWNLOAD_DIR}`);
  console.log(`[test] testing ${TEST_PICKS.length} picks...\n`);

  let ok = 0, fail = 0;
  for (const pick of TEST_PICKS) {
    const t0 = Date.now();
    const r = await neteaseSearchAndDownload(pick.name, pick.artist);
    const ms = Date.now() - t0;
    if (r.ok) {
      ok++;
      console.log(`  ✓ [${(ms/1000).toFixed(1)}s] ${pick.name} - ${pick.artist} → ${r.filePath} (${(r.size/1024).toFixed(0)} KB${r.cached ? ', cached' : ''})`);
    } else {
      fail++;
      console.log(`  ✗ [${(ms/1000).toFixed(1)}s] ${pick.name} - ${pick.artist} (${r.reason}${r.id ? ` id=${r.id}` : ''})`);
    }
  }
  console.log(`\n[test] done: ${ok} ok, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(2); });

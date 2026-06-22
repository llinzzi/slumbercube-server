#!/usr/bin/env node
/**
 * scheduled_runner.js — crontab 管理 CLI
 *
 * 每天 07:00 和 21:00 自动跑 generate_playlist.js，原子切换
 * .radio_playlist/current.json，让 ESP32 在两个时段之间任意时间
 * 访问 /api/esp 都能命中预生成的 playlist（零 AI 延迟）。
 *
 * 用法：
 *   node scripts/scheduled_runner.js install    # 注册 crontab 条目
 *   node scripts/scheduled_runner.js uninstall  # 删除本项目相关条目
 *   node scripts/scheduled_runner.js status     # 查看状态
 *   node scripts/scheduled_runner.js list       # 列出当前 crontab 中所有相关条目
 */

const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const GENERATE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'generate_playlist.js');
const NODE_BIN = process.execPath;

const TAG = '# radio_streams: scheduled playlist';

// 07:00 和 21:00 各跑一次
const CRON_JOBS = [
  { hour: 7,  minute: 0, label: 'morning playlist' },
  { hour: 21, minute: 0, label: 'evening playlist' },
];

function log(...args) { console.log('[cron]', ...args); }

function readCrontab() {
  try {
    return execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
  } catch (e) {
    // crontab 还没建过（exit code 1 + "no crontab for ..."）
    return '';
  }
}

function writeCrontab(content) {
  // Ensure trailing newline — crontab rejects files that don't end with one
  const normalized = content.replace(/\n*$/, '\n');
  execSync('crontab -', { input: normalized, encoding: 'utf8' });
}

function buildCronLines() {
  // Cron 不直接跑 generate_playlist.js（可能跑几小时）
  // 只 touch 一个 trigger 文件，dj_worker.js 守护进程监听并启动任务
  const logFile = path.join(PROJECT_ROOT, '.radio_playlist', 'cron.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  // Cron runs with a minimal PATH; ensure basic tools work
  const nvmBin = path.dirname(process.execPath);
  const cronPath = `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${nvmBin}`;

  return CRON_JOBS.map(job => {
    const env = `PATH=${cronPath}`;
    const cronTime = `${job.minute} ${job.hour} * * *`;
    // Touch trigger file; worker watches it and starts generate_playlist.js
    const triggerFile = path.join(PROJECT_ROOT, '.radio_playlist', `.trigger_${job.label.split(' ')[0]}`);
    const cmd = `cd ${PROJECT_ROOT} && ${env} touch ${JSON.stringify(triggerFile)} >> ${logFile} 2>&1`;
    return `${cronTime} ${cmd}  ${TAG} (${job.label})`;
  });
}

function install() {
  log('Installing crontab jobs...');
  const existing = readCrontab();
  const newLines = buildCronLines();

  // 移除旧的 radio_streams 行（幂等）
  const filtered = existing
    .split('\n')
    .filter(l => !l.includes(TAG));

  const combined = [...filtered, ...newLines].join('\n').replace(/\n+$/, '\n');
  writeCrontab(combined);

  log(`Installed ${newLines.length} jobs:`);
  newLines.forEach(l => log(`  ${l}`));
}

function uninstall() {
  log('Uninstalling crontab jobs...');
  const existing = readCrontab();
  const filtered = existing
    .split('\n')
    .filter(l => !l.includes(TAG));

  const removed = existing.split('\n').filter(l => l.includes(TAG));
  writeCrontab(filtered.join('\n').replace(/\n+$/, '\n'));

  log(`Removed ${removed.length} jobs:`);
  removed.forEach(l => log(`  ${l}`));
}

function listJobs() {
  const existing = readCrontab();
  const jobs = existing.split('\n').filter(l => l.includes(TAG));
  console.log(`Found ${jobs.length} radio_streams jobs:`);
  jobs.forEach(l => console.log(`  ${l}`));
}

function status() {
  console.log('=== radio_streams scheduled playlist status ===\n');

  // 1. Crontab
  const existing = readCrontab();
  const jobs = existing.split('\n').filter(l => l.includes(TAG));
  console.log(`Crontab jobs: ${jobs.length} registered`);
  if (jobs.length === 0) {
    console.log('  ⚠ NOT INSTALLED. Run: npm run schedule:install');
  } else {
    jobs.forEach(l => console.log(`  ✓ ${l.trim()}`));
  }

  // 2. Compute next run time
  if (jobs.length > 0) {
    const now = new Date();
    const nextRuns = CRON_JOBS
      .map(j => {
        const next = new Date(now);
        next.setHours(j.hour, j.minute, 0, 0);
        if (next <= now) next.setDate(next.getDate() + 1);
        return next;
      })
      .sort((a, b) => a - b);
    const soonest = nextRuns[0];
    const minsAway = Math.round((soonest - now) / 60000);
    console.log(`\nNext run: ${soonest.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} (in ${minsAway} min)`);
  }

  // 3. Current playlist
  const playlistJson = path.join(PROJECT_ROOT, '.radio_playlist', 'current.json');
  console.log(`\nCurrent playlist: ${playlistJson}`);
  if (fs.existsSync(playlistJson)) {
    try {
      const data = JSON.parse(fs.readFileSync(playlistJson, 'utf8'));
      const validUntil = new Date(data.valid_until);
      const expired = validUntil <= new Date();
      const minutesLeft = Math.round((validUntil - new Date()) / 60000);
      console.log(`  Generated: ${data.generated_at}`);
      console.log(`  Weather: ${data.weather}`);
      console.log(`  Songs: ${data.songs.length}`);
      if (data.stats) {
        console.log(`  Stats: ${data.stats.succeeded}/${data.stats.requested} OK, ${data.stats.failed} failed`);
      }
      console.log(`  Valid until: ${validUntil.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
      console.log(`  Status: ${expired ? '⚠ EXPIRED' : `✓ active (${minutesLeft} min left)`}`);
    } catch (e) {
      console.log(`  ✗ parse error: ${e.message}`);
    }
  } else {
    console.log('  ⚠ NOT GENERATED. Run: npm run generate-playlist');
  }

  // 4. Cron log tail
  const logFile = path.join(PROJECT_ROOT, '.radio_playlist', 'cron.log');
  if (fs.existsSync(logFile)) {
    console.log(`\nCron log (last 10 lines): ${logFile}`);
    const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
    lines.slice(-10).forEach(l => console.log(`  ${l}`));
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
const cmd = process.argv[2] || 'status';
try {
  switch (cmd) {
    case 'install': install(); break;
    case 'uninstall': uninstall(); break;
    case 'list': listJobs(); break;
    case 'status': status(); break;
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error('Usage: scheduled_runner.js [install|uninstall|list|status]');
      process.exit(1);
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
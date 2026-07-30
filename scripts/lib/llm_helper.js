// Shared minimax/Anthropic-compatible chat helper.
// Used by:
//   - scripts/build_playlist_from_result.js  (intros per song)
//   - scripts/scene_playlist_search.js       (keyword generation + playlist selection)
//
// Reads API key/base/model from config/settings.json via SETTINGS global
// (set up by the caller; falls back to ~/.mmx/config.json for the key).
// Falls back to process.env.ANTHROPIC_KEY if SETTINGS isn't injected.

const path = require('path');   // module-scope — used by both try blocks below
const fs = require('fs');
const os = require('os');

let _settings = null;
function getSettings() {
  if (_settings) return _settings;
  try {
    const file = path.join(__dirname, '..', '..', 'config', 'settings.json');
    if (fs.existsSync(file)) {
      const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
      _settings = d.minimax || {};
    }
  } catch (e) {
    log('getSettings: settings.json load failed:', e.message);
  }
  _settings = _settings || {};
  // Fallback for the key: ~/.mmx/config.json (mmx CLI auth)
  if (!_settings.apiKey) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mmx', 'config.json'), 'utf-8'));
      _settings.apiKey = cfg.api_key || null;
    } catch (e) {
      log('getSettings: ~/.mmx/config.json load failed:', e.message);
    }
  }
  return _settings;
}

function getAnthropicKey() {
  if (process.env.ANTHROPIC_KEY) return process.env.ANTHROPIC_KEY;
  const s = getSettings();
  if (s.llmProvider === 'deepseek') {
    return s.deepseekApiKey || process.env.DEEPSEEK_API_KEY || null;
  }
  return s.apiKey || null;
}

function getAnthropicBase() {
  return getSettings().anthropicBase || process.env.ANTHROPIC_BASE || 'https://api.minimaxi.com/anthropic/v1/messages';
}

function getAnthropicModel() {
  return getSettings().anthropicModel || process.env.ANTHROPIC_MODEL || 'MiniMax-M3';
}

function log(...args) {
  const tag = process.env.LLM_HELPER_TAG || 'llm';
  console.log(`[${tag} ${new Date().toISOString()}]`, ...args);
}

// anthropicChat(system, user, opts={})
//   opts.timeoutMs    - request timeout (default 60000)
//   opts.max_tokens    - max output tokens (default 1024 for keyword/playlist, callers can override)
//   opts.temperature   - default 0.7 (slightly creative for keyword generation)
// Returns: the assistant text (string), or null on failure / missing key.
async function anthropicChat(system, user, opts = {}) {
  const key = getAnthropicKey();
  if (!key) {
    log('no API key found in config/settings.json or ~/.mmx/config.json');
    return null;
  }
  const model = getAnthropicModel();
  const timeoutMs = opts.timeoutMs || 60000;
  const max_tokens = opts.max_tokens || 1024;
  const temperature = opts.temperature != null ? opts.temperature : 0.7;
  const settings = getSettings();
  const isDeepSeek = settings.llmProvider === 'deepseek';

  try {
    const base = isDeepSeek
      ? (settings.deepseekBase || 'https://api.deepseek.com/chat/completions')
      : getAnthropicBase();
    const selectedModel = isDeepSeek
      ? (settings.deepseekModel || 'deepseek-v4-flash')
      : model;
    const body = JSON.stringify(isDeepSeek ? {
      model: selectedModel,
      max_tokens,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    } : {
      model: selectedModel,
      max_tokens,
      temperature,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const https = require('https');
    const url = new URL(base);
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: isDeepSeek ? {
          'authorization': `Bearer ${key}`,
          'content-type': 'application/json',
        } : {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString();
            const data = JSON.parse(raw);
            if (data.error) reject(new Error(data.error.message || JSON.stringify(data.error)));
            else resolve(data);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });
    const text = (isDeepSeek
      ? (result.choices?.[0]?.message?.content || '')
      : (result.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n'))
      .trim();
    log(`OK (${text.length} chars, ${result.usage?.output_tokens || '?'} tokens)`);
    return text || null;
  } catch (e) {
    log('failed:', e.message.slice(0, 500));
    return null;
  }
}

module.exports = {
  anthropicChat,
  getAnthropicKey,
  getAnthropicBase,
  getAnthropicModel,
};

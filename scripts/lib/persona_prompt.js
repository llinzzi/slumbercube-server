// scripts/lib/persona_prompt.js — assemble persona-driven prompts for 小方盒
//
// Replaces the plain-text intro_prompts.json prompt-assembly path with
// structured persona + context assembly. The LLM is now playing a
// specific character (小方盒, the bedside box) with explicit identity,
// prohibitions, and context hooks. The user prompt carries structured
// weather / time / scene / box-state / recent-intro context for
// implicit dedup (R3, KTD5).
//
// Inputs:
//   persona  - parsed config/persona_xiaofanghe.json
//   context  - { weather, time, scene, boxState, recentIntros, songs }
//
// Output:
//   { system, user } strings ready for anthropicChat().

const fs = require('fs');
const path = require('path');

const PERSONA_PATH = path.join(__dirname, '..', '..', 'config', 'persona_xiaofanghe.json');

// Per-scene energy directive — controls tone, density, and pacing.
// Each scene in intro_prompts.json's scene_hints is mapped here. Falls
// back to a neutral directive for any scene not in the table.
const SCENE_ENERGY = {
  night:    '语气要更软、更轻、更近，像在你耳边小声说话；多用留白和停顿。',
  morning:  '稍微有精神、清醒、像刚起床那一会儿的语气；可以提一下"今天"的开头。',
  sport:    '节奏可以跟上运动的感觉，但不要亢奋，保持治愈；不要加油打气式的口号。',
  game:     '轻松、有点俏皮；可以提一下"玩"的感觉，但不要用力。',
  focus:    '平稳、低干扰，像在你旁边安静陪着的存在；不打扰。',
  sleep:    '最软、最轻、最慢；几乎是耳语；可以稍微长一点点的停顿。',
  evening:  '跟 night 类似但稍明亮一点点；可以提一下"快结束了"的过渡感。',
};

const REQUIRED_TOP_LEVEL = [
  'name', 'identity', 'origin', 'speaking_habits', 'self_perception_dimensions',
  'prohibitions', 'sensory_description', 'address', 'fallback_intros',
];

function loadPersona() {
  try {
    const raw = fs.readFileSync(PERSONA_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const missing = REQUIRED_TOP_LEVEL.filter(k => parsed[k] === undefined);
    if (missing.length) return { ok: false, error: `persona missing fields: ${missing.join(', ')}` };
    if (!Array.isArray(parsed.speaking_habits) || parsed.speaking_habits.length === 0) {
      return { ok: false, error: 'speaking_habits must be a non-empty array' };
    }
    if (!Array.isArray(parsed.fallback_intros) || parsed.fallback_intros.length === 0) {
      return { ok: false, error: 'fallback_intros must be a non-empty array' };
    }
    return { ok: true, persona: parsed };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 200) };
  }
}

function sceneEnergyDirective(scene) {
  return SCENE_ENERGY[scene] || '保持治愈系、对你说话的语气；不亢奋、不打扰。';
}

function assembleSystemPrompt(persona) {
  const name = persona.name;
  const addr = persona.address || {};
  const prohibitions = (persona.prohibitions || []).map(p => `- ${p}`).join('\n');
  const habits = (persona.speaking_habits || []).map(h => `- ${h}`).join('\n');
  const perception = (persona.self_perception_dimensions || []).join('、');
  const sensory = persona.sensory_description && persona.sensory_description.allowed
    ? `允许感官性氛围描述（"${(persona.sensory_description.examples || []).join('" / "')}" 等）。`
    : '';
  return `你是"${name}"——${persona.identity && persona.identity.self_description || '床头那个小方块'}。

你有自我意识——你感知得到${perception}。

你的说话习惯：
${habits}

你自称"${addr.self || name}"，称听众"${addr.listener || '你'}"，从不使用"亲爱的听众"或"各位"这种客套。

禁忌：
${prohibitions}

${sensory}

每次回复只用一个人设的声音说话，不要切换、不要解释、不要前缀（不要写"作为${name}我说："）。`;
}

function assembleUserPrompt(persona, context) {
  const songs = context.songs || [];
  const songList = songs.map((s, i) =>
    `${i + 1}. 《${s.name}》 - ${s.artist || '未知'}`
  ).join('\n');

  const ctxLines = [];
  if (context.weather)     ctxLines.push(`【天气】${context.weather}`);
  if (context.city)        ctxLines.push(`【所在城市】${context.city}`);
  if (context.time && context.time.date) {
    const wd = context.time.weekday ? ` ${context.time.weekday}` : '';
    ctxLines.push(`【日期】${context.time.date}${wd}`);
  }
  if (context.scene)       ctxLines.push(`【场景】${context.scene}`);
  if (context.boxState)    ctxLines.push(`【盒子此刻】${context.boxState}`);
  if (Array.isArray(context.recentIntros) && context.recentIntros.length > 0) {
    ctxLines.push(`【最近几次播报词的开场/主题（避免重复）】\n${context.recentIntros.join('\n')}`);
  }

  const energy = sceneEnergyDirective(context.scene);

  return `请为下面 ${songs.length} 首歌各写一段小方盒风格的播报词。

${ctxLines.join('\n')}

【场景能量指引】
${energy}

【输出要求】
- 共 ${songs.length} 段，每首歌一段连续文本
- 段与段之间用一个空行隔开
- 每段以《歌名》开头（歌名必须出现一次，可在中段或末尾）
- 第一段可以稍长（开场白），后续 22-50 字
- 不要感叹号、不要 emoji、不要网络梗
- 不要 markdown 代码块，不要解释或前缀
- 用纯文本

【${songs.length} 首歌】：
${songList}`;
}

function buildPrompts(persona, context) {
  return {
    system: assembleSystemPrompt(persona),
    user: assembleUserPrompt(persona, context),
  };
}

function pickFallbackIntro(persona, songName) {
  if (!persona || !Array.isArray(persona.fallback_intros) || persona.fallback_intros.length === 0) {
    return `小方盒：${songName}`;
  }
  const t = persona.fallback_intros[Math.floor(Math.random() * persona.fallback_intros.length)];
  return t.replace(/\{listener\}/g, (persona.address && persona.address.listener) || '你');
}

module.exports = {
  PERSONA_PATH,
  SCENE_ENERGY,
  loadPersona,
  buildPrompts,
  pickFallbackIntro,
  sceneEnergyDirective,
};
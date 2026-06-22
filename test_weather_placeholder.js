// One-shot test for weather placeholder substitution.
// Mirrors the helpers in build_playlist_from_result.js. If you
// change them there, sync here too.

const fs = require('fs');
const https = require('https');

function fetchWeather7d() {
  return new Promise((resolve) => {
    const url = 'https://nn3aaqw4wr.re.qweatherapi.com/v7/weather/7d?location=101210106&key=YOUR_QWEATHER_API_KEY_HERE';
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
  });
}

function formatWeatherLine(day) {
  if (!day) return '';
  const label = (day.textDay && day.textDay !== day.textNight)
    ? day.textDay + '转' + day.textNight
    : (day.textDay || '');
  const range = (day.tempMin && day.tempMax)
    ? day.tempMin + '~' + day.tempMax + '°C'
    : '';
  return [label, range].filter(Boolean).join('，');
}

(async () => {
  const r = await fetchWeather7d();
  if (!r || r.code !== '200') { console.log('FETCH FAILED'); process.exit(1); }
  const today = formatWeatherLine(r.daily[0]);
  const tomorrow = formatWeatherLine(r.daily[1]);
  console.log('weatherToday:    ' + JSON.stringify(today));
  console.log('weatherTomorrow: ' + JSON.stringify(tomorrow));

  const cfg = JSON.parse(fs.readFileSync('config/intro_prompts.json', 'utf8'));
  const sceneHint = cfg.scene_hints.night || '夜深了';
  const songList = '1. 《示例歌A》 - 示例\n2. 《示例歌B》 - 示例';
  const usr = cfg.user_template
    .replace(/\$\{sceneHint\}/g, sceneHint)
    .replace(/\$\{songs\.length\}/g, '2')
    .replace(/\$\{songList\}/g, songList)
    .replace(/\$\{weatherToday\}/g, today)
    .replace(/\$\{weatherTomorrow\}/g, tomorrow);

  const residual = (usr.match(/\$\{[^}]+\}/g) || []);
  console.log('--- residual placeholders: ' + (residual.join(',') || '(none — all replaced)'));
  console.log('--- USER prompt ---');
  console.log(usr);
})();
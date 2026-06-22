#!/usr/bin/env python3
"""
intro-tester.py — Iterate on system + user prompts without re-fetching songs.

Reuses the songs from an existing playlist.json, calls MiniMax-M3 with a
custom (system, user_template) pair, and writes a comparison report.

Usage:
    python3 intro-tester.py \\
        --playlist .radio_playlist/2026062107384/playlist.json \\
        --system "你是一个..." \\
        --user "场景：${sceneHint} ..." \\
        --out /tmp/intro-test-1.json
"""
import argparse, json, os, sys, time, urllib.request, urllib.error
from pathlib import Path

def load_api_key():
    """Read MiniMax API key from ~/.mmx/config.json (same place the worker uses)."""
    cfg_path = Path.home() / ".mmx" / "config.json"
    if cfg_path.exists():
        try:
            d = json.loads(cfg_path.read_text(encoding="utf-8"))
            if d.get("api_key"):
                return d["api_key"]
        except Exception:
            pass
    return os.environ.get("MINIMAX_API_KEY") or os.environ.get("ANTHROPIC_KEY")

def load_playlist(path):
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    return d["songs"]

def format_song_list(songs):
    return "\n".join(f"{i+1}. 《{s['name']}》 - {s.get('artist','')}" for i, s in enumerate(songs))

def call_minimax(system, user, model="MiniMax-M3"):
    key = load_api_key()
    if not key:
        sys.exit("ERROR: No API key found in ~/.mmx/config.json or env")
    url = "https://api.minimaxi.com/anthropic/v1/messages"
    body = {
        "model": model,
        "max_tokens": 4000,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8")
        return {"error": f"HTTP {e.code}: {err}", "duration_ms": int((time.time()-t0)*1000)}
    duration = int((time.time()-t0)*1000)
    try:
        text = data["content"][0]["text"]
        return {"response": text, "duration_ms": duration, "usage": data.get("usage")}
    except Exception as e:
        return {"error": f"Parse: {e} - {data}", "duration_ms": duration}

def parse_intros(text, n_songs):
    """Parse intros from response. Tries JSON array first, falls back to --- separators."""
    s = text.strip()
    # Strip code fence
    if s.startswith("```"):
        lines = s.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        s = "\n".join(lines).strip()
    # Try JSON array
    start = s.find("[")
    end = s.rfind("]")
    if start >= 0 and end > start:
        try:
            arr = json.loads(s[start:end+1])
            if isinstance(arr, list) and len(arr) == n_songs:
                return arr, None
        except json.JSONDecodeError:
            pass
    # Fallback: --- separators
    if "---" in s:
        parts = [p.strip() for p in s.split("---") if p.strip()]
        if len(parts) == n_songs:
            # Treat each part as a single-line announcement
            return [{"song": "", "announcement": p} for p in parts], None
    # Fallback: numbered sections (1. 《song》: content\n2. 《song》: content\n...)
    import re
    parts = re.split(r"\n\s*\d+[\.\u3001\u3002)\u3010]\s*[\u300c\u300e\u300a《]?", s)
    parts = [p.strip() for p in parts if p.strip()]
    if len(parts) == n_songs:
        return _join_split_song_names(parts)
    # Fallback: 【第N首】 markers
    parts2 = re.split(r"【第\s*\d+\s*首[】\]]\s*", s)
    parts2 = [p.strip() for p in parts2 if p.strip()]
    if len(parts2) == n_songs:
        return _join_split_song_names(parts2), None
    # Fallback: 《songname》——content repeating
    parts3 = re.split(r"《[^》]+》\s*[—\-]+", s)
    parts3 = [p.strip() for p in parts3 if p.strip()]
    if len(parts3) == n_songs:
        return _join_split_song_names(parts3), None
    # Fallback: blank-line separated paragraphs
    parts4 = re.split(r"\n\s*\n", s)
    parts4 = [p.strip() for p in parts4 if p.strip()]
    if len(parts4) == n_songs:
        return _join_split_song_names(parts4), None
    return None, f"no JSON array, --- separator, or numbered list found ({len(parts)}/{len(parts2)}/{len(parts3)}/{len(parts4)} parts)"

def _join_split_song_names(parts):
    """Fix lines where song name was split: 'songname》\\nrest' → 'songname》rest'.
    Also strip leading 'N. ' or '【电台开场】' markers."""
    import re
    fixed = []
    for p in parts:
        # Drop leading 【电台开场】 / 【开场】 etc on first line
        p = re.sub(r"^【[^】]+】\s*\n?", "", p)
        # Drop leading "1. " "2. " etc
        p = re.sub(r"^\s*\d+[\.\u3001\u3002)]\s*", "", p)
        # Glue split song name back to next line
        m = re.match(r"^(《[^》]+》)\s*\n\s*(.+)$", p, re.DOTALL)
        if m:
            p = m.group(1) + m.group(2)
        fixed.append(p.strip())
    return [{"song": "", "announcement": p} for p in fixed]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--playlist", required=True)
    ap.add_argument("--system", required=True)
    ap.add_argument("--user", required=True)
    ap.add_argument("--scene", default="夜深了")
    ap.add_argument("--weather-today", default="中雨转小雨, 21~29°C, 湿度87%")
    ap.add_argument("--weather-tomorrow", default="中雨转小雨, 21~29°C")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    songs = load_playlist(args.playlist)
    song_list = format_song_list(songs)

    user_text = args.user
    user_text = user_text.replace("${sceneHint}", args.scene)
    user_text = user_text.replace("${weatherToday}", args.weather_today)
    user_text = user_text.replace("${weatherTomorrow}", args.weather_tomorrow)
    user_text = user_text.replace("${songList}", song_list)

    print(f"=== system ({len(args.system)} chars) ===")
    print(args.system)
    print(f"\n=== user ({len(user_text)} chars) ===")
    print(user_text[:600] + "..." if len(user_text) > 600 else user_text)

    result = call_minimax(args.system, user_text)
    if "error" in result:
        print(f"\nAPI ERROR: {result['error']}")
        sys.exit(1)

    print(f"\n=== duration: {result['duration_ms']}ms ===")
    print(f"=== usage: {result.get('usage')} ===")

    intros, err = parse_intros(result["response"], len(songs))
    if err:
        print(f"\nPARSE ERROR: {err}")
        print("Raw response (first 800 chars):")
        print(result["response"][:800])
        sys.exit(1)

    print(f"\n=== INTRO COMPARISON ({len(intros)} songs) ===\n")
    for i, (old, new) in enumerate(zip(songs, intros)):
        song_name = old["name"]
        old_intro = old.get("intro_text", "")
        new_intro = new.get("announcement", "")
        print(f"[{i+1:2d}] 《{song_name}》")
        print(f"     OLD: {old_intro}")
        print(f"     NEW: {new_intro}")
        print()

    if args.out:
        report = {
            "playlist": str(args.playlist),
            "scene": args.scene,
            "weather_today": args.weather_today,
            "weather_tomorrow": args.weather_tomorrow,
            "system": args.system,
            "user_template": args.user,
            "duration_ms": result["duration_ms"],
            "usage": result.get("usage"),
            "old_intros": [{"name": s["name"], "intro": s.get("intro_text","")} for s in songs],
            "new_intros": [{"name": s["name"], "intro": it.get("announcement","")} for s, it in zip(songs, intros)],
        }
        Path(args.out).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"\nReport saved to {args.out}")

if __name__ == "__main__":
    main()
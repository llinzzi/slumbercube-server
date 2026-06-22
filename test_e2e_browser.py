#!/usr/bin/env python3
"""
192fm L3/L4 — Browser-driven UI E2E tests.

Designed to run via Hermes agent with browser_* tools enabled.
The agent invokes this script; the script orchestrates which checks
to perform against each page.

Architecture:
  - One check per page (rendered, no console errors)
  - One check per user-actionable control (clicks, fills, dropdowns)
  - All checks return {'name': str, 'ok': bool, 'detail': str}

Usage from Hermes agent:
  1. agent: browser_navigate(HOST + '/')
  2. agent: browser_console() — verify no errors
  3. agent: for each control on page → browser_click / browser_type / browser_press
  4. agent: browser_console() — verify no errors after interaction
  5. agent: browser_snapshot() — verify state changed (e.g. toast appeared)
"""
import sys
import json

# ---------------------------------------------------------------------------
# Pages and their action inventory (extracted from views/*.ejs 2026-06-21)
# ---------------------------------------------------------------------------
PAGES = {
    '/': {
        'name': '首页',
        'expected_title_contains': '192',
        'expected_dom': [
            ('h1', '192'),
            ('#volumeSlider', '音量滑块'),
            ('#ttsToggle', 'TTS 开关'),
            ('#playBtn', '收听按钮'),
        ],
        'user_actions': [
            # (label, selector, action, expected_dom_after)
            ('调整音量到 30', '#volumeSlider', 'fill_value:30', '#volumeDisplay == "30"'),
            ('调整音量到 80', '#volumeSlider', 'fill_value:80', '#volumeDisplay == "80"'),
            ('点击 TTS 开关', '#ttsToggle', 'click', None),
        ],
    },
    '/library': {
        'name': '曲目库',
        'expected_title_contains': '网易云收藏',
        'expected_dom': [
            ('#search', '搜索框'),
            ('#refresh', '刷新按钮'),
        ],
        'user_actions': [
            ('输入搜索词 a', '#search', 'fill_value:a', None),
            ('清空搜索', '#search', 'fill_value:', None),
            ('点击刷新', '#refresh', 'click', None),
        ],
    },
    '/admin/dj': {
        'name': '92DJ 管理面板',
        'expected_title_contains': 'DJ',
        'expected_dom': [
            ('button[data-scene="morning"]', '早安按钮'),
            ('button[data-scene="play"]', '游戏按钮'),
            ('button[data-scene="sport"]', '运动按钮'),
            ('button[data-scene="night"]', '晚安按钮'),
            ('#cancel-btn', '取消任务按钮'),
            ('#netease-search-btn', '网易云搜索按钮'),
            ('#schedule-card', '定时任务卡片'),
            ('#schedule-add', '添加定时按钮'),
            ('#schedule-save', '保存到 crontab 按钮'),
            ('#schedule-reload', '重新加载按钮'),
        ],
        'user_actions': [
            # Scene buttons trigger /api/dj/trigger (may 409 if worker busy — both OK)
            ('点击早安', 'button[data-scene="morning"]', 'click', None),
            ('点击游戏', 'button[data-scene="play"]', 'click', None),
            ('点击运动', 'button[data-scene="sport"]', 'click', None),
            ('点击晚安', 'button[data-scene="night"]', 'click', None),
            ('网易云搜索框输入', '#netease-q', 'fill_value:周杰伦', None),
            ('点击搜索', '#netease-search-btn', 'click', None),
            ('点击取消', '#cancel-btn', 'click', None),  # may be disabled when idle
            # Schedule editor (added 2026-06-21)
            ('点击添加定时', '#schedule-add', 'click', 'scheduleList 多了 1 行'),
            ('点击重新加载', '#schedule-reload', 'click', None),
            # Note: clicking #schedule-save rewrites crontab — operator should be careful
            ('点击保存到 crontab', '#schedule-save', 'click', 'crontab 写入了 enabled 项'),
        ],
    },
}

# ---------------------------------------------------------------------------
# Test execution — called by Hermes agent
# ---------------------------------------------------------------------------
def generate_test_plan(host='http://127.0.0.1:3000'):
    """Returns a list of test instructions for the Hermes agent to execute.

    Each instruction is a tuple:
        (action, target, expected)
    where action is one of: 'navigate', 'snapshot', 'console_check',
    'click', 'fill_value', 'press', 'wait'.
    """
    plan = []
    for path, spec in PAGES.items():
        url = host + path
        plan.append(('navigate', url, f'page loads: {spec["name"]}'))
        plan.append(('snapshot', None, f'snapshot of {spec["name"]}'))
        plan.append(('console_check', None, f'no errors on {spec["name"]} load'))
        plan.append(('title_check', spec['expected_title_contains'],
                     f'title contains {spec["expected_title_contains"]!r}'))
        for sel, name in spec['expected_dom']:
            plan.append(('dom_check', sel, f'DOM has {name} ({sel})'))
        plan.append(('console_check', None, f'no errors on {spec["name"]} interactions'))
        for label, sel, action, expected in spec['user_actions']:
            kind, _, val = action.partition(':')
            plan.append((kind, sel, f'{label}: {action}', val))
    return plan


def print_plan(host='http://127.0.0.1:3000'):
    plan = generate_test_plan(host)
    print(f"# 192fm browser E2E test plan — {host}")
    print(f"# {len(plan)} steps\n")
    for i, step in enumerate(plan, 1):
        action, target, desc = step[0], step[1], step[2]
        extra = step[3] if len(step) > 3 else ''
        print(f"{i:3}. {action:18} {str(target or ''):40}  # {desc} {extra}")


if __name__ == '__main__':
    host = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:3000'
    print_plan(host)
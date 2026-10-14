#!/usr/bin/env python3
"""Smoke-test both installed debug apps on a disposable Android emulator.

Usage: python3 scripts/verify-android.py emulator-5580
Both Metro servers and the API must run. DELETES APP DATA on the specified disposable emulator.
SYNC_TOKEN must match the server. Pass --reset-app-data explicitly.
"""
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

serial = sys.argv[1] if len(sys.argv) == 3 and sys.argv[2] == '--reset-app-data' else ''
if not serial.startswith('emulator-'):
    raise SystemExit('Pass an emulator serial explicitly; physical devices are not supported.')
adb = [os.path.join(os.environ['ANDROID_HOME'], 'platform-tools', 'adb'), '-s', serial]


def call(*args):
    return subprocess.check_output(adb + list(args), text=True, timeout=20)


def nodes():
    call('shell', 'uiautomator', 'dump', '/sdcard/offline-first-smoke.xml')
    return list(ET.fromstring(call('shell', 'cat', '/sdcard/offline-first-smoke.xml')).iter('node'))


def wait_for(predicate, description):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            matches = [node for node in nodes() if predicate(node)]
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            time.sleep(1)
            continue
        if matches:
            return matches[0]
        time.sleep(0.5)
    raise AssertionError('Timed out: ' + description)


def tap(node):
    x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
    call('shell', 'input', 'tap', str((x1 + x2) // 2), str((y1 + y2) // 2))


def button(label):
    return wait_for(lambda n: n.get('content-desc') == label and n.get('enabled') == 'true', label)


def type_title(value):
    # Pace key injection so controlled TextInput receives every event on a busy emulator.
    for character in value:
        call('shell', 'input', 'text', character)
        time.sleep(0.08)
    wait_for(lambda n: n.get('class') == 'android.widget.EditText' and n.get('text') == value, 'editor text committed')


def text(value):
    return wait_for(lambda n: n.get('text') == value, value)


token = os.environ['SYNC_TOKEN']
packages = [('com.watermelontodo', 'WatermelonDB', 8081), ('com.opsqlitetodo', 'OP-SQLite', 8082)]

def launch(package, database, port, reset=False):
    if reset:
        call('shell', 'pm', 'clear', package)
    call('reverse', f'tcp:{port}', f'tcp:{port}')
    call('shell', 'am', 'start', '-n', package + '/.MainActivity')
    text('Todo · ' + database)

def configure():
    tap(button('서버 설정'))
    tap(button('인증 토큰'))
    for c in token:
        call('shell', 'input', 'text', c)
        time.sleep(0.08)
    call('shell', 'input', 'keyevent', '4')
    tap(button('서버 설정 닫기'))

def sync():
    tap(button('서버 저장·복원'))
    text('서버 저장·복원 완료')

def add(title):
    tap(button('새 할 일'))
    type_title(title)
    tap(button('추가'))
    call('shell', 'input', 'keyevent', '4')
    text(title)

# Only use a disposable emulator: both databases are intentionally reset here.
for package, database, port in packages:
    call('shell', 'pm', 'clear', package)

wm_title = 'WM' + str(int(time.time()))[-6:]
op_title = 'OP' + str(int(time.time()))[-6:]
launch(*packages[0]); configure(); add(wm_title); sync()
print('Watermelon: local create -> server save passed', flush=True)
launch(*packages[1]); configure(); sync(); text(wm_title)
add(op_title); sync()
print('OP-SQLite: restore Watermelon todo -> local create -> server save passed', flush=True)
launch(*packages[0]); sync(); text(op_title)
print('Watermelon: restore OP-SQLite todo passed', flush=True)
for package, database, port in packages:
    launch(package, database, port, reset=True); configure(); sync()
    text(wm_title); text(op_title)
    print(database + ': fresh database restoration passed', flush=True)
# Delete using OP and propagate to Watermelon.
tap(button(op_title + ' 삭제'))
tap(wait_for(lambda n: n.get('text') == '삭제' and n.get('class') == 'android.widget.Button', 'delete confirmation'))
sync()
launch(*packages[0]); sync()
assert not any(n.get('text') == op_title for n in nodes()), 'Remote deletion not applied'
text(wm_title)
print('Both apps: remote deletion propagation passed', flush=True)

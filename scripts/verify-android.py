#!/usr/bin/env python3
"""Smoke-test both installed debug apps on a disposable Android emulator.

Usage: python3 scripts/verify-android.py emulator-5580
Both Metro servers must be running. Creates and deletes only its own test Todo.
"""
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

serial = sys.argv[1] if len(sys.argv) == 2 else ''
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


for package, database, port in [('com.watermelontodo', 'WatermelonDB', 8081), ('com.opsqlitetodo', 'OP-SQLite', 8082)]:
    call('reverse', f'tcp:{port}', f'tcp:{port}')
    call('shell', 'am', 'start', '-n', package + '/.MainActivity')
    text('Todo · ' + database)
    title = 'T' + str(int(time.time()))[-5:]
    tap(button('새 할 일'))
    type_title(title)
    tap(button('추가'))
    print(database + ': added', flush=True)
    text(title)
    tap(button(title + ' 완료'))
    wait_for(lambda n: n.get('content-desc') == title + ' 완료' and n.get('checked') == 'true', 'completed Todo')
    tap(button(title + ' 수정'))
    tap(button('할 일 수정'))
    call('shell', 'input', 'keyevent', '123')
    call('shell', 'input', 'keyevent', *(['67'] * len(title)))
    wait_for(lambda n: n.get('class') == 'android.widget.EditText' and n.get('text') in ('', '할 일을 입력하세요'), 'editor cleared')
    updated = title + '-edited'
    type_title(updated)
    tap(button('수정 저장'))
    text(updated)
    print(database + ': edited; restarting process', flush=True)
    call('shell', 'am', 'force-stop', package)
    call('shell', 'am', 'start', '-n', package + '/.MainActivity')
    text(updated)
    wait_for(lambda n: n.get('content-desc') == updated + ' 완료' and n.get('checked') == 'true', 'persisted completion after process restart')
    tap(button(updated + ' 삭제'))
    tap(wait_for(lambda n: n.get('text') == '삭제' and n.get('class') == 'android.widget.Button', 'delete confirmation'))
    # Allow the native transaction and list refresh to complete.
    for _ in range(10):
        if not any(n.get('text') == updated for n in nodes()):
            break
    else:
        raise AssertionError('Deleted Todo remains visible')
    print(database + ': create/edit/complete/restart persistence/delete passed', flush=True)

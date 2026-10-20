#!/bin/bash
# Live: checks what tests/reload.test.mjs models of the host's `$.state`
# across /clear (a value reads as never written, at version 0, and the
# writes after the reset are numbered above every version before, so a
# write on a version from before misses). Needs a signed-in host CLI and
# python3: it opens an interactive session of the small mod in
# tests/state-reset, in a pseudo-terminal, in the folder given (this mod's,
# if none), types /clear, then /exit, and submits no prompt, so no model is
# called. The host must trust that folder already: this never answers that.
#   bash tests/state-reset.live.sh [folder]
set -u
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/mod"
cp -R "$here/state-reset/." "$work/mod/"
python3 - "$work/mod" "${1:-$(dirname "$here")}" <<'PY'
import fcntl, json, os, pty, re, select, struct, subprocess, sys, termios, time
mod, cwd = sys.argv[1:3]
out = os.path.join(mod, 'out')
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
proc = subprocess.Popen(['claude', '--setting-sources', '', '--strict-mcp-config', '--plugin-dir', mod],
                        stdin=slave, stdout=slave, stderr=slave, cwd=cwd, start_new_session=True,
                        env={**os.environ, 'TERM': 'xterm-256color'})
os.close(slave)
screen = bytearray()
asked = False

def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        if master in select.select([master], [], [], 0.1)[0]:
            try:
                data = os.read(master, 65536)
            except OSError:
                return False
            if not data:
                return False
            screen.extend(data)
        if proc.poll() is not None:
            return False
    return True

def wait_for(name, seconds):
    # A question whether to trust the folder stops the check unanswered.
    global asked
    end = time.time() + seconds
    while time.time() < end:
        if os.path.exists(os.path.join(out, name)):
            return True
        if not pump(0.3):
            break
        # The terminal draws spaces as moves: compare the letters alone.
        shown = re.sub(rb'\x1b\[[0-9;?<>=]*[A-Za-z]|\s', b'', bytes(screen[-6000:])).lower()
        if b'trustthisfolder' in shown:
            asked = True
            break
    return os.path.exists(os.path.join(out, name))

def type_line(text):
    os.write(master, text.encode())
    pump(0.8)
    os.write(master, b'\r')

started = wait_for('start.json', 60)
if started:
    pump(1.5)
    type_line('/clear')
cleared = started and wait_for('clear.json', 30)
if not asked and proc.poll() is None:
    pump(1.0)
    type_line('/exit')
end = time.time() + 20
while not asked and proc.poll() is None and time.time() < end:
    pump(0.3)
if proc.poll() is None:
    proc.terminate()
if asked:
    print(f'not ok - the host asks whether to trust {cwd}: start it there once, answer, then run this again')
    sys.exit(1)
if not cleared:
    print('not ok - the session did not get through ' + ('/clear' if started else 'session.start'))
    sys.exit(1)
start = json.load(open(os.path.join(out, 'start.json')))
clear = json.load(open(os.path.join(out, 'clear.json')))
before = start['before']
print(json.dumps({'before': start['steps'], 'after': clear}))
first = clear['first']
ok = (before > 0 and first.get('version') == 0 and 'value' not in first
      and all(s['wrote']['isSet'] and s['wrote']['version'] > before for s in clear['steps'])
      and not any(s['stale']['isSet'] for s in clear['steps']))
print(('ok' if ok else 'not ok') + " - after /clear the host's $.state reads a value as never written, at version 0, and numbers the writes after it above every version before")
sys.exit(0 if ok else 1)
PY

"""Chỉ đọc cấu hình tải và metadata Handout67/n8n; không sửa VPS hoặc in secret.

Nhận profile VPS đã khai báo, dùng SSH helper kiểm host key; lưu biên nhận riêng.
Khi đích thiếu hoặc đọc lỗi, trả lỗi thật, không suy thành đã kiểm.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
helper_path = Path('E:/Codex-Projects/New project/services/shared/ssh-keyring-transfer.py')
spec = importlib.util.spec_from_file_location('ssh_helper', helper_path)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
source = r'''
import datetime, hashlib, json, pathlib, re, subprocess
def run(args):
    return subprocess.check_output(args, text=True)
items = json.loads(run(['docker', 'inspect', *run(['docker', 'ps', '-q']).split()]))
rows = []
for c in items:
    name = c['Name'].lstrip('/')
    env = dict(x.split('=', 1) for x in c['Config'].get('Env', []) if '=' in x)
    row = {'name': name, 'image': c['Image'], 'startedAt': c['State']['StartedAt'],
           'restartCount': c['RestartCount'],
           'environmentHash': hashlib.sha256(json.dumps(env, sort_keys=True).encode()).hexdigest()}
    if 'n8n' in name:
        row['executionLimits'] = {k: env[k] for k in ['N8N_CONCURRENCY_PRODUCTION_LIMIT', 'EXECUTIONS_MODE', 'EXECUTIONS_TIMEOUT'] if k in env}
        cmd = c['Config'].get('Cmd') or []
        row['concurrencyArgs'] = [str(cmd[i+1]) for i, v in enumerate(cmd[:-1]) if str(v) == '--concurrency']
    if name == 'izone-handout-writing67-handout67-1':
        row['ownSettingNames'] = sorted(k for k in env if k.startswith('HANDOUT67_'))
        row['limits'] = {'nanoCpus': c['HostConfig']['NanoCpus'], 'memory': c['HostConfig']['Memory']}
        for key in ['HANDOUT67_ROSTER_URL', 'HANDOUT67_N8N_WAKE_URL']:
            if key in env:
                from urllib.parse import urlsplit
                u = urlsplit(env[key]); row[key] = {'host': u.hostname, 'pathHash': hashlib.sha256(u.path.encode()).hexdigest()}
    rows.append(row)
root = pathlib.Path('/opt/izone-handout-writing67')
own = {}
for rel in ['src/service.mjs', 'src/server.mjs', 'src/config.mjs']:
    p = root / rel
    if p.is_file():
        text = p.read_text(); own[rel] = {'sha256': hashlib.sha256(text.encode()).hexdigest(),
            'maxLeasesDefaults': re.findall(r'maxLeases\s*=\s*([0-9]+|null)', text)}
print(json.dumps({'outcome': 'success', 'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'slot': 'vps_1', 'containers': rows, 'ownSource': own, 'productionChanged': False}))
'''
client, password = helper.connect('vps_1')
try:
    output = helper.run_command(client, "python3 - <<'HANDOUT67_READ_ONLY'\n" + source + "\nHANDOUT67_READ_ONLY", 90)
    value = json.loads(output)
    out = Path('.codex/product-evidence/live-before.json')
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'outcome': value['outcome'], 'productionChanged': False,
        'containers': len(value['containers']),
        'n8n': [r for r in value['containers'] if 'executionLimits' in r],
        'own': [r for r in value['containers'] if r['name'] == 'izone-handout-writing67-handout67-1'],
        'ownSource': value['ownSource'], 'evidence': str(out)}, ensure_ascii=False))
finally:
    password = ''
    client.close()

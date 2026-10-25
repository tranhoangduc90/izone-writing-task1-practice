"""VPS: pin the own registry and install the own durable two-slot consumer."""
from pathlib import Path
import json,subprocess,hashlib,os
root=Path('/opt/izone-shops-writing');release=root/'releases/20261024.1'
def run(a,input=None):
 p=subprocess.run(a,input=input,text=True,capture_output=True)
 if p.returncode:raise RuntimeError(str(a[:3])+': '+p.stderr[-700:])
 return p.stdout.strip()
key='ielts:writing:shops:prompt_registry:20261024.1'
preview_key=run(['docker','exec','shops-preview-db-20261024','psql','-U','shops_owner','-d','shops_preview_20261024','-At','-c',"SELECT prompt_registry_key FROM writing_practice.activity WHERE id=8"])
old=run(['docker','exec','redis','redis-cli','--raw','GET',preview_key]);assert old
new=old.replace('task2-shops-preview-l9-v2','task2-shops-lesson9-v2').replace(preview_key,key);json.loads(new)
assert 'task2-shops-lesson9-v2' in new
existing=run(['docker','exec','redis','redis-cli','--raw','GET',key]);assert not existing or existing==new
if not existing:run(['docker','exec','-i','redis','redis-cli','-x','SET',key],new)
assert run(['docker','exec','redis','redis-cli','--raw','GET',key])==new
assert run(['docker','exec','redis','redis-cli','--raw','GET',preview_key])==old
cfg=json.loads((root/'runtime.private.json').read_text())
config={'workflowId':'pp7D1b3dMwAYZEZf','statusUrl':'http://127.0.0.1:18927/api/v1/shops/status','recoverUrl':'http://127.0.0.1:18927/api/v1/internal/grading-jobs/recover','webhookUrl':'http://127.0.0.1:5678/webhook/shops_writing_worker','headerKey':cfg['workerKey'],'apiToken':cfg['apiToken']}
path=release/'worker-config.private.json';path.write_text(json.dumps(config));path.chmod(0o600)
runtime=Path('/usr/local/lib/shops-writing-worker');runtime.mkdir(exist_ok=True)
code=release/'worker.py';(runtime/'worker.py').write_bytes(code.read_bytes());(runtime/'worker.py').chmod(0o644)
unit='''[Unit]
Description=Shops Writing independent grading worker
Wants=network-online.target
After=network-online.target docker.service
[Service]
Type=simple
DynamicUser=yes
StateDirectory=shops-writing-worker
StateDirectoryMode=0700
LoadCredential=worker-config:/opt/izone-shops-writing/releases/20261024.1/worker-config.private.json
Environment=SHOPS_WORKER_CONFIG=%d/worker-config
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/python3 /usr/local/lib/shops-writing-worker/worker.py
Restart=always
RestartSec=5
TimeoutStopSec=20
MemoryMax=96M
CPUQuota=20%
TasksMax=16
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
IPAddressDeny=any
IPAddressAllow=localhost
UMask=0077
[Install]
WantedBy=multi-user.target
'''
candidate=release/'shops-writing-worker.service';candidate.write_text(unit);run(['systemd-analyze','verify',str(candidate)])
target=Path('/etc/systemd/system/shops-writing-worker.service');assert not target.exists(),'Service exists; inspect instead'
target.write_text(unit);run(['systemctl','daemon-reload']);run(['systemctl','enable','--now','shops-writing-worker.service'])
receipt={'outcome':'passed','workflowId':config['workflowId'],'registryKey':key,'registrySha256':hashlib.sha256(new.encode()).hexdigest(),'oldRegistryUnchanged':True,'workerSha256':hashlib.sha256(code.read_bytes()).hexdigest(),'concurrency':2,'recoverySeconds':30}
(release/'worker-install-receipt.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))

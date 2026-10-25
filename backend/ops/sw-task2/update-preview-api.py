from pathlib import Path
import subprocess,json,time,urllib.request,datetime
root=Path('/opt/izone-sw-task2-preview-20261025')
def run(a):
 p=subprocess.run(a,text=True,capture_output=True)
 if p.returncode:raise RuntimeError(p.stderr[-1000:])
 return p.stdout.strip()
live=json.loads(run(['docker','inspect','sw-task2-preview-api']))[0]
assert live['Config']['Labels']['izone.product']=='sw-task2-preview'
context=root/'image';ops=context/'ops/sw-task2'
for p in (root/'candidate').iterdir():
 if p.suffix in ['.js','.mjs','.json']:
  (ops/p.name).write_bytes(p.read_bytes());(ops/p.name).chmod(0o644)
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S')
tag='sw-task2-preview-api:'+stamp
run(['docker','build','--network=none','-t',tag,str(context)])
image=run(['docker','image','inspect',tag,'--format','{{.Id}}'])
run(['docker','stop','sw-task2-preview-api']);run(['docker','rename','sw-task2-preview-api','sw-task2-preview-api-before-'+stamp]);run(['docker','update','--restart=no','sw-task2-preview-api-before-'+stamp])
run(['docker','run','-d','--name','sw-task2-preview-api','--label','izone.product=sw-task2-preview','--restart','unless-stopped','--network','sw-task2-preview-net','--memory','256m','--cpus','0.5','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','100','--env-file',str(root/'api.env'),'-p','127.0.0.1:18935:8790',image]);run(['docker','network','connect','n8n-net','sw-task2-preview-api']);run(['docker','network','connect','bridge','sw-task2-preview-api'])
for _ in range(20):
 try:
  with urllib.request.urlopen('http://127.0.0.1:18935/api/v1/sw/status',timeout=3) as r:status=json.load(r)
  assert status['database']=='sw_task2_preview_20261025';break
 except Exception:time.sleep(1)
else:raise RuntimeError('Updated preview not healthy; previous container retained')
receipt={'outcome':'passed','previousImage':live['Image'],'apiImage':image,'productionServicesTouched':False}
(root/'latest-api-image.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))

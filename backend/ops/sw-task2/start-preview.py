from pathlib import Path
import subprocess,json,urllib.request,urllib.error,time,hashlib
root=Path('/opt/izone-sw-task2-preview-20261025')
assert json.loads((root/'migration-receipt.json').read_text())['outcome']=='passed'
def run(a):
 p=subprocess.run(a,text=True,capture_output=True)
 if p.returncode:raise RuntimeError(str(a[:3])+p.stderr[-1000:])
 return p.stdout.strip()
def exists(n):return bool(run(['docker','ps','-aq','--filter','name=^/'+n+'$']))
if not exists('sw-task2-preview-api'):
 assert ':18935 ' not in run(['ss','-ltn'])
 image=json.loads((root/'runtime-prepared.json').read_text())['apiImage']
 run(['docker','run','-d','--name','sw-task2-preview-api','--label','izone.product=sw-task2-preview','--restart','unless-stopped','--network','sw-task2-preview-net','--memory','256m','--cpus','0.5','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','100','--env-file',str(root/'api.env'),'-p','127.0.0.1:18935:8790',image])
 run(['docker','network','connect','n8n-net','sw-task2-preview-api']);run(['docker','network','connect','bridge','sw-task2-preview-api'])
for _ in range(20):
 try:
  with urllib.request.urlopen('http://127.0.0.1:18935/api/v1/sw/status',timeout=3) as r:status=json.load(r)
  assert status['database']=='sw_task2_preview_20261025';break
 except Exception:time.sleep(1)
else:raise RuntimeError('Preview not healthy; public configuration unchanged')
site=Path('/etc/nginx/sites-enabled/ducizone.conf').resolve();old=site.read_text()
snippet=Path('/etc/nginx/snippets/izone-sw-task2-preview.conf');include='    include /etc/nginx/snippets/izone-sw-task2-preview.conf;'
if include not in old:
 assert not snippet.exists()
 needle='    include /etc/nginx/snippets/izone-shops-writing.conf;';assert old.count(needle)==1
 new=old.replace(needle,needle+'\n'+include)
 text='''# SW Task 2 candidate only. Existing products keep their routes and images.
location ^~ /sw-task2-preview-api/api/v1/internal/ { return 404; }
location ^~ /sw-task2-preview-api/ {
    proxy_pass http://127.0.0.1:18935/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 45s;
    client_max_body_size 128k;
}
'''
 (root/'nginx-before.conf').write_text(old);snippet.write_text(text);site.write_text(new)
 check=subprocess.run(['nginx','-t'],text=True,capture_output=True)
 if check.returncode:
  site.write_text(old);raise RuntimeError(check.stderr[-1000:])
 run(['systemctl','reload','nginx'])
 assert site.read_text().replace('\n'+include,'')==old
with urllib.request.urlopen('https://ducizone.ddns.net/sw-task2-preview-api/api/v1/sw/status',timeout=15) as r:public=json.load(r)
assert public['database']=='sw_task2_preview_20261025'
try:urllib.request.urlopen(urllib.request.Request('https://ducizone.ddns.net/sw-task2-preview-api/api/v1/internal/grading-jobs/recover',data=b'{}'),timeout=10);raise RuntimeError('Internal route exposed')
except urllib.error.HTTPError as e:assert e.code==404
report={'outcome':'passed','publicStatus':public,'existingUpstreamsUnchanged':True,'internalRoutesBlocked':True,'realClassesOpened':False}
(root/'https-receipt.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))

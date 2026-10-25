"""VPS: add one production prefix without changing any existing upstream."""
from pathlib import Path
import subprocess,json,hashlib,urllib.request,urllib.error
release=Path('/opt/izone-shops-writing/releases/20261024.1')
site=Path('/etc/nginx/sites-enabled/ducizone.conf').resolve();old=site.read_text()
snippet=Path('/etc/nginx/snippets/izone-shops-writing.conf');include='    include /etc/nginx/snippets/izone-shops-writing.conf;'
assert include not in old and not snippet.exists(),'Route exists; inspect instead'
needle='    include /etc/nginx/snippets/izone-shops-review-preview.conf;';assert old.count(needle)==1
new=old.replace(needle,needle+'\n'+include)
text='''# Shops owns its API, queue, database and read-only results.
location ^~ /shops-writing-api/api/v1/internal/ { return 404; }
location ^~ /shops-writing-api/api/v1/preview/ { return 404; }
location ^~ /shops-writing-api/api/v1/preview-sso/ { return 404; }
location ^~ /shops-writing-api/ {
    proxy_pass http://127.0.0.1:18927/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 45s;
    client_max_body_size 128k;
}
'''
(release/'nginx-before.conf').write_text(old);snippet.write_text(text);site.write_text(new)
check=subprocess.run(['nginx','-t'],capture_output=True,text=True)
if check.returncode:
 site.write_text(old);snippet.unlink();raise RuntimeError(check.stderr[-900:])
subprocess.run(['systemctl','reload','nginx'],check=True)
origin='https://ducizone.ddns.net/shops-writing-api/api/v1/'
with urllib.request.urlopen(origin+'shops/status',timeout=15) as r:status=json.load(r);assert status['database']=='shops_writing'
blocked=[]
for path in ['internal/grading-jobs/recover','internal/writing-flow/intake','preview/reviewer','preview-sso/internal/x']:
 try:urllib.request.urlopen(urllib.request.Request(origin+path,data=b'{}',headers={'Content-Type':'application/json'}),timeout=15);raise AssertionError(path+' exposed')
 except urllib.error.HTTPError as e:assert e.code==404;blocked.append(path)
report={'outcome':'passed','prefix':'/shops-writing-api/','site':str(site),'siteBeforeSha256':hashlib.sha256(old.encode()).hexdigest(),'siteAfterSha256':hashlib.sha256(new.encode()).hexdigest(),'publicStatus':status,'privatePathsBlocked':blocked,'existingRoutesUnchanged':site.read_text().replace('\n'+include,'')==old}
(release/'https-receipt.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))

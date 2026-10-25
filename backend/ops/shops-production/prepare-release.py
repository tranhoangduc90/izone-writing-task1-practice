"""Prepare the approved Shops UI and product entrypoint for production.
No server mutation; all generated data stays in this task's C: workspace.
"""
from pathlib import Path
import json,shutil,hashlib,re
here=Path(__file__).parent
backend=here.parent.parent
pages=Path('C:/Users/ADMIN/Documents/Codex/shops-production-worktrees/pages')
preview=pages/'shops-backend-preview-20261024'
out=pages/'shops-writing'
assert preview.is_dir() and not out.exists()
shutil.copytree(preview,out)
ui=out/'writing-handouts/shops-review'
for p in out.rglob('*'):
 if p.suffix in ['.js','.mjs','.html','.css']:
  text=p.read_text(encoding='utf-8-sig')
  text=text.replace('shops-review-preview-api','shops-writing-api').replace('IZONE_SHOPS_PREVIEW','IZONE_SHOPS')
  text=text.replace('izone:shops-connected:20261024:','izone:shops-writing:production:')
  text=text.replace('Bản thử nối backend giảng viên','Giảng viên').replace('Bản thử nối backend học viên','Học viên')
  text=text.replace('Đang mở bản thử nối backend…','Đang mở handout…').replace('dùng bản thử nối backend có tương tác','dùng handout có tương tác')
  p.write_text(text,encoding='utf-8')
app=ui/'connected-app.mjs';s=app.read_text()
a=s.index('function banner(){');b=s.index('\nfunction top()',a)
s=s[:a]+"function banner(){return '';}"+s[b:]
s=s.replace('href="./connected.html"','href="./index.html"').replace('src="../../shared/master170/assets/','src="./shared/master170/assets/')
s=s.replace('Kết quả chấm từ pipeline Writing; học viên xem tại mục Kết quả.','Nhận xét từng câu của Draft 2; học viên xem cùng nội dung tại mục Kết quả.')
s=s.replace('máy chủ thử','máy chủ').replace('Database riêng · hồ sơ giả và bản sao bài cũ đã bỏ định danh. Chưa phát hành.','')
app.write_text(s,encoding='utf-8')
google=ui/'teacher-google.mjs';s=google.read_text().replace("+'preview/auth-config'","+'auth/config'");google.write_text(s,encoding='utf-8')
for name,dest in [('connected.html','index.html'),('connected-teacher.html','teacher.html')]:
 s=(ui/name).read_text()
 def relocate(m):
  value=m.group(2)
  if value.startswith(('https:','data:','#')):return m.group(0)
  path,sep,query=value.partition('?');absolute=(ui/path).resolve();relative=absolute.relative_to(out.resolve()).as_posix()
  return m.group(1)+'="./'+relative+(sep+query if sep else '')+'"'
 s=re.sub(r'(href|src)="([^"]+)"',relocate,s)
 (out/dest).write_text(s,encoding='utf-8')
# Use the current shared SSO library, with one additional product in this bundle.
s=(pages/'shared/teacher-single-sign-on.js').read_text(encoding='utf-8-sig')
marker='const products=[';assert s.count(marker)==1
s=s.replace(marker,marker+"{id:'shops',prefix:'/shops-writing-api/api',source:'/shops-writing-api/api/v1/auth/session/shared-session'},",1)
(out/'shared/teacher-single-sign-on.js').write_text(s,encoding='utf-8')
# No local broker or test reviewer issuer in production.
src=backend/'ops/shops-preview'
s=(src/'server.mjs').read_text(encoding='utf-8-sig')
s=re.sub(r"^import .* from './sso/[^']+';\n",'',s,flags=re.M)
s=s.replace("config.nodeEnv!=='test'","config.nodeEnv!=='production'").replace("/shops_preview_20261024","/shops_writing").replace('ISOLATED_TEST_DATABASE_REQUIRED','SHOPS_PRODUCTION_DATABASE_REQUIRED')
a=s.index('const ssoEnabled=');b=s.index('const safe=',a)
s=s[:a]+'''// Source bridge for the central teacher SSO; authentication tables remain owned.
app.post('/api/v1/auth/session/shared-session',async(q,r,next)=>{
 try{
  const result=await fetch('http://izone-teacher-session:8962/v1/source/shops',{method:'POST',headers:{'Content-Type':'application/json','X-Izone-Csrf':q.get('x-izone-csrf')||'',Origin:q.get('origin')||'',Cookie:q.get('cookie')||''},body:JSON.stringify(q.body||{}),signal:AbortSignal.timeout(15000),redirect:'error'});
  for(const cookie of result.headers.getSetCookie())r.append('Set-Cookie',cookie);
  r.status(result.status).type('application/json').send(await result.text());
 }catch(error){next(error);}
});
app.get('/api/v1/auth/config',(_q,r)=>r.json({ok:true,googleClientId:config.googleClientId,sharedSession:true,source:'shops'}));
'''+s[b:]
a=s.index('// Chỉ trong runtime test');b=s.index("app.post('/api/v1/lesson9/sessions'",a);s=s[:a]+s[b:]
s=s.replace("'/api/v1/preview/status'","'/api/v1/shops/status'").replace("environment:'isolated-test'","environment:'production'").replace('Shops isolated Writing API ready','Shops Writing API ready')
(here/'server.mjs').write_text(s,encoding='utf-8')
s=(src/'atomic-results.mjs').read_text(encoding='utf-8-sig').replace('shops-writing56-67-20261024.1','shops-writing56-67-production-20261024.1').replace('shops-review-preview-api','shops-writing-api').replace('shops-backend-preview-20261024','shops-writing').replace('shops-preview-writer-20261024','shops-writing-writer')
(here/'atomic-results.mjs').write_text(s,encoding='utf-8')
# Canonical old entry points keep working for this activity only.
redirect='''(()=>{const u=new URL(location.href);if(u.searchParams.get('task')!=='writing-task2-public-health-ban')return;const teacher=location.pathname.endsWith('/teacher.html');const target=new URL('../shops-writing/'+(teacher?'teacher.html':'index.html'),location.href);for(const key of ['class','session'])if(u.searchParams.has(key))target.searchParams.set(key,u.searchParams.get(key));location.replace(target.href);})();\n'''
(pages/'writing-handouts/js/shops-entry-redirect.js').write_text(redirect,encoding='utf-8')
for name in ['lesson.html','teacher.html']:
 p=pages/'writing-handouts'/name;s=p.read_text(encoding='utf-8-sig');assert 'shops-entry-redirect.js' not in s
 s=s.replace('</head>','  <script src="./js/shops-entry-redirect.js?v=20261024"></script>\n</head>');p.write_text(s,encoding='utf-8')
receipt={'release':'shops-production-20261024.1','frontendFiles':len([p for p in out.rglob('*') if p.is_file()]),'serverSha256':hashlib.sha256((here/'server.mjs').read_bytes()).hexdigest(),'resultsSha256':hashlib.sha256((here/'atomic-results.mjs').read_bytes()).hexdigest(),'officialStudent':'https://tranhoangduc90.github.io/izone-ai-team-pages/shops-writing/','officialTeacher':'https://tranhoangduc90.github.io/izone-ai-team-pages/shops-writing/teacher.html'}
(here/'source-lock.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8');print(json.dumps(receipt))

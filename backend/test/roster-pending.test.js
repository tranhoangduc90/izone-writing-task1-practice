import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
const {createWritingPracticeService}=await import(process.env.WRITING_ROSTER_TEST_FILE
  ?pathToFileURL(process.env.WRITING_ROSTER_TEST_FILE).href:'../src/service.js');

// Chỉ dùng SQL giả và HTTP loopback. Gộp lúc đang đọc, không giữ kết quả/quyền sau phản hồi.
// Sai bài, nguồn lỗi hoặc dữ liệu thay đổi vẫn phải được đọc và trả đúng ở lượt sau.
function fixture(wait=async()=>{}){
 const state={activityReads:0,rosterReads:0,available:true,failed:false,name:'Người giả A'};
 const pool={async query(sql,params){
  assert.ok(sql.trim().startsWith('SELECT'));
  if(sql.includes('SELECT id, slug, title')){
   state.activityReads++;await wait();if(state.failed)throw Error('SOURCE_FAILED');
   return {rowCount:state.available?1:0,rows:state.available?[{id:params[0],slug:params[0],title:'Bài '+params[0]}]:[]};
  }
  state.rosterReads++;
  return {rows:[{class_ref:'class-'+params[0],class_name_snapshot:'Lớp giả',student_ref:'student-'+params[0],display_name:state.name,display_alias:'Alias giả',provisional:false,requires_access_code:false}]};
 }};
 return {state,service:createWritingPracticeService({pool})};
}
test('Writing roster · 100 yêu cầu HTTP ở bốn bài chỉ đọc mỗi bài một lần đang chờ',async()=>{
 let accepted=0,release;const barrier=new Promise(r=>release=r),f=fixture(()=>barrier);
 const server=createServer(async(req,res)=>{
  accepted++;if(accepted===100)release();
  try{const slug=new URL(req.url,'http://fixture').searchParams.get('slug');
   const value=await f.service.getRoster(slug);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));
  }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.code||e.message}));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  await Promise.all(Array.from({length:100},async(_,n)=>{
   const slug='fake-task-'+(n%4),r=await fetch(`http://127.0.0.1:${server.address().port}/?slug=${slug}`);assert.equal(r.status,200);
   const value=await r.json();assert.equal(value.activity.slug,slug);assert.equal(value.classes[0].classRef,'class-'+slug);assert.equal(value.classes[0].students[0].studentRef,'student-'+slug);
  }));
  assert.equal(f.state.activityReads,4);assert.equal(f.state.rosterReads,4);
 }finally{release();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('Writing roster · xong/lỗi phải bỏ bản nhớ; lượt sau đọc nguồn mới',async()=>{
 const f=fixture();await f.service.getRoster('fake-task');f.state.name='Người giả B';
 assert.equal((await f.service.getRoster('fake-task')).classes[0].students[0].displayName,'Người giả B');
 assert.equal(f.state.activityReads,2);
 f.state.available=false;await assert.rejects(f.service.getRoster('fake-task'),{code:'ACTIVITY_NOT_FOUND'});
 f.state.available=true;f.state.failed=true;
 const failures=await Promise.allSettled(Array.from({length:30},()=>f.service.getRoster('fake-task')));
 assert.ok(failures.every(r=>r.status==='rejected'&&r.reason.message==='SOURCE_FAILED'));
 f.state.failed=false;assert.equal((await f.service.getRoster('fake-task')).activity.slug,'fake-task');
});

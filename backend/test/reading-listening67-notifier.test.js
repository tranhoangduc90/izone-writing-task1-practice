// Kiểm mất ACK, lỗi hàng chờ và gửi chỉ định danh; không chạm mạng thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadingListening67Notifier } from '../src/reading-listening67/notifier.js';
test('Mất ACK: ghi lỗi cùng lượt, không gửi nội dung học viên',async()=>{
  const sent=[],failed=[];
  const store={recoverExpired:async()=>{},dispatchDue:async()=>({jobId:'j1',dispatchToken:'lease1'}),dispatchFailed:async j=>failed.push(j)};
  const notifier=createReadingListening67Notifier({store,url:'https://example.invalid/notify',token:'fixture',fetchFn:async(url,request)=>{sent.push(request);throw Error('ACK_LOST');}});
  await notifier.tick();await notifier.close();
  assert.deepEqual(JSON.parse(sent[0].body),{jobId:'j1'});
  assert.deepEqual(failed,[{jobId:'j1',dispatchToken:'lease1'}]);
});
test('Không gửi hai lượt tick song song và không chạy sau close',async()=>{
  let calls=0,release;
  const store={recoverExpired:async()=>{},dispatchDue:async()=>({jobId:'j1'}),dispatchFailed:async()=>{}};
  const notifier=createReadingListening67Notifier({store,url:'https://example.invalid/notify',token:'fixture',fetchFn:async()=>{calls++;await new Promise(resolve=>{release=resolve;});return{ok:true};}});
  const first=notifier.tick();await new Promise(resolve=>setImmediate(resolve));await notifier.tick();
  assert.equal(calls,1);release();await first;await notifier.close();await notifier.tick();assert.equal(calls,1);
});
test('Đóng notifier chờ request hiện tại trước khi đóng pool',async()=>{
  let release,closed=false;
  const notifier=createReadingListening67Notifier({store:{recoverExpired:async()=>{},dispatchDue:async()=>({jobId:'j1'}),dispatchFailed:async()=>{}},url:'https://example.invalid/jobs',token:'fixture',fetchFn:async()=>{await new Promise(resolve=>{release=resolve;});return{ok:true};}});
  const tick=notifier.tick();await new Promise(resolve=>setImmediate(resolve));
  const close=notifier.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(closed,false);release();await tick;await close;assert.equal(closed,true);
});

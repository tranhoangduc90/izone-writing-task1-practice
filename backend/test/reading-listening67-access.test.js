// Kiểm metadata quyền, lỗi và cache; không kết nối VPS hoặc đọc dữ liệu Writing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadingListening67AccessGuard } from '../src/reading-listening67/database-access.js';
test('Role Writing hoặc role Reading có quyền vượt phạm vi không được dùng',async()=>{
  for(const row of [{role_name:'writing_practice_api'},{role_name:'reading_listening67_api',elevated:true},{role_name:'reading_listening67_api',member_of_other_role:true},{role_name:'reading_listening67_api',cross_product_access:true}]) {
    const guard=createReadingListening67AccessGuard({query:async()=>({rows:[row]})});
    await assert.rejects(guard(),/RL67_DATABASE_ROLE_OVERSCOPED/);
  }
});
test('Kiểm quyền hợp lệ gộp request song song; lỗi DB không được cache thành hợp lệ',async()=>{
  let calls=0;
  const guard=createReadingListening67AccessGuard({query:async()=>{calls++;if(calls===1)throw Error('offline');return{rows:[{role_name:'reading_listening67_api',elevated:false,member_of_other_role:false,cross_product_access:false}]};}});
  await assert.rejects(guard(),/offline/);await Promise.all([guard(),guard()]);await guard();
  assert.equal(calls,2);
});

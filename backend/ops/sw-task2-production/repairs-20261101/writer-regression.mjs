// Chạy trong image writer đã ghim; chỉ phân tích dữ liệu giả, không HTTP/AI/DB/ghi kết quả.
import assert from 'node:assert/strict';
import test from 'node:test';
const {parseStructuredCreatePayload}=await import(process.env.SW_WRITER_PARSER||'/app/parser.mjs');
function payload(reason){return {schema_version:2,request_id:'isolated-parser-regression',bai_viet:'This policy are useful.',corrections:[{source_index:0,correction_index:0,operation_key:'synthetic-0',original_text:'This policy are useful.',revised_text:'This policy is useful.',original:'are',improved:'is',original_next_word:'useful',improved_next_word:'useful',reason}]};}
test('structured explanations preserve cô lập and meaningful Vietnamese words',async()=>{
 const reason='Không dùng từ cô lập: câu này cần liên kết với ý trước. Em hãy kiểm lại chủ ngữ.';
 const result=await parseStructuredCreatePayload(payload(reason));assert(result.snapshot.essays[0].comments[0].includes(reason));
});
test('preserving explanation text retains HTML sanitization',async()=>{
 const result=await parseStructuredCreatePayload(payload('Giữ nguyên cụm cô lập. <script>alert(1)</script>'));
 assert(result.snapshot.essays[0].comments[0].includes('cô lập'));assert.doesNotMatch(result.snapshot.essays[0].comments[0],/<script|onerror=/i);
});

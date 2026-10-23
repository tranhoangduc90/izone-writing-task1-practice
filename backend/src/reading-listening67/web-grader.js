/**
 * Nhận bản workflow Read 67 đã ghim và 20 câu trả lời có ID; chạy nguyên Code
 * node của bộ chấm. Chỉ thay adapter nguồn và nơi lưu kết quả, không gọi writer Docs.
 * Prompt/key ở máy chủ. Sai hash/model/schema hoặc thiếu target thì dừng, không trả đúng giả.
 */
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';

export const READING67_WEB_CODE = '67-reading-materials-beyond-concrete-matching-information-nen-cap-1';
export const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const canonical=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export const reading67AnswerFingerprint=parsed=>sha256(canonical(parsed.targets.map(t=>({target_id:t.target_id,source_text:t.source_text,source_text_original:t.source_text_original,observed_state:t.observed_state}))));
const clone = value => JSON.parse(JSON.stringify(value));
const PREPARE_NODES = ['Kiểm tra parser registry', 'Đánh giá mức hoàn thành', 'Chấm deterministic exact', 'Chấm deterministic proposition-targets', 'Chuẩn bị semantic oracle'];
const RESULT_NODES = ['Lấy output AI chính', 'Đọc JSON AI chính', 'Quyết định verdict từ unit audit', 'Merge và kiểm tra fail-closed'];

export class WebGradingError extends Error {
  constructor(code, status=422, details={}) { super(code); this.code=code;this.status=status;this.details=details; }
}

export async function loadReading67WebGrader({snapshotPath, expectedSha256, provider, fetchImpl=fetch}) {
  const bytes=await readFile(snapshotPath);
  if(!expectedSha256||sha256(bytes.toString('utf8'))!==expectedSha256)throw new WebGradingError('GRADER_PIN_MISMATCH',503);
  const workflow=JSON.parse(bytes);
  if(workflow.id!=='l7KBHRE53ES4Rx2j')throw new WebGradingError('GRADER_ID_MISMATCH',503);
  const codes=new Map(workflow.nodes.filter(n=>n.parameters?.jsCode).map(n=>[n.name,n.parameters.jsCode]));
  const reader=codes.get('Đọc target qua source adapter');
  const end=reader?.lastIndexOf('const input = $input.first().json;');
  if(!reader||end<0)throw new WebGradingError('GRADER_SOURCE_CONTRACT_CHANGED',503);
  const helpers=new vm.Script(`(function(){${reader.slice(0,end)}\nreturn {CONFIG,normalizeSpace,normalizeSearch,isPlaceholder,canonicalizeTargetValue,exactNormalizer,stripGeneratedSuffix};})()`).runInNewContext({}, {timeout:4000});
  const config=clone(helpers.CONFIG), profile=config.layout_profiles.l10_mi_v3;
  if(config.lesson_id!=='l10'||profile.expected_cells!==20||profile.minimum_required!==16)throw new WebGradingError('GRADER_PROFILE_CHANGED',503);
  const selected=new Set(['Đọc target qua source adapter',...PREPARE_NODES,...RESULT_NODES,'Tập hợp prompt','Merge không cần AI']);
  const scripts=new Map([...codes].filter(([name])=>selected.has(name)).map(([name,code])=>[name,new vm.Script(`(function(){${code}\n})()`,{filename:name+'.js'})]));
  const pins={workflowId:workflow.id,workflowVersion:workflow.versionId,sha256:expectedSha256,model:config.model.name,thinking:config.model.thinking,promptVersion:config.prompt_version,oracleVersion:config.oracle_version,gradingContract:config.grading_contract_version};
  function run(name,input,states,operationId) {
    const lookup=key=>{if(!states.has(key))throw new WebGradingError('GRADER_CONTEXT_MISSING',503,{node:key});const item={json:states.get(key)};return {first:()=>item,all:()=>[item],item};};
    const result=scripts.get(name)?.runInNewContext({$input:{first:()=>({json:input}),all:()=>[{json:input}]},$:lookup,$execution:{id:operationId}}, {timeout:name==='Đọc target qua source adapter'?60000:5000});
    if(!Array.isArray(result)||result.length!==1||!result[0]?.json)throw new WebGradingError('GRADER_NODE_OUTPUT_INVALID',503,{node:name});
    const output=clone(result[0].json);states.set(name,output);return output;
  }
  function parseWeb(answers) {
    if(!answers||typeof answers!=='object'||Array.isArray(answers))throw new WebGradingError('ANSWERS_INVALID');
    if(Object.keys(answers).some(id=>!profile.expected_target_ids.includes(id)))throw new WebGradingError('TARGET_UNKNOWN');
    const targets=profile.expected_target_ids.map((id,index)=>{
      const original=answers[id]??'';
      if(typeof original!=='string'||original.length>12000)throw new WebGradingError('ANSWER_INVALID');
      const target=config.targets[id],raw=helpers.stripGeneratedSuffix(original);
      const unsupported=helpers.normalizeSpace(raw).replace(/\uFFFC/g,'').trim()===''&&raw.includes('\uFFFC');
      const placeholder=!unsupported&&helpers.isPlaceholder(raw,config);
      const canonical=placeholder||unsupported?'':helpers.canonicalizeTargetValue(raw,target);
      const value=helpers.exactNormalizer(target)&&canonical===null?helpers.normalizeSearch(raw):canonical;
      return {target_id:id,source_text:value??'',source_text_original:helpers.normalizeSpace(raw),observed_state:unsupported?'unsupported':placeholder?'unanswered':'answered',is_placeholder:placeholder,grade_mode:target.grade_mode,pointer:{tab_id:'web',table_signature:config.document_signature.id,row_index:index,column_index:0,anchor:id}};
    });
    return {schema_version:'reading_parsed_registry_v1',lesson_id:config.lesson_id,layout_id:'l10_mi_v3',workflow_version:config.workflow_version,targets};
  }
  function prepareParsed(parsed,operationId=randomUUID()) {
    const states=new Map([['Đọc target qua source adapter',{parsed}]]);
    let value={parsed};
    for(const name of PREPARE_NODES){
      value=run(name,value,states,operationId);
      if(name==='Đánh giá mức hoàn thành'&&!value.completeness.eligible_for_grading)return {gate:value,states,operationId,pins,eligible:false};
    }
    const prompt=value.semantic_targets.length?run('Tập hợp prompt',value,states,operationId):null;
    return {gate:states.get('Đánh giá mức hoàn thành'),graded:value,prompt,states,operationId,pins,eligible:true};
  }
  function prepareWeb(answers,operationId){return prepareParsed(parseWeb(answers),operationId);}
  function inspectWeb(answers){const states=new Map();const validated=run('Kiểm tra parser registry',{parsed:parseWeb(answers)},states,'inspect');return run('Đánh giá mức hoàn thành',validated,states,'inspect');}
  function prepareLegacy(markdown,operationId=randomUUID()){
    const states=new Map();const parsed=run('Đọc target qua source adapter',{markdown,requestedTabId:'t.0'},states,operationId).parsed;
    return prepareParsed(parsed,operationId);
  }
  const httpNode=workflow.nodes.find(n=>n.name.startsWith('AI chính'));
  const endpoint=httpNode?.parameters?.url;
  if(!endpoint||new URL(endpoint).origin!=='https://ducizone.ddns.net')throw new WebGradingError('GRADER_PROVIDER_CHANGED',503);
  const callProvider=provider||async function (prompt,{signal}={}){
    let response;
    try{response=await fetchImpl(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model_id:config.model.name,thinking_level:config.model.thinking,prompt:prompt.prompt,anh_minh_hoa:'',generation_config:prompt.requested_generation_config}),signal:signal||AbortSignal.timeout(650000)});}
    catch(error){throw new WebGradingError(error.name==='TimeoutError'||error.name==='AbortError'?'AI_OUTCOME_UNKNOWN':'AI_CONNECTION_FAILED',503);}
    if(!response.ok)throw new WebGradingError('AI_HTTP_'+response.status,503);
    const text=await response.text();if(text.length>4_000_000)throw new WebGradingError('AI_RESPONSE_TOO_LARGE',503);
    try{return JSON.parse(text);}catch{throw new WebGradingError('AI_RESPONSE_INVALID',503);}
  };
  async function finish(prepared,{replayResponse,onProviderResponse,signal}={}){
    if(!prepared.eligible)throw new WebGradingError('BELOW_COMPLETION_THRESHOLD',422,prepared.gate.completeness);
    const {states,operationId}=prepared;let grading,audit=null,response=null;
    if(prepared.prompt){
      response=replayResponse??await callProvider(prepared.prompt,{signal,operationId});
      if(onProviderResponse)await onProviderResponse(clone(response));
      let value=response;for(const name of RESULT_NODES)value=run(name,value,states,operationId);
      grading=value.grading;
      audit={gateway:states.get('Lấy output AI chính').gateway_audit,unitAudit:states.get('Quyết định verdict từ unit audit').unit_audit_summary,promptHash:prepared.prompt.prompt_hash,inputFingerprint:prepared.prompt.input_fingerprint};
    }else grading=run('Merge không cần AI',prepared.graded,states,operationId).grading;
    if(grading?.target_results?.length!==20)throw new WebGradingError('GRADING_RESULT_INCOMPLETE',503);
    const allowed=['correct','partial','incorrect','missing'];
    if(grading.target_results.some(t=>!allowed.includes(t.verdict)))throw new WebGradingError('GRADING_VERDICT_INVALID',503);
    const feedback=Object.fromEntries(grading.target_results.map(result=>[result.target_id,{status:result.verdict==='missing'?'blank':result.verdict,modelAnswer:result.correct_answer,reason:result.feedback||'Bộ chấm xác nhận phần trả lời này đúng.',sourceMeaning:result.why_official_right||'',nextStep:result.next_step||'Giữ cách nén và đối chiếu các ý cốt lõi.',raw:result}]));
    return {grading,feedback,completeness:prepared.gate.completeness,pins,audit,providerResponse:response,context:{operationId,sourceDigest:reading67AnswerFingerprint(prepared.gate.parsed)}};
  }
  return {pins,config,profile,parseWeb,inspectWeb,prepareWeb,prepareLegacy,finish};
}

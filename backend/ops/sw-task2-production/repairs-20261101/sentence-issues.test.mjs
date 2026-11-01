import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {atomicIssuesCoverRevision,splitDeclaredAtomicIssues} from './sentence-issues.mjs';
const issue=(span,revised_span)=>({span,revised_span,reason:'Lý do đã được AI khai báo.',category:'grammar'});
test('repeated words: selects the occurrence consistent with the revised prefix',()=>{
 const before='The examples are clear, but this new policy are unnecessary.';
 const after='The examples are clear, but this new policy is unnecessary.';
 assert.equal(atomicIssuesCoverRevision(before,after,[issue('are','is')]),true);
 assert.equal(atomicIssuesCoverRevision(before,after+' Indeed.',[issue('are','is')]),false);
});
test('split only already-declared edits, preserve exact revised text and rationale',()=>{
 const before='This new policy create a long-term reduction of waste in many large cities.';
 const after='This new policy leads to a long-term reduction in waste in many large cities.';
 const declared=[issue('create a long-term reduction of','leads to a long-term reduction in')];
 assert.equal(atomicIssuesCoverRevision(before,after,declared),false);
 const split=splitDeclaredAtomicIssues(before,after,declared);
 assert.equal(split.length,2);assert.equal(atomicIssuesCoverRevision(before,after,split),true);
 assert(split.every(i=>i.reason===declared[0].reason));
});
test('unexplained edits, empty explanations and oversized spans stay rejected',()=>{
 const before='A long example sentence shows why this policy are helpful to many families.';
 const after='A long example sentence explains why this policy is helpful to many families.';
 for(const issues of [[issue('are','is')],[{...issue('are','is'),reason:''}]])assert.equal(atomicIssuesCoverRevision(before,after,splitDeclaredAtomicIssues(before,after,issues)),false);
});
test('deployment receipt: every validator contains the exact tested functions', {skip:!process.env.SW_WORKFLOW_SNAPSHOT},()=>{
 const workflow=JSON.parse(fs.readFileSync(process.env.SW_WORKFLOW_SNAPSHOT,'utf8').replace(/^\uFEFF/,''));
 const source=fs.readFileSync(new URL('./sentence-issues.mjs',import.meta.url),'utf8').replace(/\r\n/g,'\n').replace(/^export /gm,'').trim();
 const [atomic,split]=source.split('\n\n// Split only edits');
 const codeNodes=workflow.nodes.filter(n=>n.parameters?.jsCode?.includes('function atomicIssuesCoverRevision('));
 assert.equal(codeNodes.length,14);
 for(const node of codeNodes){const code=node.parameters.jsCode.replace(/\r\n/g,'\n');assert(code.includes(atomic.trim()),node.name+' atomic');assert(code.includes('// Split only edits'+split),node.name+' split');}
});

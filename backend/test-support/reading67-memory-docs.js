import assert from 'node:assert/strict';
import {HOMEWORK_CTA,HOMEWORK_STATUS} from '../src/reading-listening67/web-homework-docs.js';

export function memoryDocs(code){
 const values=new Map(),calls={read:0,write:0};let loseAck=false;
 const chars=text=>[...text].map(text=>({text,style:{link:{url:'https://manual.test/keep'},bold:true}}));
 // Fixture chỉ dùng ký tự BMP; index Google/JS cùng đơn vị UTF-16.
 const get=id=>{if(!values.has(id))values.set(id,{chars:chars('Chữ tay giữ nguyên'),cta:{},revision:1});return values.get(id);};
 const paragraph=(start,text,style={})=>({paragraph:{elements:[{startIndex:start,textRun:{content:text+'\n',textStyle:style}}]}});
 function document(id){const state=get(id),elements=state.chars.map((c,i)=>({startIndex:500+i,textRun:{content:c.text,textStyle:c.style}}));elements.push({startIndex:500+state.chars.length,textRun:{content:'\n',textStyle:{}}});
  return {documentId:id,revisionId:'r'+state.revision,tabs:[{tabProperties:{tabId:'child'},documentTab:{body:{content:[{table:{tableRows:[{tableCells:[{content:[paragraph(1,HOMEWORK_CTA,state.cta),paragraph(100,code)]}]},{tableCells:[{content:[paragraph(300,HOMEWORK_STATUS)]}]},{tableCells:[{content:[{paragraph:{elements}}]}]}]}},paragraph(5000,'Bài Reading khác: nguyên văn/link giữ nguyên',{link:{url:'https://manual.test/other'}})]}}}]};
 }
 return {calls,values,get,loseNextAck(){loseAck=true;},read:async id=>{calls.read++;return document(id);},write:async(id,plan)=>{
  const state=get(id);assert.equal(plan.revisionId,'r'+state.revision);calls.write++;
  for(const r of plan.requests){
   if(r.insertText){const at=r.insertText.location.index-500;assert.ok(at>=0);state.chars.splice(at,0,...chars(r.insertText.text));}
   if(r.deleteContentRange){const {startIndex,endIndex}=r.deleteContentRange.range;assert.ok(startIndex>=500);state.chars.splice(startIndex-500,endIndex-startIndex);}
   if(r.updateTextStyle){const {range,textStyle,fields}=r.updateTextStyle;if(range.startIndex===1){state.cta={...state.cta,...textStyle};continue;}
    for(let i=range.startIndex-500;i<range.endIndex-500;i++)for(const field of fields.split(',')){if(textStyle[field]===undefined)delete state.chars[i].style[field];else state.chars[i].style[field]=structuredClone(textStyle[field]);}
   }
  }
  state.revision++;if(loseAck){loseAck=false;throw Error('Mất ACK sau khi Google đã ghi');}
 }};
}

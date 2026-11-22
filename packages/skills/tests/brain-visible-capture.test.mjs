import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import {plan,lookup,records} from '../skills/oneezy/oneezy-brain/scripts/drive-plan.mjs';
const headers=['ID','title','context_doc','source_url','views'];
const native=v=>v ? {userEnteredValue:{stringValue:v}} : {};
const table=(sheetId,data=[])=>({sheetId,headers,editableFields:headers,rows:Array.from({length:8},(_,i)=>({rowIndex:i+2,cells:headers.map(k=>native(data[i]?.[k]))}))});
const snapshot=(inbox=[],backlog=[])=>({statuses:[],energy:[],tables:{Inbox:table(2030074332,inbox),Backlog:table(2,backlog)}});
const apply=(s,requests)=>{for(const {updateCells:u} of requests){const t=Object.values(s.tables).find(t=>t.sheetId===u.start.sheetId),r=t.rows.find(r=>r.rowIndex===u.start.rowIndex);r.cells[u.start.columnIndex]=u.rows[0].values[0];}};
test('meaningful work creates visible Inbox with existing context Doc and retries across both tabs',()=>{
 const s=snapshot();const data={ID:'59',title:'Repair Skills Sync',views:'Inbox',source_url:'',context_doc:'https://docs.google.com/document/d/1kXhbxXlFayp0Qjd3y9uSdvf_LIlVDRQQL1U3lYIcALQ/edit'};
 apply(s,plan(s,{kind:'capture',meaningful:true,data}).requests);
 assert.equal(lookup(s,'59').tab,'Inbox');assert.equal(lookup(s,'59').data.context_doc,data.context_doc);
 assert.equal(plan(s,{kind:'capture',data}).requests.length,0);
 const promoted=snapshot([],[data]);assert.equal(plan(promoted,{kind:'capture',data:{...data,ID:'60'}}).requests.length,0);
 assert.equal(records(promoted.tables.Inbox).length,0);
});
test('conversational filler is a zero-write capture decision',()=>{
 const s=snapshot();assert.deepEqual(plan(s,{kind:'capture',meaningful:false,data:{ID:'59',title:'thanks'}}).requests,[]);
 assert.equal(records(s.tables.Inbox).length,0);
});
test('unrelated duplicate immutable IDs block capture before any write',()=>{
 const duplicate={ID:'57',title:'Existing deferred skills',source_url:''};const s=snapshot([duplicate],[duplicate]);
 assert.throws(()=>plan(s,{kind:'capture',data:{ID:'59',title:'Repair',source_url:''}}),/occurs more than once/);
});
test('IDs 57 and 58 are found by identity, never duplicated or tied to historical rows',()=>{
 const a={ID:'57',title:'Deferred skills',source_url:''}, b={ID:'58',title:'Routing fix',source_url:''};
 const s=snapshot([a], [b]);
 for(const data of [a,b])assert.equal(plan(s,{kind:'capture',data}).requests.length,0);
 assert.equal(lookup(s,'57').rowIndex,2);assert.equal(lookup(s,'58').tab,'Backlog');
});
test('instructions route meaningful requests and work to Inbox before context-only storage, and sync invokes Status',()=>{
 const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
 assert.match(read('skills/oneezy/oneezy-brain/references/routing.md'),/meaningful requests and work/i);
 assert.match(read('skills/oneezy/oneezy-brain/SKILL.md'),/visible Inbox record/i);
 assert.match(read('skills/oneezy/oneezy-skills/SKILL.md'),/invoke.*\/oneezy-status/i);
 assert.match(read('skills/oneezy/oneezy-status/SKILL.md'),/Skills Sync/);
});

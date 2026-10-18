'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {identity,enrich}=require('../lib/team-bonus-identity.cjs');
const row=extra=>({UID:'RECIPIENT',Type:'Team Bonus (A-Hand)',Amount_micro:'4141800',...extra});
test('legacy, v2 and explicit identities never confuse recipient with source',()=>{
    assert.deepEqual(identity(row({Admin_Remarks:'From: Aminul (UID: SOURCE)'})),{uid:'SOURCE',name:'Aminul'});
    assert.deepEqual(identity(row({Admin_Remarks:'NFT policy v2; source UID: SOURCE'})),{uid:'SOURCE',name:''});
    assert.deepEqual(identity(row({Source_UID:'OTHER',Source_Name:'Saved name',Admin_Remarks:'From: Wrong (UID: SOURCE)'})),{uid:'OTHER',name:'Saved name'});
    for(const extra of [{},{Admin_Remarks:'NFT policy v2; source UID: ../../secret'},{Type:'Deposit',Source_UID:'SOURCE'}])assert.deepEqual(identity(row(extra)),{uid:'',name:''});
});
test('historical v2 enrichment batches unique names, projects public fields and performs no writes',async()=>{
    let calls=0;
    const db={collection:c=>{assert.equal(c,'Users');return {doc:id=>({id})};},getAll:async(...args)=>{
        calls++;assert.deepEqual(args.pop(),{fieldMask:['Name','Account_Deleted']});assert.deepEqual(args,[{id:'SOURCE'}]);
        return [{id:'SOURCE',exists:true,data:()=>({Name:'Aminul',Password:'never returned'})}];
    }};
    const rows=[row({Admin_Remarks:'NFT policy v2; source UID: SOURCE'}),row({Admin_Remarks:'NFT policy v2; source UID: SOURCE'}),row({UID:'FOREIGN',Source_UID:'SECRET'})];
    const before=JSON.stringify(rows),result=await enrich(db,rows,'RECIPIENT');
    assert.equal(calls,1);assert.equal(result.length,2);assert.equal(result[0].Source_Name,'Aminul');assert.equal(result[0].UID,'RECIPIENT');assert.equal(result[0].Amount_micro,'4141800');
    assert.equal(JSON.stringify(rows),before);assert(!JSON.stringify(result).includes('Password'));
});
test('missing, deleted or unavailable users preserve UID without inventing a name; lookup bounded to 20',async()=>{
    const rows=Array.from({length:30},(_,i)=>row({Admin_Remarks:'NFT policy v2; source UID: S'+i}));
    let count=0;const db={collection:()=>({doc:id=>({id})}),getAll:async(...args)=>{count=args.length-1;throw Error('offline');}};
    const result=await enrich(db,rows,'RECIPIENT');assert.equal(count,20);assert.equal(result[0].Source_UID,'S0');assert.equal(result[0].Source_Name,'');
    db.getAll=async()=>[{id:'S0',exists:true,data:()=>({Name:'Private',Account_Deleted:true})}];
    assert.equal((await enrich(db,rows,'RECIPIENT'))[0].Source_Name,'');
    assert.deepEqual(await enrich(db,undefined,'RECIPIENT'),[]);
});
test('actual Dashboard renderer shows old/new identities and escapes markup in source name',()=>{
    const source=fs.readFileSync(path.join(__dirname,'fixtures/Dashboard.html'),'utf8');
    const begin=source.indexOf('    window.teamBonusSourceIdentity ='),end=source.indexOf('    window.loadMoreTeamBonus =',begin);
    const box={innerHTML:''},window={teamBonusData:[row({Source_UID:'SOURCE',Source_Name:'<img onerror=attack>'}),row({Admin_Remarks:'From: Old Name (UID: OLD)'}),row({Admin_Remarks:'NFT policy v2; source UID: V2'})],teamBonusLimit:5,formatTxDate:()=>'<time>'};
    vm.runInNewContext(source.slice(begin,end),{window,document:{getElementById:()=>box}});window.renderTeamBonusChunk();
    assert(box.innerHTML.includes('UID: SOURCE'));assert(box.innerHTML.includes('UID: OLD'));assert(box.innerHTML.includes('Old Name'));assert(box.innerHTML.includes('UID: V2'));
    assert(box.innerHTML.includes('&lt;img onerror=attack&gt;'));assert(!box.innerHTML.includes('<img'));assert(box.innerHTML.includes('Name not recorded'));
});
test('current server hydrates cached init, fresh init, pagination and both team responses',()=>{
    const s=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
    for(const expression of ['teamBonusIdentity.enrich(db, cachedData.transactions, uid)','teamBonusIdentity.enrich(db, head.records, uid)','teamBonusIdentity.enrich(db, txs, uid)','teamBonusIdentity.enrich(db, cachedData, uid)','teamBonusIdentity.enrich(db, bonuses, uid)'])assert(s.includes(expression),expression);
});

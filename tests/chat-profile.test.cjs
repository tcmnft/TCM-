'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),create=require('../lib/chat-profile.cjs');
function fixture(){const routes={},events=[],rows=new Map([['U',{UID:'U',Name:'Aminul',Avatar:'https://example.test/a.png',Status:'Active',Token:'TOKEN',Password:'SECRET',abdar:'old'}]]);let failCommit=false;
    const doc=id=>({id,get:async()=>({exists:rows.has(id),data:()=>rows.get(id)})});const db={collection:()=>({doc}),runTransaction:async callback=>{const changes=[];const r=await callback({get:ref=>ref.get(),update:(ref,data)=>changes.push([ref.id,data])});if(failCommit)throw Error('unavailable');for(const [id,data]of changes)rows.set(id,{...rows.get(id),...data});return r;}};
    const api=create({app:{get:(p,fn)=>routes['GET '+p]=fn,post:(p,fn)=>routes['POST '+p]=fn},db,io:{emit:(event,data)=>events.push({event,data})},invalidate:async()=>{}});
    const req={authenticatedUid:'U',headers:{authorization:'Bearer TOKEN'},body:{},query:{uid:'U'}};
    const call=async(method,path,body={},extra={})=>{const res={statusCode:200,set(){},status(code){this.statusCode=code;return this;},json(value){this.body=value;}};await routes[method+' '+path]({...req,body,...extra},res);return res;};
    return {api,req,rows,events,call,fail:()=>failCommit=true};
}
test('Abdar create, edit and clear publish exact public profile with increasing revision',async()=>{
    const f=fixture();let r=await f.call('POST','/api/user/abdar',{abdar:'  My wish  '});assert.equal(r.body.data.abdar,'My wish');assert.equal(r.body.data.version,1);
    r=await f.call('POST','/api/user/abdar',{abdar:'new'});assert.equal(r.body.data.version,2);r=await f.call('POST','/api/user/abdar',{abdar:null});assert.equal(r.body.data.abdar,'');assert.equal(r.body.data.version,3);
    assert.equal(f.rows.get('U').abdar,'');assert.equal(f.events.length,3);assert.equal(f.events[2].event,'EVT_USER_PROFILE_UPDATED');assert(!JSON.stringify(f.events).includes('SECRET'));assert(!('Token' in r.body.data));
});
test('public lookup never returns conversation snapshots, auth tokens or personal settings',async()=>{
    const f=fixture();f.rows.get('U').abdar='live';const r=await f.call('GET','/api/chat/profile');assert.equal(r.body.data.abdar,'live');assert.deepEqual(Object.keys(r.body.data).sort(),['abdar','avatar','name','timestamp','uid','verifiedAdmin','version']);
});
test('wrong owner, stale token, banned user, oversize status and bad UID cannot write',async()=>{
    const f=fixture();assert.equal((await f.call('POST','/api/user/abdar',{uid:'OTHER',abdar:'forged'})).statusCode,403);
    assert.equal((await f.call('POST','/api/user/abdar',{abdar:'x'.repeat(241)})).statusCode,400);
    assert.equal((await f.call('GET','/api/chat/profile',{}, {query:{uid:'../secret'}})).statusCode,400);
    f.rows.get('U').Token='NEW';assert.equal((await f.call('POST','/api/user/abdar',{abdar:'forged'})).statusCode,403);
    f.rows.get('U').Token='TOKEN';f.rows.get('U').Status='Banned';assert.equal((await f.call('POST','/api/user/abdar',{abdar:'forged'})).statusCode,403);assert.equal(f.events.length,0);assert.equal(f.rows.get('U').abdar,'old');
});
test('failed profile transaction cannot emit a false live profile update',async()=>{
    const f=fixture();f.fail();assert.equal((await f.call('POST','/api/user/abdar',{abdar:'new'})).body.success,false);assert.equal(f.events.length,0);assert.equal(f.rows.get('U').abdar,'old');
});
test('avatar mutation uses the same profile revision and live update channel',async()=>{
    const f=fixture();const p=await f.api.update(f.req,{Avatar:''});assert.equal(p.avatar,'');assert.equal(p.abdar,'old');assert.equal(p.version,1);assert.equal(f.events.length,1);
});


test('TCM Verified is derived solely from stored Admin role, never request fields or isAdmin flags',async()=>{
    const f=fixture();Object.assign(f.rows.get('U'),{Role:'User',isAdmin:true,verifiedAdmin:true});let r=await f.call('POST','/api/user/abdar',{abdar:'x',role:'Admin',verifiedAdmin:true});assert.equal(r.body.data.verifiedAdmin,false);
    f.rows.get('U').Role='Admin';r=await f.call('GET','/api/chat/profile');assert.equal(r.body.data.verifiedAdmin,true);f.rows.get('U').Role='User';r=await f.call('GET','/api/chat/profile');assert.equal(r.body.data.verifiedAdmin,false);assert(!('Role' in r.body.data));
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),create=require('../lib/chat-module15.cjs');
function fixture(){
    const rows=new Map(),routes={},events=[],writes=[];let seq=0,failCommit=false,onlineSockets=[];
    const data=path=>({id:path.split('/').at(-1),ref:doc(path),exists:rows.has(path),data:()=>structuredClone(rows.get(path))});
    function doc(path){return {path,id:path.split('/').at(-1),collection:name=>query(path+'/'+name),get:async()=>data(path)};}
    function query(path,opts={}){return {path,doc:id=>doc(path+'/'+(id||'ID'+seq++)),orderBy:()=>query(path,opts),limit:n=>query(path,{...opts,n}),startAfter:d=>query(path,{...opts,after:d.id}),get:async()=>{
        let list=[...rows].filter(([p])=>p.startsWith(path+'/')&&p.slice(path.length+1).indexOf('/')===-1).map(([p])=>data(p)).sort((a,b)=>(b.data().timestamp||0)-(a.data().timestamp||0));
        if(opts.after)list=list.slice(list.findIndex(d=>d.id===opts.after)+1);list=list.slice(0,opts.n||1000);return {docs:list,size:list.length};
    }};}
    const apply=(p,v)=>{const old=rows.get(p)||{};const out={...old};for(const [k,x]of Object.entries(v)){out[k]=x?.union?[...new Set([...(old[k]||[]),x.union])]:x?.increment?Number(old[k]||0)+x.increment:x;}rows.set(p,out);};
    const db={collection:query,runTransaction:async callback=>{const staged=[];let writing=false;const tx={get:async ref=>{assert(!writing,'read after write');return ref.get();},create:(r,v)=>{writing=true;staged.push(['create',r.path,v]);},update:(r,v)=>{writing=true;staged.push(['update',r.path,v]);},delete:r=>{writing=true;staged.push(['delete',r.path]);}};const value=await callback(tx);if(failCommit)throw Error('commit failed');for(const [type,p,v]of staged){if(type==='delete')rows.delete(p);else apply(p,v);writes.push([type,p]);}return value;}};
    const app={get:(p,fn)=>routes['GET '+p]=fn,post:(p,fn)=>routes['POST '+p]=fn};
    const io={emit:(...e)=>events.push(e),to:r=>({emit:(...e)=>events.push([r,...e])}),in:()=>({fetchSockets:async()=>onlineSockets})};
    let verified=0;const api=create({app,db,io,FieldValue:{serverTimestamp:()=>10000,increment:n=>({increment:n}),arrayUnion:x=>({union:x})},invalidate:async()=>{},verifySocket:async()=>{verified++;}});
    for(const id of ['U','V','W'])rows.set('Users/'+id,{Status:'Active',Token:id+'TOKEN',Name:id,Role:'User'});
    rows.set('Users/U/Friends/V',{uid:'V',lastMsg:'old',unreadCount:1});rows.set('Users/V/Friends/U',{uid:'U',lastMsg:'old',unreadCount:0});
    async function call(path,body={},who='U',method='POST',query={}){const response={statusCode:200,set(){},status(c){this.statusCode=c;return this;},json(v){this.body=v;}};await routes[method+' /api/chat/v15/'+path]({authenticatedUid:who,headers:{authorization:'Bearer '+who+'TOKEN'},body,query},response);return response;}
    return {rows,writes,events,call,api,verified:()=>verified,setFail:v=>failCommit=v,setOnline:value=>onlineSockets=value};
}
test('delete for everyone checks every sender before any write; forged caller fields do not confer authority',async()=>{
    const f=fixture();f.rows.set('Global_Chat/A',{senderUid:'U',message:'own',timestamp:2});f.rows.set('Global_Chat/B',{senderUid:'V',message:'peer',timestamp:1});
    const r=await f.call('delete',{mode:'global',msgIds:['A','B'],deleteType:'everyone',uid:'V'});assert.equal(r.statusCode,403);assert.equal(f.writes.length,0);assert(f.rows.has('Global_Chat/A'));
});
test('delete for me hides only for the authenticated user; commit failure preserves all messages',async()=>{
    const f=fixture();f.rows.set('Global_Chat/A',{senderUid:'V',message:'peer',timestamp:1,deletedFor:[]});
    f.setFail(true);assert.equal((await f.call('delete',{mode:'global',msgIds:['A'],deleteType:'me'})).body.success,false);assert.deepEqual(f.rows.get('Global_Chat/A').deletedFor,[]);
    f.setFail(false);assert.equal((await f.call('delete',{mode:'global',msgIds:['A'],deleteType:'me'})).body.success,true);assert.deepEqual(f.rows.get('Global_Chat/A').deletedFor,['U']);
});
test('radar searches beyond 15 hidden messages and updates each participant own preview',async()=>{
    const f=fixture();for(let i=0;i<60;i++)f.rows.set('Private_Chats/U_V/Messages/M'+i,{senderUid:'U',message:'text'+i,timestamp:100-i,deletedFor:i<59?['U']:[]});
    const r=await f.call('delete',{mode:'private',target:'V',msgIds:['M0'],deleteType:'me'});assert.equal(r.body.success,true);
    assert.equal(f.rows.get('Users/U/Friends/V').lastMsg,'You: text59');assert.equal(f.rows.get('Users/V/Friends/U').lastMsg,'old');
});
test('private deletion refuses removed friendships and a changed authenticated session without writes',async()=>{
    const f=fixture();f.rows.delete('Users/V/Friends/U');assert.equal((await f.call('delete',{mode:'private',target:'V',msgIds:['A'],deleteType:'me'})).statusCode,403);assert.equal(f.writes.length,0);
    f.rows.set('Users/U',{Status:'Active',Token:'CHANGED'});assert.equal((await f.call('upload',{mode:'global',fileId:'ID',name:'a.txt',type:'text/plain',base64:'aGk='})).statusCode,403);assert.equal(f.writes.length,0);
});
test('attachment validation rejects SVG, forged signatures and oversize payloads',()=>{
    assert.throws(()=>create.fileInput({name:'a.svg',type:'image/svg+xml',base64:Buffer.from('<svg/>').toString('base64')}));
    assert.throws(()=>create.fileInput({name:'a.png',type:'image/png',base64:'aGk='}));
    assert.throws(()=>create.fileInput({name:'a.txt',type:'text/plain',base64:Buffer.alloc(600000,97).toString('base64')}));
    assert.equal(create.fileInput({name:'a.txt',type:'text/plain',base64:'aGk='}).bytes,2);
});
test('attachment upload/send is idempotent, unread increments once, recipient download is authorized',async()=>{
    const f=fixture(),upload={mode:'private',target:'V',fileId:'FILE',name:'a.txt',type:'text/plain',base64:'aGk='};
    assert.equal((await f.call('upload',upload)).body.success,true);assert.equal((await f.call('upload',upload)).body.success,true);
    const payload={mode:'private',target:'V',fileId:'FILE'};assert.equal((await f.call('send-file',payload)).body.success,true);assert.equal((await f.call('send-file',payload)).body.success,true);
    assert.equal(f.rows.get('Users/V/Friends/U').unreadCount,1);assert.equal([...f.rows.keys()].filter(k=>k.startsWith('Private_Chats/U_V/Messages/')).length,1);
    assert.equal((await f.call('file',{},'V','GET',{id:'FILE'})).body.data.base64,'aGk=');assert.equal((await f.call('file',{},'W','GET',{id:'FILE'})).statusCode,403);
    await f.call('delete',{mode:'private',target:'U',msgIds:['file_FILE'],deleteType:'me'},'V');assert.equal((await f.call('file',{},'V','GET',{id:'FILE'})).statusCode,404);
});
test('read acknowledgement updates only incoming messages and notifies the sender',async()=>{
    const f=fixture();f.rows.set('Private_Chats/U_V/Messages/IN',{senderUid:'V',timestamp:2,status:'sent'});f.rows.set('Private_Chats/U_V/Messages/OUT',{senderUid:'U',timestamp:1,status:'sent'});
    assert.equal((await f.call('read',{mode:'private',target:'V'})).body.success,true);assert.equal(f.rows.get('Private_Chats/U_V/Messages/IN').status,'read');assert.equal(f.rows.get('Private_Chats/U_V/Messages/OUT').status,'sent');assert(f.events.some(e=>e[1]==='chat_v15_read'));
});
test('live status watcher uses verified session, one peer room, and stops on unwatch/disconnect',async()=>{
    const f=fixture(),handlers={},joined=new Set(),emitted=[];
    const socket={connected:true,data:{authenticatedUid:'U'},on:(name,fn)=>handlers[name]=fn,join:async name=>joined.add(name),leave:name=>joined.delete(name),emit:(...args)=>emitted.push(args)};
    f.api.attach(socket);await handlers.chat_v15_watch({target:'V'});assert.deepEqual([...joined],['chat_v15_status_V']);assert(emitted.some(e=>e[0]==='chat_v15_status'&&e[1].uid==='V'));assert(f.verified()>0);
    handlers.chat_v15_unwatch();assert.equal(joined.size,0);await handlers.chat_v15_watch({target:'W'});assert.equal(joined.size,0);
    handlers.disconnect();assert.equal(joined.size,0);
});
test('late status check cannot rejoin a room after unwatch',async()=>{
    const f=fixture(),handlers={},joined=new Set();const socket={connected:true,data:{authenticatedUid:'U'},on:(name,fn)=>handlers[name]=fn,join:async name=>joined.add(name),leave:name=>joined.delete(name),emit(){}};
    f.api.attach(socket);const pending=handlers.chat_v15_watch({target:'V'});handlers.chat_v15_unwatch();await pending;assert.equal(joined.size,0);
});


test('recipient delivery ACK verifies direction, does not mark read and cannot downgrade read',async()=>{
    const f=fixture();f.rows.set('Private_Chats/U_V/Messages/S',{senderUid:'V',status:'sent'});f.rows.set('Private_Chats/U_V/Messages/R',{senderUid:'V',status:'read'});
    const r=await f.call('delivered',{mode:'private',target:'V',msgIds:['S','R']});assert.equal(r.body.success,true);assert.deepEqual(r.body.ids,['S']);assert.equal(f.rows.get('Private_Chats/U_V/Messages/S').status,'delivered');assert.equal(f.rows.get('Private_Chats/U_V/Messages/R').status,'read');assert.equal(f.rows.get('Users/U/Friends/V').unreadCount,1);assert(f.events.some(e=>e[0]==='V'&&e[1]==='chat_v15_delivered'));
    const count=f.events.length;assert.deepEqual((await f.call('delivered',{mode:'private',target:'V',msgIds:['S']})).body.ids,[]);assert.equal(f.events.length,count);
});
test('delivery ACK refuses forged sender, hidden messages, missing friendship and invalid batches without writes',async()=>{
    for(const mode of ['outgoing','hidden','unfriend','global','oversize','invalid']){
        const f=fixture();f.rows.set('Private_Chats/U_V/Messages/M',{senderUid:mode==='outgoing'?'U':'V',status:'sent',deletedFor:mode==='hidden'?['U']:[]});if(mode==='unfriend')f.rows.delete('Users/V/Friends/U');
        const r=await f.call('delivered',{mode:mode==='global'?'global':'private',target:'V',msgIds:mode==='oversize'?Array(51).fill('M'):mode==='invalid'?['../M']:['M']});assert.equal(r.body.success,false,mode);assert.equal(f.writes.length,0,mode);assert(!f.events.some(e=>e[1]==='chat_v15_delivered'),mode);
    }
});
test('failed delivery commit emits no false receipt; a missing message is never invented',async()=>{
    const f=fixture();f.rows.set('Private_Chats/U_V/Messages/M',{senderUid:'V',status:'sent'});f.setFail(true);assert.equal((await f.call('delivered',{mode:'private',target:'V',msgIds:['M']})).body.success,false);assert.equal(f.rows.get('Private_Chats/U_V/Messages/M').status,'sent');assert.equal(f.events.length,0);f.setFail(false);assert.deepEqual((await f.call('delivered',{mode:'private',target:'V',msgIds:['GONE']})).body.ids,[]);assert(!f.rows.has('Private_Chats/U_V/Messages/GONE'));
});
test('a completed read clears unread state on the readers other authenticated devices',async()=>{
    const f=fixture();await f.call('read',{mode:'private',target:'V'});assert(f.events.some(e=>e[0]==='U'&&e[1]==='chat_v15_unread_cleared'&&e[2].target==='V'));
});
test('last socket disconnect persists last seen and only the watched public presence event',async()=>{
    const f=fixture(),handlers={};const socket={connected:false,data:{authenticatedUid:'U'},on:(name,fn)=>handlers[name]=fn,join:async()=>{},leave(){},emit(){}};
    const before=Date.now();f.api.attach(socket);handlers.disconnect();await new Promise(r=>setTimeout(r,25));const last=f.rows.get('Users/U').lastActive;assert(last>=before&&last<=Date.now());assert(f.events.some(e=>e[0]==='chat_v15_status_U'&&e[1]==='chat_v15_status'&&e[2].online===false&&e[2].lastActive===last));
});
test('closing one tab does not publish offline while another authenticated socket remains',async()=>{
    const f=fixture(),handlers={};f.rows.get('Users/U').lastActive=123;f.setOnline([{}]);const socket={connected:false,data:{authenticatedUid:'U'},on:(name,fn)=>handlers[name]=fn,join:async()=>{},leave(){},emit(){}};
    f.api.attach(socket);handlers.disconnect();await new Promise(r=>setTimeout(r,25));assert.equal(f.rows.get('Users/U').lastActive,123);assert(f.events.some(e=>e[1]==='chat_v15_status'&&e[2].online===true));assert(!f.events.some(e=>e[1]==='chat_v15_status'&&e[2].online===false));
});

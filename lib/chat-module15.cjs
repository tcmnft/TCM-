'use strict';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const uid=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw fail('Invalid account or message ID.');return value;};
const stamp=value=>value?.toMillis?.() ?? (value?.seconds ? value.seconds*1000 : Number(value)||0);
function fileInput(body){
    const {name,type,base64}=body||{};
    if(typeof name!=='string'||!name.trim()||name.length>180||/[\x00-\x1f]/.test(name)||typeof base64!=='string'||base64.length>700000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))throw fail('Invalid attachment.');
    const bytes=Buffer.from(base64,'base64');if(!bytes.length||bytes.length>512*1024)throw fail('Attachment limit is 512 KB.');
    const signatures={
        'image/png':()=>bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
        'image/jpeg':()=>bytes[0]===255&&bytes[1]===216&&bytes[2]===255,
        'image/gif':()=>/^GIF8[79]a/.test(bytes.toString('ascii',0,6)),
        'image/webp':()=>bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP',
        'application/pdf':()=>bytes.toString('ascii',0,5)==='%PDF-',
        'text/plain':()=>!bytes.includes(0)&&!Buffer.from(bytes.toString('utf8')).compare(bytes),
        'application/msword':()=>bytes.subarray(0,8).equals(Buffer.from([208,207,17,224,161,177,26,225])),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document':()=>bytes[0]===80&&bytes[1]===75&&bytes.includes(Buffer.from('word/'))
    };
    if(!signatures[type]?.())throw fail('Unsupported file or file type mismatch.');
    return {name:name.replace(/[\\/]/g,'_'),type,base64,bytes:bytes.length};
}
module.exports=function createChat15({app,db,io,FieldValue,invalidate,verifySocket}){
    const rate=new Map();
    const users=id=>db.collection('Users').doc(id);
    const room=(mode,source,target)=>mode==='global'?db.collection('Global_Chat'):db.collection('Private_Chats').doc([source,target].sort().join('_')).collection('Messages');
    const context=(body,source)=>{uid(source);if(!['global','private'].includes(body.mode))throw fail('Invalid conversation.');if(body.mode==='private'&&uid(body.target||body.receiverUid)===source)throw fail('Choose another member.');return {mode:body.mode,target:body.mode==='private'?(body.target||body.receiverUid):''};};
    function actor(doc,token){const data=doc.exists?doc.data():null;if(!data||data.Status!=='Active'||data.Account_Deleted||data.Token!==token)throw fail('Session expired or account unavailable.',403);return data;}
    const token=req=>(req.headers.authorization||'').replace(/^Bearer /,'');
    async function authorize(t,req,c){
        const source=req.authenticatedUid,own=await t.get(users(source));const data=actor(own,token(req));
        if(c.mode==='private'){
            const peer=await t.get(users(c.target)),a=await t.get(users(source).collection('Friends').doc(c.target)),b=await t.get(users(c.target).collection('Friends').doc(source));
            if(!peer.exists||peer.data().Status!=='Active'||peer.data().Account_Deleted||!a.exists||!b.exists)throw fail('This conversation is unavailable.',403);
        }return data;
    }
    function route(method,path,handler){app[method]('/api/chat/v15/'+path,async(req,res)=>{
        res.set('Cache-Control','no-store');try{uid(req.authenticatedUid);
            const key=req.authenticatedUid+':'+path,now=Date.now(),value=rate.get(key);const count=value&&now-value.at<60000?value.count+1:1;
            if(count>(path==='upload'?8:120))throw fail('Please wait before trying again.',429);
            rate.delete(key);rate.set(key,{count,at:value&&now-value.at<60000?value.at:now});while(rate.size>5000)rate.delete(rate.keys().next().value);
            await handler(req,res);}catch(error){res.status(error.status||503).json({success:false,message:error.status?error.message:'Chat is temporarily unavailable. Please retry.'});}
    });}
    async function notify(c,source,event,data){
        if(c.mode==='global')io.emit(event,{...data,mode:'global',sender:source});
        else for(const target of new Set([source,c.target]))io.to(target).emit(event,{...data,mode:'private',sender:source,target:c.target});
    }
    async function refresh(c,source){try{await invalidate(source,...(c.target?[c.target]:[]));}catch(_){} }
    route('post','room',async(req,res)=>{
        const c=context(req.body,req.authenticatedUid);await db.runTransaction(t=>authorize(t,req,c));res.json({success:true});
    });
    route('post','read',async(req,res)=>{
        const source=req.authenticatedUid,c=context(req.body,source);if(c.mode!=='private')throw fail('Private conversation required.');
        const ids=await db.runTransaction(async t=>{
            await authorize(t,req,c);const snap=await t.get(room(c.mode,source,c.target).orderBy('timestamp','desc').limit(50));
            const incoming=snap.docs.filter(d=>d.data().senderUid===c.target&&d.data().status!=='read'&&!(d.data().deletedFor||[]).includes(source));
            for(const d of incoming)t.update(d.ref,{status:'read'});
            t.update(users(source).collection('Friends').doc(c.target),{unreadCount:0});return incoming.map(d=>d.id);
        });await refresh(c,source);io.to(source).emit('chat_v15_unread_cleared',{target:c.target});if(ids.length)io.to(c.target).emit('chat_v15_read',{uid:source,ids});res.json({success:true});
    });
    route('post','delivered',async(req,res)=>{
        const source=req.authenticatedUid,c=context(req.body,source),raw=req.body.msgIds;
        if(c.mode!=='private'||!Array.isArray(raw)||raw.length<1||raw.length>50)throw fail('Select between 1 and 50 incoming messages.');
        const ids=[...new Set(raw)];ids.forEach(uid);
        const changed=await db.runTransaction(async t=>{
            await authorize(t,req,c);const docs=[];
            for(const id of ids)docs.push(await t.get(room('private',source,c.target).doc(id)));
            if(docs.some(d=>d.exists&&(d.data().senderUid!==c.target||(d.data().deletedFor||[]).includes(source))))throw fail('Incoming messages only.',403);
            const incoming=docs.filter(d=>d.exists&&d.data().status==='sent');
            for(const d of incoming)t.update(d.ref,{status:'delivered'});return incoming.map(d=>d.id);
        });
        if(changed.length)io.to(c.target).emit('chat_v15_delivered',{uid:source,ids:changed});
        res.json({success:true,ids:changed});
    });
    route('post','delete',async(req,res)=>{
        const source=req.authenticatedUid,c=context(req.body,source),kind=req.body.deleteType;
        const ids=[...new Set(req.body.msgIds||[])];if(!['me','everyone'].includes(kind)||!ids.length||ids.length>50)throw fail('Select between 1 and 50 messages.');ids.forEach(uid);
        await db.runTransaction(async t=>{
            const user=await authorize(t,req,c),col=room(c.mode,source,c.target),docs=[];
            for(const id of ids)docs.push(await t.get(col.doc(id)));
            if(kind==='everyone'&&docs.some(d=>d.exists&&d.data().senderUid!==source&&user.Role!=='Admin'))throw fail('You can only delete your own messages for everyone.',403);
            const previews=[];
            if(c.mode==='private'){
                const targets=kind==='everyone'?[source,c.target]:[source];let query=col.orderBy('timestamp','desc').limit(50),exhausted=false;
                const latest=new Map();
                // Bounded pages: never falsely claim no messages when a deeper page is unresolved.
                for(let page=0;page<10;page++){
                    const snap=await t.get(query);
                    for(const d of snap.docs)for(const who of targets)if(!latest.has(who)&&!ids.includes(d.id)&&!(d.data().deletedFor||[]).includes(who))latest.set(who,d.data());
                    exhausted=snap.size<50;if(exhausted||targets.every(who=>latest.has(who)))break;
                    query=col.orderBy('timestamp','desc').startAfter(snap.docs.at(-1)).limit(50);
                }
                for(const who of targets){
                    const other=who===source?c.target:source,ref=users(who).collection('Friends').doc(other),saved=await t.get(ref),m=latest.get(who);
                    if(saved.exists&&(m||exhausted))previews.push([ref,m?{lastMsg:(m.senderUid===who?'You: ':'')+(m.fileId?(m.fileType?.startsWith('image/')?'📷 Sent a photo':'📎 Sent a file'):m.message||''),lastMsgTime:m.timestamp}:{lastMsg:'Say Hello! 👋',lastMsgTime:null}]);
                }
            }
            for(const d of docs)if(d.exists){if(kind==='everyone')t.delete(d.ref);else t.update(d.ref,{deletedFor:FieldValue.arrayUnion(source)});}
            for(const [ref,value] of previews)t.update(ref,value);
        });
        await refresh(c,source);
        if(kind==='everyone')await notify(c,source,'chat_v15_deleted',{ids});else io.to(source).emit('chat_v15_deleted',{ids,mode:c.mode,sender:source,target:c.target});
        res.json({success:true,ids});
    });
    route('post','upload',async(req,res)=>{
        const source=req.authenticatedUid,c=context(req.body,source),file=fileInput(req.body),id=uid(req.body.fileId);
        await db.runTransaction(async t=>{
            await authorize(t,req,c);const ref=db.collection('Chat_Attachments').doc(id),old=await t.get(ref);
            if(old.exists){const prior=old.data();if(prior.owner!==source||prior.mode!==c.mode||prior.target!==c.target||prior.base64!==file.base64)throw fail('Attachment ID already used.',409);return;}
            t.create(ref,{...file,owner:source,...c,createdAt:Date.now(),messageId:null});
        });res.json({success:true,data:{fileId:id,name:file.name,type:file.type}});
    });
    route('post','send-file',async(req,res)=>{
        const source=req.authenticatedUid,c=context(req.body,source),id=uid(req.body.fileId),messageId='file_'+id,col=room(c.mode,source,c.target);
        const data=await db.runTransaction(async t=>{
            const user=await authorize(t,req,c),ref=db.collection('Chat_Attachments').doc(id),fileSnap=await t.get(ref),existing=await t.get(col.doc(messageId));
            if(!fileSnap.exists)throw fail('Attachment not found.',404);const file=fileSnap.data();
            if(file.owner!==source||file.mode!==c.mode||file.target!==c.target)throw fail('Attachment ownership mismatch.',403);
            if(existing.exists)return {id:messageId,...existing.data()};
            if(file.messageId)throw fail('This attachment was already sent.',409);
            const data={senderUid:source,senderName:String(user.Name||'TCM member').slice(0,120),avatar:typeof user.Avatar==='string'?user.Avatar:'',message:'',fileId:id,fileName:file.name,fileType:file.type,timestamp:FieldValue.serverTimestamp(),deletedFor:[],status:'sent'};
            t.create(col.doc(messageId),data);t.update(ref,{messageId});
            if(c.mode==='private'){
                const preview=file.type.startsWith('image/')?'📷 Sent a photo':'📎 Sent a file';
                t.update(users(source).collection('Friends').doc(c.target),{lastMsg:'You: '+preview,lastMsgTime:FieldValue.serverTimestamp()});
                t.update(users(c.target).collection('Friends').doc(source),{lastMsg:preview,lastMsgTime:FieldValue.serverTimestamp(),unreadCount:FieldValue.increment(1)});
            }return {id:messageId,...data,timestamp:new Date().toISOString()};
        });await refresh(c,source);await notify(c,source,'chat_v15_message',data);res.json({success:true,data});
    });
    route('get','file',async(req,res)=>{
        const source=req.authenticatedUid,id=uid(req.query.id),snapshot=await db.collection('Chat_Attachments').doc(id).get();
        if(!snapshot.exists)throw fail('Attachment unavailable.',404);const file=snapshot.data();
        if(!['global','private'].includes(file.mode))throw fail('Attachment unavailable.',404);
        if(!file.messageId||(file.mode==='private'&&source!==file.owner&&source!==file.target))throw fail('Attachment access denied.',403);
        // The recipient's room is always the owner's original conversation.
        const peer=file.owner===source?file.target:file.owner;
        await db.runTransaction(async t=>{
            await authorize(t,req,{mode:file.mode,target:peer});const m=await t.get(room(file.mode,file.owner,file.target).doc(file.messageId));
            if(!m.exists||(m.data().deletedFor||[]).includes(source)||m.data().fileId!==id)throw fail('Attachment unavailable.',404);
        });res.json({success:true,data:{base64:file.base64,type:file.type,name:file.name}});
    });
    const watchRoom=id=>'chat_v15_status_'+id;
    async function status(target){const online=(await io.in(target).fetchSockets()).length>0;let lastActive=0;if(!online){const snap=await users(target).get();if(snap.exists)lastActive=stamp(snap.data().lastActive);}return {uid:target,online,lastActive};}
    function attach(socket){
        const source=socket.data.authenticatedUid;let watched='',epoch=0,typingAt=0;
        const stop=()=>{epoch++;if(watched)socket.leave(watchRoom(watched));watched='';};
        socket.on('chat_v15_unwatch',stop);
        socket.on('chat_v15_watch',async(body={},ack)=>{
            const version=++epoch;stop();const expected=epoch;
            try{
                await verifySocket(socket);const target=uid(body.target),friend=await users(source).collection('Friends').doc(target).get();
                if(!friend.exists)throw fail('Friendship required.',403);const value=await status(target);
                if(expected!==epoch||!socket.connected)return;
                watched=target;await socket.join(watchRoom(target));if(expected!==epoch){socket.leave(watchRoom(target));return;}
                socket.emit('chat_v15_status',value);if(typeof ack==='function')ack({success:true});
            }catch(_){if(typeof ack==='function')ack({success:false,message:'Live status unavailable.'});}
        });
        socket.on('chat_v15_typing',async(body={})=>{
            if(!watched||body.target!==watched||Date.now()-typingAt<700)return;typingAt=Date.now();
            try{await verifySocket(socket);const f=await users(source).collection('Friends').doc(watched).get();if(f.exists)io.to(watched).emit('chat_v15_typing',{uid:source,typing:body.typing===true,at:Date.now()});}catch(_){}
        });
        Promise.resolve().then(()=>io.to(watchRoom(source)).emit('chat_v15_status',{uid:source,online:true,lastActive:Date.now()}));
        socket.on('disconnect',()=>{
            stop();const disconnectedAt=Date.now();
            setTimeout(async()=>{try{
                if(!(await io.in(source).fetchSockets()).length){
                    await db.runTransaction(async t=>{const ref=users(source),snap=await t.get(ref);
                        if(snap.exists&&snap.data().Status==='Active'&&!snap.data().Account_Deleted&&stamp(snap.data().lastActive)<disconnectedAt)t.update(ref,{lastActive:disconnectedAt});
                    });
                }
                const value=await status(source);io.to(watchRoom(source)).emit('chat_v15_status',value);
            }catch(_){}},0);
        });
    }
    return {attach,fileInput};
};
module.exports.fileInput=fileInput;

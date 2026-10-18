'use strict';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function validUid(value){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw fail('Invalid profile UID.');return value;}
function publicProfile(id,data={}){
    return {uid:id,name:typeof data.Name==='string'?data.Name.slice(0,120):'TCM member',avatar:typeof data.Avatar==='string'?data.Avatar:'',
        abdar:typeof data.abdar==='string'?data.abdar.slice(0,240):'',verifiedAdmin:data.Role==='Admin',version:Number.isSafeInteger(data.Profile_Version)?data.Profile_Version:0,timestamp:Number(data.Profile_Updated_At)||0};
}
module.exports=function createProfile({app,db,io,invalidate}){
    const users=id=>db.collection('Users').doc(id);
    function actor(req,snapshot){const data=snapshot.exists?snapshot.data():null;
        if(!data||data.Status!=='Active'||data.Account_Deleted||data.Token!==(req.headers.authorization||'').replace(/^Bearer /,''))throw fail('Your session changed. Sign in again.',403);return data;
    }
    function route(method,path,fn){app[method](path,async(req,res)=>{res.set('Cache-Control','no-store');try{validUid(req.authenticatedUid);await fn(req,res);}catch(error){res.status(error.status||503).json({success:false,message:error.status?error.message:'Profile is temporarily unavailable.'});}});}
    const limits=new Map();
    async function update(req,patch){
        const id=validUid(req.authenticatedUid);if(req.body?.uid!==undefined&&req.body.uid!==id)throw fail('Account ownership mismatch.',403);
        const now=Date.now(),rate=limits.get(id);if(rate&&now-rate.at<60000&&rate.count>=20)throw fail('Please wait before updating again.',429);
        limits.delete(id);limits.set(id,{at:rate&&now-rate.at<60000?rate.at:now,count:rate&&now-rate.at<60000?rate.count+1:1});while(limits.size>5000)limits.delete(limits.keys().next().value);
        const profile=await db.runTransaction(async t=>{
            const ref=users(id),snapshot=await t.get(ref),data=actor(req,snapshot);
            const version=(Number.isSafeInteger(data.Profile_Version)?data.Profile_Version:0)+1;
            const changes={...patch,Profile_Version:version,Profile_Updated_At:now};t.update(ref,changes);return publicProfile(id,{...data,...changes});
        });
        try{await invalidate(id);}catch(_){}
        io.emit('EVT_USER_PROFILE_UPDATED',profile);return profile;
    }
    route('get','/api/chat/profile',async(req,res)=>{
        const id=validUid(req.query.uid),snapshot=await users(id).get();
        if(!snapshot.exists||snapshot.data().Status!=='Active'||snapshot.data().Account_Deleted)throw fail('This profile is unavailable.',404);
        res.json({success:true,data:publicProfile(id,snapshot.data())});
    });
    route('post','/api/user/abdar',async(req,res)=>{
        const raw=req.body?.abdar;
        if(raw!==null&&(typeof raw!=='string'||raw.length>240))throw fail('Abdar must be at most 240 characters.');
        const abdar=raw===null?'':raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim();
        res.json({success:true,data:await update(req,{abdar})});
    });
    return {update,publicProfile};
};
module.exports.publicProfile=publicProfile;

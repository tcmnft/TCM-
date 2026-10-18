'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {third,chainFixture}=require('./nft-import-fixture.cjs');
function fixture(){
    const live=path.join(__dirname,'../admin.html');
    const html=fs.readFileSync(fs.existsSync(live)?live:path.join(__dirname,'fixtures/admin.html'),'utf8');
    const start=html.indexOf('/* NFT ADMIN IMPORT CONTROLLER START */'),end=html.indexOf('/* NFT ADMIN IMPORT CONTROLLER END */',start);
    assert(start>0&&end>start);
    const nodes=new Map(),requests=[],session={ready:true,generation:1},state={mode:'ok',token:'test-admin',confirm:true};
    const node=name=>{
        if(!nodes.has(name))nodes.set(name,{value:'',checked:false,hidden:true,disabled:false,textContent:'',handlers:{},addEventListener(event,fn){this.handlers[event]=fn;}});
        return nodes.get(name);
    };
    const a=chainFixture().registry.byId('TCM-003');
    const data=()=>({reviewId:'11111111-2222-3333-4444-555555555555',planSHA256:'a'.repeat(64),asset:{...a},
        verification:{assetId:a.assetId,tokenId:a.tokenId,chainId:'56',contract:a.contract,owner:a.custody,hash:a.mintHash,
            assetKey:a.assetKey,metadataURI:a.metadataURI,checkedAt:new Date().toISOString(),confirmations:100},
        expiresAt:Date.now()+900000,metadata:{integrity:'Raw_CID_SHA256_Verified',name:a.name,imageURI:a.imageURI}});
    const context={URL,AbortController,setTimeout,clearTimeout,console,Date,
        document:{getElementById:()=>({querySelector:selector=>node(selector.match(/="(.+)"/)[1])})},
        localStorage:{getItem:()=>state.token},adminAuthState:session,BACKEND_URL:'https://backend.test/',
        window:{addEventListener(){},confirm(){if(state.confirmHook)state.confirmHook();return state.confirm;}},
        async _nativeFetch(url,options){
            requests.push({url,options});if(state.hook)state.hook();
            const result=data();if(state.mode==='testnet')result.verification.chainId='97';
            if(state.mode==='wrong-price')result.asset.priceMicro='2002000000';
            if(state.mode==='metadata')result.metadata.integrity='Not_Checked';
            if(state.mode==='session')session.generation++;
            return{ok:state.mode!=='error',headers:{get:()=>state.mode==='html'?'text/html':'application/json'},
                json:async()=>({success:state.mode!=='error',message:'Backend unavailable',data:url.endsWith('/publish')?
                    {id:'BSC_56_'+a.contract.slice(2).toLowerCase()+'_3',assetId:a.assetId,status:'Available',alreadyPublished:false}:result})};
        }};
    vm.createContext(context);vm.runInContext(html.slice(start,end),context);
    const candidate={kind:'Gallery_Candidate_Only',readyForProduction:false,Name:third.name,Asset_ID:third.assetId,Image_URI:third.imageURI,
        Blockchain:{Chain_ID:56,Contract_Address:a.contract,Custody_Address:a.custody,Token_ID:'3',Mint_TxHash:third.mintHash,Metadata_URI:third.metadataURI}};
    async function load(overrides={}){const c={...candidate,...overrides};await node('file').handlers.change({target:{files:[{size:1000,text:async()=>JSON.stringify(c)}]}});}
    async function verify(){node('level').value='3';node('price').value='2001';await node('verify').handlers.click();}
    return{node,requests,session,state,load,verify,html};
}
test('import requires no automatic request, checks level/price and explicitly previews before publication',async()=>{
    const f=fixture();assert.equal(f.requests.length,0);await f.load();assert.equal(f.requests.length,0);
    await f.verify();assert.match(f.node('status').textContent,/PASS/);assert.equal(f.node('preview').hidden,false);
    assert.equal(f.node('publish').disabled,true);f.node('approve').checked=true;f.node('approve').handlers.change();
    assert.equal(f.node('publish').disabled,false);await f.node('publish').handlers.click();assert.equal(f.requests.length,2);
    assert.match(f.requests[0].url,/candidate\/preview$/);assert.match(f.requests[1].url,/candidate\/publish$/);
    assert.deepEqual(JSON.parse(f.requests[1].options.body),{reviewId:'11111111-2222-3333-4444-555555555555',planSHA256:'a'.repeat(64)});
    assert.match(f.node('status').textContent,/Published.*TCM-003/);assert.equal(f.node('approve').checked,false);
});
test('testnet and unsafe names fail locally; invalid prices send no request',async()=>{
    const f=fixture();await f.load({Name:'<img src=x onerror=alert(1)>'});assert.equal(f.requests.length,0);assert(f.node('verify').disabled);
    await f.load({Blockchain:{Chain_ID:97}});assert(f.node('verify').disabled);
    await f.load();f.node('level').value='3';f.node('price').value='50';await f.node('verify').handlers.click();
    assert.equal(f.requests.length,0);assert.match(f.node('status').textContent,/outside/);
});
test('mismatched proof, unverified metadata, HTML and changed sessions cannot enable Publish',async t=>{
    for(const mode of ['testnet','wrong-price','metadata','html','session','error'])await t.test(mode,async()=>{
        const f=fixture();await f.load();f.state.mode=mode;await f.verify();
        assert.equal(f.node('publish').disabled,true);assert.equal(f.node('preview').hidden,true);assert.equal(f.requests.length,1);
    });
});
test('editing price or level invalidates the preview and in-flight responses cannot restore it',async()=>{
    const f=fixture();await f.load();await f.verify();f.node('price').value='2002';f.node('price').handlers.input();
    assert.equal(f.node('preview').hidden,true);assert(f.node('publish').disabled);
    f.state.hook=()=>f.node('level').handlers.input();await f.verify();assert.equal(f.node('preview').hidden,true);
    assert(f.node('publish').disabled);
});
test('cancel, changed session at confirmation and uncertain publication never auto-submit again',async()=>{
    const f=fixture();await f.load();await f.verify();f.node('approve').checked=true;f.state.confirm=false;
    await f.node('publish').handlers.click();assert.equal(f.requests.length,1);
    f.state.confirm=true;f.state.mode='error';await f.node('publish').handlers.click();assert.equal(f.requests.length,2);
    assert.match(f.node('status').textContent,/same preview/);assert.equal(f.node('approve').checked,true);
    f.state.mode='ok';await f.node('publish').handlers.click();assert.equal(f.requests.length,3);
    const g=fixture();await g.load();await g.verify();g.node('approve').checked=true;
    g.state.confirmHook=()=>{g.session.generation++;};await g.node('publish').handlers.click();assert.equal(g.requests.length,1);
});

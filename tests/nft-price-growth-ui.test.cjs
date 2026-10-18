'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const growth=require('../lib/nft-price-growth.cjs');
test('Dashboard policy-v2 estimates match the integer backend math without hiding sub-cent credits',()=>{
    const live=path.join(__dirname,'../Dashboard.html'),html=fs.readFileSync(fs.existsSync(live)?live:path.join(__dirname,'fixtures/Dashboard.html'),'utf8');
    const start=html.indexOf('window.nftPolicyNetEstimate ='),end=html.indexOf('window.closeScanAndGoToCollection =',start);
    assert(start>0&&end>start);
    const ctx={window:{LEVEL_PROFIT_RATES:{1:.013,2:.018,3:.023,4:.028,5:.033,6:.038}}};vm.createContext(ctx);vm.runInContext(html.slice(start,end),ctx);
    for(const [price,level]of [[50,1],[501,2],[2001,3],[5001,4],[10001,5],[20001,6],[2002.3806,3]]){
        const expected=growth.math(BigInt(Math.round(price*1e6)),level);
        const text=ctx.window.nftPolicyNetEstimate({price,level,Price_Policy:{Version:2}});
        assert(!text.includes(','));assert.equal(Number(text),Number(expected.net)/1e6);
    }
    assert.equal(ctx.window.nftPolicyNetEstimate({price:2001,level:3,Price_Policy:{Version:2}}),'36.3558');
});

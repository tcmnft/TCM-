'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
const html=fs.readFileSync(path.join(__dirname,'fixtures/Dashboard.html'),'utf8');
const source=html.slice(html.indexOf('/* MASTER CLOCK START */'),html.indexOf('/* MASTER CLOCK END */'));
function fixture(){let now=0,active=new Set(),seq=0;const handlers={};const window={},document={hidden:false,addEventListener:(name,fn)=>handlers[name]=fn};
    window.addEventListener=(name,fn)=>handlers[name]=fn;const context={window,document,console:{warn(){}},Date:{now:()=>now},setInterval:(fn,ms)=>{assert.equal(ms,1000);const id=++seq;active.add(id);return id;},clearInterval:id=>active.delete(id)};vm.runInNewContext(source,context);
    return {clock:window.MasterClockDispatcher,active,document,handlers,context,now:value=>now=value};}
test('one singleton interval serves many countdown subscribers and replaces duplicate IDs',()=>{
    const f=fixture();let calls=0;for(let i=0;i<20;i++)f.clock.register('job'+i,()=>calls++);assert.equal(f.active.size,1);f.clock.register('job0',()=>calls++);assert.equal(f.clock.size,20);f.now(1000);f.clock.flush();assert.equal(calls,20);vm.runInNewContext(source,f.context);assert.equal(f.active.size,1);f.clock.clear();assert.equal(f.active.size,0);
});
test('hidden tab pauses native timer and resumes from wall time without replaying missed payouts',()=>{
    const f=fixture();let calls=0;f.clock.register('timer',()=>calls++);f.document.hidden=true;f.handlers.visibilitychange();assert.equal(f.active.size,0);f.now(100000);f.document.hidden=false;f.handlers.visibilitychange();assert.equal(calls,1);assert.equal(f.active.size,1);f.clock.unregister('timer');assert.equal(f.active.size,0);
});
test('a failing callback cannot stop another clock and unregistering prevents further calls',()=>{
    const f=fixture();let calls=0;f.clock.register('bad',()=>{throw Error('boom')});f.clock.register('ok',()=>calls++);f.now(1000);f.clock.flush();assert.equal(calls,1);f.clock.unregister('ok');f.now(2000);f.clock.flush();assert.equal(calls,1);
});
test('all independent intervals and native dialogs are removed from the complete Dashboard',()=>{
    assert.equal((html.match(/\bsetInterval\s*\(/g)||[]).length,1);assert(!/\b(?:window\.)?(?:confirm|alert)\s*\(/.test(html));
    for(const id of ['liveTimerInterval','reserveTimerInterval','vaultTimerInterval','globalPendingClock','stakingCountdownInterval','cinemaProfitInterval'])assert(html.includes("MasterClockDispatcher.register('"+id+"'"));
});
test('a late initialization callback cannot restart the clock after logout',()=>{
    const f=fixture();f.clock.register('initial',()=>{});f.context.window.dashboardSession={closed:true};f.clock.clear();f.clock.register('late-feed',()=>{});assert.equal(f.active.size,0);assert.equal(f.clock.size,0);
});

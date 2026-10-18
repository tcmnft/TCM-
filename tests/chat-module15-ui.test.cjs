'use strict';
const fs=require('node:fs'),path=require('node:path'),test=require('node:test'),assert=require('node:assert/strict');
const html=fs.readFileSync(path.join(__dirname,'fixtures/Dashboard.html'),'utf8');
test('all original Module15 visual CSS is preserved byte-for-byte inside the complete Dashboard',()=>{
    const css=fs.readFileSync(path.join(__dirname,'fixtures/chat-module15-design.css'),'utf8');assert(html.includes('<style id="tcm-module15-styles">'+css));
    for(const name of ['global-crescent-bubble','sender-name-3d','flyAwayDelete','drawChar','fillChar','btn-3d-select','bulk-delete-popup'])assert(css.includes(name));
});
test('chat adapter has no direct Firebase reads/writes and preserves existing ack, support and directory paths',()=>{
    const s=html.slice(html.indexOf('/* MODULE 15 ADAPTER START'),html.indexOf('/* MODULE 15 ADAPTER END'))+html.slice(html.indexOf('/* LUXURY R2 START */'),html.indexOf('/* LUXURY R2 END */'));
    assert(!/firebase|onSnapshot|deleteDoc|setDoc|getDocs|updateDoc|window\.db/.test(s));
    for(const token of ['/chat/v15/delete','/chat/v15/room','chat_v15_watch','chat_v15_typing','window.chatFinishDelivery','releaseFiles','imageBusy<2'])assert(s.includes(token));
    assert(html.includes("'/chat/directory?after='"));assert(html.includes("window.chatSendWithAck('send_support_message'"));assert(html.includes("window.chatSendWithAck('send_private_message'"));
});

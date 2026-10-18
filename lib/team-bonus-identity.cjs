/* Source identity only: transaction UID always remains the recipient. */
'use strict';
function identity(row) {
    const valid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : '';
    if (!row || !/^Team Bonus \([ABC]-Hand\)$/.test(row.Type || '')) return {uid:'',name:''};
    const remarks = typeof row.Admin_Remarks === 'string' ? row.Admin_Remarks : '';
    const old = /^From: ([\s\S]*?) \(UID: ([A-Za-z0-9_-]{1,128})\)$/.exec(remarks);
    const v2 = /^NFT policy v2; source UID: ([A-Za-z0-9_-]{1,128})$/.exec(remarks);
    const uid = valid(row.Source_UID) || (old && old[2]) || (v2 && v2[1]) || '';
    const name = typeof row.Source_Name === 'string' && row.Source_Name.trim()
        ? row.Source_Name.trim().slice(0,200) : old && old[2] === uid ? old[1].slice(0,200) : '';
    return {uid,name};
}
async function enrich(db, rows, recipient) {
    if (!Array.isArray(rows)) return [];
    // Scope before reading Users. Never trust another recipient's cached row.
    const scoped = rows.filter(row => row && row.UID === recipient);
    const ids = [...new Set(scoped.map(identity).filter(x=>x.uid && !x.name).map(x=>x.uid))].slice(0,20);
    const names = new Map();
    if (ids.length) {
        try {
            const docs = await db.getAll(...ids.map(uid=>db.collection('Users').doc(uid)), {fieldMask:['Name','Account_Deleted']});
            for (const doc of docs) if (doc.exists && ids.includes(doc.id)) {
                const value=doc.data();
                if (!value.Account_Deleted && typeof value.Name==='string' && value.Name.trim()) names.set(doc.id,value.Name.trim().slice(0,200));
            }
        } catch (_) { /* Keep the source UID usable during a lookup outage. */ }
    }
    return scoped.map(row=>{
        const source=identity(row);
        return source.uid ? {...row,Source_UID:source.uid,Source_Name:source.name || names.get(source.uid) || ''} : {...row};
    });
}
module.exports={identity,enrich};

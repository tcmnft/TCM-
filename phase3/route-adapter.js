(function(root){'use strict';
// Transport interface for future authenticated bridge. Not constructed by default-disabled owner UI.
class Phase3RouteAdapter{
 constructor({request,storage,uid}){if(typeof request!=='function'||!storage||typeof uid!=='string')throw Error('Adapter dependencies');this.request=request;this.storage=storage;this.uid=uid;}
 key(order){if(!this.uid)throw Error('AUTH_REQUIRED');return 'phase3-pending:'+this.uid+':'+order;}
 async claim(order,expectedRevision){const key=this.key(order);let intent=this.storage.getItem(key);intent=intent?JSON.parse(intent):{requestKey:crypto.randomUUID(),order,expectedRevision};if(intent.order!==order||!Number.isSafeInteger(intent.expectedRevision))throw Error('Invalid saved intent');this.storage.setItem(key,JSON.stringify(intent));const result=await this.request('/api/phase3/claim',intent);if(result.status==='BLOCKED')return result;if(!result.receipt)throw Error('UNKNOWN_OUTCOME');this.storage.removeItem(key);return result;}
 async recover(order){this.key(order);const result=await this.request('/api/phase3/outcome?order='+encodeURIComponent(order));if(result.state==='PAID'&&result.receipt)this.storage.removeItem(this.key(order));return result;}
 clearUser(){this.uid=null;}
}
root.Phase3RouteAdapter=Phase3RouteAdapter;
})(globalThis);
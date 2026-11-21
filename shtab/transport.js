(function(root){
  'use strict';
  const protocol='shtab-hq-offline-v1';
  const allowedOrigin=/^https:\/\/[a-z0-9-]+-script\.googleusercontent\.com$/;
  function createTransport(host,endpoint){
    let popup,peer,origin,nonce,pending,readyListener=()=>{};
    function finish(error,value){
      if(!pending)return;
      host.clearTimeout(pending.timeout);host.clearInterval(pending.retry);
      const request=pending;pending=null;
      if(error)request.reject(error);else request.resolve(value);
    }
    function send(){
      if(!pending||!peer)return;
      try{peer.postMessage(pending.message,origin);}catch(_){peer=null;}
    }
    function timeout(){
      if(!pending)return;
      // iOS may suspend either window. Resume the same request when visible.
      if(host.document?.hidden){pending.timeout=host.setTimeout(timeout,15000);return;}
      peer=null;
      finish(new Error('SYNC_TIMEOUT'));
    }
    host.addEventListener('message',event=>{
      const message=event.data;
      if(!popup||!event.source||!allowedOrigin.test(event.origin)||message?.protocol!==protocol||message.nonce!==nonce)return;
      try{if(event.source.top!==popup)return;}catch(_){return;}
      if(message.type==='ready'){
        const changed=peer!==event.source||origin!==event.origin;
        peer=event.source;origin=event.origin;
        if(pending)send();
        else if(changed)Promise.resolve().then(readyListener).catch(()=>{});
        return;
      }
      if(event.source!==peer||event.origin!==origin||!pending||message.id!==pending.message.id)return;
      if(message.type==='accepted'){pending.accepted=true;return;}
      if(message.type==='response')finish(message.ok?null:new Error(message.code||'SYNC_SERVER'),message.reply);
    });
    return {
      onReady(callback){readyListener=callback;},
      ready(){return Boolean(peer&&popup&&!popup.closed);},
      confirmSaved(){if(this.ready())peer.postMessage({protocol,nonce,type:'saved'},origin);},
      connect(){
        finish(new Error('SYNC_RECONNECTED'));popup?.close();peer=null;
        nonce=host.crypto.randomUUID();const url=new URL(endpoint);url.searchParams.set('offlineHQ',nonce);
        popup=host.open(url.href,'_blank','popup');return Boolean(popup);
      },
      exchange(request){
        if(!this.ready()||pending)return Promise.reject(new Error('SYNC_UNAVAILABLE'));
        return new Promise((resolve,reject)=>{
          const message={protocol,nonce,type:'exchange',id:host.crypto.randomUUID(),request};
          pending={message,resolve,reject,timeout:host.setTimeout(timeout,90000),retry:host.setInterval(send,4000)};
          send();
        });
      }
    };
  }
  if(typeof module!=='undefined')module.exports={createTransport};else root.HQOfflineTransport={createTransport};
})(typeof window==='undefined'?globalThis:window);

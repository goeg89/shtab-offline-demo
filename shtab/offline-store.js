(function(root){
  'use strict';
  const database='shtab-hq-offline-v1';
  let db,key;
  async function open(){
    if(db)return;
    db=await new Promise((resolve,reject)=>{const request=indexedDB.open(database,1);request.onupgradeneeded=()=>request.result.createObjectStore('private');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    key=await get('key');
  }
  async function get(name){return new Promise((resolve,reject)=>{const request=db.transaction('private').objectStore('private').get(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
  async function put(name,value){return new Promise((resolve,reject)=>{const tx=db.transaction('private','readwrite');tx.objectStore('private').put(value,name);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
  async function enable(){await open();if(!key){key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);await put('key',key);}}
  async function read(){await open();const box=await get('state');if(!box)return null;if(!key)throw Error('OFFLINE_KEY_MISSING');const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:box.iv,additionalData:new TextEncoder().encode(database)},key,box.data);return JSON.parse(new TextDecoder().decode(bytes));}
  async function write(state){await open();if(!key)throw Error('OFFLINE_NOT_ENABLED');const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(database)},key,new TextEncoder().encode(JSON.stringify(state)));await put('state',{iv,data});}
  root.HQOfflineStore={open,enable,read,write,enabled:()=>Boolean(key)};
})(window);

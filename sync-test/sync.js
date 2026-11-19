/* PWA-SYNC-0.2-pre. Тестовый транспорт к отдельной вымышленной Google Sheets.
 * CORS-free: HMAC-подписанный JSONP GET и HTML form POST + статус по OP ID.
 * Внимание: общий ключ хранится на устройстве. НЕ использовать с данными клиентов.
 */
(function(){
'use strict';
const STORAGE_KEY='shtab-demo-test-bridge-v02';
const PREFIX='__shtab_';
let busy=false;
let formCount=0;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function config(){
  try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}');}catch(_){return {};}
}
function saveConfig(url,secret){
  const normalized=String(url||'').trim().split('#')[0].split('?')[0];
  if(!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(normalized))
    throw Error('Нужна ссылка на опубликованный Apps Script /exec');
  if(!/^[0-9a-f]{64}$/.test(secret))throw Error('Тестовый секрет должен быть из 64 символов 0–9, a–f');
  localStorage.setItem(STORAGE_KEY,JSON.stringify({url:normalized,secret}));
  return {url:normalized,secret};
}
function clearConfig(){localStorage.removeItem(STORAGE_KEY);}
function b64url(data){
  const bytes=new TextEncoder().encode(JSON.stringify(data));
  let s='';for(const b of bytes)s+=String.fromCharCode(b);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function asHex(buffer){return [...new Uint8Array(buffer)].map(n=>n.toString(16).padStart(2,'0')).join('');}
async function sign(method,payload){
  const {url,secret}=config();if(!url||!secret)throw Error('Не настроено тестовое подключение');
  if(!navigator.onLine)throw Error('Нет интернет-соединения');
  const ts=String(Date.now()),nonce=crypto.randomUUID().replace(/[^A-Za-z0-9-]/g,'');
  const encoded=b64url(payload);
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const message=method+'\n'+ts+'\n'+nonce+'\n'+encoded;
  const sig=asHex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(message)));
  return {url,fields:{ts,nonce,payload:encoded,sig}};
}
function jsonp(payload){
  return sign('GET',payload).then(({url,fields})=>new Promise((resolve,reject)=>{
    const callback=PREFIX+crypto.randomUUID().replace(/-/g,'');
    const script=document.createElement('script');
    let done=false,timer;
    function cleanup(){script.remove();delete window[callback];clearTimeout(timer);}
    function finish(error,response){if(done)return;done=true;cleanup();error?reject(error):resolve(response);}
    window[callback]=response=>{
      if(!response?.ok)return finish(Error(response?.error||'Ошибка тестового сервера'));
      finish(null,response);
    };
    script.onerror=()=>finish(Error('Не удалось связаться с тестовым сервером (проверьте /exec и доступ)'));
    timer=setTimeout(()=>finish(Error('Тестовый сервер не ответил за 20 секунд')),20000);
    const q=new URLSearchParams({...fields,callback});
    script.src=url+'?'+q.toString();
    script.referrerPolicy='no-referrer';
    document.head.appendChild(script);
  }));
}
function formPost(payload){
  return sign('POST',payload).then(({url,fields})=>new Promise((resolve,reject)=>{
    // Нельзя читать iframe/POST ответ (cross-origin); нужен отдельный статус через JSONP.
    const name='shtab-post-'+(++formCount)+'-'+Date.now();
    const frame=document.createElement('iframe');
    frame.name=name;frame.hidden=true;frame.setAttribute('aria-hidden','true');
    const form=document.createElement('form');
    form.style.display='none';form.target=name;form.method='POST';form.action=url;
    for(const [key,value] of Object.entries(fields)){
      const input=document.createElement('input');input.type='hidden';input.name=key;input.value=value;form.appendChild(input);
    }
    document.body.append(frame,form);
    try{form.submit();setTimeout(()=>{form.remove();frame.remove();},24000);resolve(true);}
    catch(e){form.remove();frame.remove();reject(e);}
  }));
}
async function fetchStatus(opId){return jsonp({action:'status',opId});}
async function sendAndVerify(op){
  await formPost({action:'apply',op});
  for(let i=0;i<10;i++){
    await delay(i===0?1800:1500);
    const answer=await fetchStatus(op.opId);
    if(answer.found&&answer.status==='applied')return {status:'applied',result:answer.result};
    if(answer.found&&answer.status==='conflict')return {status:'conflict',result:answer.result};
    if(!navigator.onLine)throw Error('Сеть отключилась. Изменение осталось в очереди');
  }
  throw Error('Нет подтверждения записи. Операция оставлена в очереди: повторить безопасно по OP ID');
}
async function guarded(task){
  if(busy)throw Error('Синхронизация уже выполняется');busy=true;
  try{return await task();}finally{busy=false;}
}
async function connect(db){return guarded(async()=>{
  const hello=await jsonp({action:'hello'});
  if(hello.protocol!=='pwa-sync-test-0.2')throw Error('Не тот тестовый сервер');
  const data=await db.readAll();
  if(data.queue.length)throw Error('Очередь не пуста. Скачайте резервную копию и сбросьте только тестовые данные перед подключением');
  const snapshot=await jsonp({action:'pull'});
  await db.replaceFromServer(snapshot);
  return {cases:snapshot.cases.length,events:snapshot.events.length,at:snapshot.pulledAt};
});}
async function pull(db){return guarded(async()=>{
  const data=await db.readAll();
  if(data.queue.length)throw Error('Сначала разберите локальную очередь');
  const snapshot=await jsonp({action:'pull'});
  await db.replaceFromServer(snapshot);
  return {cases:snapshot.cases.length,events:snapshot.events.length,at:snapshot.pulledAt};
});}
async function push(db,onProgress){return guarded(async()=>{
  let applied=0,conflicts=0;
  const local=await db.readAll();
  if(local.source!=='test-server-v02')throw Error('Это демоданные. Сначала загрузите дела из отдельной тестовой Google Sheets');
  const queue=[...local.queue].sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  for(const op of queue){
    if(op.status==='conflict')throw Error('Есть неразрешённый конфликт. Очередь не изменена');
    if(onProgress)onProgress('Проверяю '+op.opId.slice(0,18)+'…');
    const reply=await sendAndVerify(op);
    if(reply.status==='applied'){await db.markSynced(op.opId);applied++;}
    else {
      await db.markConflict(op.opId,reply.result);
      conflicts++;
      break; // Никаких следующих операций при конфликте.
    }
  }
  if(!conflicts && (await db.readAll()).queue.length===0){
    const snapshot=await jsonp({action:'pull'});
    await db.replaceFromServer(snapshot);
  }
  return {applied,conflicts};
});}
window.DemoSync=Object.freeze({config,saveConfig,clearConfig,jsonp,connect,pull,push,get busy(){return busy;}});
}());
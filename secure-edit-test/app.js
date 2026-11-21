/* OFFLINE-SECURE-0.9.5-journal-download-pre (field-by-field last-write-wins merge; compatible encrypted vault 0.9).
 * A later UTC editedAt wins only for the same case/event and field.
 * Equal timestamps with different values keep the local value and report a tie.
 * Public static app; private snapshots and local drafts are encrypted in IndexedDB.
 * NO Google Sheets writes, API calls, background sync, plaintext in storage.
 * Data from an unlocked vault lives briefly in memory until background/lock.
 */
(function () {
  'use strict';
  const VERSION='OFFLINE-SECURE-0.9-local-edits-pre';
  const VAULT_FORMAT='shtab-offline-vault';
  const DATA_PROTOCOL='shtab-offline-draft-data-v1';
  const LOG_PROTOCOL='shtab-offline-draft-log-v1';
  const LOG_FORMAT='shtab-offline-draft-envelope';
  const VAULT_AAD='shtab-offline-vault-v1|TEST_COPY_ONLY';
  const LOG_AAD='shtab-offline-draft-log-v1|TEST_COPY_ONLY|';
  const DB_NAME='shtab-secure-edit-test-v0.9';
  const DB_STORE='vault';
  const FILE_LIMIT=5*1024*1024;
  const PAGE_SIZE=15;
  const CASE_FIELDS=['client','dispute','subject','status','task','taskType','planDate','legalDate'];
  const EVENT_FIELDS=['date','time','place','result'];
  const CASE_ID=/^CASE-[A-Za-z0-9-]{8,100}$/;
  const EVENT_ID=/^EVT-[A-Za-z0-9-]{8,100}$/;
  const editableCase=['task','planDate'];
  const editableEvent=['result'];
  const encoder=new TextEncoder();
  const ids=['setup','vault-file','import-pass','import','unlock-zone','stored-note',
    'unlock-pass','unlock','delete','viewer','lock','case-count','event-count',
    'draft-count','tab-cases','tab-events','tab-drafts','query','page-count',
    'records','prev','next','journal-tools','backup','restore-file','restore','clear-drafts','editor',
    'edit-title','case-edit-fields','event-edit-fields','edit-task','edit-date',
    'edit-result','save-edit','cancel-edit','status','sw-status',
    'quick-controls','quick-note','quick-status','quick-enable','quick-disable','quick-disable-locked',
    'trust-enable','trust-open-locked',
    'edit-auth','edit-pass','edit-authorize','edit-auth-cancel'];
  const el={};ids.forEach(id=>{el[id]=document.getElementById(id);});

  let envelope=null;
  let snapshot=null;
  let cryptoKey=null;
  let snapshotId='';
  let journal=[];
  let mode='cases';
  let offset=0;
  let editTarget=null;
  let busy=false;
  let generation=0;
  let quickEnabled=false;
  let trustedEditEnabled=false;
  let quickView=false;
  let manualLock=false;
  let pendingEdit=null;

  function fail(code) {const e=new Error(code);e.code=code;throw e;}
  function notify(text,style) {
    el.status.className='status'+(style?' '+style:'');
    el.status.textContent=text;
  }
  function errorMessage(code) {
    if(code==='BAD_PASSWORD_OR_FILE')return 'Парольная фраза неверна или файл повреждён.';
    if(code==='BAD_FORMAT')return 'Нужен новый зашифрованный файл версии 0.9 (не файл сейфа 0.8).';
    if(code==='STORAGE')return 'Не удалось сохранить зашифрованные данные на устройстве.';
    if(code==='JOURNAL_DAMAGED')return 'Не удалось проверить зашифрованный журнал правок. Правки не удалены.';
    if(code==='HAS_VAULT')return 'Копия уже есть. Удаление старой копии уничтожит локальные правки — сначала сохрани журнал.';
    if(code==='NOT_EDITABLE')return 'У дела нет записи на листе «Список», поэтому здесь нельзя менять задачу.';
    if(code==='QUICK_NOT_SUPPORTED')return 'Safari не смог безопасно сохранить локальный ключ быстрого просмотра. Фраза по-прежнему работает; ничего не удалено.';
    if(code==='MERGE_CONFLICT')return 'Не удалось автоматически объединить журнал. Текущие правки сохранены.';
    return 'Операция не выполнена; исходные данные и предыдущие правки сохранены.';
  }
  function supportsCrypto(){return!!(window.isSecureContext&&window.crypto&&crypto.subtle&&crypto.getRandomValues&&window.indexedDB);}
  function fromB64(s){
    if(typeof s!=='string'||s.length>15_000_000||!/^[A-Za-z0-9+/]*={0,2}$/.test(s))fail('BAD_FORMAT');
    let raw;try{raw=atob(s);}catch(_){fail('BAD_FORMAT');}
    const a=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)a[i]=raw.charCodeAt(i);return a;
  }
  function toB64(bytes){let s='';for(let i=0;i<bytes.length;i+=0x8000)
    s+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));return btoa(s);}
  function validDate(s){
    if(s==='')return true;
    const z=/^(\d{4})-(\d{2})-(\d{2})$/.exec(s);if(!z)return false;
    const y=+z[1],m=+z[2],d=+z[3],x=new Date(Date.UTC(y,m-1,d));
    return y>=1900&&y<=2100&&x.getUTCFullYear()===y&&x.getUTCMonth()+1===m&&x.getUTCDate()===d;
  }
  function validateEnvelope(v){
    if(!v||typeof v!=='object'||Array.isArray(v)||v.format!==VAULT_FORMAT||
      v.formatVersion!==1||v.scope!=='TEST_COPY_ONLY'||!v.kdf||
      v.kdf.name!=='PBKDF2'||v.kdf.hash!=='SHA-256'||v.kdf.iterations!==600000||
      !v.cipher||v.cipher.name!=='AES-GCM'||fromB64(v.kdf.salt).length!==16||
      fromB64(v.cipher.iv).length!==12||fromB64(v.cipher.data).length<17)fail('BAD_FORMAT');
    return v;
  }
  function validateSnapshot(v){
    if(!v||typeof v!=='object'||Array.isArray(v)||v.protocol!==DATA_PROTOCOL||
      v.scope!=='TEST_COPY_ONLY'||v.sourceVersion!=='OFFLINE-SECURE-0.6-read-bridge-pre'||
      !/^[a-f0-9]{64}$/.test(v.snapshotFingerprint)||
      !Array.isArray(v.cases)||!Array.isArray(v.events)||
      v.cases.length>1000||v.events.length>2000)fail('BAD_FORMAT');
    const cases=new Set(),events=new Set();
    function validText(r,keys){return!!r&&typeof r==='object'&&!Array.isArray(r)&&
      keys.every(k=>typeof r[k]==='string'&&r[k].length<=5000);}
    for(const c of v.cases){
      if(!CASE_ID.test(c?.caseId||'')||cases.has(c.caseId)||
        !['acts_only','list_only','acts_and_list'].includes(c.source)||
        !validText(c,CASE_FIELDS)||!validDate(c.planDate)||!validDate(c.legalDate))fail('BAD_FORMAT');
      cases.add(c.caseId);
    }
    for(const e of v.events){
      if(!EVENT_ID.test(e?.eventId||'')||events.has(e.eventId)||
        !CASE_ID.test(e.caseId||'')||!cases.has(e.caseId)||
        !validText(e,EVENT_FIELDS)||!validDate(e.date)||!e.date||
        (e.time!==''&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(e.time)))fail('BAD_FORMAT');
      events.add(e.eventId);
    }
    return v;
  }
  async function derivedKey(v,phrase){
    if(typeof phrase!=='string'||phrase.length<16||phrase.length>256)fail('BAD_PASSWORD_OR_FILE');
    const secret=encoder.encode(phrase.normalize('NFKC'));
    const raw=await crypto.subtle.importKey('raw',secret,'PBKDF2',false,['deriveKey']);secret.fill(0);
    return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt:fromB64(v.kdf.salt),iterations:600000},
      raw,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  }
  async function decryptVault(v,key){
    let plaintext;
    try{plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:fromB64(v.cipher.iv),
      additionalData:encoder.encode(VAULT_AAD)},key,fromB64(v.cipher.data));}
    catch(_){fail('BAD_PASSWORD_OR_FILE');}
    let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext));}
    catch(_){fail('BAD_FORMAT');}
    return validateSnapshot(data);
  }
  async function getSnapshotId(v){
    const body=fromB64(v.cipher.data);
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',body));
    return [...digest].map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  function openDB(){return new Promise((resolve,reject)=>{
    let req;try{req=indexedDB.open(DB_NAME,1);}catch(_){return reject(new Error('STORAGE'));}
    req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(DB_STORE))req.result.createObjectStore(DB_STORE);};
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(new Error('STORAGE'));
    req.onblocked=()=>reject(new Error('STORAGE'));
  });}
  async function getStored(name){
    const db=await openDB();try{return await new Promise((resolve,reject)=>{
      const req=db.transaction(DB_STORE,'readonly').objectStore(DB_STORE).get(name);
      req.onsuccess=()=>resolve(req.result||null);
      req.onerror=()=>reject(new Error('STORAGE'));
    });}finally{db.close();}
  }
  async function store(name,value){
    const db=await openDB();try{await new Promise((resolve,reject)=>{
      const tx=db.transaction(DB_STORE,'readwrite');tx.objectStore(DB_STORE).put(value,name);
      tx.oncomplete=resolve;tx.onerror=()=>reject(new Error('STORAGE'));
      tx.onabort=()=>reject(new Error('STORAGE'));
    });}finally{db.close();}
  }
  async function deleteStored(name){
    const db=await openDB();try{await new Promise((resolve,reject)=>{
      const tx=db.transaction(DB_STORE,'readwrite');tx.objectStore(DB_STORE).delete(name);
      tx.oncomplete=resolve;tx.onerror=()=>reject(new Error('STORAGE'));
      tx.onabort=()=>reject(new Error('STORAGE'));
    });}finally{db.close();}
  }
  async function eraseAll(){
    const db=await openDB();try{await new Promise((resolve,reject)=>{
      const tx=db.transaction(DB_STORE,'readwrite');const s=tx.objectStore(DB_STORE);
      s.delete('encrypted');s.delete('drafts');s.delete('quick');s.delete('quick-paused');
      tx.oncomplete=resolve;tx.onerror=()=>reject(new Error('STORAGE'));
      tx.onabort=()=>reject(new Error('STORAGE'));
    });}finally{db.close();}
  }
  // An edit timestamp is an exact UTC instant. ISO-8601 canonical strings sort by time.
  function validEditTime(s){
    if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s))return false;
    const t=Date.parse(s);
    return Number.isFinite(t)&&new Date(t).toISOString()===s;
  }
  function changeKey(item){return item.kind+'|'+item.id+'|'+item.field;}
  // Merge only matching fields of the exact same encrypted snapshot. Validity of
  // both arrays and the matching snapshot is checked before this function runs.
  // Equal timestamps with different values cannot identify the true last edit.
  // In that rare case the local entry stays and the ambiguity is reported.
  function mergeDraftsByTime(local,incoming){
    const merged=local.slice(),at=new Map(local.map((item,i)=>[changeKey(item),i]));
    const stats={added:0,replaced:0,keptLocal:0,sameValue:0,refreshedTime:0,ties:0};
    for(const item of incoming){
      const key=changeKey(item),index=at.get(key);
      if(index===undefined){at.set(key,merged.length);merged.push(item);stats.added++;continue;}
      const old=merged[index];
      if(item.editedAt>old.editedAt){
        merged[index]=item;
        if(item.to===old.to)stats.refreshedTime++;
        else stats.replaced++;
      }else if(item.editedAt<old.editedAt){
        if(item.to===old.to)stats.sameValue++;
        else stats.keptLocal++;
      }else if(item.to===old.to)stats.sameValue++;
      else stats.ties++;
    }
    return {merged,stats,changed:stats.added+stats.replaced+stats.refreshedTime>0};
  }
  function checkDrafts(items,data,hash){
    if(!Array.isArray(items)||items.length>4000)fail('JOURNAL_DAMAGED');
    const caseIndex=new Map(data.cases.map(c=>[c.caseId,c]));
    const eventIndex=new Map(data.events.map(e=>[e.eventId,e]));
    const unique=new Set();
    for(const item of items){
      if(!item||typeof item!=='object'||Array.isArray(item)||
        !['case','event'].includes(item.kind)||typeof item.id!=='string'||
        typeof item.field!=='string'||typeof item.from!=='string'||
        typeof item.to!=='string'||item.to.length>5000||
        !validEditTime(item.editedAt))fail('JOURNAL_DAMAGED');
      const k=item.kind+'|'+item.id+'|'+item.field;
      if(unique.has(k))fail('JOURNAL_DAMAGED');unique.add(k);
      const record=item.kind==='case'?caseIndex.get(item.id):eventIndex.get(item.id);
      if(!record||(item.kind==='case'&&
        (record.source==='acts_only'||!editableCase.includes(item.field)))||
        (item.kind==='event'&&!editableEvent.includes(item.field))||
        record[item.field]!==item.from||
        (item.field==='planDate'&&!validDate(item.to)))fail('JOURNAL_DAMAGED');
    }
    return items;
  }
  function validateLogBox(v,id){
    if(!v||typeof v!=='object'||v.format!==LOG_FORMAT||v.version!==1||
       v.scope!=='TEST_COPY_ONLY'||v.snapshotId!==id||
       !v.cipher||v.cipher.name!=='AES-GCM'||fromB64(v.cipher.iv).length!==12||
       fromB64(v.cipher.data).length<17)fail('JOURNAL_DAMAGED');return v;
  }
  async function decryptLog(box,key,data,id){
    validateLogBox(box,id);
    let plain;try{plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:fromB64(box.cipher.iv),
      additionalData:encoder.encode(LOG_AAD+id)},key,fromB64(box.cipher.data));}
    catch(_){fail('JOURNAL_DAMAGED');}
    let doc;try{doc=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));}
    catch(_){fail('JOURNAL_DAMAGED');}
    if(!doc||doc.protocol!==LOG_PROTOCOL||doc.scope!=='TEST_COPY_ONLY'||
      doc.snapshotId!==id||doc.sourceFingerprint!==data.snapshotFingerprint)fail('JOURNAL_DAMAGED');
    return checkDrafts(doc.changes,data,id);
  }
  async function encryptLog(items,key,data,id){
    checkDrafts(items,data,id);
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const plaintext=encoder.encode(JSON.stringify({protocol:LOG_PROTOCOL,scope:'TEST_COPY_ONLY',
      snapshotId:id,sourceFingerprint:data.snapshotFingerprint,changes:items}));
    const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,
      additionalData:encoder.encode(LOG_AAD+id)},key,plaintext);
    return {format:LOG_FORMAT,version:1,scope:'TEST_COPY_ONLY',snapshotId:id,
      cipher:{name:'AES-GCM',iv:toB64(iv),data:toB64(new Uint8Array(cipher))}};
  }
  function resetView(){
    snapshot=null;cryptoKey=null;snapshotId='';journal=[];mode='cases';offset=0;editTarget=null;
    el.query.value='';el.records.replaceChildren();el['page-count'].textContent='';
    el['case-count'].textContent='';el['event-count'].textContent='';el['draft-count'].textContent='';
    el['edit-task'].value='';el['edit-date'].value='';el['edit-result'].value='';
    el['unlock-pass'].value='';el['import-pass'].value='';el['edit-pass'].value='';
    quickView=false;pendingEdit=null;el['edit-auth'].hidden=true;
    el.editor.hidden=true;el.viewer.hidden=true;
  }
  function lockScreen(manual){
    if(manual===true)manualLock=true;
    generation++;resetView();if(envelope){el.setup.hidden=true;el['unlock-zone'].hidden=false;}
  }
  function showStored(){
    el['unlock-zone'].hidden=!envelope;el.setup.hidden=!!envelope;
    el['stored-note'].textContent=envelope?('Снимок: '+String(envelope.createdAt||'').slice(0,10)+
      '. Хранится зашифрованным. Режим без ввода фразы включается только по желанию.') : '';
    el['quick-disable-locked'].hidden=!quickEnabled||!envelope;
    el['trust-open-locked'].hidden=!envelope||!trustedEditEnabled;
  }
  function refreshQuickUi(){
    el['quick-controls'].hidden=!snapshot;
    el['quick-enable'].hidden=quickEnabled||quickView;
    // In legacy quick-view, this button asks for the original phrase once and then upgrades trust.
    el['trust-enable'].hidden=!snapshot||trustedEditEnabled;
    el['trust-enable'].textContent=quickView?
      'Включить полный доступ (последний раз ввести фразу)':
      'Разрешить просмотр и правки без пароля на этом устройстве';
    el['quick-disable'].hidden=!quickEnabled;
    el['quick-disable'].textContent=trustedEditEnabled?
      'Отключить доверенное устройство — снова требовать фразу':
      'Отключить быстрый просмотр — снова требовать фразу';
    el['quick-note'].hidden=!quickView;
    if(snapshot){el['quick-status'].textContent=trustedEditEnabled?
      'Доверенное устройство: просмотр и локальные правки без фразы, в том числе после перезапуска.':
      quickEnabled?
        (quickView?'Быстрый просмотр включён · только чтение. Для изменения нужна фраза.':
        'Быстрый просмотр включён. После нового запуска список дел откроется автоматически; для правок нужна фраза.'):
        'Автовход выключен. Можно разрешить этому устройству просмотр и правки без фразы.';}
    el['journal-tools'].hidden=quickView;
    el.lock.textContent=trustedEditEnabled?'Скрыть экран':'Заблокировать';
  }
  function fmtDate(s){return /^\d{4}-\d{2}-\d{2}$/.test(s)?s.slice(8,10)+'.'+s.slice(5,7)+'.'+s.slice(0,4):(s||'—');}
  function label(card,name,v){if(v==='')return;const p=document.createElement('p');p.textContent=name+v;card.appendChild(p);}
  function editedFor(kind,id,field){return journal.find(x=>x.kind===kind&&x.id===id&&x.field===field);}
  function effective(record,kind){
    const out=Object.assign({},record),id=kind==='case'?record.caseId:record.eventId;
    for(const field of (kind==='case'?editableCase:editableEvent)){
      const edit=editedFor(kind,id,field);if(edit)out[field]=edit.to;
    }
    return out;
  }
  function annotate(card,count){
    if(!count)return;
    const mark=document.createElement('span');mark.className='edited';
    mark.textContent='Локальный черновик · '+count;card.appendChild(mark);
  }
  function command(card,caption,fn){
    const btn=document.createElement('button');btn.type='button';btn.textContent=caption;
    btn.addEventListener('click',fn);card.appendChild(btn);
  }
  // The whole record opens on tap. Keep its explicit action button for clarity.
  // Guard bubbling so tapping that button does not open the editor twice.
  function tappableCard(card,caption,action){
    card.classList.add('record-tappable');
    card.setAttribute('role','button');
    card.setAttribute('tabindex','0');
    card.setAttribute('aria-label',caption);
    card.addEventListener('click',event=>{
      if(event.target.closest && event.target.closest('button,a,input,textarea,select'))return;
      action();
    });
    card.addEventListener('keydown',event=>{
      if(event.target!==card)return;
      if(event.key==='Enter'||event.key===' '){event.preventDefault();action();}
    });
  }
  function caseList(){
    return snapshot.cases.slice().sort((a,b)=>a.client.localeCompare(b.client,'ru')||
      a.subject.localeCompare(b.subject,'ru'));
  }
  function eventList(){
    const byCase=new Map(snapshot.cases.map(c=>[c.caseId,c]));
    return snapshot.events.map(e=>Object.assign({},e,{
      client:byCase.get(e.caseId)?.client||'',subject:byCase.get(e.caseId)?.subject||''
    })).sort((a,b)=>b.date.localeCompare(a.date)||b.time.localeCompare(a.time));
  }
  function render(){
    if(!snapshot||!cryptoKey)return;
    el.editor.hidden=true;editTarget=null;
    const q=el.query.value.trim().toLocaleLowerCase('ru');
    const base=mode==='cases'?caseList():(mode==='events'?eventList():journal.slice().sort((a,b)=>b.editedAt.localeCompare(a.editedAt)));
    const items=base.filter(raw=>{
      if(!q)return true;
      if(mode==='drafts'){
        const source=raw.kind==='case'?snapshot.cases.find(c=>c.caseId===raw.id):snapshot.events.find(e=>e.eventId===raw.id);
        const p=raw.kind==='event'?snapshot.cases.find(c=>c.caseId===source?.caseId):source;
        const info=[p?.client,p?.subject,raw.to,raw.from,raw.field];
        return info.some(v=>typeof v==='string'&&v.toLocaleLowerCase('ru').includes(q));
      }
      const e=effective(raw,mode==='cases'?'case':'event');
      return Object.values(e).some(v=>typeof v==='string'&&v.toLocaleLowerCase('ru').includes(q));
    });
    if(offset>=items.length)offset=Math.max(0,Math.floor((items.length-1)/PAGE_SIZE)*PAGE_SIZE);
    const visible=items.slice(offset,offset+PAGE_SIZE);
    el.records.replaceChildren();
    for(const raw of visible){
      const card=document.createElement('article');card.className='record';
      const heading=document.createElement('h3');
      if(mode==='cases'){
        const c=effective(raw,'case');heading.textContent=c.client||c.subject||'Без названия';card.appendChild(heading);
        annotate(card,journal.filter(x=>x.kind==='case'&&x.id===raw.caseId).length);
        label(card,'Спор: ',c.dispute);label(card,'Предмет: ',c.subject);label(card,'Статус: ',c.status);
        label(card,'Текущая задача: ',c.task||'Не назначена');label(card,'Тип: ',c.taskType);
        label(card,'План: ',fmtDate(c.planDate));label(card,'Юридический срок (без изменения): ',fmtDate(c.legalDate));
        if(c.source==='acts_only'){
          label(card,'Только просмотр: ','нет задачи на листе «Список». Редактирование недоступно.');
        } else {
          const edit=()=>openEditor('case',raw.caseId);
          tappableCard(card,'Открыть редактор дела',edit);
          command(card,'Изменить задачу и плановый срок',edit);
        }
      } else if(mode==='events'){
        const e=effective(raw,'event');heading.textContent=e.client||e.subject||'Заседание';card.appendChild(heading);
        annotate(card,journal.filter(x=>x.kind==='event'&&x.id===raw.eventId).length);
        label(card,'Предмет: ',e.subject);label(card,'Когда: ',fmtDate(e.date)+(e.time?' в '+e.time:''));
        label(card,'Место: ',e.place);label(card,'Результат: ',e.result||'Не указан');
        const edit=()=>openEditor('event',raw.eventId);
        tappableCard(card,'Открыть редактор события',edit);
        command(card,'Зафиксировать результат',edit);
      } else {
        const src=raw.kind==='case'?snapshot.cases.find(c=>c.caseId===raw.id):snapshot.events.find(e=>e.eventId===raw.id);
        const c=raw.kind==='case'?src:snapshot.cases.find(x=>x.caseId===src?.caseId);
        heading.textContent=(c?.client||c?.subject||'Запись')+' · '+({task:'Задача',planDate:'План',result:'Результат'}[raw.field]||raw.field);
        card.appendChild(heading);
        label(card,'Исходное: ',raw.field==='planDate'?fmtDate(raw.from):raw.from||'—');
        label(card,'Локально: ',raw.field==='planDate'?fmtDate(raw.to):raw.to||'—');
        label(card,'Время правки: ',raw.editedAt.slice(0,19).replace('T',' '));
        const open=()=>{mode=raw.kind==='case'?'cases':'events';offset=0;el.query.value='';render();openEditor(raw.kind,raw.id);};
        tappableCard(card,'Открыть запись с локальной правкой',open);
        command(card,'Открыть запись',open);
      }
      el.records.appendChild(card);
    }
    el['case-count'].textContent='Дел: '+snapshot.cases.length;
    el['event-count'].textContent='Событий: '+snapshot.events.length;
    el['draft-count'].textContent='Локальных правок: '+journal.length;
    el['page-count'].textContent=items.length?(offset+1)+'–'+(offset+visible.length)+' из '+items.length:'Нет записей';
    el.prev.disabled=offset===0;el.next.disabled=offset+PAGE_SIZE>=items.length;
    ['cases','events','drafts'].forEach(k=>el['tab-'+k].className=mode===k?'active':'');
    el.backup.disabled=journal.length===0;el['clear-drafts'].disabled=journal.length===0;
    refreshQuickUi();
  }
  function openEditor(kind,id){
    if(busy||!snapshot||!cryptoKey)return;
    const source=kind==='case'?snapshot.cases.find(c=>c.caseId===id):snapshot.events.find(e=>e.eventId===id);
    if(!source)return;
    if(kind==='case'&&source.source==='acts_only')return notify(errorMessage('NOT_EDITABLE'),'error');
    if(quickView){
      pendingEdit={kind,id};el['edit-pass'].value='';el['edit-auth'].hidden=false;
      el['edit-auth'].scrollIntoView({behavior:'smooth',block:'start'});
      return notify('Для редактирования нужна исходная парольная фраза. Быстрый просмотр не даёт права изменять записи.','');
    }
    editTarget={kind,id};
    el['case-edit-fields'].hidden=kind!=='case';el['event-edit-fields'].hidden=kind!=='event';
    const live=effective(source,kind);
    if(kind==='case'){
      el['edit-task'].value=live.task;el['edit-date'].value=live.planDate;
      el['edit-title'].textContent='Задача и плановый срок · '+(source.client||source.subject||'Дело');
    } else {
      el['edit-result'].value=live.result;
      const c=snapshot.cases.find(x=>x.caseId===source.caseId);
      el['edit-title'].textContent='Результат заседания · '+(c?.client||c?.subject||'Событие');
    }
    el.editor.hidden=false;el.editor.scrollIntoView({behavior:'smooth',block:'start'});
  }
  async function persistDrafts(proposed,key,data,id){
    const sealed=await encryptLog(proposed,key,data,id);
    await store('drafts',sealed);
    const checked=await getStored('drafts');
    if(JSON.stringify(checked)!==JSON.stringify(sealed))fail('STORAGE');
    return sealed;
  }
  async function handleSave(){
    if(busy||quickView||!cryptoKey||!snapshot||!editTarget)return;
    const target=editTarget,source=target.kind==='case'?
      snapshot.cases.find(x=>x.caseId===target.id):snapshot.events.find(x=>x.eventId===target.id);
    if(!source)return;
    const next=target.kind==='case'?{
      task:el['edit-task'].value.trim(),planDate:el['edit-date'].value
    }:{result:el['edit-result'].value.trim()};
    if(!Object.entries(next).every(([k,v])=>v.length<=5000&&(k!=='planDate'||validDate(v))))
      return notify('Неправильная дата или слишком длинный текст.','error');
    const changedFields=Object.keys(next).filter(field=>{
      const old=editedFor(target.kind,target.id,field);
      return next[field]!== (old?old.to:source[field]);
    });
    if(!changedFields.length){
      el.editor.hidden=true;editTarget=null;return notify('Новых изменений нет.','');
    }
    // Only changed fields get a new timestamp. Preserve all others exactly.
    // A return to the snapshot value is an explicit timestamped reset marker;
    // without it an older backup could reintroduce a cancelled value.
    const now=new Date().toISOString();
    const changedSet=new Set(changedFields);
    const proposed=journal.filter(x=>!(x.kind===target.kind&&x.id===target.id&&changedSet.has(x.field)));
    for(const field of changedFields)proposed.push({kind:target.kind,id:target.id,field,
      from:source[field],to:next[field],editedAt:now});
    busy=true;el['save-edit'].disabled=true;
    const current=generation,key=cryptoKey,data=snapshot,id=snapshotId;
    try{
      await persistDrafts(proposed,key,data,id);
      if(current===generation){journal=proposed;render();notify('Черновик зашифрован и сохранён на iPhone. В CRM ничего не отправлено.','success');}
    }catch(e){if(current===generation)notify(errorMessage(e.code||'STORAGE'),'error');}
    finally{busy=false;el['save-edit'].disabled=false;}
  }
  async function handleImport(){
    if(busy||envelope)return;
    const file=el['vault-file'].files?.[0];let phrase=el['import-pass'].value;
    if(!file||file.size<100||file.size>FILE_LIMIT)return notify('Выбери зашифрованный файл 0.9 размером не более 5 МБ.','error');
    if(phrase.length<16||phrase.length>256)return notify('Введите парольную фразу (не менее 16 символов).','error');
    busy=true;el.import.disabled=true;const current=generation;
    try{
      const v=validateEnvelope(JSON.parse(await file.text()));
      const key=await derivedKey(v,phrase);
      await decryptVault(v,key);phrase='';el['import-pass'].value='';
      if(await getStored('encrypted'))fail('HAS_VAULT');
      await store('encrypted',v);
      if(current===generation){envelope=v;showStored();el['vault-file'].value='';
        notify('Шифрованная копия 0.9 проверена и сохранена. Отключи интернет и открой её по фразе.','success');}
    }catch(e){if(current===generation)notify(errorMessage(e.code||'BAD_FORMAT'),'error');}
    finally{phrase='';el['import-pass'].value='';busy=false;el.import.disabled=false;}
  }
  async function openWithKey(key,readOnly,current){
    const data=await decryptVault(envelope,key);
    const id=await getSnapshotId(envelope);
    const sealed=await getStored('drafts');
    const existing=sealed?await decryptLog(sealed,key,data,id):[];
    if(current!==generation||document.hidden)return false;
    snapshot=data;cryptoKey=key;snapshotId=id;journal=existing;quickView=readOnly;
    pendingEdit=null;el['edit-auth'].hidden=true;
    el.setup.hidden=true;el['unlock-zone'].hidden=true;el.viewer.hidden=false;
    mode='cases';offset=0;el.query.value='';render();
    notify(readOnly?'Дела открыты автоматически в режиме просмотра. Для правок введи парольную фразу.':
      trustedEditEnabled?'Доверенное устройство: просмотр и локальные правки доступны без фразы. В CRM ничего не отправляется.':
      'Офлайн-копия открыта. Правки сохраняются на устройстве в зашифрованном виде.','success');
    return true;
  }
  async function handleUnlock(){
    if(busy||!envelope)return;
    let phrase=el['unlock-pass'].value;
    if(phrase.length<16)return notify('Нужна парольная фраза от новой копии 0.9.','error');
    busy=true;el.unlock.disabled=true;const current=generation;
    try{
      const key=await derivedKey(envelope,phrase);phrase='';el['unlock-pass'].value='';
      if(await openWithKey(key,false,current)){manualLock=false;await deleteStored('quick-paused');}
    }catch(e){if(current===generation)notify(errorMessage(e.code||'BAD_PASSWORD_OR_FILE'),'error');}
    finally{phrase='';el['unlock-pass'].value='';busy=false;el.unlock.disabled=false;}
  }
  function validQuickRecord(r,id){
    return !!r&&r.format==='shtab-quick-view-key-v1'&&r.snapshotId===id&&
      (r.access===undefined||r.access==='view'||r.access==='full')&&
      r.key?.type==='secret'&&r.key?.algorithm?.name==='AES-GCM'&&
      r.key.extractable===false&&Array.isArray(r.key.usages)&&
      r.key.usages.includes('decrypt')&&r.key.usages.includes('encrypt');
  }
  async function tryQuickUnlock(){
    if(!envelope||manualLock||busy||snapshot||document.hidden)return;
    busy=true;const current=generation;
    try{
      const saved=await getStored('quick');
      if(!saved){quickEnabled=false;trustedEditEnabled=false;showStored();return;}
      const id=await getSnapshotId(envelope);
      if(!validQuickRecord(saved,id)){
        quickEnabled=false;trustedEditEnabled=false;await deleteStored('quick');showStored();
        if(current===generation)notify('Быстрый доступ устарел или недоступен; введи парольную фразу. Данные сохранены.','error');
        return;
      }
      quickEnabled=true;trustedEditEnabled=saved.access==='full';showStored();
      await openWithKey(saved.key,!trustedEditEnabled,current);
    }catch(_){
      if(current===generation)notify('Быстрый просмотр не открылся. Введи обычную парольную фразу, данные сохранены.','error');
    }finally{busy=false;}
  }
  async function handleQuickEnable(){
    if(busy||quickView||!snapshot||!cryptoKey||!envelope)return;
    if(!window.confirm('Включить автоматический просмотр дел на этом iPhone? Любой человек с доступом к разблокированному устройству сможет просматривать данные без парольной фразы. Локальный неэкспортируемый ключ сохранится в хранилище этого приложения. Для правок фраза по-прежнему нужна.'))return;
    busy=true;el['quick-enable'].disabled=true;
    try{
      const item={format:'shtab-quick-view-key-v1',snapshotId:snapshotId,key:cryptoKey,access:'view'};
      await store('quick',item);await deleteStored('quick-paused');manualLock=false;
      const verify=await getStored('quick');
      if(!validQuickRecord(verify,snapshotId))fail('QUICK_NOT_SUPPORTED');
      quickEnabled=true;trustedEditEnabled=false;refreshQuickUi();showStored();
      notify('Быстрый просмотр включён. При следующем запуске дела откроются автоматически; для правок нужна фраза.','success');
    }catch(_){
      try{await deleteStored('quick');}catch(__){}
      quickEnabled=false;trustedEditEnabled=false;refreshQuickUi();showStored();
      notify(errorMessage('QUICK_NOT_SUPPORTED'),'error');
    }finally{busy=false;el['quick-enable'].disabled=false;}
  }
  async function handleTrustEnable(){
    if(busy||!snapshot||!envelope||trustedEditEnabled)return;
    if(quickView){
      pendingEdit={kind:'trusted-setup'};
      el['edit-pass'].value='';el['edit-auth'].hidden=false;
      el['edit-auth'].scrollIntoView({behavior:'smooth',block:'start'});
      notify('Чтобы включить постоянный просмотр И редактирование на этом устройстве, введи исходную фразу последний раз.','');
      return;
    }
    if(!cryptoKey)return;
    if(!window.confirm('ДОВЕРЕННОЕ УСТРОЙСТВО: разрешить на этом устройстве просмотр И РЕДАКТИРОВАНИЕ без повторного ввода парольной фразы?\n\nЛюбой человек или вредоносный код с доступом к разблокированному устройству/данным этого сайта сможет просматривать и локально менять записи. Это НЕ повторная Google-авторизация и НЕ Face ID.\n\nВключать только на личном устройстве с кодом блокировки. При очистке данных браузера доверие будет потеряно.'))return;
    busy=true;el['trust-enable'].disabled=true;
    let previous=null;
    try{
      previous=await getStored('quick');
      const record={format:'shtab-quick-view-key-v1',snapshotId:snapshotId,
        key:cryptoKey,access:'full'};
      await store('quick',record);
      const verified=await getStored('quick');
      if(!validQuickRecord(verified,snapshotId)||verified.access!=='full')fail('QUICK_NOT_SUPPORTED');
      await deleteStored('quick-paused');
      quickEnabled=true;trustedEditEnabled=true;manualLock=false;
      refreshQuickUi();showStored();
      notify('Доверенное устройство включено. При запуске дела откроются автоматически, редактирование будет без ввода фразы. Данные остаются локальными.','success');
    }catch(_){
      // Roll back a partial opt-in without deleting the original encrypted vault or journal.
      const saved=await getStored('quick').catch(()=>null);
      if(saved&&saved.access==='full'){
        try{
          if(previous&&validQuickRecord(previous,snapshotId))await store('quick',previous);
          else await deleteStored('quick');
        }catch(__){} // Never delete the vault or any drafts during an authorization failure.
      }
      const restored=await getStored('quick').catch(()=>null);
      quickEnabled=!!(restored&&validQuickRecord(restored,snapshotId));
      trustedEditEnabled=!!(quickEnabled&&restored.access==='full');
      refreshQuickUi();showStored();
      notify(errorMessage('QUICK_NOT_SUPPORTED'),'error');
    }finally{busy=false;el['trust-enable'].disabled=false;}
  }
  async function handleQuickDisable(){
    if(busy)return;
    busy=true;
    try{
      const wasAutoSession=quickView||trustedEditEnabled;
      await deleteStored('quick');await deleteStored('quick-paused');
      quickEnabled=false;trustedEditEnabled=false;manualLock=false;
      if(wasAutoSession){lockScreen(true);showStored();
        notify('Доверие к устройству отозвано. Для входа снова нужна фраза. Копия и журнал сохранены.','success');}
      else{refreshQuickUi();showStored();notify('Автоматический вход выключен. Зашифрованная копия и журнал сохранены.','success');}
    }catch(_){notify(errorMessage('STORAGE'),'error');}
    finally{busy=false;}
  }
  async function handleEditAuthorize(){
    if(busy||!quickView||!pendingEdit||!envelope)return;
    let phrase=el['edit-pass'].value;
    if(phrase.length<16)return notify('Для редактирования нужна исходная парольная фраза (не менее 16 символов).','error');
    busy=true;el['edit-authorize'].disabled=true;const current=generation,requested=pendingEdit;
    try{
      const key=await derivedKey(envelope,phrase);phrase='';el['edit-pass'].value='';
      await decryptVault(envelope,key);
      if(current!==generation||document.hidden)return;
      cryptoKey=key;quickView=false;pendingEdit=null;el['edit-auth'].hidden=true;
      busy=false;render();
      if(requested.kind==='trusted-setup'){
        await handleTrustEnable();
      }else{
        openEditor(requested.kind,requested.id);
        notify('Редактирование разблокировано на время текущего сеанса.','success');
      }
    }catch(_){if(current===generation)notify('Парольная фраза неверная. Данные не изменены.','error');}
    finally{phrase='';el['edit-pass'].value='';busy=false;el['edit-authorize'].disabled=false;}
  }
  async function handleDelete(){
    if(busy||!envelope)return;
    if(!window.confirm('Удалить зашифрованную копию И ВСЕ локальные правки с iPhone? Это нельзя отменить. Сначала сохрани журнал в «Файлы».'))return;
    busy=true;
    try{await eraseAll();envelope=null;quickEnabled=false;trustedEditEnabled=false;manualLock=false;lockScreen();showStored();notify('Локальная копия и все правки удалены.','success');}
    catch(e){notify(errorMessage(e.code||'STORAGE'),'error');}
    finally{busy=false;}
  }
  async function handleClearDrafts(){
    if(busy||quickView||!cryptoKey||!snapshot||!journal.length)return;
    if(!window.confirm('Отменить ВСЕ локальные правки? Они исчезнут из зашифрованного журнала.'))return;
    busy=true;const current=generation;
    try{await persistDrafts([],cryptoKey,snapshot,snapshotId);
      if(current===generation){journal=[];render();notify('Все локальные правки отменены. Исходный снимок не изменён.','success');}}
    catch(e){if(current===generation)notify(errorMessage(e.code||'STORAGE'),'error');}
    finally{busy=false;}
  }
  async function handleRestore(){
    if(busy||quickView||!cryptoKey||!snapshot||!snapshotId)return;
    const file=el['restore-file'].files?.[0];
    if(!file||file.size<100||file.size>FILE_LIMIT)
      return notify('Выбери зашифрованный журнал .shtabchanges.json размером до 5 МБ.','error');
    busy=true;el.restore.disabled=true;const current=generation;
    try{
      const outer=JSON.parse(await file.text());
      if(!outer||outer.type!=='shtab-test-encrypted-change-backup'||outer.version!==1||
        outer.scope!=='TEST_COPY_ONLY'||outer.requiresOriginalVault!==true||
        outer.source!==VERSION)fail('BAD_FORMAT');
      validateLogBox(outer.encryptedJournal,snapshotId);
      const items=await decryptLog(outer.encryptedJournal,cryptoKey,snapshot,snapshotId);
      if(!items.length)fail('BAD_FORMAT');
      // Field-by-field automatic last-write-wins. Different fields always coexist.
      const {merged,stats,changed}=mergeDraftsByTime(journal,items);
      if(current!==generation||document.hidden)return;
      const note='Новых полей: '+stats.added+
        '; более поздних значений из файла: '+stats.replaced+
        '; текущих более поздних значений сохранено: '+stats.keptLocal+
        '; совпадают: '+stats.sameValue+
        '; обновлено время без изменения значения: '+stats.refreshedTime+
        '; равное время с разными значениями: '+stats.ties+'.';
      const timeWarning=stats.ties?
        ' При одинаковой отметке времени нельзя определить последнюю правку — оставлено значение на этом устройстве.':'';
      if(!changed){
        el['restore-file'].value='';
        return notify('Журналы проверены. Изменять ничего не требуется. '+note+timeWarning,
          stats.ties?'error':'success');
      }
      // Persist the newly encrypted journal first. In-memory state changes only
      // after the IndexedDB transaction and its readback succeed.
      await persistDrafts(merged,cryptoKey,snapshot,snapshotId);
      if(current===generation){journal=merged;el['restore-file'].value='';render();
        notify('Автоматическое объединение по времени выполнено. '+note+
          timeWarning+' Только локальные правки; в CRM ничего не отправлено.',
          stats.ties?'error':'success');}
    }catch(e){if(current===generation)notify(errorMessage(e.code||'JOURNAL_DAMAGED'),'error');}
    finally{busy=false;el.restore.disabled=false;}
  }
  async function handleBackup(){
    if(busy||quickView||!cryptoKey||!snapshot||!journal.length)return;
    busy=true;
    try{
      const boxed=await getStored('drafts');validateLogBox(boxed,snapshotId);
      const content=JSON.stringify({type:'shtab-test-encrypted-change-backup',
        version:1,scope:'TEST_COPY_ONLY',source:'OFFLINE-SECURE-0.9-local-edits-pre',
        requiresOriginalVault:true,encryptedJournal:boxed});
      const name='shtab-local-drafts-'+new Date().toISOString().slice(0,10)+'.shtabchanges.json';
      const url=URL.createObjectURL(new Blob([content],{type:'application/json'}));
      const link=document.createElement('a');
      link.href=url;
      link.download=name;
      document.body.appendChild(link);
      try{link.click();}
      finally{
        link.remove();
        setTimeout(()=>URL.revokeObjectURL(url),30000);
      }
      notify('Скачивание зашифрованного журнала запрошено. Проверь загрузки браузера.','success');
    }catch(_){notify('Сохранение резервного журнала отменено или не удалось. Локальные правки не удалены.','error');}
    finally{busy=false;}
  }
  el.import.addEventListener('click',handleImport);
  el.unlock.addEventListener('click',handleUnlock);
  el.delete.addEventListener('click',handleDelete);
  el.lock.addEventListener('click',async ()=>{
    // Full trusted access deliberately hides, not permanently password-locks.
    if(trustedEditEnabled){
      lockScreen(false);showStored();
      notify('Экран скрыт. На доверенном устройстве можно снова открыть дела и редактирование без фразы.','');
      return;
    }
    lockScreen(true);
    try{if(quickEnabled)await store('quick-paused',true);}catch(_){
      notify('Экран заблокирован, но не удалось сохранить запрет автовхода после перезапуска.','error');return;
    }
    notify('Экран заблокирован вручную. До следующего ввода фразы автоматический просмотр приостановлен.','');
  });
  el['save-edit'].addEventListener('click',handleSave);
  el['cancel-edit'].addEventListener('click',()=>{el.editor.hidden=true;editTarget=null;});
  el.backup.addEventListener('click',handleBackup);
  el.restore.addEventListener('click',handleRestore);
  el['quick-enable'].addEventListener('click',handleQuickEnable);
  el['trust-enable'].addEventListener('click',handleTrustEnable);
  el['trust-open-locked'].addEventListener('click',()=>{if(!busy)void tryQuickUnlock();});
  el['quick-disable'].addEventListener('click',handleQuickDisable);
  el['quick-disable-locked'].addEventListener('click',handleQuickDisable);
  el['edit-authorize'].addEventListener('click',handleEditAuthorize);
  el['edit-auth-cancel'].addEventListener('click',()=>{
    pendingEdit=null;el['edit-pass'].value='';el['edit-auth'].hidden=true;
  });
  el['clear-drafts'].addEventListener('click',handleClearDrafts);
  ['cases','events','drafts'].forEach(k=>el['tab-'+k].addEventListener('click',()=>{mode=k;offset=0;el.query.value='';render();}));
  el.query.addEventListener('input',()=>{offset=0;render();});
  el.prev.addEventListener('click',()=>{offset=Math.max(0,offset-PAGE_SIZE);render();});
  el.next.addEventListener('click',()=>{offset+=PAGE_SIZE;render();});
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden)lockScreen();else if(!manualLock)void tryQuickUnlock();
  });
  window.addEventListener('pagehide',()=>lockScreen());
  window.addEventListener('pageshow',e=>{
    if(e.persisted){lockScreen();if(!manualLock)void tryQuickUnlock();}
  });
  (async function init(){
    if(!supportsCrypto()){notify('Для этого приложения необходимы HTTPS, WebCrypto и IndexedDB.','error');return;}
    try{
      envelope=await getStored('encrypted');if(envelope)validateEnvelope(envelope);
      const savedQuick=envelope?await getStored('quick'):null;
      quickEnabled=!!savedQuick;trustedEditEnabled=savedQuick?.access==='full';
      manualLock=quickEnabled&&!trustedEditEnabled&&(await getStored('quick-paused'))===true;
      showStored();notify(envelope?'Шифрованная копия найдена. Проверяю быстрый просмотр…':
        'Ожидается файл 0.9 из тестового Web App.','');
      if(envelope&&!manualLock)await tryQuickUnlock();
      else if(manualLock)notify('Быстрый просмотр приостановлен ручной блокировкой. Введи фразу, чтобы снять запрет.','');
    }catch(_){notify('Не удалось прочитать локальное хранилище. Данные не удалялись.','error');}
    if('serviceWorker' in navigator){
      try{await navigator.serviceWorker.register('./sw.js',{scope:'./'});await navigator.serviceWorker.ready;
        el['sw-status'].textContent='Оболочка готова к офлайн-проверке. Отключение сети проверь вручную.';
      }catch(_){el['sw-status'].textContent='Не удалось кэшировать приложение. Обнови страницу с интернетом.';}
    }else el['sw-status'].textContent='Service Worker отсутствует: офлайн-запуск недоступен.';
  })();
})();

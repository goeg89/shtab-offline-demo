/* OFFLINE-SECURE-0.8-vault-pre — isolated offline-only encrypted viewer.
 * No external network requests, no Sheets sync, no plaintext persistence.
 * Note: an unlocked viewer holds plaintext in JS memory until background/lock.
 */
(function () {
  'use strict';
  const VERSION = 'OFFLINE-SECURE-0.8-vault-pre';
  const FORMAT = 'shtab-offline-vault';
  const DATA_PROTOCOL = 'shtab-offline-vault-data-v1';
  const AAD = 'shtab-offline-vault-v1|TEST_COPY_ONLY';
  const PAGE_SIZE = 15;
  const DB_NAME = 'shtab-secure-offline-vault-v1';
  const DB_STORE = 'vault';
  const MAX_FILE_BYTES = 5 * 1024 * 1024;
  const ids = ['setup','vault-file','import-pass','import','unlock-zone','stored-note',
    'unlock-pass','unlock','delete','viewer','lock','case-count','event-count',
    'tab-cases','tab-events','query','page-count','records','prev','next','status','sw-status'];
  const el = {};
  ids.forEach(id => { el[id] = document.getElementById(id); });
  let envelope = null;
  let plaintext = null;
  let mode = 'cases';
  let offset = 0;
  let busy = false;
  let generation = 0;

  function message(str, type) {
    el.status.className = 'status' + (type ? ' ' + type : '');
    el.status.textContent = str;
  }
  function errorText(code) {
    if (code === 'BAD_PASSWORD_OR_FILE') return 'Парольная фраза неверна или файл повреждён.';
    if (code === 'BAD_FORMAT') return 'Неверный формат: нужен зашифрованный файл офлайн-сейфа версии 0.8.';
    if (code === 'STORAGE') return 'Не удалось сохранить файл на устройстве. Проверьте доступность хранилища Safari/PWA.';
    return 'Операция не удалась. Открытые сведения не сохранены.';
  }
  function failure(code) { const e = new Error(code); e.code = code; throw e; }
  function readyCrypto() {
    return !!(window.isSecureContext && window.crypto && crypto.subtle && crypto.getRandomValues && window.indexedDB);
  }
  function fromB64(s) {
    if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length > 15_000_000)
      failure('BAD_FORMAT');
    let raw;
    try { raw = atob(s); } catch (_) { failure('BAD_FORMAT'); }
    const a = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i);
    return a;
  }
  function validateEnvelope(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x) ||
        x.format !== FORMAT || x.formatVersion !== 1 || x.scope !== 'TEST_COPY_ONLY' ||
        !x.kdf || x.kdf.name !== 'PBKDF2' || x.kdf.hash !== 'SHA-256' ||
        x.kdf.iterations !== 600000 || !x.cipher || x.cipher.name !== 'AES-GCM')
      failure('BAD_FORMAT');
    if (fromB64(x.kdf.salt).length !== 16 || fromB64(x.cipher.iv).length !== 12 ||
        fromB64(x.cipher.data).length < 17) failure('BAD_FORMAT');
    return x;
  }
  function validateData(x) {
    if (!x || typeof x !== 'object' || x.protocol !== DATA_PROTOCOL ||
        x.scope !== 'TEST_COPY_ONLY' || !Array.isArray(x.cases) ||
        !Array.isArray(x.events) || x.cases.length > 1000 || x.events.length > 2000)
      failure('BAD_FORMAT');
    const cs = ['client','dispute','subject','status','task','taskType','planDate','legalDate'];
    const es = ['client','subject','date','time','place','result'];
    const check = (r,fields) => r && typeof r === 'object' && !Array.isArray(r) &&
      fields.every(k => typeof r[k] === 'string' && r[k].length <= 5000);
    if (!x.cases.every(r => check(r,cs)) || !x.events.every(r => check(r,es)))
      failure('BAD_FORMAT');
    return x;
  }
  async function unlockEnvelope(saved, phrase) {
    validateEnvelope(saved);
    if (typeof phrase !== 'string' || phrase.length < 16 || phrase.length > 256)
      failure('BAD_PASSWORD_OR_FILE');
    const encoder = new TextEncoder();
    const secret = encoder.encode(phrase.normalize('NFKC'));
    const rawKey = await crypto.subtle.importKey('raw', secret, 'PBKDF2', false, ['deriveKey']);
    secret.fill(0);
    const key = await crypto.subtle.deriveKey({
      name:'PBKDF2',hash:'SHA-256',salt:fromB64(saved.kdf.salt),iterations:600000
    },rawKey,{name:'AES-GCM',length:256},false,['decrypt']);
    let result;
    try {
      result = await crypto.subtle.decrypt({name:'AES-GCM',iv:fromB64(saved.cipher.iv),additionalData:encoder.encode(AAD)},
        key,fromB64(saved.cipher.data));
    } catch (_) { failure('BAD_PASSWORD_OR_FILE'); }
    let obj;
    try { obj = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(result)); }
    catch (_) { failure('BAD_FORMAT'); }
    return validateData(obj);
  }
  function openDB() {
    return new Promise((resolve,reject) => {
      let r;
      try { r = indexedDB.open(DB_NAME,1); } catch (_) { return reject(new Error('STORAGE')); }
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(DB_STORE)) r.result.createObjectStore(DB_STORE); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(new Error('STORAGE'));
      r.onblocked = () => reject(new Error('STORAGE'));
    });
  }
  async function readSaved() {
    const db = await openDB();
    try { return await new Promise((resolve,reject) => {
      const tr = db.transaction(DB_STORE,'readonly');
      const r = tr.objectStore(DB_STORE).get('encrypted');
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(new Error('STORAGE'));
    }); } finally { db.close(); }
  }
  async function writeSaved(x) {
    const db = await openDB();
    try { await new Promise((resolve,reject) => {
      const tr = db.transaction(DB_STORE,'readwrite');
      tr.objectStore(DB_STORE).put(x,'encrypted');
      tr.oncomplete = () => resolve();
      tr.onerror = () => reject(new Error('STORAGE'));
      tr.onabort = () => reject(new Error('STORAGE'));
    }); } finally { db.close(); }
  }
  async function deleteSaved() {
    const db = await openDB();
    try { await new Promise((resolve,reject) => {
      const tr = db.transaction(DB_STORE,'readwrite');
      tr.objectStore(DB_STORE).delete('encrypted');
      tr.oncomplete = () => resolve();
      tr.onerror = () => reject(new Error('STORAGE'));
      tr.onabort = () => reject(new Error('STORAGE'));
    }); } finally { db.close(); }
  }
  function resetViewer() {
    plaintext = null;
    mode = 'cases'; offset = 0;
    el.query.value = '';
    el.records.replaceChildren();
    el['case-count'].textContent = '';
    el['event-count'].textContent = '';
    el['page-count'].textContent = '';
    el.viewer.hidden = true;
    el['unlock-pass'].value = '';
    el['import-pass'].value = '';
  }
  function lockScreen() {
    generation++;
    resetViewer();
    if (envelope) { el['unlock-zone'].hidden = false; el.setup.hidden = true; }
  }
  function showStored() {
    el['unlock-zone'].hidden = !envelope;
    el.setup.hidden = !!envelope;
    el['stored-note'].textContent = envelope ?
      'Копия сохранена на устройстве только в зашифрованном виде. Дата экспорта: ' +
      (typeof envelope.createdAt === 'string' ? envelope.createdAt.slice(0,10) : 'неизвестна') : '';
  }
  function label(card,title,value) {
    if (!value) return;
    const p = document.createElement('p');
    p.textContent = title + value;
    card.appendChild(p);
  }
  function dt(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(8,10)+'.'+s.slice(5,7)+'.'+s.slice(0,4) : (s || '—');
  }
  function caseSort(a,b) { return a.client.localeCompare(b.client,'ru') || a.subject.localeCompare(b.subject,'ru'); }
  function eventSort(a,b) { return b.date.localeCompare(a.date) || b.time.localeCompare(a.time); }
  function render() {
    if (!plaintext) return;
    const query = el.query.value.trim().toLocaleLowerCase('ru');
    const raw = (mode === 'cases' ? plaintext.cases : plaintext.events).slice();
    raw.sort(mode === 'cases' ? caseSort : eventSort);
    const list = query ? raw.filter(r => Object.values(r).some(v => typeof v === 'string' && v.toLocaleLowerCase('ru').includes(query))) : raw;
    if (offset >= list.length) offset = Math.max(0,Math.floor((list.length-1)/PAGE_SIZE)*PAGE_SIZE);
    const visible = list.slice(offset,offset+PAGE_SIZE);
    el.records.replaceChildren();
    visible.forEach(r => {
      const card = document.createElement('article'); card.className='record';
      const h = document.createElement('h3');h.textContent=r.client || r.subject || 'Без названия';card.appendChild(h);
      if (mode === 'cases') {
        label(card,'Спор: ',r.dispute);label(card,'Предмет: ',r.subject);label(card,'Статус: ',r.status);
        label(card,'Задача: ',r.task || 'Не назначена');label(card,'Тип: ',r.taskType);
        label(card,'План: ',dt(r.planDate));label(card,'Юридический срок: ',dt(r.legalDate));
      } else {
        label(card,'Предмет: ',r.subject);label(card,'Когда: ',dt(r.date)+(r.time?' в '+r.time:''));
        label(card,'Место: ',r.place);label(card,'Результат: ',r.result || 'Не указан');
      }
      el.records.appendChild(card);
    });
    el['page-count'].textContent = list.length ? (offset+1)+'–'+(offset+visible.length)+' из '+list.length : 'Нет совпадений';
    el.prev.disabled = offset === 0;
    el.next.disabled = offset + PAGE_SIZE >= list.length;
    el['tab-cases'].className = mode === 'cases' ? 'active' : '';
    el['tab-events'].className = mode === 'events' ? 'active' : '';
  }
  function showData(data) {
    plaintext = data;
    el['case-count'].textContent = 'Дел: '+data.cases.length;
    el['event-count'].textContent = 'Событий: '+data.events.length;
    el.viewer.hidden = false;
    el.setup.hidden = true;
    el['unlock-zone'].hidden = true;
    mode = 'cases'; offset = 0; el.query.value = '';
    render();
  }
  async function handleImport() {
    if (busy) return;
    const file = el['vault-file'].files?.[0];
    let phrase = el['import-pass'].value;
    if (!file || file.size > MAX_FILE_BYTES || file.size < 100) return message('Выбери небольшой зашифрованный файл .json из «Файлов».','error');
    if (phrase.length < 16 || phrase.length > 256) return message('Введи полную парольную фразу (не меньше 16 символов).','error');
    busy=true;el.import.disabled=true;
    try {
      const x=validateEnvelope(JSON.parse(await file.text()));
      await unlockEnvelope(x,phrase);
      phrase=''; el['import-pass'].value='';
      await writeSaved(x);
      envelope=x;resetViewer();showStored();
      el['vault-file'].value='';
      message('Зашифрованная копия проверена и сохранена. Теперь можно отключить интернет и разблокировать её.','success');
    } catch(e) { message(errorText(e.code || 'STORAGE'),'error'); }
    finally { phrase=''; el['import-pass'].value='';busy=false;el.import.disabled=false; }
  }
  async function handleUnlock() {
    if(busy||!envelope)return;
    let phrase=el['unlock-pass'].value;
    if(phrase.length<16)return message('Парольная фраза должна содержать не менее 16 символов.','error');
    busy=true;el.unlock.disabled=true;
    const current = generation;
    try { const data=await unlockEnvelope(envelope,phrase);phrase='';el['unlock-pass'].value='';
      if (current === generation && !document.hidden) { showData(data);message('Офлайн-копия открыта только в памяти устройства. Изменения отключены.','success'); }
    }
    catch(e) { message(errorText(e.code || 'BAD_PASSWORD_OR_FILE'),'error'); }
    finally {phrase='';el['unlock-pass'].value='';busy=false;el.unlock.disabled=false;}
  }
  el.import.addEventListener('click',handleImport);
  el.unlock.addEventListener('click',handleUnlock);
  el.delete.addEventListener('click',async () => {
    if(busy||!envelope)return;
    if(!window.confirm('Удалить зашифрованную копию с этого устройства? Файл в «Файлах» останется.'))return;
    busy=true;
    try{await deleteSaved();envelope=null;resetViewer();showStored();message('Локальная копия удалена.','success');}
    catch(_){message('Не удалось удалить копию из хранилища устройства.','error');}
    finally{busy=false;}
  });
  el.lock.addEventListener('click',()=>{lockScreen();message('Экран заблокирован.','');});
  el['tab-cases'].addEventListener('click',()=>{mode='cases';offset=0;render();});
  el['tab-events'].addEventListener('click',()=>{mode='events';offset=0;render();});
  el.query.addEventListener('input',()=>{offset=0;render();});
  el.prev.addEventListener('click',()=>{offset=Math.max(0,offset-PAGE_SIZE);render();});
  el.next.addEventListener('click',()=>{offset+=PAGE_SIZE;render();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)lockScreen();});
  window.addEventListener('pagehide',lockScreen);
  window.addEventListener('pageshow',e=>{if(e.persisted)lockScreen();});
  (async function init(){
    if(!readyCrypto()) {message('Для сейфа нужен HTTPS, WebCrypto и IndexedDB. На этом устройстве недоступна защита.','error');return;}
    try{envelope=await readSaved();if(envelope)validateEnvelope(envelope);showStored();message(envelope?'Копия найдена, можно открыть её без сети.':'Ожидается зашифрованный файл из тестового Web App.','');}
    catch(_){message('Не удалось проверить локальное зашифрованное хранилище.','error');}
    if('serviceWorker' in navigator){
      try{await navigator.serviceWorker.register('./sw.js',{scope:'./'});await navigator.serviceWorker.ready;
        el['sw-status'].textContent='Статические файлы приложения сохранены для офлайн-запуска. Проверить нужно в авиарежиме.';
      }catch(_){el['sw-status'].textContent='Не удалось подготовить офлайн-запуск: проверь интернет и обнови страницу.';}
    } else {el['sw-status'].textContent='На этом браузере офлайн-запуск не поддерживается.';}
  })();
})();

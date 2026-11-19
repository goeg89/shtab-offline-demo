/*
 * Штаб Офлайн SYNC 0.2-pre. Изолированная локальная база тестового сервера.
 * Рабочая CRM НЕ подключается.
 */
(function () {
  'use strict';
  const DB_NAME = 'moi-dela-offline-test-sync-v2';
  const DB_VERSION = 1;
  let opened = null;

  const dateKey = (offset = 0) => {
    const now = new Date(); now.setHours(12, 0, 0, 0); now.setDate(now.getDate() + offset);
    return [now.getFullYear(), String(now.getMonth()+1).padStart(2,'0'), String(now.getDate()).padStart(2,'0')].join('-');
  };
  const uid = prefix => prefix + '-' + (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  function openDb() {
    if (opened) return opened;
    opened = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const [name, options] of [
          ['cases', {keyPath:'id'}], ['events', {keyPath:'id'}],
          ['queue', {keyPath:'opId'}], ['meta', {keyPath:'key'}]
        ]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options);
      };
      request.onsuccess = () => {request.result.onversionchange = () => request.result.close(); resolve(request.result);};
      request.onerror = () => {opened = null; reject(request.error || new Error('Не удалось открыть локальную базу'));};
    });
    return opened;
  }
  function transaction(stores, mode, action) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let value, failure;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(failure || tx.error || new Error('Операция с локальной базой отменена'));
      tx.onerror = () => { /* Ошибку обрабатывает onabort */ };
      const done = result => {value = result;};
      const fail = error => {failure = error instanceof Error ? error : new Error(String(error)); try {tx.abort();} catch (_) {} };
      try {action(tx, done, fail);} catch (error) {fail(error);}
    }));
  }
  const exampleCases = () => [
    {id:'CASE-DEMO-001',client:'Иванов И.И. (пример)',task:'',plan:'',legal:dateKey(10),legalBasis:'Определение суда (пример)',completed:false,localVersion:1},
    {id:'CASE-DEMO-002',client:'Петрова А.А. (пример)',task:'Подготовить письменные пояснения',plan:dateKey(0),legal:'',legalBasis:'',completed:false,localVersion:1},
    {id:'CASE-DEMO-003',client:'ООО «Учебное дело»',task:'Направить документы в суд',plan:dateKey(12),legal:dateKey(-1),legalBasis:'Условный срок подачи заявления',completed:false,localVersion:1},
    {id:'CASE-DEMO-004',client:'Сидоров С.С. (пример)',task:'Проверить документы и направить запрос',plan:dateKey(-2),legal:dateKey(30),legalBasis:'',completed:false,localVersion:1},
    {id:'CASE-DEMO-005',client:'Кузнецова Н.Н. (пример)',task:'',plan:'',legal:'',legalBasis:'',completed:false,localVersion:1}
  ];
  const exampleEvents = () => [
    {id:'EVT-DEMO-001',caseId:'CASE-DEMO-001',date:dateKey(0),time:'10:30',place:'Районный суд (пример)',result:'',done:false,localVersion:1},
    {id:'EVT-DEMO-002',caseId:'CASE-DEMO-004',date:dateKey(3),time:'14:00',place:'Арбитражный суд (пример)',result:'',done:false,localVersion:1},
    {id:'EVT-DEMO-003',caseId:'CASE-DEMO-003',date:dateKey(7),time:'11:15',place:'Видеосвязь (пример)',result:'',done:false,localVersion:1}
  ];
  async function ensureDemo() {
    return transaction(['cases','events','meta'],'readwrite',(tx,done,fail)=>{
      const meta=tx.objectStore('meta');
      meta.get('seeded').onsuccess = function () {
        if (this.result?.value) {done(false);return;}
        for (const c of exampleCases()) tx.objectStore('cases').put(c);
        for (const e of exampleEvents()) tx.objectStore('events').put(e);
        meta.put({key:'seeded',value:true});
        done(true);
      };
    });
  }
  function readAll() {
    return transaction(['cases','events','queue','meta'],'readonly',(tx,done,fail)=>{
      const data={cases:[],events:[],queue:[],focus:[],source:'demo'};
      for(const name of ['cases','events','queue']) {
        tx.objectStore(name).getAll().onsuccess = function(){data[name] = this.result || [];};
      }
      tx.objectStore('meta').get('focus:'+dateKey()).onsuccess = function(){data.focus = this.result?.value || [];};
      tx.objectStore('meta').get('source').onsuccess = function(){data.source = this.result?.value || 'demo';};
      done(data);
    });
  }
  function toggleFocus(caseId, selected) {
    return transaction(['meta'],'readwrite',(tx,done,fail)=>{
      const store=tx.objectStore('meta'), key='focus:'+dateKey();
      store.get(key).onsuccess = function(){
        const list=Array.isArray(this.result?.value) ? this.result.value : [];
        const updated=list.filter(x=>x!==caseId);
        if(selected) updated.push(caseId);
        store.put({key,value:updated});done(updated);
      };
    });
  }

  /** Атомарное сохранение: изменение дела, результата и нового события вместе с одной операцией очереди. */
  function saveWork(input) {
    const opId=uid('OP'),now=new Date().toISOString();
    return transaction(['cases','events','queue'],'readwrite',(tx,done,fail)=>{
      const cs=tx.objectStore('cases'),es=tx.objectStore('events'),qs=tx.objectStore('queue');
      cs.get(input.caseId).onsuccess = function(){
        const before=this.result;
        if(!before){fail('Дело не найдено. Перезагрузите приложение.');return;}
        if(before.localVersion!==input.expectedVersion){fail('Карточка изменилась в другой вкладке. Обновите данные и повторите действие.');return;}
        const patch=input.patch || {},hasPatch=Object.keys(patch).length>0;
        const finish=event=>{
          const hasEvent=!!event;
          if(!hasPatch&&!hasEvent){fail('Нет изменений для сохранения.');return;}
          if(hasPatch)cs.put({...before,...patch,localVersion:before.localVersion+1,updatedAt:now});
          if(hasEvent) {
            es.put({...event,done:true,result:input.eventResult,localVersion:event.localVersion+1,completedAt:now});
            if(input.nextEvent){
              es.put({id:input.nextEvent.id,caseId:input.caseId,date:input.nextEvent.date,time:input.nextEvent.time,
                place:input.nextEvent.place,result:'',done:false,localVersion:1,createdAt:now});
            }
          }
          qs.add({opId,caseId:input.caseId,client:before.client,kind:hasEvent?'hearing_and_case':'case_update',
            createdAt:now,status:'pending',baseVersion:before.localVersion,patch,
            event:hasEvent?{eventId:event.id,expectedEventVersion:event.localVersion,result:input.eventResult,
              nextEvent:input.nextEvent||null}:null,
            note:input.note||''});
          done({opId,queued:true});
        };
        if(input.eventId) {
          es.get(input.eventId).onsuccess=function(){
            const event=this.result;
            if(!event||event.caseId!==input.caseId||event.done){fail('Событие уже изменено или не найдено.');return;}
            if(event.localVersion!==input.expectedEventVersion){fail('Событие изменилось в другой вкладке. Обновите данные.');return;}
            finish(event);
          };
        } else finish(null);
      };
    });
  }

  /** Заменять серверным снимком можно только без неотправленной очереди. */
  function normalizeDemoDate(value) {
  if (typeof value !== 'string' || value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const m = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) (\d{4}) \d{2}:\d{2}:\d{2} GMT[+-]\d{4}\b/.exec(value);
  if (!m) return value;
  const month = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12}[m[1]];
  const day = Number(m[2]), year = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return value;
  return `${m[3]}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}
  function normalizeDemoTime(value) {
  if (typeof value !== 'string' || value === '' || /^\d{2}:\d{2}$/.test(value)) return value;
  const m = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{4} (\d{2}):(\d{2}):\d{2} GMT[+-]\d{4}\b/.exec(value);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return value;
  return `${m[1]}:${m[2]}`;
}

  function replaceFromServer(payload) {
    if(!payload || payload.protocol!=='pwa-sync-test-0.2' || !Array.isArray(payload.cases) || !Array.isArray(payload.events))
      return Promise.reject(new Error('Сервер вернул неподдерживаемые данные'));
    if(payload.cases.length>500 || payload.events.length>2000) return Promise.reject(new Error('Превышен тестовый объём'));
    // Нормализуем строковое представление дат и времени, сформированное Google Sheets / Apps Script.
    const normalizedCases=payload.cases.map(c=>c?{...c,plan:normalizeDemoDate(c.plan),legal:normalizeDemoDate(c.legal)}:c);
    const normalizedEvents=payload.events.map(e=>e?{...e,date:normalizeDemoDate(e.date),time:normalizeDemoTime(e.time)}:e);
    for(const c of normalizedCases)if(!c||!/^CASE-DEMO-\d{3}$/.test(c.id)||!Number.isSafeInteger(c.localVersion)||c.localVersion<1||!validDate(c.plan)||!validDate(c.legal))
      return Promise.reject(new Error('Неверное дело или дата из тестовой базы'));
    for(const e of normalizedEvents)if(!e||!/^EVT-(DEMO-\d{3}|LOCAL-[a-zA-Z0-9-]{8,80})$/.test(e.id)||!Number.isSafeInteger(e.localVersion)||!validDate(e.date)||!isStr(e.time,5))
      return Promise.reject(new Error('Неверное событие или время из тестовой базы'));
    return transaction(['cases','events','queue','meta'],'readwrite',(tx,done,fail)=>{
      tx.objectStore('queue').getAll().onsuccess=function(){
        if(this.result?.length) {fail('Очередь не пуста. Сначала синхронизируйте или вручную разрешите конфликты.');return;}
        for(const name of ['cases','events'])tx.objectStore(name).clear();
        normalizedCases.forEach(c=>tx.objectStore('cases').put(c));
        normalizedEvents.forEach(e=>tx.objectStore('events').put(e));
        tx.objectStore('meta').put({key:'source',value:'test-server-v02'});
        tx.objectStore('meta').put({key:'lastPull',value:payload.pulledAt||new Date().toISOString()});
        tx.objectStore('meta').put({key:'seeded',value:true});
        done(true);
      };
    });
  }
  function markSynced(opId) {return transaction(['queue'],'readwrite',(tx,done)=>{
    tx.objectStore('queue').delete(opId);done(true);
  });}
  function markConflict(opId,remote) {return transaction(['queue'],'readwrite',(tx,done,fail)=>{
    const store=tx.objectStore('queue');store.get(opId).onsuccess=function(){
      const item=this.result;if(!item){fail('Операция не найдена');return;}
      store.put({...item,status:'conflict',conflictDetail:remote});done(true);
    };
  });}
  function backup() {
    return readAll().then(data=>({format:'shtab-offline-demo-backup',schema:1,createdAt:new Date().toISOString(),
      cases:data.cases,events:data.events,queue:data.queue,focus:data.focus,focusDate:dateKey(),source:data.source,
      note:'Только вымышленные данные тестового сервера, не рабочая CRM'}));
  }
  const isStr=(x,max=2500)=>typeof x==='string' && x.length<=max;
  const validDate=x=>x==='' || /^\d{4}-\d{2}-\d{2}$/.test(x);
  function validateBackup(doc) {
    if(!doc||doc.format!=='shtab-offline-demo-backup'||doc.schema!==1) throw new Error('Неизвестный формат резервной копии');
    if(!Array.isArray(doc.cases)||!Array.isArray(doc.events)||!Array.isArray(doc.queue)||doc.cases.length>1000||doc.events.length>5000||doc.queue.length>20000) throw new Error('Неверное содержимое или размер копии');
    const ids=new Set(),events=new Set(),ops=new Set();
    const cases=doc.cases.map(c=>{
      const plan=c?normalizeDemoDate(c.plan):null,legal=c?normalizeDemoDate(c.legal):null;
      if(!c||!isStr(c.id,100)||!isStr(c.client,300)||!isStr(c.task,5000)||!validDate(plan)||!validDate(legal)||!isStr(c.legalBasis,2000)||!Number.isSafeInteger(c.localVersion))throw new Error('Повреждена запись дела');
      if(ids.has(c.id))throw new Error('Повтор ID дела');ids.add(c.id);
      return {id:c.id,client:c.client,task:c.task,plan,legal,legalBasis:c.legalBasis,completed:Boolean(c.completed),localVersion:c.localVersion,updatedAt:String(c.updatedAt||'')};
    });
    const eventRows=doc.events.map(e=>{
      const date=e?normalizeDemoDate(e.date):null,time=e?normalizeDemoTime(e.time):null;
      if(!e||!isStr(e.id,100)||!isStr(e.caseId,100)||!validDate(date)||!isStr(time,5)||!isStr(e.place,300)||!isStr(e.result,5000)||!Number.isSafeInteger(e.localVersion))throw new Error('Повреждена запись события');
      if(events.has(e.id)||!ids.has(e.caseId))throw new Error('Событие с неправильным CASE ID или дубликат');events.add(e.id);
      return {id:e.id,caseId:e.caseId,date,time,place:e.place,result:e.result,done:Boolean(e.done),localVersion:e.localVersion,createdAt:String(e.createdAt||''),completedAt:String(e.completedAt||'')};
    });
    const queue=doc.queue.map(q=>{
      if(!q||!isStr(q.opId,100)||!isStr(q.caseId,100)||!ids.has(q.caseId)||!['pending','conflict'].includes(q.status)||!['case_update','hearing_and_case'].includes(q.kind)||typeof q.patch!=='object'||q.patch===null||Array.isArray(q.patch))throw new Error('Повреждена очередь действий');
      if(ops.has(q.opId))throw new Error('Повтор ID операции');ops.add(q.opId);
      const patch={};for(const key of ['task','plan','legal','legalBasis'])if(Object.prototype.hasOwnProperty.call(q.patch,key)){
        const v=q.patch[key];if(!isStr(v,5000)||(key==='plan'||key==='legal')&&!validDate(v))throw new Error('Недопустимое поле очереди');patch[key]=v;
      }
      const restored={opId:q.opId,caseId:q.caseId,client:String(q.client||''),kind:q.kind,createdAt:String(q.createdAt||''),status:q.status,baseVersion:Number(q.baseVersion||0),patch,event:q.event||null,note:String(q.note||'')};
      // Для pending-операции не добавляем новое поле: повтор того же opId должен совпадать с серверным JSON.
      if(Object.prototype.hasOwnProperty.call(q,'conflictDetail'))restored.conflictDetail=q.conflictDetail||null;
      return restored;
    });
    return {cases,events:eventRows,queue,focus:Array.isArray(doc.focus)?doc.focus.filter(id=>ids.has(id)):[],focusDate:typeof doc.focusDate==='string'?doc.focusDate:'',source:doc.source==='test-server-v02'?'test-server-v02':'demo'};
  }
  async function restore(doc) {
    const data=validateBackup(doc);
    return transaction(['cases','events','queue','meta'],'readwrite',(tx,done)=>{
      for(const name of ['cases','events','queue','meta'])tx.objectStore(name).clear();
      for(const c of data.cases)tx.objectStore('cases').put(c);
      for(const e of data.events)tx.objectStore('events').put(e);
      for(const q of data.queue)tx.objectStore('queue').put(q);
      tx.objectStore('meta').put({key:'seeded',value:true});
      tx.objectStore('meta').put({key:'source',value:data.source});
      if(data.focusDate===dateKey())tx.objectStore('meta').put({key:'focus:'+dateKey(),value:data.focus});
      done(true);
    });
  }
  async function resetDemo() {
    await transaction(['cases','events','queue','meta'],'readwrite',(tx,done)=>{
      for(const name of ['cases','events','queue','meta'])tx.objectStore(name).clear();
      done(true);
    });
    await ensureDemo();
  }
  window.OfflineDb=Object.freeze({openDb,ensureDemo,readAll,toggleFocus,saveWork,replaceFromServer,markSynced,markConflict,backup,restore,resetDemo,uid,dateKey});
}());
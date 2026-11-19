/* Штаб Офлайн 0.2-pre. Отдельный HMAC тестовый сервер и локальная очередь. */
(function () {
'use strict';
const db=window.OfflineDb;
const $=id=>document.getElementById(id);
const state={data:{cases:[],events:[],queue:[],focus:[]},tab:'focus',selectedCase:null,toastTimer:null};
function node(tag,className,text){const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=String(text);return n;}
function add(parent,...children){for(const child of children)if(child)parent.appendChild(child);return parent;}
function dateLabel(value){if(!value)return 'не назначен';const [y,m,d]=value.split('-');return `${d}.${m}.${y}`;}
function dayOffset(key){if(!key)return null;const today=db.dateKey();return Math.round((Date.parse(key+'T12:00:00Z')-Date.parse(today+'T12:00:00Z'))/86400000);}
function upcoming(caseId){return state.data.events.filter(e=>e.caseId===caseId&&!e.done&&e.date>=db.dateKey()).sort((a,b)=>a.date.localeCompare(b.date)||a.time.localeCompare(b.time));}
function priority(c){
 const ev=upcoming(c.id)[0]||null,ld=dayOffset(c.legal),pd=dayOffset(c.plan),ed=ev?dayOffset(ev.date):null;
 const auto=ld!==null&&ld<=0||pd===0||ed===0;
 let group='scheduled',rank=7,reason='В работе',p='P3';
 if(ld!==null&&ld<=0){group='legalCritical';rank=0;p='P1';reason=ld<0?'Юридический срок просрочен':'Юридический срок сегодня';}
 else if(ld!==null&&ld<=14){group='legalSoon';rank=ld<=3?2:4;p=ld<=3?'P2':'P3';reason='Приближается юридический срок';}
 else if(pd!==null&&pd<0){group='planOverdue';rank=1;p='P1';reason='Плановая задача просрочена';}
 else if(ed!==null&&ed<=7){group='hearingSoon';rank=ed===0?1:3;p=ed===0?'P1':ed<=3?'P2':'P3';reason=ed===0?'Заседание сегодня':'Ближайшее заседание';}
 else if(pd!==null&&pd<=3){group='planSoon';rank=pd===0?1:3;p=pd===0?'P1':'P2';reason='Ближайшая задача';}
 else if(!c.task&&!ev&&!c.legal&&!c.plan){group='noNext';rank=8;reason='Не определён следующий шаг';}
 else if(c.task&&!c.plan&&!ev&&!c.legal){group='noNext';rank=8;reason='У задачи нет плановой даты';}
 if(auto)p='P1';
 return {c,ev,ld,pd,ed,auto,group,rank,p,reason};
}
function sortedCases(){return state.data.cases.filter(c=>!c.completed).map(priority).sort((a,b)=>a.rank-b.rank||a.c.client.localeCompare(b.c.client,'ru'));}
function chip(text,tone){return node('span','date-chip '+(tone||''),text);}
function renderDates(target,x){
 const {c,ev,ld,pd,ed}=x;const wrap=node('div','case-dates');
 if(ev)wrap.appendChild(chip('С/З '+dateLabel(ev.date)+(ev.time?' · '+ev.time:''),ed===0?'today':'event'));
 if(c.plan)wrap.appendChild(chip('ПЛАН '+dateLabel(c.plan)+(pd<0?' · просрочен':pd===0?' · сегодня':''),pd<0?'plan-overdue':pd===0?'today':''));
 if(c.legal)wrap.appendChild(chip('ЮР '+dateLabel(c.legal)+(ld<0?' · просрочен':ld===0?' · сегодня':''),ld<=0?'legal-overdue':ld<=14?'legal-watch':''));
 if(wrap.children.length)target.appendChild(wrap);
}
function action(text,style,handler){const b=node('button','button '+style,text);b.type='button';b.addEventListener('click',handler);return b;}
function card(x,allowFocus=true){
 const c=x.c,item=node('article','case-row'),details=node('div','case-info');
 add(details,node('div','case-name',c.client),node('div','case-task',c.task||(x.ed===0?'Заседание / встреча сегодня':x.reason)));renderDates(details,x);
 const actions=node('div','case-actions');
 if(allowFocus){const inFocus=x.auto||state.data.focus.includes(c.id);
 if(x.auto)actions.appendChild(node('span','button selected','Обязательно сегодня'));
 else actions.appendChild(action(inFocus?'Убрать из фокуса':'+ В фокус',inFocus?'selected':'secondary',async()=>{
   try{await db.toggleFocus(c.id,!inFocus);await refresh();showToast(inFocus?'Убрано из моего выбора':'Добавлено в мой выбор');}
   catch(err){showToast(err.message,true);}
 }));}
 actions.appendChild(action('Открыть дело','primary',()=>openEditor(c.id)));
 add(item,details,actions);return item;
}
function bucket(title,items,allowFocus=true){const wrap=node('section','bucket');const head=node('div','bucket-head');add(head,node('span','',title),node('span','count',items.length));wrap.appendChild(head);
 if(!items.length)wrap.appendChild(node('div','empty','Нет дел в этой группе'));
 else items.forEach(x=>wrap.appendChild(card(x,allowFocus)));
 return wrap;
}
function renderFocus(){
 const items=sortedCases(),must=items.filter(x=>x.auto),mine=items.filter(x=>!x.auto&&state.data.focus.includes(x.c.id)),root=$('focus-list');root.replaceChildren(bucket('Обязательно сегодня',must,false),bucket('Мой выбор',mine,true));
 const att=$('attention-list');att.replaceChildren();
 const groups=[['legalCritical','Юридические сроки сегодня / просрочены'],['legalSoon','Ближайшие юридические сроки'],['planOverdue','Просроченные плановые задачи'],['hearingSoon','Ближайшие заседания'],['planSoon','Плановые задачи на 1–3 дня'],['noNext','Без следующего шага'],['scheduled','Остальные дела']];
 for(const [key,title] of groups){const subset=items.filter(x=>x.group===key);if(subset.length)att.appendChild(bucket(title,subset,true));}
 const search=($('case-search').value||'').trim().toLocaleLowerCase('ru');
 const filtered=items.filter(x=>!search||(x.c.client+' '+x.c.task).toLocaleLowerCase('ru').includes(search));
 $('cases-list').replaceChildren(bucket(search?'Результаты поиска':'Активные дела',filtered,true));
 $('stat-focus').textContent=String(must.length+mine.length);
}
function renderQueue(){const root=$('queue-list');root.replaceChildren();const list=[...state.data.queue].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
 if(!list.length){root.appendChild(node('div','bucket empty','Локальных изменений пока нет. Откройте дело и сохраните результат.'));return;}
 for(const op of list){const box=node('article','queue-card');const head=node('div','queue-card-head');add(head,node('strong','',op.client||op.caseId),node('small','',new Date(op.createdAt).toLocaleString('ru-RU')));box.appendChild(head);
 const label=op.kind==='hearing_and_case'?'Результат заседания и обновление дела':'Изменение задачи / сроков';box.appendChild(node('p','',label));
 if(op.event?.result)box.appendChild(node('p','', 'Результат: '+op.event.result));
 if(op.event?.nextEvent)box.appendChild(node('p','', 'Следующее событие: '+dateLabel(op.event.nextEvent.date)));
 const changes=Object.keys(op.patch||{});if(changes.length)box.appendChild(node('p','', 'Изменены поля: '+changes.map(k=>({task:'задача',plan:'плановый срок',legal:'юридический срок',legalBasis:'основание'}[k]||k)).join(', ')));
 if(op.note)box.appendChild(node('p','', 'Комментарий: '+op.note));
 if(op.status==='conflict'){
   box.appendChild(chip('Конфликт — ручная проверка','legal-overdue'));
   box.appendChild(node('p','conflict-message',(op.conflictDetail?.reason||'Сервер отклонил изменение')+'. Локальная правка сохранена. Экспортируйте резервную копию.'));
 }else box.appendChild(chip('Ожидает подтверждения сервера','plan-overdue'));
 root.appendChild(box);
 }
}
function renderStatus(){const online=navigator.onLine;$('network-status').textContent=online?'Сеть предположительно есть':'Нет интернета';$('network-status').classList.toggle('offline',!online);
 const n=state.data.queue.length;$('queue-chip').textContent=n+' '+plural(n,'действие','действия','действий')+' в очереди';$('stat-queue').textContent=String(n);
 $('stat-events').textContent=String(state.data.events.filter(e=>!e.done&&e.date>=db.dateKey()).length);
}
function plural(num,single,few,many){const v=Math.abs(num)%100,t=v%10;return v>=11&&v<=19?many:t===1?single:t>=2&&t<=4?few:many;}
async function refresh(){state.data=await db.readAll();renderStatus();renderFocus();renderQueue();await storageInfo();}
function tab(name){state.tab=name;for(const b of document.querySelectorAll('.tab')){const current=b.dataset.tab===name;b.classList.toggle('active',current);b.setAttribute('aria-selected',current?'true':'false');}
 for(const s of document.querySelectorAll('.screen'))s.classList.toggle('hidden',s.id!=='screen-'+name);}
function showToast(message,error=false){const elem=$('toast');elem.textContent=message;elem.classList.toggle('error',error);elem.classList.remove('hidden');clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>elem.classList.add('hidden'),3700);}
function setFormError(message){$('form-error').textContent=message;$('form-error').classList.toggle('hidden',!message);}
function openEditor(caseId){const c=state.data.cases.find(x=>x.id===caseId);if(!c)return;state.selectedCase=caseId;$('dialog-title').textContent=c.client;
 $('edit-task').value=c.task||'';$('edit-plan').value=c.plan||'';$('edit-legal').value=c.legal||'';$('edit-legal-basis').value=c.legalBasis||'';$('edit-note').value='';
 $('edit-event-result').value='';$('edit-next-date').value='';$('edit-next-time').value='';$('edit-next-place').value='';
 const list=upcoming(caseId),sel=$('edit-event-select');sel.replaceChildren();if(list.length){for(const e of list){const opt=node('option','',dateLabel(e.date)+(e.time?' в '+e.time:'')+(e.place?' · '+e.place:''));opt.value=e.id;sel.appendChild(opt);}}
 else{const opt=node('option','','Нет предстоящих событий');opt.value='';sel.appendChild(opt);}
 $('event-edit-fields').classList.toggle('hidden',!list.length);$('event-note').textContent=list.length?'Впишите результат, если заседание состоялось.':'Сначала назначьте событие через текущую рабочую CRM. В этом прототипе создание нового события доступно после результата существующего.';
 setFormError('');$('edit-dialog').showModal();
}
function closeEditor(){$('edit-dialog').close();state.selectedCase=null;}
async function saveEditor(e){e.preventDefault();const caseId=state.selectedCase,c=state.data.cases.find(x=>x.id===caseId);if(!c)return;
 const read=id=>$(id).value.trim();const values={task:read('edit-task'),plan:read('edit-plan'),legal:read('edit-legal'),legalBasis:read('edit-legal-basis')};
 if(values.legalBasis&&!values.legal){setFormError('Основание юридического срока нельзя оставить без даты.');return;}
 const patch={};for(const key of Object.keys(values))if(values[key]!==String(c[key]||''))patch[key]=values[key];
 const eventResult=read('edit-event-result'),nextDate=read('edit-next-date'),nextTime=read('edit-next-time'),nextPlace=read('edit-next-place');
 if((nextDate||nextTime||nextPlace)&&!eventResult){setFormError('Сначала укажите результат текущего заседания.');return;}
 if((nextTime||nextPlace)&&!nextDate){setFormError('Для следующего заседания необходимо указать дату.');return;}
 const id=read('edit-event-select'),event=state.data.events.find(x=>x.id===id&&x.caseId===caseId&&!x.done);
 if(eventResult&&!event){setFormError('Выберите действующее заседание.');return;}
 if(!Object.keys(patch).length&&!eventResult){setFormError('Нет изменений: измените задачу или внесите результат заседания.');return;}
 const input={caseId,expectedVersion:c.localVersion,patch,note:read('edit-note'),eventId:eventResult?event.id:'',expectedEventVersion:eventResult?event.localVersion:0,eventResult,
 nextEvent:nextDate?{id:db.uid('EVT-LOCAL'),date:nextDate,time:nextTime,place:nextPlace}:null};
 $('save-dialog').disabled=true;setFormError('');
 try{await db.saveWork(input);closeEditor();await refresh();showToast('Сохранено на устройстве. Ожидает синхронизации.');
   if(navigator.onLine&&db&&state.data.source==='test-server-v02'&&window.DemoSync.config().url)
     setTimeout(()=>runSync(false),100);}
 catch(error){setFormError('Не удалось сохранить: '+error.message);await refresh();}
 finally{$('save-dialog').disabled=false;}
}
async function exportBackup(){try{const backup=await db.backup();const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='shtab-offline-demo-backup-'+db.dateKey()+'.json';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);showToast('Резервная копия создана');}catch(e){showToast('Ошибка экспорта: '+e.message,true);}}
async function importBackup(event){const file=event.target.files?.[0];event.target.value='';if(!file)return;
 if(file.size>8*1024*1024){showToast('Слишком большой архив',true);return;}
 if(!confirm('Восстановление заменит ВСЕ локальные демонстрационные дела и очередь. Продолжить?'))return;
 try{const data=JSON.parse(await file.text());await db.restore(data);await refresh();showToast('Копия восстановлена');}catch(e){showToast('Ошибка импорта: '+e.message,true);}}
async function resetDemo(){if(!confirm('Удалить все локальные изменения и заново создать вымышленные дела?'))return;
 if(!confirm('Это удалит НЕСИНХРОНИЗИРОВАННУЮ очередь. Подтвердить сброс?'))return;
 try{await db.resetDemo();await refresh();showToast('Демонстрационная база сброшена');}catch(e){showToast('Ошибка сброса: '+e.message,true);}}
async function storageInfo(){const n=$('storage-note');if(!navigator.storage){n.textContent='Информация о локальном хранилище недоступна.';return;}
 try{const est=await navigator.storage.estimate(),persisted=navigator.storage.persisted?await navigator.storage.persisted():false;
 n.textContent='Локальная база: '+Math.round((est.usage||0)/1024)+' КБ использовано. '+(persisted?'Браузер разрешил постоянное хранение.':'Хранение может быть очищено браузером; регулярно сохраняйте резервную копию.');}
 catch(_){n.textContent='Не удалось проверить хранилище. Сохраняйте резервные копии.';}}
async function requestPersist(){try{if(!navigator.storage?.persist)throw Error('Браузер не поддерживает эту функцию');const ok=await navigator.storage.persist();await storageInfo();showToast(ok?'Постоянное хранение разрешено':'Браузер отказал: сохраняйте резервные копии',!ok);}catch(e){showToast(e.message,true);}}

function syncMessage(t){$('sync-feedback').textContent=t;}
function readConnection(){const conf=window.DemoSync.config();
 $('sync-url').value=conf.url||'';$('sync-secret').value=conf.secret||'';
 syncMessage(conf.url?'Тестовое подключение сохранено на этом устройстве.':'Сначала откройте «Подключение» в инструкции и укажите /exec + тестовый ключ.');
}
async function connectServer(){
 if(!navigator.onLine){showToast('Включите интернет для первого подключения',true);return;}
 try{
   window.DemoSync.saveConfig($('sync-url').value,$('sync-secret').value);
   syncMessage('Проверяю подписанное соединение и загружаю вымышленные дела…');
   const result=await window.DemoSync.connect(db);
   await refresh();syncMessage('Тестовая база подключена: '+result.cases+' дел, '+result.events+' событий.');
   showToast('Загружены только вымышленные дела');
 }catch(e){syncMessage('Ошибка подключения: '+e.message);showToast(e.message,true);}
}
async function runSync(manual=true){
 if(!window.DemoSync.config().url){if(manual)showToast('Сначала подключите тестовый сервер',true);return;}
 if(!navigator.onLine){if(manual)showToast('Нет сети. Очередь сохранена на устройстве');return;}
 if(window.DemoSync.busy)return;
 try{
   syncMessage('Проверяю локальную очередь…');
   const result=await window.DemoSync.push(db,syncMessage);
   await refresh();
   syncMessage('Подтверждено записей: '+result.applied+'. Конфликтов: '+result.conflicts+'. '+new Date().toLocaleTimeString('ru-RU'));
   if(result.conflicts)showToast('Обнаружен конфликт. Проверьте очередь и скачайте резервную копию.',true);
   else if(result.applied||manual)showToast('Тестовая таблица подтвердила '+result.applied+' изменений');
 }catch(e){await refresh();syncMessage('Синхронизация остановлена: '+e.message);
   if(manual)showToast(e.message,true);
 }
}
async function pullServer(){
 if(!navigator.onLine){showToast('Нет сети',true);return;}
 try{
   syncMessage('Проверяю пустую очередь и загружаю снимок…');
   const result=await window.DemoSync.pull(db);
   await refresh();syncMessage('Обновлено с тестового сервера: '+result.cases+' дел, '+result.events+' событий.');
   showToast('Снимок загружен');
 }catch(e){syncMessage('Ошибка загрузки: '+e.message);showToast(e.message,true);}
}
function forgetConnection(){
 if(!confirm('Забыть только ключ и URL? Очередь и дела останутся на устройстве.'))return;
 window.DemoSync.clearConfig();$('sync-url').value='';$('sync-secret').value='';
 syncMessage('Ключ и URL забыты. Данные и очередь оставлены на устройстве.');
}
function bind(){for(const btn of document.querySelectorAll('.tab'))btn.addEventListener('click',()=>tab(btn.dataset.tab));
 $('case-search').addEventListener('input',renderFocus);$('export-top').addEventListener('click',exportBackup);$('export-queue').addEventListener('click',exportBackup);
 $('request-persist').addEventListener('click',requestPersist);$('reset-demo').addEventListener('click',resetDemo);$('import-file').addEventListener('change',importBackup);
 $('close-dialog').addEventListener('click',closeEditor);$('cancel-dialog').addEventListener('click',closeEditor);$('edit-form').addEventListener('submit',saveEditor);
 $('edit-dialog').addEventListener('click',event=>{if(event.target===$('edit-dialog'))closeEditor();});
 $('sync-connect').addEventListener('click',connectServer);
 $('sync-push').addEventListener('click',()=>runSync(true));
 $('sync-pull').addEventListener('click',pullServer);
 $('sync-disconnect').addEventListener('click',forgetConnection);
 window.addEventListener('online',()=>{renderStatus();runSync(false);});
 window.addEventListener('offline',renderStatus);
}
async function main(){try{bind();if(!('indexedDB' in window))throw Error('Этот браузер не поддерживает IndexedDB.');await db.ensureDemo();readConnection();await refresh();
 if('serviceWorker' in navigator&&location.protocol!=='file:'){
   try{await navigator.serviceWorker.register('./sw.js',{scope:'./'});}catch(error){showToast('Автономная загрузка недоступна: '+error.message,true);}
 }
 if(navigator.onLine&&window.DemoSync.config().url&&state.data.source==='test-server-v02')setTimeout(()=>runSync(false),1400);
}catch(e){const box=$('focus-list');box.replaceChildren(node('div','form-error','Ошибка запуска: '+e.message));showToast(e.message,true);}}
window.addEventListener('DOMContentLoaded',main);
}());
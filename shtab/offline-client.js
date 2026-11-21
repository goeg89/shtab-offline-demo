(function(){
  'use strict';
  const endpoint='https://script.google.com/macros/s/AKfycbzrOJxhfdcZqYDf-Y0fgVkEDOi18WirThrVWApQdXJ5dPYnIuDU2rtQNpu4QknJAeiiDg/exec';
  const transport=HQOfflineTransport.createTransport(window,endpoint);
  let state={data:null,acts:{},queue:[],review:[]},chain=Promise.resolve(),syncing=false,dirty=false,storageDamaged=false,durable=false,lastConfirmed=false,retryAfter=0;
  const initialized=HQOfflineStore.read().then(saved=>{if(saved){state=saved;durable=Boolean(saved.data);}}).catch(()=>{storageDamaged=true;message('Локальная копия не читается. Перезапись остановлена, сохранённые данные оставлены на устройстве.');});
  function copy(value){return JSON.parse(JSON.stringify(value));}
  function message(text){const node=document.getElementById('offline-status');if(node)node.textContent=text;}
  function locked(fn){const next=chain.then(fn);chain=next.catch(()=>{});return next;}
  async function persist(){
    if(storageDamaged)throw Error('OFFLINE_STORAGE_DAMAGED');
    if(!HQOfflineStore.enabled())return false;
    await HQOfflineStore.write(state);
    const verified=await HQOfflineStore.read();
    if(JSON.stringify(verified)!==JSON.stringify(state))throw Error('OFFLINE_SAVE_VERIFY');
    durable=Boolean(verified.data);
    return true;
  }
  function view(){let result=copy(state.data);for(const op of state.queue)result=HQOfflineModel.project(result,op);return result;}
  function status(){
    if(storageDamaged)return message('Локальная копия не читается. Перезапись остановлена, сохранённые данные оставлены на устройстве.');
    if(state.queue.some(op=>op.status==='conflict'||op.status==='uncertain'))return message('Есть правка, требующая проверки. Открой очередь.');
    if(state.queue.length)return message('На устройстве сохранено действий: '+state.queue.length+'. Ожидают отправки.');
    if(state.data){
      if(!durable)return message('Дела загружены. Включи офлайн для сохранения на устройстве.');
      const settings=document.getElementById('offline-settings');
      if(settings&&!settings.dataset.openedByUser){settings.open=false;document.getElementById('offline-settings-toggle').setAttribute('aria-expanded','false');}
      if(!navigator.onLine)return message('Без сети · дела сохранены на устройстве');
      return message(transport.ready()&&lastConfirmed?'Синхронизировано':'Дела сохранены на устройстве');
    }
    message('Первая загрузка ещё не завершена. Нужен доступ к Google.');
  }
  async function sync(){
    await initialized;
    if(syncing||Date.now()<retryAfter||!navigator.onLine||!transport.ready())return;
    syncing=true;
    const button=document.getElementById('offline-sync');if(button){button.disabled=true;button.textContent='Выполняется обмен…';}
    try{await locked(async()=>{
      for(const op of state.queue){
        if(op.status==='conflict'||op.status==='uncertain')break;
        message('Отправляем сохранённое действие…');
        const reply=await transport.exchange({type:'operation',operation:op.operation});
        if(reply.status==='done'){
          state.queue=state.queue.filter(item=>item.id!==op.id);
          await persist();
        }else{
          op.status=reply.status;op.message=reply.message;await persist();break;
        }
      }
      if(!state.queue.length){
        const before=JSON.stringify(state.data);
        state.data=await transport.exchange({type:'read'});
        if(await persist()){
          transport.confirmSaved();
          const settings=document.getElementById('offline-settings');if(settings)delete settings.dataset.openedByUser;
        }
        if(before!==JSON.stringify(state.data)&&!dirty&&typeof window.loadData==='function')setTimeout(()=>window.loadData(),0);
      }
      lastConfirmed=true;retryAfter=0;
      status();
    });}catch(error){
      console.warn('HQ offline exchange',error.name,error.message);lastConfirmed=false;retryAfter=Date.now()+30000;
      message(state.queue.length?'Подтверждение задерживается. Сохранено действий: '+state.queue.length+'. Очередь остаётся на устройстве.':'Обновление задерживается. Сохранённые дела доступны.');
    }
    finally{syncing=false;if(button){button.disabled=false;button.textContent='Отправить и обновить';}}
  }
  async function rpc(name,arg){
    await initialized;
    if(name==='getHeadquartersData'){
      if(!state.data&&transport.ready())await locked(async()=>{if(!state.data){state.data=await transport.exchange({type:'read'});await persist();}});
      if(!state.data)throw Error('Подключи Google для первой загрузки дел.');
      status();void sync();const data=view();data.newAchievements=[];return data;
    }
    if(name==='getActProgressFromHQ'){
      if(transport.ready())await locked(async()=>{state.acts[arg]=await transport.exchange({type:'acts',caseId:arg});await persist();});
      if(!state.acts[arg])throw Error('Даты актов этого дела ещё не сохранены. Открой их при подключении к Google.');
      return copy(state.acts[arg]);
    }
    if(!HQOfflineModel.mutations.includes(name))throw Error('Действие недоступно в отдельном приложении.');
    return locked(async()=>{
      if(!HQOfflineStore.enabled())throw Error('Нажми «Разрешить офлайн на этом устройстве», чтобы надёжно сохранить правку.');
      if(!state.data)throw Error('Сначала загрузи дела.');
      const id=crypto.randomUUID(),current=view();
      const operation={id,name,arg:arg===undefined?null:copy(arg),editedAt:new Date().toISOString(),baseline:HQOfflineModel.baseline(current,name,arg)};
      const item={id,name,arg:operation.arg,operation,status:'pending'};
      state.queue.push(item);
      try{await persist();}catch(error){state.queue=state.queue.filter(op=>op.id!==id);throw error;}
      dirty=false;
      status();setTimeout(()=>void sync(),0);
      if(name==='setCaseFocusFromHQ')return {caseIds:view().focusPinnedCaseIds||[],message:'Выбор сохранён в очереди.'};
      return {ok:true,offline:true,message:'Действие зашифровано и сохранено на устройстве. Ожидает подтверждения таблицы.'};
    });
  }
  function runner(success,failure){return new Proxy({}, {get(_target,name){
    if(name==='withSuccessHandler')return callback=>runner(callback,failure);
    if(name==='withFailureHandler')return callback=>runner(success,callback);
    return arg=>{rpc(name,arg).then(value=>success&&success(value)).catch(error=>failure?failure({message:error.message}):message(error.message));};
  }});}
  window.google={script:{run:runner(null,null)}};
  document.addEventListener('DOMContentLoaded',()=>{
    const panel=document.createElement('section');panel.className='offline-panel';
    panel.innerHTML='<div class="offline-summary"><span id="offline-status" role="status">Открываем сохранённые дела…</span><button type="button" id="offline-settings-toggle" aria-controls="offline-settings" aria-expanded="false">Настройки</button></div><details id="offline-settings"><summary>Подключение и офлайн</summary><p id="offline-shell">Сохраняем оболочку приложения…</p><div><button type="button" id="offline-enable">Разрешить офлайн на этом устройстве</button><button type="button" id="offline-connect">Подключить Google</button><button type="button" id="offline-sync">Отправить и обновить</button></div><details id="offline-queue-details"><summary>Сохранённые действия</summary><div id="offline-queue"></div></details></details>';
    document.querySelector('.app').prepend(panel);
    const settings=document.getElementById('offline-settings');
    document.getElementById('offline-settings-toggle').onclick=()=>{settings.dataset.openedByUser=settings.open?'':'true';settings.open=!settings.open;document.getElementById('offline-settings-toggle').setAttribute('aria-expanded',String(settings.open));};
    document.getElementById('offline-enable').onclick=async()=>{const button=document.getElementById('offline-enable');button.disabled=true;message('Сохраняем зашифрованную копию…');try{await initialized;if(storageDamaged)throw Error('OFFLINE_STORAGE_DAMAGED');await HQOfflineStore.enable();if(await persist()&&state.data)transport.confirmSaved();button.hidden=true;status();}catch(_){message('Не удалось подтвердить сохранение локальной копии.');}finally{button.disabled=false;}};
    document.getElementById('offline-connect').onclick=()=>{lastConfirmed=false;retryAfter=0;message(transport.connect()?'Идёт подключение Google. Дождись подтверждения сохранения дел, затем вернись в Штаб.':'Разреши открытие окна Google и повтори.');};
    document.getElementById('offline-sync').onclick=()=>{
      if(syncing)return message('Обмен уже выполняется. Дождись ответа Google.');
      if(!navigator.onLine)return message('Нет сети. Сохранённые дела и очередь доступны на устройстве.');
      if(!transport.ready())return message('Для отправки нажми «Подключить Google». Сохранённые дела уже доступны.');
      retryAfter=0;message('Проверяем данные и отправляем очередь…');void sync();
    };
    document.addEventListener('input',event=>{if(event.target.matches('textarea,input:not([type="search"]):not([type="checkbox"])'))dirty=true;});
    document.getElementById('offline-queue-details').ontoggle=()=>{
      const box=document.getElementById('offline-queue');box.replaceChildren();
      for(const op of [...state.queue,...(state.review||[])]){
        const p=document.createElement('p');p.textContent=op.operation.editedAt+' · '+op.name+' · '+(op.message||'Ждёт отправки');box.append(p);
        const details=document.createElement('details'),label=document.createElement('summary'),pre=document.createElement('pre');label.textContent='Содержимое правки';pre.textContent=JSON.stringify(op.arg,null,2);pre.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere';details.append(label,pre);box.append(details);
        if(state.queue.includes(op)&&['conflict','uncertain'].includes(op.status)){
          const button=document.createElement('button');button.textContent='Оставить для проверки и продолжить очередь';
          button.onclick=()=>void locked(async()=>{state.review=state.review||[];state.review.push(op);state.queue=state.queue.filter(item=>item.id!==op.id);await persist();status();button.disabled=true;void sync();});box.append(button);
        }
      }
    };
    initialized.then(()=>{document.getElementById('offline-enable').hidden=HQOfflineStore.enabled();settings.open=!state.data;status();});
    if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js',{scope:'./'}).then(()=>navigator.serviceWorker.ready).then(()=>{document.getElementById('offline-shell').textContent='Оболочка готова к запуску без интернета.';}).catch(()=>{document.getElementById('offline-shell').textContent='Оболочка не сохранена. Обнови страницу с интернетом.';});
  });
  window.addEventListener('online',()=>void sync());window.addEventListener('offline',status);
  transport.onReady(()=>sync());
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){status();void sync();}});
  window.addEventListener('pageshow',()=>{void initialized.then(()=>{status();void sync();});});
  setInterval(()=>{if(!document.hidden)void sync();},15000);
})();

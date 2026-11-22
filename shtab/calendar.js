(function(){
 'use strict';
 const labels={task:'Задача',event:'Заседание / встреча',legal:'Юридический срок'};
 let data,updated,all=[],selected=localToday(),month=selected.slice(0,7),root;
 const filters=new Set(Object.keys(labels));
 function localToday(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
 function node(tag,text,cls){const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;}
 function button(text,action){const b=node('button',text);b.type='button';b.onclick=action;return b;}
 function visible(){return all.filter(e=>filters.has(e.kind));}
 function move(delta){const [y,m]=month.split('-').map(Number),d=new Date(Date.UTC(y,m-1+delta,1,12));month=d.toISOString().slice(0,7);selected=month+'-01';render();}
 function openEntry(item){
   if(!item.caseId){return;}
   const select=document.getElementById('caseSelect');
   if(!Array.from(select.options).some(o=>o.value===item.caseId)){
     const check=document.getElementById('showCompleted');if(check&&!check.checked){check.checked=true;check.dispatchEvent(new Event('change',{bubbles:true}));}
   }
   if(!Array.from(select.options).some(o=>o.value===item.caseId))return;
   select.value=item.caseId;select.dispatchEvent(new Event('change',{bubbles:true}));
   const tab=document.querySelector('.tab[data-panel="'+(item.kind==='event'?'eventPanel':'stagePanel')+'"]');tab?.click();
   if(item.eventId){const eventSelect=document.getElementById('eventSelect');eventSelect.value=item.eventId;eventSelect.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('eventSelect').scrollIntoView({block:'center'});}
   else document.getElementById('workspaceHeading').scrollIntoView({block:'start'});
 }
 function render(){
   if(!root)return;root.replaceChildren();root.append(node('h2','Календарь'));
   const toolbar=node('div',null,'calendar-toolbar');const title=node('strong',new Date(month+'-01T12:00:00Z').toLocaleDateString('ru-RU',{month:'long',year:'numeric',timeZone:'UTC'}));
   const prev=button('‹',()=>move(-1)),next=button('›',()=>move(1));prev.setAttribute('aria-label','Предыдущий месяц');next.setAttribute('aria-label','Следующий месяц');
   toolbar.append(prev,title,next,button('Сегодня',()=>{selected=localToday();month=selected.slice(0,7);render();}));root.append(toolbar);
   const filterBar=node('div',null,'calendar-filters');
   for(const [kind,label]of Object.entries(labels)){const labelNode=node('label'),input=node('input');input.type='checkbox';input.checked=filters.has(kind);input.onchange=()=>{input.checked?filters.add(kind):filters.delete(kind);render();};labelNode.append(input,document.createTextNode(label));filterBar.append(labelNode);}root.append(filterBar);
   if(!data){root.append(node('p','Календарь появится после загрузки сохранённых дел.'));return;}
   root.append(node('p',updated?'Сохранённые данные · обновлены '+new Date(updated).toLocaleString('ru-RU'):'Сохранённые данные · время обновления неизвестно','calendar-source'));
   const items=visible(),byDate=new Map();for(const item of items){if(!byDate.has(item.date))byDate.set(item.date,[]);byDate.get(item.date).push(item);}
   const grid=node('div',null,'calendar-grid');for(const day of ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'])grid.append(node('span',day,'calendar-weekday'));
   const [y,m]=month.split('-').map(Number);
   for(const date of HQCalendarModel.monthDays(y,m-1)){
     const dayItems=byDate.get(date)||[],b=button(String(Number(date.slice(-2))),()=>{selected=date;month=date.slice(0,7);render();});
     b.className='calendar-day'+(date.slice(0,7)!==month?' calendar-other':'')+(date===localToday()?' calendar-today':'');b.setAttribute('aria-pressed',String(date===selected));
     b.setAttribute('aria-label',date.split('-').reverse().join('.')+', записей: '+dayItems.length);
     const marks=node('span',null,'calendar-marks');for(const kind of Object.keys(labels))if(dayItems.some(e=>e.kind===kind))marks.append(node('i',null,'calendar-dot calendar-'+kind));b.append(marks);grid.append(b);
   }root.append(grid);
   const list=node('div',null,'calendar-agenda');list.setAttribute('aria-live','polite');list.append(node('h3',selected.split('-').reverse().join('.')));
   const dayItems=byDate.get(selected)||[];if(!dayItems.length)list.append(node('p','На эту дату нет записей в выбранных категориях. Задачи без даты в календаре не отображаются.'));
   for(const item of dayItems){const card=node('article',null,'calendar-entry calendar-'+item.kind);card.append(node('small',labels[item.kind]+(item.time?' · '+item.time:'')+(item.completed?' · результат записан':'')),node('strong',item.client),node('p',item.title));if(item.caseId)card.append(button('Открыть дело',()=>openEntry(item)));else card.append(node('small','Событие без связанного дела.'));list.append(card);}root.append(list);
 }
 document.addEventListener('DOMContentLoaded',()=>{root=node('section',null,'hq-calendar');root.id='hq-calendar';root.setAttribute('aria-label','Календарь дел и сроков');document.getElementById('eventPanel').prepend(root);render();});
 window.addEventListener('hq-data',event=>{data=event.detail.data;updated=event.detail.updated;all=HQCalendarModel.entries(data);render();});
})();

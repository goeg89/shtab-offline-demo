(function(root){
  'use strict';
  function dateKey(value){
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return '';
    const d=new Date(value+'T12:00:00Z');return Number.isFinite(+d)&&d.toISOString().slice(0,10)===value?value:'';
  }
  function entries(data){
    const result=[],cases=new Map((data.cases||[]).map(c=>[c.id,c]));
    function add(kind,date,item,title,eventId){if(dateKey(date))result.push({kind,date,caseId:item.id||'',client:item.client||'Дело без названия',title:title||'',eventId:eventId||'',time:''});}
    for(const item of cases.values())if(!item.completed){
      if(item.task)add('task',item.deadline,item,item.task);
      add('legal',item.legalDeadline,item,item.legalBasis||'Юридический срок');
    }
    for(const event of data.events||[]){
      const date=dateKey(event.date)||dateKey(event.dateKey);if(!date)continue;
      const item=cases.get(event.caseId);
      result.push({kind:'event',date,caseId:event.caseId||'',client:event.client||item?.client||'Заседание / встреча',title:event.place||'Заседание / встреча',eventId:event.eventId||'',time:event.timeDisplay||event.time||'',completed:Boolean(event.result)});
    }
    return result.sort((a,b)=>a.date.localeCompare(b.date)||a.time.localeCompare(b.time)||a.client.localeCompare(b.client));
  }
  function monthDays(year,month){
    const first=new Date(Date.UTC(year,month,1,12)),offset=(first.getUTCDay()+6)%7;
    const count=new Date(Date.UTC(year,month+1,0,12)).getUTCDate(),length=Math.ceil((offset+count)/7)*7;
    return Array.from({length},(_,i)=>new Date(Date.UTC(year,month,1-offset+i,12)).toISOString().slice(0,10));
  }
  const api={dateKey,entries,monthDays};if(typeof module!=='undefined')module.exports=api;else root.HQCalendarModel=api;
})(typeof window==='undefined'?globalThis:window);

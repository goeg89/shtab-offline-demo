(function(root){
  'use strict';
  const mutations=['setCaseFocusFromHQ','rescheduleTaskFromHQ','hideFocusItemFromHQ','restoreTodayFocusFromHQ','closeActFromHQ','closeHonorActFromHQ','saveStageFromHQ','saveMeetingFromHQ','deleteMeetingFromHQ','saveLegalDeadlineFromHQ','saveCaseFromHQ','saveAbsenceFromHQ','deleteAbsenceFromHQ'];
  function baseline(data,name,arg){
    const p=arg||{};
    if(['setCaseFocusFromHQ','hideFocusItemFromHQ','restoreTodayFocusFromHQ'].includes(name))return null;
    if(name==='deleteMeetingFromHQ')return data.events.find(x=>x.eventId===arg)||null;
    if(name==='deleteAbsenceFromHQ')return (data.absences||[]).find(x=>x.id===arg)||null;
    if(p.caseId)return data.cases.find(x=>x.id===p.caseId)||null;
    return null;
  }
  function project(data,op){
    const next=JSON.parse(JSON.stringify(data)),p=op.arg||{};
    const item=next.cases.find(x=>x.id===p.caseId);
    const display=date=>date?date.split('-').reverse().join('.'):'';
    if(item){
      if(op.name==='rescheduleTaskFromHQ'){item.deadline=p.deadline;item.deadlineDisplay=display(p.deadline);}
      if(op.name==='saveLegalDeadlineFromHQ'){item.legalDeadline=p.legalDeadline||'';item.legalBasis=p.legalBasis||'';item.legalDeadlineDisplay=display(item.legalDeadline);}
      if(op.name==='saveCaseFromHQ'){for(const field of ['client','dispute','subject','task','taskType','deadline','caseNumbers'])if(field in p)item[field]=p[field];item.completed=Boolean(p.completeMatter);}
      if(op.name==='saveStageFromHQ'){item.task=p.nextTask||'';item.taskType=p.nextTaskType||'';item.deadline=p.nextDeadline||'';item.completed=Boolean(p.completeMatter);}
      if(op.name==='saveMeetingFromHQ'&&p.updateTask){item.task=p.task||'';item.taskType=p.taskType||'';item.deadline=p.taskDeadline||'';}
      if(op.name==='setCaseFocusFromHQ')next.focusPinnedCaseIds=p.selected?[...new Set([...(next.focusPinnedCaseIds||[]),p.caseId])]:(next.focusPinnedCaseIds||[]).filter(id=>id!==p.caseId);
    }
    if(op.name==='saveMeetingFromHQ'&&p.eventId){const event=next.events.find(x=>x.eventId===p.eventId);if(event)Object.assign(event,{date:p.date,dateKey:p.date,dateDisplay:display(p.date),time:p.time,timeDisplay:p.time,place:p.place,result:p.result});}
    if(op.name==='deleteMeetingFromHQ')next.events=next.events.filter(x=>x.eventId!==op.arg);
    if(op.name==='hideFocusItemFromHQ')next.focusHiddenKeys=[...new Set([...(next.focusHiddenKeys||[]),p.itemKey])];
    if(op.name==='restoreTodayFocusFromHQ')next.focusHiddenKeys=[];
    return next;
  }
  const api={mutations,baseline,project};
  if(typeof module!=='undefined')module.exports=api;else root.HQOfflineModel=api;
})(typeof window==='undefined'?globalThis:window);

/**
 * PWA-SYNC-0.2-pre — ТОЛЬКО для отдельной демонстрационной таблицы.
 * Никаких обращений к рабочей CRM / ШтабКод.gs. Без XP, актов или реальных дел.
 *
 * Транспорт: подписанный HMAC-SHA256 JSONP GET + обычный HTML form POST.
 * POST не считается успешным до подтверждения через подписанный GET status.
 * Ограничения: тестовый общий ключ на устройстве; НЕ использовать с реальными данными.
 */
const TEST_SYNC = Object.freeze({
  spreadsheetId: '1BW68gb2l5HxcHZ0Fn-BAM91XZCPyQ-QOijRaCibQ9as',
  titlePrefix: 'Штаб Офлайн — ТЕСТ синхронизации 0.2',
  secretProp: 'PWA_SYNC_TEST_SECRET_V02',
  clockToleranceMs: 180000,
  maxPayloadChars: 32000,
  protocol: 'pwa-sync-test-0.2'
});

/** Выполнить ОДИН раз в редакторе Apps Script тестовой таблицы. Секрет не публиковать. */
function setupTestSync() {
  const ss = testSyncSpreadsheet_();
  let secret = PropertiesService.getScriptProperties().getProperty(TEST_SYNC.secretProp);
  if (!secret) {
    secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toLowerCase();
    PropertiesService.getScriptProperties().setProperty(TEST_SYNC.secretProp, secret);
  }
  Logger.log('TEST SHEET: ' + ss.getUrl());
  Logger.log('SECRET — ВВЕДИТЕ ТОЛЬКО В ТЕСТОВОМ ПРИЛОЖЕНИИ, НЕ ПРИСЫЛАЙТЕ В ЧАТ: ' + secret);
  Logger.log('Длина ключа: ' + secret.length + '; не размещайте его в GitHub.');
  return 'Подготовлено. Секрет показан в журнале выполнения (он никогда не возвращается через Web App).';
}

function doGet(e) {
  const callback = String((e && e.parameter && e.parameter.callback) || '');
  if (!/^__shtab_[A-Za-z0-9_]{8,48}$/.test(callback)) {
    return ContentService.createTextOutput('/* invalid callback */')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  let answer;
  try {
    const payload = testSyncAuthorize_(e.parameter, 'GET');
    answer = testSyncHandleRead_(payload);
  } catch (error) {
    answer = {ok: false, error: String(error.message || error).slice(0, 180)};
  }
  return ContentService.createTextOutput(callback + '(' + JSON.stringify(answer) + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function doPost(e) {
  let answer;
  try {
    const payload = testSyncAuthorize_(e.parameter, 'POST');
    if (payload.action !== 'apply') throw Error('Недопустимое действие POST');
    answer = testSyncApply_(payload.op);
  } catch (error) {
    answer = {ok: false, error: String(error.message || error).slice(0, 180)};
  }
  // Ответ iframe нельзя надёжно прочитать с GitHub Pages. Клиент проверяет status.
  return ContentService.createTextOutput(JSON.stringify(answer))
    .setMimeType(ContentService.MimeType.JSON);
}

function testSyncAuthorize_(params, method) {
  if (!params) throw Error('Нет параметров');
  const secret = PropertiesService.getScriptProperties().getProperty(TEST_SYNC.secretProp);
  if (!secret) throw Error('Сначала запустите setupTestSync');
  const timestamp = String(params.ts || '');
  const nonce = String(params.nonce || '');
  const encoded = String(params.payload || '');
  const signature = String(params.sig || '');
  if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > TEST_SYNC.clockToleranceMs)
    throw Error('Время запроса неверное');
  if (!/^[A-Za-z0-9-]{12,80}$/.test(nonce) || encoded.length > TEST_SYNC.maxPayloadChars ||
      !/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[a-f0-9]{64}$/.test(signature))
    throw Error('Некорректный подписанный запрос');
  const canonical = method + '\n' + timestamp + '\n' + nonce + '\n' + encoded;
  const actual = testSyncHex_(Utilities.computeHmacSha256Signature(canonical, secret));
  if (!testSyncEquals_(actual, signature)) throw Error('Неверная подпись');
  let obj;
  try {
    const pad = encoded + '==='.slice((encoded.length + 3) % 4);
    obj = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(pad)).getDataAsString('UTF-8'));
  } catch (_) { throw Error('Недопустимый JSON'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw Error('Недопустимый пакет');
  return obj;
}

function testSyncHex_(bytes) {
  return bytes.map(x => ('0' + ((x + 256) % 256).toString(16)).slice(-2)).join('');
}
function testSyncEquals_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function testSyncSpreadsheet_() {
  const ss = SpreadsheetApp.openById(TEST_SYNC.spreadsheetId);
  if (ss.getId() !== TEST_SYNC.spreadsheetId || !ss.getName().startsWith(TEST_SYNC.titlePrefix))
    throw Error('Разрешена только отдельная тестовая таблица');
  const expected = {
    Cases: 'id|client|task|plan|legal|legalBasis|completed|revision|updatedAt|lastOpId',
    Events: 'id|caseId|date|time|place|result|done|revision|updatedAt|lastOpId',
    Ops: 'opId|caseId|status|requestJson|responseJson|updatedAt'
  };
  for (const name of Object.keys(expected)) {
    const s = ss.getSheetByName(name);
    if (!s) throw Error('Отсутствует тестовый лист ' + name);
    const hdr = s.getRange(1, 1, 1, expected[name].split('|').length).getDisplayValues()[0].join('|');
    if (hdr !== expected[name]) throw Error('Неожиданная структура тестового листа ' + name);
  }
  return ss;
}

function testSyncRows_(sheet, width, limit) {
  const count = Math.max(0, sheet.getLastRow() - 1);
  if (count > limit) throw Error('Превышен размер тестового журнала');
  return count ? sheet.getRange(2, 1, count, width).getValues() : [];
}
function testSyncCase_(v) {
  return {id:String(v[0]), client:String(v[1]), task:String(v[2] || ''),
    plan:String(v[3] || ''), legal:String(v[4] || ''), legalBasis:String(v[5] || ''),
    completed:v[6] === true || String(v[6]).toLowerCase() === 'true',
    localVersion:Number(v[7] || 1), updatedAt:String(v[8] || '')};
}
function testSyncEvent_(v) {
  return {id:String(v[0]),caseId:String(v[1]),date:String(v[2] || ''),
    time:String(v[3] || ''),place:String(v[4] || ''),result:String(v[5] || ''),
    done:v[6] === true || String(v[6]).toLowerCase() === 'true',
    localVersion:Number(v[7] || 1), updatedAt:String(v[8] || '')};
}
function testSyncHandleRead_(req) {
  const ss = testSyncSpreadsheet_();
  if (req.action === 'hello') return {ok:true,protocol:TEST_SYNC.protocol,serverTime:Date.now()};
  if (req.action === 'pull') {
    const cases = testSyncRows_(ss.getSheetByName('Cases'), 10, 500).filter(x => x[0]).map(testSyncCase_);
    const events = testSyncRows_(ss.getSheetByName('Events'), 10, 2000).filter(x => x[0]).map(testSyncEvent_);
    return {ok:true,protocol:TEST_SYNC.protocol,cases,events,pulledAt:new Date().toISOString()};
  }
  if (req.action === 'status') {
    const opId = String(req.opId || '');
    if (!/^OP-[A-Za-z0-9-]{8,100}$/.test(opId)) throw Error('Недопустимый ID операции');
    const rows = testSyncRows_(ss.getSheetByName('Ops'), 6, 10000);
    const row = rows.find(x => String(x[0]) === opId);
    return row ? {ok:true,found:true,status:String(row[2]),result:row[4]?JSON.parse(String(row[4])):null}
               : {ok:true,found:false,status:'missing'};
  }
  throw Error('Неизвестное действие GET');
}

const TEST_SYNC_PATCH_KEYS = Object.freeze(['task','plan','legal','legalBasis']);
function testSyncValidateOp_(op) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) throw Error('Нет операции');
  const s = (x, max) => typeof x === 'string' && x.length <= max;
  const date = x => x === '' || /^\d{4}-\d{2}-\d{2}$/.test(x);
  if (!s(op.opId, 103) || !/^OP-[A-Za-z0-9-]{8,100}$/.test(op.opId) ||
      !s(op.caseId, 100) || !/^CASE-DEMO-\d{3}$/.test(op.caseId) ||
      !['case_update','hearing_and_case'].includes(op.kind) ||
      !Number.isSafeInteger(op.baseVersion) || op.baseVersion < 1 || op.baseVersion > 1000000)
    throw Error('Недопустимые ID, тип или версия');
  if (!op.patch || typeof op.patch !== 'object' || Array.isArray(op.patch)) throw Error('Нет изменений');
  const keys = Object.keys(op.patch);
  if (keys.some(k => !TEST_SYNC_PATCH_KEYS.includes(k))) throw Error('Неразрешённое поле');
  for (const k of keys) {
    const v=op.patch[k];
    if (!s(v, k==='task'?5000:k==='legalBasis'?2000:10) ||
        ((k==='plan'||k==='legal') && !date(v))) throw Error('Недопустимое значение');
  }
  if (op.kind === 'case_update' && (!keys.length || op.event)) throw Error('Нет изменений дела');
  if (op.kind === 'hearing_and_case') {
    const ev = op.event;
    if (!ev || !s(ev.eventId,100) || !/^EVT-(DEMO-\d{3}|LOCAL-[A-Za-z0-9-]{8,80})$/.test(ev.eventId) ||
        !Number.isSafeInteger(ev.expectedEventVersion) || ev.expectedEventVersion < 1 ||
        !s(ev.result,5000) || !ev.result.trim()) throw Error('Некорректное событие');
    if (ev.nextEvent) {
      const n = ev.nextEvent;
      if (!s(n.id,100) || !/^EVT-LOCAL-[A-Za-z0-9-]{8,80}$/.test(n.id) ||
          !s(n.date,10) || !date(n.date) || !n.date ||
          !s(n.time,5) || (n.time && !/^\d{2}:\d{2}$/.test(n.time)) ||
          !s(n.place,300)) throw Error('Некорректное следующее событие');
    }
  }
  return op;
}

function testSyncApply_(raw) {
  const op = testSyncValidateOp_(raw);
  const lock=LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw Error('Сервер занят; повторите синхронизацию');
  try {
    const ss=testSyncSpreadsheet_();
    const cases=ss.getSheetByName('Cases'), events=ss.getSheetByName('Events'), logs=ss.getSheetByName('Ops');
    const logRows=testSyncRows_(logs,6,10000);
    const opJSON=JSON.stringify(op);
    const logAt=logRows.findIndex(x=>String(x[0])===op.opId);
    const logRow=logAt<0?null:logRows[logAt];
    if (logRow && String(logRow[3]) !== opJSON) throw Error('ID операции использован с другим содержимым');
    if (logRow && ['applied','conflict'].includes(String(logRow[2])))
      return JSON.parse(String(logRow[4]));
    let rowNumber;
    if (logRow) rowNumber=logAt+2;
    else {
      rowNumber=logs.getLastRow()+1;
      logs.getRange(rowNumber,1,1,6).setValues([[op.opId,op.caseId,'processing',opJSON,'',new Date().toISOString()]]);
      SpreadsheetApp.flush();
    }
    const caseRows=testSyncRows_(cases,10,500), evRows=testSyncRows_(events,10,2000);
    const cIndex=caseRows.findIndex(x=>String(x[0])===op.caseId);
    if(cIndex<0) return testSyncFinish_(logs,rowNumber,'conflict',{ok:false,status:'conflict',opId:op.opId,reason:'Дело удалено на сервере'});
    const c=caseRows[cIndex], eObj=op.event;
    const eIndex=eObj?evRows.findIndex(x=>String(x[0])===eObj.eventId):-1;
    const e=eIndex<0?null:evRows[eIndex];
    const newIndex=eObj&&eObj.nextEvent?evRows.findIndex(x=>String(x[0])===eObj.nextEvent.id):-1;
    const nextExisting=newIndex<0?null:evRows[newIndex];
    const cAlready=Object.keys(op.patch).length>0 && String(c[9])===op.opId;
    const eAlready=!!e && String(e[9])===op.opId;
    const nAlready=!!nextExisting && String(nextExisting[9])===op.opId;
    const reason=(!cAlready && Number(c[7])!==op.baseVersion)?'Дело изменилось на сервере'
      : (eObj && !e)?'Заседание отсутствует на сервере'
      : (eObj && !eAlready && (e[6]===true || Number(e[7])!==eObj.expectedEventVersion))?'Заседание изменилось на сервере'
      : (nextExisting && !nAlready)?'ID следующего заседания уже используется':'';
    if(reason) return testSyncFinish_(logs,rowNumber,'conflict',{
      ok:false,status:'conflict',opId:op.opId,reason,
      serverCase:testSyncCase_(c),serverEvent:e?testSyncEvent_(e):null});
    const now=new Date().toISOString();
    if(Object.keys(op.patch).length && !cAlready){
      for(const [key,index] of [['task',2],['plan',3],['legal',4],['legalBasis',5]])
        if(Object.prototype.hasOwnProperty.call(op.patch,key))c[index]=op.patch[key];
      c[7]=Number(c[7])+1;c[8]=now;c[9]=op.opId;
      cases.getRange(cIndex+2,1,1,10).setValues([c]);
      SpreadsheetApp.flush();
    }
    if(eObj && !eAlready){
      e[5]=eObj.result;e[6]=true;e[7]=Number(e[7])+1;e[8]=now;e[9]=op.opId;
      events.getRange(eIndex+2,1,1,10).setValues([e]);
      SpreadsheetApp.flush();
    }
    if(eObj && eObj.nextEvent && !nAlready){
      const n=eObj.nextEvent;
      events.getRange(events.getLastRow()+1,1,1,10).setValues([[
        n.id,op.caseId,n.date,n.time||'',n.place||'','',false,1,now,op.opId]]);
      SpreadsheetApp.flush();
    }
    return testSyncFinish_(logs,rowNumber,'applied',{
      ok:true,status:'applied',opId:op.opId,caseId:op.caseId,serverRevision:Number(c[7])});
  } finally {lock.releaseLock();}
}
function testSyncFinish_(sheet,row,status,result){
  sheet.getRange(row,3,1,4).setValues([[status,String(sheet.getRange(row,4).getValue()),JSON.stringify(result),new Date().toISOString()]]);
  SpreadsheetApp.flush();
  return result;
}
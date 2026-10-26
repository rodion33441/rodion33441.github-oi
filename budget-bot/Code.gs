/**
 * Бюджет-бот.
 * MacroDroid пересылает сюда уведомления Ozon Банка, скрипт пишет операции
 * в таблицу и по расписанию присылает план и диагностику в Telegram.
 * Инструкция по установке — в README.md рядом.
 */

// ===== Настройки: меняй под себя =====
const CONFIG = {
  TIMEZONE: 'Europe/Moscow',
  INCOME: 10000,        // обычный доход в месяц, ₽
  INCOME_SPREAD: 3000,  // насколько доход может гулять в минус — план строим по худшему случаю
  LIFE: 5000,           // на жизнь в месяц: еда, проезд, мелочи, ₽
  BILLS: [              // обязательные платежи: что, сколько, какого числа
    // { name: 'Связь', amount: 400, day: 5 },
  ],
  DAILY_REPORT: true,   // короткий отчёт каждый вечер
  REPORT_HOUR: 21,
};

const SHEET_NAME = 'Операции';

const CATEGORIES = [
  ['🍔 Еда', ['пятёрочка', 'пятерочка', 'магнит', 'перекрёсток', 'перекресток', 'вкусвилл', 'ашан', 'лента', 'дикси',
    'spar', 'окей', 'kfc', 'rostics', 'вкусно', 'бургер', 'burger', 'додо', 'dodo', 'самокат', 'лавка', 'кафе', 'столовая',
    'пекарня', 'кофе', 'coffee', 'шоколадница', 'теремок', 'fix price', 'светофор', 'красное', 'бристоль', 'продукт']],
  ['🚌 Транспорт', ['метро', 'транспорт', 'тройка', 'автобус', 'такси', 'taxi', 'yandex go', 'яндекс go', 'ржд', 'электричка',
    'мосгортранс', 'самокат юрент', 'whoosh', 'юрент']],
  ['📦 Маркетплейсы', ['ozon', 'озон', 'wildberries', 'вайлдберриз', 'wb ', 'яндекс маркет', 'market', 'aliexpress', 'мегамаркет']],
  ['📱 Связь', ['билайн', 'beeline', 'мтс', 'mts', 'мегафон', 'megafon', 'теле2', 'tele2', 't2', 'yota', 'йота', 'ростелеком']],
  ['🎮 Развлечения', ['steam', 'playstation', 'xbox', 'кино', 'синема', 'cinema', 'яндекс плюс', 'plus', 'кинопоиск', 'ivi',
    'okko', 'spotify', 'vk музыка', 'boosty', 'donat', 'игр']],
  ['💸 Переводы', ['перевод']],
];

// ===== Приём уведомлений от MacroDroid =====

function doPost(e) {
  let data = (e && e.parameter) || {};
  if (!data.text && e && e.postData && e.postData.contents) {
    try { data = JSON.parse(e.postData.contents); } catch (err) { /* не JSON — оставляем параметры */ }
  }
  if (!data.key || data.key !== prop_('SECRET')) return text_('forbidden');

  const op = parseNotification(data.text);
  if (!op) return text_('skip');

  const sheet = sheet_();
  const now = new Date();
  // MacroDroid иногда присылает одно уведомление дважды
  const last = sheet.getLastRow() > 1 ? sheet.getRange(sheet.getLastRow(), 1, 1, 6).getValues()[0] : null;
  if (last && last[5] === op.raw && now - new Date(last[0]) < 2 * 60 * 1000) return text_('duplicate');

  sheet.appendRow([now, op.type, op.amount, op.place, op.category, op.raw]);
  return text_('ok');
}

function doGet() {
  return text_('Бюджет-бот работает');
}

/** Разбирает текст уведомления: «Покупка на 250 ₽. Пятёрочка» → {type, amount, place, category}. */
function parseNotification(text) {
  const raw = String(text || '').replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = raw.match(/(\d[\d ]*(?:[.,]\d{1,2})?)\s*(?:₽|руб|RUB|р\.)/i);
  if (!m) return null;
  const amount = parseFloat(m[1].replace(/ /g, '').replace(',', '.'));
  if (!amount) return null;

  let type = 'other';
  if (/между (своими )?сч|накопительн|копилк|вклад/i.test(raw)) type = 'internal';  // свои деньги между своими счетами
  else if (/пополнени|зачислени|поступлени|возврат|кешб[эе]к|кэшб[эе]к|cashback|перевод от|входящ/i.test(raw)) type = 'in';
  else if (/покупк|оплат|списани|снятие|перевод|плат[её]ж|подписк/i.test(raw)) type = 'out';

  // Где потратил — обычно следующее предложение после суммы
  const after = raw.slice(m.index + m[0].length).replace(/^[.,:;\s]+/, '');
  const place = after.split(/\. |\n/)[0].replace(/,?\s*(доступно|баланс|остаток).*$/i, '').trim().slice(0, 60);

  return { type, amount, place, category: type === 'out' ? categorize_(raw) : '', raw };
}

function categorize_(text) {
  const t = text.toLowerCase();
  for (const [name, words] of CATEGORIES) {
    if (words.some(w => t.includes(w))) return name;
  }
  return '🛒 Прочее';
}

// ===== Расчёты =====

function plan_() {
  const bills = CONFIG.BILLS.reduce((s, b) => s + b.amount, 0);
  const incomeMin = CONFIG.INCOME - CONFIG.INCOME_SPREAD;
  const budget = bills + CONFIG.LIFE;  // сколько можно потратить за месяц вместе с платежами
  const saveMin = Math.max(0, incomeMin - budget);
  return { bills, incomeMin, budget, saveMin, savePct: incomeMin ? Math.floor(saveMin / incomeMin * 100) : 0 };
}

function monthStats_(date) {
  const tz = CONFIG.TIMEZONE;
  const key = Utilities.formatDate(date, tz, 'yyyy-MM');
  const [y, m] = key.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const day = Number(Utilities.formatDate(date, tz, 'd'));
  const ops = readOps_().filter(o => Utilities.formatDate(o.date, tz, 'yyyy-MM') === key);
  const p = plan_();

  const income = sum_(ops.filter(o => o.type === 'in'));
  const spent = sum_(ops.filter(o => o.type === 'out'));
  const billsLeft = CONFIG.BILLS.filter(b => Math.min(b.day, days) > day).reduce((s, b) => s + b.amount, 0);
  const left = p.budget - spent - billsLeft;               // осталось на жизнь до конца месяца
  const normSpent = (p.bills - billsLeft) + CONFIG.LIFE * day / days;  // сколько «положено» потратить к этому дню
  const canSave = income - spent - billsLeft - Math.max(0, left);       // лишнее, что можно отложить уже сейчас
  return { key, y, m, days, day, ops, income, spent, billsLeft, left, normSpent, canSave, plan: p };
}

function byCategory_(ops) {
  const groups = {};
  ops.filter(o => o.type === 'out').forEach(o => { groups[o.category] = (groups[o.category] || 0) + o.amount; });
  return Object.entries(groups).sort((a, b) => b[1] - a[1]);
}

function categoryLines_(ops, total) {
  return byCategory_(ops).slice(0, 6)
    .map(([name, amount]) => `${name}: ${rub_(amount)} (${Math.round(amount / total * 100)}%)`);
}

function paceLine_(s) {
  const diff = s.spent - s.normSpent;
  if (diff > s.normSpent * 0.1 && diff > 200) return `🔴 Перерасход: потрачено на ${rub_(diff)} больше плана`;
  if (diff < -s.normSpent * 0.1 && diff < -200) return `🟢 Экономишь: на ${rub_(-diff)} меньше плана`;
  return '🟡 Идёшь по плану';
}

// ===== Отчёты в Telegram =====

/** 1-го числа: итоги прошлого месяца и план на новый. */
function monthlyPlan() {
  const now = new Date();
  const prev = monthStats_(new Date(now.getTime() - 24 * 3600 * 1000 * now.getDate()));
  const p = plan_();
  const days = new Date(Number(Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy')),
    Number(Utilities.formatDate(now, CONFIG.TIMEZONE, 'M')), 0).getDate();
  const lines = [];

  if (prev.ops.length) {
    lines.push(`<b>Итоги: ${monthName_(prev.m)}</b>`,
      `Пришло: ${rub_(prev.income)}`,
      `Потрачено: ${rub_(prev.spent)}`,
      `Осталось/отложено: ${rub_(prev.income - prev.spent)}`);
    if (prev.spent) lines.push('', 'Куда ушли деньги:', ...categoryLines_(prev.ops, prev.spent));
    lines.push('');
  }

  lines.push(`<b>📅 План на ${monthName_(Number(Utilities.formatDate(now, CONFIG.TIMEZONE, 'M')))}</b>`,
    `Доход ждём ${rub_(p.incomeMin)}–${rub_(CONFIG.INCOME + CONFIG.INCOME_SPREAD)}, считаем по минимуму: ${rub_(p.incomeMin)}.`);
  if (CONFIG.BILLS.length) {
    lines.push('', 'Обязательные платежи:',
      ...CONFIG.BILLS.slice().sort((a, b) => a.day - b.day).map(b => `• ${esc_(b.name)}: ${rub_(b.amount)} — ${b.day}-го`));
  }
  lines.push('', `На жизнь: ${rub_(CONFIG.LIFE)} → <b>${rub_(CONFIG.LIFE / days)} в день</b>, ~${rub_(CONFIG.LIFE / days * 7)} в неделю.`);

  if (p.saveMin > 0) {
    lines.push('', `💰 <b>Копилка: с каждого поступления сразу откладывай ${p.savePct}%</b> (минимум ${rub_(p.saveMin)} за месяц).`,
      `Всё, что пришло сверх ${rub_(p.incomeMin)}, — целиком в копилку.`,
      'Что осталось в конце месяца — тоже в копилку.');
  } else {
    lines.push('', `⚠️ Платежи и жизнь (${rub_(p.budget)}) съедают весь минимальный доход. Откладывай всё, что пришло сверх ${rub_(p.budget)}.`);
  }
  send_(lines.join('\n'));
}

/** По понедельникам: как идёт месяц. */
function weeklyReport() {
  const s = monthStats_(new Date());
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const week = s.ops.filter(o => o.date >= weekAgo);
  const weekSpent = sum_(week.filter(o => o.type === 'out'));
  const daysLeft = s.days - s.day + 1;

  const lines = [`<b>📊 Неделя: ${rub_(weekSpent)} потрачено</b>`];
  if (weekSpent) lines.push(...categoryLines_(week, weekSpent));
  lines.push('', `<b>С начала месяца</b> (${s.day} из ${s.days} дней)`,
    `Пришло: ${rub_(s.income)} · Потрачено: ${rub_(s.spent)}`,
    paceLine_(s),
    '', `На жизнь осталось: ${rub_(Math.max(0, s.left))} → <b>${rub_(Math.max(0, s.left) / daysLeft)} в день</b>`);
  if (s.billsLeft) lines.push(`Ещё впереди платежи: ${rub_(s.billsLeft)}`);
  if (s.canSave > 0) lines.push(`💰 Свободно сверх плана: <b>${rub_(s.canSave)}</b> — если ещё не отложил, переведи в копилку`);
  if (s.income < s.plan.incomeMin && s.day > 20) lines.push(`⚠️ Доход пока ниже минимума (${rub_(s.plan.incomeMin)}) — трать осторожнее.`);
  send_(lines.join('\n'));
}

/** Каждый вечер: сколько ушло сегодня и сколько можно завтра. */
function dailyReport() {
  const s = monthStats_(new Date());
  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const ops = s.ops.filter(o => o.type === 'out' && Utilities.formatDate(o.date, CONFIG.TIMEZONE, 'yyyy-MM-dd') === today);
  const spentToday = sum_(ops);
  const lines = [`Сегодня потрачено: <b>${rub_(spentToday)}</b>`];
  ops.forEach(o => lines.push(`• ${rub_(o.amount)} — ${esc_(o.place || o.category)}`));
  if (s.day < s.days) lines.push(`Завтра можно: <b>${rub_(Math.max(0, s.left) / (s.days - s.day))}</b>`);
  lines.push(paceLine_(s));
  if (s.canSave > 0) lines.push(`💰 Свободно сверх плана: ${rub_(s.canSave)} — в копилку`);
  send_(lines.join('\n'));
}

// ===== Установка =====

/** Запусти один раз: создаёт таблицу, расписание и секретный ключ для MacroDroid. */
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SECRET')) props.setProperty('SECRET', Utilities.getUuid().slice(0, 12));
  sheet_();
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('monthlyPlan').timeBased().onMonthDay(1).atHour(9).inTimezone(CONFIG.TIMEZONE).create();
  ScriptApp.newTrigger('weeklyReport').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).inTimezone(CONFIG.TIMEZONE).create();
  if (CONFIG.DAILY_REPORT) {
    ScriptApp.newTrigger('dailyReport').timeBased().everyDays(1).atHour(CONFIG.REPORT_HOUR).inTimezone(CONFIG.TIMEZONE).create();
  }
  Logger.log('Готово. Секретный ключ для MacroDroid: ' + props.getProperty('SECRET'));
}

/** Напиши боту /start, потом запусти эту функцию — она запомнит твой чат. */
function connectTelegram() {
  const res = JSON.parse(UrlFetchApp.fetch(`https://api.telegram.org/bot${prop_('TELEGRAM_TOKEN')}/getUpdates`).getContentText());
  const msg = (res.result || []).map(u => u.message).filter(Boolean).pop();
  if (!msg) throw new Error('Бот не видит сообщений. Напиши ему /start в Telegram и запусти ещё раз.');
  PropertiesService.getScriptProperties().setProperty('CHAT_ID', String(msg.chat.id));
  send_('✅ Бот подключён! План придёт 1-го числа, отчёт — по понедельникам' +
    (CONFIG.DAILY_REPORT ? ` и каждый вечер в ${CONFIG.REPORT_HOUR}:00.` : '.'));
}

// ===== Вспомогательное =====

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(['Дата', 'Тип', 'Сумма', 'Где', 'Категория', 'Текст уведомления']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readOps_() {
  const sh = sheet_();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues()
    .filter(r => r[0] && r[2])
    .map(r => ({ date: new Date(r[0]), type: r[1], amount: Number(r[2]), place: String(r[3]), category: r[4] || '🛒 Прочее' }));
}

function send_(html) {
  const token = prop_('TELEGRAM_TOKEN'), chat = prop_('CHAT_ID');
  if (!token || !chat) throw new Error('Не настроен Telegram: добавь TELEGRAM_TOKEN и запусти connectTelegram().');
  UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    payload: { chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: 'true' },
  });
}

function prop_(name) { return PropertiesService.getScriptProperties().getProperty(name); }
function text_(s) { return ContentService.createTextOutput(s); }
function sum_(ops) { return ops.reduce((s, o) => s + o.amount, 0); }
function rub_(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽'; }
function esc_(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function monthName_(m) {
  return ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'][m - 1];
}

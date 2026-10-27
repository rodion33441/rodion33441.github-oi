/**
 * Бюджет-бот.
 * MacroDroid пересылает сюда уведомления Ozon Банка, скрипт пишет операции
 * в таблицу и по расписанию присылает план и диагностику в Telegram.
 * Инструкция по установке — в README.md рядом.
 */

// ===== Настройки: меняй под себя =====
const CONFIG = {
  TELEGRAM_TOKEN: '',   // токен бота от @BotFather (или свойство скрипта TELEGRAM_TOKEN)
  CHAT_ID: '',          // твой Telegram ID (узнать у @userinfobot); пусто — connectTelegram() найдёт сам
  SECRET: '',           // ключ для MacroDroid; пусто — setup() придумает сам
  OWNER_NAME: '',       // твоё имя и отчество, как в уведомлениях банка: переводы самому себе не считаются тратой
  TIMEZONE: 'Europe/Moscow',
  SAVE_PCT: 20,         // сколько процентов с каждого пополнения откладывать в копилку
  START_BALANCE: 0,     // сколько денег на траты уже было на карте, когда подключил бота, ₽
  BILLS: [              // обязательные платежи: что, сколько, какого числа — бот заранее отложит на них
    // { name: 'Связь', amount: 400, day: 5 },
  ],
  INSTANT: true,        // сообщение сразу после каждой покупки и пополнения
  DAILY_REPORT: true,   // итог дня каждый вечер
  REPORT_HOUR: 21,
};

const SHEET_NAME = 'Операции';

const CATEGORIES = [
  ['🍔 Еда', ['пятёрочка', 'пятерочка', 'магнит', 'перекрёсток', 'перекресток', 'вкусвилл', 'ашан', 'лента', 'дикси',
    'spar', 'окей', 'kfc', 'rostics', 'вкусно', 'бургер', 'burger', 'додо', 'dodo', 'самокат', 'лавка', 'кафе', 'столовая',
    'пекарня', 'кофе', 'coffee', 'шоколадница', 'теремок', 'fix price', 'светофор', 'красное', 'бристоль', 'продукт',
    'pyaterochka', 'magnit', 'perekrestok', 'vkusvill', 'auchan', 'lenta', 'dixy', 'krasnoe', 'bristol', 'fixprice',
    'svetofor', 'vkusno', 'teremok', 'cafe', 'kafe', 'stolovaya', 'pekarnya', 'bakery', 'krendel', 'samokat', 'lavka']],
  ['🚌 Транспорт', ['метро', 'транспорт', 'тройка', 'автобус', 'такси', 'taxi', 'yandex go', 'яндекс go', 'ржд', 'электричка',
    'мосгортранс', 'whoosh', 'юрент', 'metro', 'transport', 'mosgortrans', 'yandex.go', 'yandex go', 'urent']],
  ['📦 Маркетплейсы', ['ozon', 'озон', 'wildberries', 'вайлдберриз', 'wb ', 'яндекс маркет', 'market', 'aliexpress', 'мегамаркет',
    'dns', 'мвидео', 'mvideo', 'эльдорадо', 'eldorado']],
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

  const op = parseNotification(data.text, data.title, data.source);
  if (!op) return text_('skip');

  // Уведомления от Ozon и Mir Pay могут прийти одновременно — обрабатываем по очереди
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let result;
  try { result = record_(op); } finally { lock.releaseLock(); }

  if (CONFIG.INSTANT && result.notify) {
    try { instantReport_(result.notify); } catch (err) { console.error(err); }  // запись в таблицу важнее сообщения
  }
  return text_(result.status);
}

/**
 * Пишет операцию в таблицу. Одна покупка может прийти дважды: Ozon присылает магазин без суммы,
 * Mir Pay — сумму. Такие пары в пределах 10 минут склеиваем в одну строку.
 */
function record_(op) {
  const sheet = sheet_();
  const now = new Date();
  const n = Math.min(20, sheet.getLastRow() - 1);
  const first = sheet.getLastRow() - n + 1;
  const recent = n <= 0 ? [] : sheet.getRange(first, 1, n, 7).getValues()
    .map((r, i) => ({ row: first + i, date: new Date(r[0]), type: r[1], amount: Number(r[2]) || 0, place: r[3], raw: r[5], source: String(r[6] || '') }))
    .filter(r => now - r.date < 10 * 60 * 1000);

  if (recent.some(r => r.raw === op.raw && now - r.date < 2 * 60 * 1000)) return { status: 'duplicate' };

  if (op.type === 'out') {
    const single = r => r.type === 'out' && r.source !== op.source && !r.source.includes('+');
    const twin = op.amount
      ? recent.reverse().find(r => single(r) && (!r.amount || r.amount === op.amount))
      : recent.reverse().find(r => single(r) && r.amount);
    if (twin) {
      const amount = op.amount || twin.amount;
      const place = (op.amount ? twin.place : op.place) || op.place || twin.place;  // название магазина берём от Ozon
      const text = [place, twin.raw, op.raw].map(t => String(t).replace(/карта.*$/i, '')).join(' ');
      sheet.getRange(twin.row, 3, 1, 3).setValues([[amount, place, categorize_(text)]]);
      sheet.getRange(twin.row, 7).setValue(twin.source + '+' + op.source);
      // Сообщение шлём, только когда сумма стала известна впервые
      return { status: 'merged', notify: twin.amount ? null : { type: 'out', amount, place } };
    }
  }

  sheet.appendRow([now, op.type, op.amount || '', op.place, op.category, op.raw, op.source]);
  return { status: 'ok', notify: op.amount && (op.type === 'in' || op.type === 'out') ? op : null };
}

function doGet() {
  return text_('Бюджет-бот работает');
}

/** Разбирает текст уведомления: «Покупка на 250 ₽. Пятёрочка» → {type, amount, place, category}. */
function parseNotification(text, title, source) {
  const norm = t => String(t || '').replace(/[\u00a0\u202f\u2009]/g, ' ').replace(/\s+/g, ' ').trim();
  const amountRe = /(\d[\d ]*(?:[.,]\d{1,2})?)\s*(?:₽|руб|RUB|р\.)/i;
  let raw = norm(text);
  let m = raw.match(amountRe);
  if (!m && amountRe.test(norm(title))) {  // некоторые приложения пишут сумму в заголовке
    raw = norm(title) + '. ' + raw;
    m = raw.match(amountRe);
  }
  if (!raw) return null;
  // Рекламу вроде «Кешбэк до 1000 ₽ в ноябре» не считаем
  if (/(?:^|\s)до\s+\d|акци|предложени|успей|получите|скидк|выгодн|розыгрыш|подключите/i.test(raw)) return null;
  source = String(source || 'ozon').toLowerCase();
  const amount = m ? parseFloat(m[1].replace(/ /g, '').replace(',', '.')) : 0;
  // Mir Pay: заголовок «Оплата покупки», текст «Сумма 147 ₽. 27.10.2026, 20:49. Карта …»
  if (/оплата покупки/i.test(norm(title)) || /^сумма\s+\d/i.test(raw)) source = source === 'ozon' ? 'mirpay' : source;
  const kw = norm(title) + ' ' + raw;  // тип операции ищем и в заголовке

  let type = 'other';
  if (/между (своими )?сч|накопительн|копилк|вклад/i.test(kw)) type = 'internal';  // свои деньги между своими счетами
  else if (/пополнени|зачислени|поступлени|возврат|кешб[эе]к|кэшб[эе]к|cashback|перевод от|входящ/i.test(kw)) type = 'in';
  else if (/покупк|оплат|списани|снятие|перевод|плат[её]ж|подписк/i.test(kw)) type = 'out';
  else if (source === 'mirpay' && amount) type = 'out';  // Mir Pay пишет только об оплатах
  if (type === 'out' && CONFIG.OWNER_NAME && raw.toLowerCase().includes(CONFIG.OWNER_NAME.toLowerCase())) type = 'internal';

  // Где потратил: «Покупка в KRENDELKOFF» или следующее предложение после суммы
  const shop = raw.match(/(?:покупка|оплата)\s+в\s+([^.]+)/i);
  const after = m ? raw.slice(m.index + m[0].length).replace(/^[.,:;\s]+/, '').split(/\. |\n/)[0] : '';
  let place = (shop ? shop[1] : after).replace(/,?\s*(доступно|баланс|остаток|карта).*$/i, '').trim().slice(0, 60);
  if (/^[\d.,:\s]*$/.test(place)) place = '';  // у Mir Pay после суммы идут дата и время, а не магазин

  // Ozon прячет сумму покупки — запоминаем магазин, сумма придёт от Mir Pay или её впишут вручную
  if (!amount && !(type === 'out' && place)) return null;
  // «Карта Ozon …» в тексте Mir Pay не должна превращать покупку в маркетплейс
  return { type, amount, place, category: type === 'out' ? categorize_(raw.replace(/карта.*$/i, '')) : '', raw, source };
}

function categorize_(text) {
  const t = text.toLowerCase();
  for (const [name, words] of CATEGORIES) {
    if (words.some(w => t.includes(w))) return name;
  }
  return '🛒 Прочее';
}

// ===== Расчёты =====

/**
 * Правило простое: с каждого пополнения SAVE_PCT% — в копилку, остальное — на траты.
 * Всё, что на траты и ещё не потрачено, делим на оставшиеся дни месяца.
 */
function state_(date) {
  const tz = CONFIG.TIMEZONE;
  const fmt = (d, f) => Utilities.formatDate(d, tz, f);
  const key = fmt(date, 'yyyy-MM'), today = fmt(date, 'yyyy-MM-dd');
  const [y, m] = key.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const day = Number(fmt(date, 'd'));
  const keep = 1 - CONFIG.SAVE_PCT / 100;

  const all = readOps_().filter(o => o.date <= date);
  const ops = all.filter(o => fmt(o.date, 'yyyy-MM') === key);
  const todayOps = ops.filter(o => o.type === 'out' && fmt(o.date, 'yyyy-MM-dd') === today);

  const pool = CONFIG.START_BALANCE + sum_(all.filter(o => o.type === 'in')) * keep - sum_(all.filter(o => o.type === 'out'));
  const billsLeft = sum_(CONFIG.BILLS.filter(b => Math.min(b.day, days) > day));
  const free = pool - billsLeft;                          // можно тратить до конца месяца
  const spentToday = sum_(todayOps);
  const daysLeft = days - day + 1;                        // включая сегодня
  const todayLimit = Math.max(0, free + spentToday) / daysLeft;

  const income = sum_(ops.filter(o => o.type === 'in'));
  return {
    y, m, day, days, daysLeft, ops, todayOps, pool, free, billsLeft, spentToday, todayLimit,
    restToday: todayLimit - spentToday,
    tomorrow: daysLeft > 1 ? Math.max(0, free) / (daysLeft - 1) : 0,
    income, saved: income * CONFIG.SAVE_PCT / 100, spent: sum_(ops.filter(o => o.type === 'out')),
    savedTotal: sum_(all.filter(o => o.type === 'in')) * CONFIG.SAVE_PCT / 100,
  };
}

function startDate_() {
  const props = PropertiesService.getScriptProperties();
  let start = props.getProperty('START');
  if (!start) {
    start = new Date().toISOString();
    props.setProperty('START', start);
  }
  return new Date(start);
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

function poolLine_(s) {
  if (s.free <= 0) return '⚠️ Деньги на траты закончились — до следующего пополнения лучше ничего не покупать.';
  return `На траты осталось: <b>${rub_(s.free)}</b> → примерно <b>${rub_(s.free / s.daysLeft)} в день</b> до конца месяца`;
}

// ===== Отчёты в Telegram =====

/** Сразу после операции. */
function instantReport_(op) {
  const s = state_(new Date());
  const lines = [];
  if (op.type === 'out') {
    lines.push(`−${rub_(op.amount)} ${esc_(op.place || op.category || 'покупка')}`);
    lines.push(s.restToday >= 0
      ? `На сегодня осталось: <b>${rub_(s.restToday)}</b>`
      : `🔴 Сегодня перерасход на ${rub_(-s.restToday)} — завтра лимит станет меньше`);
  } else {
    const save = Math.round(op.amount * CONFIG.SAVE_PCT / 100);
    lines.push(`<b>+${rub_(op.amount)} пришло</b>`, '',
      `💰 В копилку (${CONFIG.SAVE_PCT}%): <b>${rub_(save)}</b> — переведи на накопительный счёт`,
      `🛒 На траты: +${rub_(op.amount - save)}`, '',
      poolLine_(s));
  }
  send_(lines.join('\n'));
}

/** Каждый вечер: итог дня. */
function dailyReport() {
  const s = state_(new Date());
  const lines = [`<b>Итог дня, ${s.day} ${monthName_(s.m, true)}</b>`, '', `Потратил сегодня: <b>${rub_(s.spentToday)}</b>`];
  s.todayOps.forEach(o => lines.push(`• ${rub_(o.amount)} — ${esc_(o.place || o.category)}`));
  const unknown = noAmountToday_();
  if (unknown.length) {
    lines.push('', `❓ Банк не показал сумму: ${unknown.map(esc_).join(', ')}`,
      `Впиши суммы в столбец «Сумма»: ${sheet_().getParent().getUrl()}`);
  }
  lines.push('', s.restToday >= 0
    ? `🟢 Уложился в лимит (было можно ${rub_(s.todayLimit)})`
    : `🔴 Перерасход на ${rub_(-s.restToday)} (было можно ${rub_(s.todayLimit)})`);
  if (s.free <= 0) {
    lines.push('', poolLine_(s));
  } else if (s.daysLeft > 1) {
    lines.push('', `Можно тратить завтра: <b>${rub_(s.tomorrow)}</b>`,
      `(на траты осталось ${rub_(s.free)} на ${s.daysLeft - 1} ${days_(s.daysLeft - 1)})`);
  }
  send_(lines.join('\n'));
}

/** По понедельникам: итог недели. */
function weeklyReport() {
  const s = state_(new Date());
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const week = readOps_().filter(o => o.date >= weekAgo);
  const weekSpent = sum_(week.filter(o => o.type === 'out'));

  const lines = [`<b>📊 Итог недели</b>`, '', `За неделю потратил: <b>${rub_(weekSpent)}</b>`];
  if (weekSpent) lines.push(...categoryLines_(week, weekSpent));
  lines.push('', `<b>С начала месяца</b>`,
    `Пришло: ${rub_(s.income)}`,
    `В копилку (${CONFIG.SAVE_PCT}%): ${rub_(s.saved)}`,
    `Потратил: ${rub_(s.spent)}`,
    '', poolLine_(s));
  if (s.billsLeft) lines.push(`(уже без обязательных платежей впереди: ${rub_(s.billsLeft)})`);
  send_(lines.join('\n'));
}

/** 1-го числа: итоги прошлого месяца и как жить в новом. */
function monthlyPlan() {
  const now = new Date();
  const prevDay = new Date(now.getTime() - 24 * 3600 * 1000 * Number(Utilities.formatDate(now, CONFIG.TIMEZONE, 'd')));
  const prev = state_(prevDay);
  const s = state_(now);
  const lines = [];

  if (prev.ops.length) {
    lines.push(`<b>Итоги: ${monthName_(prev.m)}</b>`,
      `Пришло: ${rub_(prev.income)}`,
      `В копилку (${CONFIG.SAVE_PCT}%): ${rub_(prev.saved)}`,
      `Потратил: ${rub_(prev.spent)}`);
    if (prev.spent) lines.push('', 'Куда ушли деньги:', ...categoryLines_(prev.ops, prev.spent));
    lines.push('', `💰 Всего в копилке должно быть: <b>${rub_(s.savedTotal)}</b>`, '');
  }

  lines.push(`<b>📅 ${monthName_(s.m)[0].toUpperCase() + monthName_(s.m).slice(1)}: правило месяца</b>`,
    `С каждого пополнения ${CONFIG.SAVE_PCT}% — в копилку, ${100 - CONFIG.SAVE_PCT}% — на траты. Сколько куда — подскажу сразу, как придут деньги.`);
  if (CONFIG.BILLS.length) {
    lines.push('', 'Обязательные платежи (я заранее оставлю на них деньги):',
      ...CONFIG.BILLS.slice().sort((a, b) => a.day - b.day).map(b => `• ${esc_(b.name)}: ${rub_(b.amount)} — ${b.day}-го`));
  }
  lines.push('', poolLine_(s));
  send_(lines.join('\n'));
}

// ===== Установка =====

/** Запусти один раз: создаёт таблицу, расписание и секретный ключ для MacroDroid. */
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!prop_('SECRET')) props.setProperty('SECRET', Utilities.getUuid().slice(0, 12));
  startDate_();
  sheet_();
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('monthlyPlan').timeBased().onMonthDay(1).atHour(9).inTimezone(CONFIG.TIMEZONE).create();
  ScriptApp.newTrigger('weeklyReport').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).inTimezone(CONFIG.TIMEZONE).create();
  if (CONFIG.DAILY_REPORT) {
    ScriptApp.newTrigger('dailyReport').timeBased().everyDays(1).atHour(CONFIG.REPORT_HOUR).inTimezone(CONFIG.TIMEZONE).create();
  }
  Logger.log('Готово. Секретный ключ для MacroDroid: ' + prop_('SECRET'));
  if (prop_('TELEGRAM_TOKEN') && !prop_('CHAT_ID')) {
    try { connectTelegram(); } catch (err) { Logger.log(err.message); }
  }
}

/** Напиши боту /start, потом запусти эту функцию — она запомнит твой чат. */
function connectTelegram() {
  const res = JSON.parse(UrlFetchApp.fetch(`https://api.telegram.org/bot${prop_('TELEGRAM_TOKEN')}/getUpdates`).getContentText());
  const msg = (res.result || []).map(u => u.message).filter(Boolean).pop();
  if (!msg) throw new Error('Бот не видит сообщений. Напиши ему /start в Telegram и запусти ещё раз.');
  PropertiesService.getScriptProperties().setProperty('CHAT_ID', String(msg.chat.id));
  send_('✅ Бот подключён!');
}

// ===== Вспомогательное =====

function sheet_() {
  // Скрипт можно создать и из таблицы, и отдельно на script.google.com — тогда таблица создастся сама
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    const props = PropertiesService.getScriptProperties();
    const id = props.getProperty('SHEET_ID');
    ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.create('Бюджет');
    if (!id) {
      props.setProperty('SHEET_ID', ss.getId());
      Logger.log('Создана таблица: ' + ss.getUrl());
    }
  }
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(['Дата', 'Тип', 'Сумма', 'Где', 'Категория', 'Текст уведомления', 'Источник']);
    sh.setFrozenRows(1);
  }
  if (!sh.getRange(1, 7).getValue()) sh.getRange(1, 7).setValue('Источник');  // таблицы, созданные до Mir Pay
  return sh;
}

/** Сегодняшние покупки, для которых так и не пришла сумма. */
function noAmountToday_() {
  const sh = sheet_();
  if (sh.getLastRow() < 2) return [];
  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  return sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues()
    .filter(r => r[0] && r[1] === 'out' && !r[2] && Utilities.formatDate(new Date(r[0]), CONFIG.TIMEZONE, 'yyyy-MM-dd') === today)
    .map(r => String(r[3]));
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

function prop_(name) { return PropertiesService.getScriptProperties().getProperty(name) || CONFIG[name] || ''; }
function text_(s) { return ContentService.createTextOutput(s); }
function sum_(ops) { return ops.reduce((s, o) => s + o.amount, 0); }
function rub_(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽'; }
function esc_(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function monthName_(m, genitive) {
  return (genitive
    ? ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
    : ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'])[m - 1];
}
function days_(n) {
  const d = n % 10, h = n % 100;
  if (d === 1 && h !== 11) return 'день';
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return 'дня';
  return 'дней';
}

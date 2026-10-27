/**
 * Команды бота. Отдельный файл в том же проекте Apps Script — пользуется функциями из Code.gs.
 * Раз в минуту забирает новые сообщения из Telegram и отвечает на них.
 * После вставки один раз запусти setupCommands().
 */

const COMMANDS = [
  ['today', 'сегодня', 'Сколько ещё можно потратить сегодня'],
  ['piggy', 'копилка', 'Сколько в копилке и сколько накопится'],
  ['minimum', 'минимум', 'На какой минимум можно прожить'],
  ['goal', 'цель', 'Цель: /goal 15000 наушники'],
  ['spend', 'трата', 'Записать трату: /spend 300 шаурма'],
  ['amount', 'сумма', 'Сумма для покупки без суммы: /amount 390'],
  ['top', 'топ', 'Где тратишь больше всего'],
  ['forecast', 'прогноз', 'Сколько останется к концу месяца'],
  ['help', 'помощь', 'Список команд'],
];

// Продукты, проезд и связь — необходимое; кафе, доставка, маркетплейсы, игры — хотелки
const ESSENTIAL = [
  ['🥦 Продукты', ['пятёрочка', 'пятерочка', 'магнит', 'перекрёсток', 'перекресток', 'вкусвилл', 'ашан', 'лента', 'дикси',
    'spar', 'окей', 'fix price', 'светофор', 'красное', 'бристоль', 'продукт', 'pyaterochka', 'magnit', 'perekrestok',
    'vkusvill', 'auchan', 'lenta', 'dixy', 'krasnoe', 'bristol', 'fixprice', 'svetofor']],
  ['🚌 Проезд', ['метро', 'транспорт', 'тройка', 'автобус', 'ржд', 'электричка', 'мосгортранс', 'metro', 'transport', 'mosgortrans']],
  ['📱 Связь', ['билайн', 'beeline', 'мтс', 'mts', 'мегафон', 'megafon', 'теле2', 'tele2', 't2', 'yota', 'йота', 'ростелеком']],
];

/** Запусти один раз: проверка сообщений раз в минуту и меню команд в Telegram. */
function setupCommands() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'pollCommands')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('pollCommands').timeBased().everyMinutes(1).create();
  tg_('setMyCommands', { commands: JSON.stringify(COMMANDS.map(([cmd, , description]) => ({ command: cmd, description }))) });
  send_('✅ Команды подключены! Напиши /help');
}

/** Раз в минуту: забрать новые сообщения и ответить. */
function pollCommands() {
  const props = PropertiesService.getScriptProperties();
  const offset = Number(props.getProperty('TG_OFFSET') || 0);
  const updates = tg_('getUpdates', { offset: offset, timeout: 0 }).result || [];
  updates.forEach(u => {
    props.setProperty('TG_OFFSET', String(u.update_id + 1));  // сразу, чтобы не ответить дважды при ошибке
    const msg = u.message;
    if (!msg || !msg.text || String(msg.chat.id) !== String(prop_('CHAT_ID'))) return;
    try {
      handleCommand_(msg.text);
    } catch (err) {
      send_('Что-то пошло не так: ' + esc_(err.message));
    }
  });
}

function handleCommand_(text) {
  const words = text.trim().replace(/^\//, '').replace(/@\S+/, '').split(/\s+/);
  const word = words[0].toLowerCase();
  const args = words.slice(1);
  const found = COMMANDS.find(([cmd, ru]) => word === cmd || word === ru);
  const name = found ? found[0] : 'help';
  const handlers = {
    today: cmdToday_, piggy: cmdPiggy_, minimum: cmdMinimum_, goal: cmdGoal_, spend: cmdSpend_,
    amount: cmdAmount_, top: cmdTop_, forecast: cmdForecast_, help: cmdHelp_,
  };
  handlers[name](args);
}

// ===== Команды =====

function cmdHelp_() {
  send_(['<b>Что я умею</b>', '',
    ...COMMANDS.map(([cmd, ru, description]) => `/${cmd} (или «${ru}») — ${description}`)].join('\n'));
}

function cmdToday_() {
  const s = state_(new Date());
  const lines = [`<b>Сегодня, ${s.day} ${monthName_(s.m, true)}</b>`, '',
    `Можно было: ${rub_(s.todayLimit)}`, `Потратил: ${rub_(s.spentToday)}`];
  lines.push(s.restToday >= 0
    ? `🟢 Ещё можно: <b>${rub_(s.restToday)}</b>`
    : `🔴 Перерасход: ${rub_(-s.restToday)}`);
  lines.push('', poolLine_(s));
  send_(lines.join('\n'));
}

function cmdPiggy_() {
  const s = state_(new Date());
  const days = daysTracked_();
  const perMonth = s.savedTotal / days * 30;
  const now = new Date();
  const newYear = new Date(now.getFullYear() + 1, 0, 1);
  const toNewYear = s.savedTotal + perMonth * (newYear - now) / (30 * 24 * 3600 * 1000);
  const lines = ['<b>💰 Копилка</b>', '',
    `Должно быть отложено: <b>${rub_(s.savedTotal)}</b>`,
    `(${CONFIG.SAVE_PCT}% со всех пополнений за ${days} ${days_(days)})`];
  if (s.savedTotal > 0) {
    lines.push('', `В таком темпе — примерно ${rub_(perMonth)} в месяц:`,
      `• к Новому году: <b>${rub_(toNewYear)}</b>`,
      `• через год: <b>${rub_(s.savedTotal + perMonth * 12)}</b>`);
  }
  goals_().forEach(g => lines.push('', goalLine_(g, s.savedTotal, perMonth)));
  send_(lines.join('\n'));
}

function cmdMinimum_() {
  const days = daysTracked_();
  const ops = readOps_();
  const out = ops.filter(o => o.type === 'out');
  const income = sum_(ops.filter(o => o.type === 'in'));
  const groups = {};
  let wants = 0;
  out.forEach(o => {
    const kind = essentialKind_(o.place + ' ' + o.category);
    if (kind) groups[kind] = (groups[kind] || 0) + o.amount;
    else wants += o.amount;
  });
  const bills = sum_(CONFIG.BILLS);
  const perMonth = x => x / days * 30;
  const essential = Object.values(groups).reduce((a, b) => a + b, 0);
  const minimum = perMonth(essential) + bills;
  const spent = perMonth(sum_(out));

  const lines = ['<b>📉 Твой минимум</b>', ''];
  if (days < 14) lines.push(`⚠️ Пока данных мало (${days} ${days_(days)}), цифры станут точнее через пару недель.`, '');
  lines.push(`Необходимое: <b>~${rub_(minimum)} в месяц</b>`);
  Object.entries(groups).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => lines.push(`• ${k}: ${rub_(perMonth(v))}`));
  if (bills) lines.push(`• Обязательные платежи: ${rub_(bills)}`);
  lines.push('', `Сейчас тратишь: ~${rub_(spent)} в месяц`,
    `Из них хотелки (кафе, доставка, покупки, игры): ${rub_(perMonth(wants))}` +
    (spent ? ` — ${Math.round(perMonth(wants) / spent * 100)}%` : ''));
  if (income) {
    const incomeMonth = perMonth(income);
    const maxSave = Math.max(0, Math.round((incomeMonth - minimum) / incomeMonth * 100));
    lines.push('', `Доход: ~${rub_(incomeMonth)} в месяц`,
      `Если жить на минимуме, можно откладывать <b>до ${maxSave}%</b> вместо ${CONFIG.SAVE_PCT}%`);
  }
  send_(lines.join('\n'));
}

function cmdGoal_(args) {
  const props = PropertiesService.getScriptProperties();
  let goals = goals_();
  const s = state_(new Date());
  const perMonth = s.savedTotal / daysTracked_() * 30;

  if (args[0] && /^(удалить|delete|del)$/i.test(args[0])) {
    const name = args.slice(1).join(' ').toLowerCase();
    goals = goals.filter(g => g.name.toLowerCase() !== name);
    props.setProperty('GOALS', JSON.stringify(goals));
    return send_(`🗑 Цель «${esc_(name)}» удалена`);
  }
  const amount = parseAmount_(args[0]);
  if (amount) {
    const goal = { name: args.slice(1).join(' ') || 'Цель', amount };
    goals = goals.filter(g => g.name.toLowerCase() !== goal.name.toLowerCase()).concat(goal);
    props.setProperty('GOALS', JSON.stringify(goals));
    return send_(`🎯 Цель добавлена!\n\n${goalLine_(goal, s.savedTotal, perMonth)}`);
  }
  if (!goals.length) return send_('Целей пока нет. Добавь так: /goal 15000 наушники');
  send_(['<b>🎯 Цели</b>', ...goals.map(g => '\n' + goalLine_(g, s.savedTotal, perMonth)),
    '', 'Удалить: /goal удалить наушники'].join('\n'));
}

function cmdSpend_(args) {
  const amount = parseAmount_(args[0]);
  if (!amount) return send_('Напиши так: /spend 300 шаурма');
  const place = args.slice(1).join(' ') || 'Наличные';
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    sheet_().appendRow([new Date(), 'out', amount, place, categorize_(place), 'вручную: ' + place, 'manual']);
  } finally { lock.releaseLock(); }
  instantReport_({ type: 'out', amount, place });
}

function cmdAmount_(args) {
  const amount = parseAmount_(args[0]);
  if (!amount) return send_('Напиши так: /amount 390 — и я впишу сумму в последнюю покупку без суммы');
  const name = args.slice(1).join(' ').toLowerCase();
  const sh = sheet_();
  const rows = sh.getLastRow() < 2 ? [] : sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    const [date, type, sum, place] = rows[i];
    if (type === 'out' && !sum && String(place).toLowerCase().includes(name)) {
      sh.getRange(i + 2, 3).setValue(amount);
      return instantReport_({ type: 'out', amount, place: String(place) });
    }
  }
  send_('Не нашёл покупок без суммы' + (name ? ` с названием «${esc_(name)}»` : '') + ' 👍');
}

function cmdTop_() {
  const s = state_(new Date());
  const byPlace = {};
  s.ops.filter(o => o.type === 'out').forEach(o => {
    const key = o.place || o.category;
    byPlace[key] = (byPlace[key] || 0) + o.amount;
  });
  const top = Object.entries(byPlace).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!top.length) return send_('В этом месяце трат пока нет 🙌');
  const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
  send_([`<b>🏆 Топ трат за ${monthName_(s.m)}</b>`, '',
    ...top.map(([place, amount], i) => `${medals[i]} ${esc_(place)} — ${rub_(amount)}`),
    '', 'По категориям:', ...categoryLines_(s.ops, s.spent)].join('\n'));
}

function cmdForecast_() {
  const s = state_(new Date());
  const pace = s.spent / Math.min(s.day, daysTracked_());  // сколько в среднем уходит в день
  const ahead = pace * (s.daysLeft - 1) + Math.max(pace, s.spentToday) - s.spentToday;
  const end = s.free - ahead;
  const lines = [`<b>🔮 Прогноз до конца ${monthName_(s.m, true)}</b>`, '',
    `Тратишь в среднем: ${rub_(pace)} в день`,
    `До конца месяца уйдёт ещё примерно: ${rub_(ahead)}`];
  lines.push(end >= 0
    ? `🟢 Останется: <b>${rub_(end)}</b> — их можно будет отложить`
    : `🔴 Не хватит: <b>${rub_(-end)}</b>. Чтобы дотянуть, трать не больше ${rub_(Math.max(0, s.free) / s.daysLeft)} в день`);
  send_(lines.join('\n'));
}

// ===== Вспомогательное =====

function goalLine_(goal, saved, perMonth) {
  const pct = Math.min(100, Math.round(saved / goal.amount * 100));
  const bar = '▓'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
  const left = goal.amount - saved;
  let when = '✅ Уже хватает!';
  if (left > 0) when = perMonth > 0 ? `Осталось ${rub_(left)} — это ~${Math.ceil(left / perMonth)} мес.` : `Осталось ${rub_(left)}`;
  return `<b>${esc_(goal.name)}</b>: ${rub_(goal.amount)}\n${bar} ${pct}%\n${when}`;
}

function goals_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('GOALS') || '[]'); } catch (e) { return []; }
}

function essentialKind_(text) {
  const t = text.toLowerCase();
  const hit = ESSENTIAL.find(([, words]) => words.some(w => t.includes(w)));
  return hit ? hit[0] : null;
}

function daysTracked_() {
  return Math.max(1, Math.ceil((Date.now() - startDate_().getTime()) / (24 * 3600 * 1000)));
}

function parseAmount_(s) {
  const n = parseFloat(String(s || '').replace(',', '.').replace(/[^\d.]/g, ''));
  return n > 0 ? n : 0;
}

function tg_(method, payload) {
  const res = UrlFetchApp.fetch(`https://api.telegram.org/bot${prop_('TELEGRAM_TOKEN')}/${method}`,
    { method: 'post', payload, muteHttpExceptions: true });
  return JSON.parse(res.getContentText());
}

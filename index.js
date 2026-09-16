require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const AdmZip = require("adm-zip");
const mongoose = require("mongoose");
const fetch = require("node-fetch");
const FormData = require("form-data");
global.fetch = fetch;
global.FormData = FormData;
global.Blob = class { constructor(parts) { return Buffer.concat(parts.map((part) => Buffer.isBuffer(part) ? part : Buffer.from(part))); } };
const TelegramBot = require("node-telegram-bot-api").default;

const Worker = require("./model/worker");
const Task = require("./model/task");
const TaskRecord = require("./model/taskRecord");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = String(process.env.ADMIN_IDS || process.env.ADMIN_ID || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
let ADMIN_ID = "";
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/oustabashi";
const BALE_API = process.env.BALE_API || "https://tapi.bale.ai";
const PDF_PYTHON = process.env.PDF_PYTHON || (process.platform === "win32" ? "C:\\Users\\Behiii\\AppData\\Local\\Programs\\GapGPT\\resources\\gap-runtime\\python\\python.exe" : "python3");
const TIME_ZONE = "Asia/Tehran";
const pendingReasons = new Map();
const reportStates = new Map();

if (!BOT_TOKEN || BOT_TOKEN.includes("توکن") || BOT_TOKEN.length < 20) throw new Error("BOT_TOKEN واقعی در فایل .env قرار نگرفته است.");
if (!ADMIN_IDS.length || ADMIN_IDS.some((id) => !/^\d+$/.test(id))) console.warn("ADMIN_IDS must contain comma-separated numeric IDs.");

const bot = new TelegramBot(BOT_TOKEN, { polling: true, baseApiUrl: BALE_API });
bot.on("polling_error", (error) => console.error("polling_error:", error.message || error));

function normalize(text) { return String(text || "").replace(/\s+/g, " ").trim(); }
function taskKey(task) { return `${task.order}|${normalize(task.title).replace(/\s*([()،,:؛])\s*/g, "$1")}`; }
function allowed(message) {
  const id = String(message.from && message.from.id);
  if (ADMIN_IDS.includes(id)) ADMIN_ID = id;
  return ADMIN_IDS.includes(id);
}
function today() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${p.year}-${p.month}-${p.day}`;
}
function jalaliToGregorian(jy, jm, jd) {
  jy += 1595; let days = -355668 + 365 * jy + Math.floor(jy / 33) * 8 + Math.floor((jy % 33 + 3) / 4) + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy = 400 * Math.floor(days / 146097); days %= 146097;
  if (days > 36524) { gy += 100 * Math.floor(--days / 36524); days %= 36524; if (days >= 365) days++; }
  gy += 4 * Math.floor(days / 1461); days %= 1461;
  if (days > 365) { gy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  const monthDays = [31, (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; let gm = 0;
  while (gm < 11 && days >= monthDays[gm]) days -= monthDays[gm++];
  return `${gy}-${String(gm + 1).padStart(2, "0")}-${String(days + 1).padStart(2, "0")}`;
}
function gregorianToJalali(date) {
  const [gy, gm, gd] = date.split("-").map(Number); let jy = gy - 621; const march = 20; const first = new Date(Date.UTC(gy, 2, march)); const current = new Date(Date.UTC(gy, gm - 1, gd));
  if (current < first) jy--; const start = jalaliToGregorian(jy, 1, 1); const diff = Math.floor((current - new Date(`${start}T00:00:00Z`)) / 86400000); const jm = diff < 186 ? Math.floor(diff / 31) + 1 : Math.floor((diff - 186) / 30) + 7; const jd = diff < 186 ? diff % 31 + 1 : (diff - 186) % 30 + 1;
  return `${jy}-${String(jm).padStart(2, "0")}-${String(jd).padStart(2, "0")}`;
}
function jalaliToday() { return gregorianToJalali(today()); }
function displayDate(date) { return gregorianToJalali(date); }
function inputDate(value) { const match = String(value || "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); return match ? jalaliToGregorian(Number(match[1]), Number(match[2]), Number(match[3])) : null; }
function dateObject(date) { return new Date(`${date}T12:00:00+03:30`); }
function weekdayName(date) { return new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, weekday: "long" }).format(dateObject(date)).toUpperCase(); }
function addDays(date, days) { const d = dateObject(date); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
function datesBetween(start, end) { const result = []; for (let date = start; date <= end; date = addDays(date, 1)) result.push(date); return result; }
function firstWeekOfMonth(date) { return dateObject(date).getDate() <= 7; }
function firstWeekOfSeason(date) { const d = dateObject(date); return d.getDate() <= 7 && [0, 3, 6, 9].includes(d.getMonth()); }
function taskApplies(task, date) {
  const day = weekdayName(date);
  if (task.scheduleType === "DAILY") return true;
  if (task.scheduleType === "WEEKDAY") return task.weekdays.includes(day);
  if (task.scheduleType === "FIRST_MONTH_WEEKDAY") return task.weekdays.includes(day) && firstWeekOfMonth(date);
  if (task.scheduleType === "FIRST_SEASON_WEEKDAY") return task.weekdays.includes(day) && firstWeekOfSeason(date);
  return false;
}

function scheduleFor(text, extraDay) {
  const value = `${text} ${extraDay || ""}`;
  const days = { شنبه: "SATURDAY", یکشنبه: "SUNDAY", دوشنبه: "MONDAY", "سه شنبه": "TUESDAY", "سه‌شنبه": "TUESDAY", چهارشنبه: "WEDNESDAY", "پنج شنبه": "THURSDAY", "پنج‌شنبه": "THURSDAY", جمعه: "FRIDAY" };
  const key = Object.keys(days).find((item) => value.includes(item));
  const weekday = key ? days[key] : null;
  if (/سالی\s*یک\s*بار/.test(value)) return { scheduleType: "YEARLY", weekdays: [] };
  if (/بعد\s*از\s*هر|هر\s*بار/.test(value)) return { scheduleType: "EVENT", weekdays: [] };
  if (/اولین/.test(value) && /فصل/.test(value)) return { scheduleType: "FIRST_SEASON_WEEKDAY", weekdays: weekday ? [weekday] : [] };
  if (/اولین/.test(value) && /ماه/.test(value)) return { scheduleType: "FIRST_MONTH_WEEKDAY", weekdays: weekday ? [weekday] : [] };
  if (weekday) return { scheduleType: "WEEKDAY", weekdays: [weekday] };
  return { scheduleType: "DAILY", weekdays: [] };
}
function paragraphsFromDocx(file) {
  const xml = new AdmZip(file).readAsText("word/document.xml");
  return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) => normalize([...m[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((x) => x[1]).join("").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"))).filter(Boolean);
}
function parseTasks(file) {
  const people = []; let person = null; let extraDay = null; let current = null;
  const finish = () => { if (current) { person.tasks.push({ order: current.order, title: current.text, ...scheduleFor(current.text, current.extraDay) }); current = null; } };
  for (const line of paragraphsFromDocx(file)) {
    const personMatch = line.match(/^(آقای|خانم)\s+(.+)$/);
    if (personMatch) { finish(); const name = `${personMatch[1]} ${personMatch[2]}`; person = people.find((x) => x.name === name); if (!person) { person = { name, tasks: [] }; people.push(person); } extraDay = null; continue; }
    const extraMatch = line.match(/^کارهای\s+مازاد\s+(.+)$/);
    if (extraMatch) { finish(); extraDay = extraMatch[1]; continue; }
    if (/^امضاء/.test(line)) { finish(); extraDay = null; continue; }
    const taskMatch = line.match(/^\s*(\d+)\s*:\s*(.*)$/);
    if (taskMatch && person) { finish(); current = { order: Number(taskMatch[1]), text: normalize(taskMatch[2]), extraDay }; }
    else if (current) current.text = normalize(`${current.text} ${line}`);
  }
  finish(); return people;
}
async function seedFromDocx() {
  const people = parseTasks(path.join(__dirname, "tasks.docx")); let count = 0;
  for (const data of people) {
    const worker = await Worker.findOneAndUpdate({ name: data.name }, { $set: { name: data.name, active: true } }, { upsert: true, new: true });
    for (const item of data.tasks) { const sourceKey = `${worker.name}|${item.order}|${item.title}`; await Task.findOneAndUpdate({ sourceKey }, { $set: { ...item, workerId: worker._id, sourceKey, active: true } }, { upsert: true }); count++; }
  }
  console.log(`${people.length} نفر و ${count} تسک آماده شد.`);
}

const uiStates = new Map();
const backMenu = () => [{ text: "↩️ بازگشت به منو", callback_data: "back:menu" }];
function replyKeyboard(rows) { return { reply_markup: { keyboard: rows, resize_keyboard: true, is_persistent: true } }; }
function menu() { return replyKeyboard([["📋 بررسی تسک‌های امروز"], ["📄 ساخت گزارش PDF"]]); }
async function sendWorkers(chatId, date, back = "menu") {
  const workers = await Worker.find({ active: true }).sort({ name: 1 });
  uiStates.set(String(chatId), { screen: "workers", date, workers: workers.map((worker) => ({ id: String(worker._id), name: worker.name })) });
  const rows = workers.map((worker) => [worker.name]); rows.push([back === "menu" ? "↩️ بازگشت به منو" : "↩️ بازگشت به انتخاب شخص"]);
  await bot.sendMessage(chatId, `شخص مورد نظر برای تاریخ ${displayDate(date)}:`, replyKeyboard(rows));
}
async function sendTasks(chatId, workerId, date, page = 1) {
  const worker = await Worker.findById(workerId); const tasks = await Task.find({ workerId, active: true }).sort({ order: 1 }); const records = await TaskRecord.find({ workerId, date });
  const applicable = [];
  const seen = new Set();
  for (const task of tasks.filter((item) => taskApplies(item, date))) {
    const key = taskKey(task);
    if (seen.has(key)) continue;
    seen.add(key);
    const sameTasks = tasks.filter((item) => taskKey(item) === key);
    const record = records.find((item) => sameTasks.some((itemTask) => String(itemTask._id) === String(item.taskId)));
    if (!record || record.status !== "DONE") applicable.push(record && String(record.taskId) !== String(task._id) ? sameTasks.find((item) => String(item._id) === String(record.taskId)) : task);
  }
  if (!applicable.length) { uiStates.set(ADMIN_ID, { screen: "workers", date }); await bot.sendMessage(chatId, `همه تسک‌های قابل انجام ${worker.name} در این تاریخ بررسی شده‌اند.`, replyKeyboard([["↩️ بازگشت به انتخاب شخص"], ["↩️ بازگشت به منو"]])); return; }
  const perPage = 6; const totalPages = Math.ceil(applicable.length / perPage); const safePage = Math.min(Math.max(Number(page) || 1, 1), totalPages); const rows = [];
  const keyboard = [];
  for (const task of applicable.slice((safePage - 1) * perPage, safePage * perPage)) {
    const record = records.find((item) => String(item.taskId) === String(task._id)); const mark = record ? "❌" : "⬜";
    rows.push(`${mark} ${task.order}. ${task.title}`);
    keyboard.push([`✅ انجام شد | ${task.order}`, `❌ انجام نشد | ${task.order}`]);
  }
  const navigation = []; if (safePage > 1) navigation.push("⬅️ صفحه قبل"); if (safePage < totalPages) navigation.push("صفحه بعد ➡️");
  if (navigation.length) keyboard.push(navigation); keyboard.push(["↩️ بازگشت به انتخاب شخص"], ["↩️ بازگشت به منو"]);
  uiStates.set(ADMIN_ID, { screen: "tasks", workerId: String(workerId), workerName: worker.name, date, page: safePage, totalPages, tasks: applicable.slice((safePage - 1) * perPage, safePage * perPage).map((task) => ({ id: String(task._id), order: task.order })) });
  await bot.sendMessage(chatId, `تسک‌های باقی‌مانده ${worker.name} — صفحه ${safePage} از ${totalPages}:\n\n${rows.join("\n")}`, replyKeyboard(keyboard));
}

function currentYearMonthDay() { const value = jalaliToday(); return { year: Number(value.slice(0, 4)), month: Number(value.slice(5, 7)), day: Number(value.slice(8, 10)) }; }
function monthKeyboard() {
  const current = currentYearMonthDay(); const rows = [];
  for (let start = 1; start <= current.month; start += 3) rows.push([start, start + 1, start + 2].filter((month) => month <= current.month).map((month) => `ماه ${month}`));
  rows.push(["↩️ بازگشت به منو"]); return replyKeyboard(rows);
}
function maxDayForMonth(month) { const current = currentYearMonthDay(); if (month === current.month) return current.day; return month <= 6 ? 31 : month <= 11 ? 30 : 30; }
function dayKeyboard(stage, month, page = 1) {
  const maxDay = maxDayForMonth(month); const perPage = 15; const totalPages = Math.ceil(maxDay / perPage); const safePage = Math.min(Math.max(Number(page) || 1, 1), totalPages); const start = (safePage - 1) * perPage + 1; const end = Math.min(safePage * perPage, maxDay); const rows = [];
  for (let day = start; day <= end; day += 5) rows.push(Array.from({ length: Math.min(5, end - day + 1) }, (_, index) => String(day + index)));
  const navigation = []; if (safePage > 1) navigation.push("⬅️ صفحه قبل"); if (safePage < totalPages) navigation.push("صفحه بعد ➡️");
  if (navigation.length) rows.push(navigation); rows.push(["↩️ بازگشت به منو"]); return replyKeyboard(rows);
}
async function startReport(chatId) { reportStates.set(ADMIN_ID, {}); uiStates.set(ADMIN_ID, { screen: "reportMonth" }); await bot.sendMessage(chatId, "ماه گزارش را انتخاب کنید:", monthKeyboard()); }
async function requestReportStart(chatId, month) { reportStates.set(ADMIN_ID, { month }); uiStates.set(ADMIN_ID, { screen: "reportStart", month, page: 1 }); await bot.sendMessage(chatId, `ماه ${month} را انتخاب کردید. روز شروع:`, dayKeyboard("start", month)); }
async function requestReportEnd(chatId, month) { uiStates.set(ADMIN_ID, { screen: "reportEnd", month, page: 1 }); await bot.sendMessage(chatId, "روز پایان را انتخاب کنید:", dayKeyboard("end", month)); }
async function reportWorker(chatId) { const state = reportStates.get(ADMIN_ID); const workers = await Worker.find({ active: true }).sort({ name: 1 }); uiStates.set(ADMIN_ID, { screen: "reportWorker", start: state && state.start, end: state && state.end, workers: workers.map((worker) => ({ id: String(worker._id), name: worker.name })) }); await bot.sendMessage(chatId, `بازه ${state && state.start ? state.start : "نامشخص"} تا ${state && state.end ? state.end : "نامشخص"}. فقط یک نفر را انتخاب کنید:`, replyKeyboard([...workers.map((worker) => [worker.name]), ["↩️ بازگشت به منو"]])); }

async function reportWorker(chatId) {
  const state = reportStates.get(ADMIN_ID); const workers = await Worker.find({ active: true }).sort({ name: 1 });
  uiStates.set(ADMIN_ID, { screen: "reportWorker", start: state && state.start, end: state && state.end, workers: workers.map((worker) => ({ id: String(worker._id), name: worker.name })) });
  await bot.sendMessage(chatId, `بازه ${state && state.start ? displayDate(state.start) : "نامشخص"} تا ${state && state.end ? displayDate(state.end) : "نامشخص"}. فقط یک نفر را انتخاب کنید:`, replyKeyboard([...workers.map((worker) => [worker.name]), ["↩️ بازگشت به منو"]]));
}

async function buildReportData(workerId, start, end) {
  const worker = await Worker.findById(workerId); const tasks = await Task.find({ workerId, active: true }).sort({ order: 1 }); const rows = []; const dayNotes = []; let doneCount = 0;
  const allWorkers = await Worker.find({ active: true }).select("_id");
  for (const date of datesBetween(start, end)) {
    const workerRecords = await TaskRecord.find({ workerId, date });
    if (!workerRecords.length) {
      const otherRecords = await TaskRecord.find({ date, workerId: { $in: allWorkers.filter((item) => String(item._id) !== String(workerId)).map((item) => item._id) } }).limit(1);
      dayNotes.push({ date, text: otherRecords.length ? "برای این شخص احتمالاً مرخصی بوده است؛ گزارشی برای او ثبت نشده." : "این روز احتمالاً تعطیل بوده یا هنوز گزارش آن ثبت نشده است." });
    }
    const seen = new Set();
    for (const task of tasks.filter((item) => taskApplies(item, date))) {
      const key = taskKey(task);
      if (seen.has(key)) continue;
      seen.add(key);
      const sameTasks = tasks.filter((item) => taskKey(item) === key);
      const record = workerRecords.find((item) => sameTasks.some((itemTask) => String(itemTask._id) === String(item.taskId)));
      if (record && record.status === "DONE") doneCount++;
      else rows.push({ date, task: task.title, status: record ? record.status : "NOT_CHECKED", reason: record && record.reason ? record.reason : "" });
    }
  }
  return { worker: worker.name, start: displayDate(start), end: displayDate(end), rows: rows.map((row) => ({ ...row, date: displayDate(row.date) })), doneCount, dayNotes: dayNotes.map((item) => ({ ...item, date: displayDate(item.date) })) };
}
function createPdf(data) {
  const safeWorkerName = data.worker.replace(/[<>:"/\\|?*\x00-\x1F]/g, " ").replace(/\s+/g, " ").trim();
  const output = path.join(__dirname, `report-${safeWorkerName}-${data.start}-to-${data.end}.pdf`); const result = spawnSync(PDF_PYTHON, [path.join(__dirname, "report_pdf.py"), output], { input: JSON.stringify(data), encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "ساخت PDF ناموفق بود."); return output;
}
async function sendReportPdf(chatId, workerId) { const saved = reportStates.get(ADMIN_ID) || uiStates.get(ADMIN_ID); if (!saved || !saved.start || !saved.end) { await bot.sendMessage(chatId, "بازه گزارش پیدا نشد. لطفاً گزارش را دوباره از منوی اصلی شروع کنید.", menu()); return; } const data = await buildReportData(workerId, saved.start, saved.end); const file = createPdf(data); await bot.sendDocument(chatId, file, { caption: `گزارش ${data.worker} از ${data.start} تا ${data.end}` }); reportStates.delete(ADMIN_ID); uiStates.delete(ADMIN_ID); await bot.sendMessage(chatId, "گزارش آماده شد.", menu()); }

bot.onText(/^\/(start|menu)$/i, async (message) => { if (!allowed(message)) return bot.sendMessage(message.chat.id, `شناسه شما: ${message.from.id}`); await bot.sendMessage(message.chat.id, "مدیریت تسک‌ها", menu()); });
bot.onText(/^\/myid$/i, (message) => bot.sendMessage(message.chat.id, `شناسه شما: ${message.from.id}`));
bot.onText(/^\/check(?:\s+(\d{4}-\d{1,2}-\d{1,2}))?$/i, async (message, match) => { if (allowed(message)) { const date = match[1] ? inputDate(match[1]) : today(); if (date) await sendWorkers(message.chat.id, date); } });
bot.onText(/^\/report$/i, async (message) => { if (allowed(message)) await startReport(message.chat.id); });

bot.on("message_legacy_disabled", async (message) => {
  if (!allowed(message) || !message.text || message.text.startsWith("/")) return;
  const reasonState = pendingReasons.get(ADMIN_ID);
  if (reasonState) {
    const reason = normalize(message.text); const sentences = reason.split(/[.!؟?]+/).map((item) => item.trim()).filter(Boolean);
    if (!reason || reason.length > 200 || sentences.length > 2) return bot.sendMessage(message.chat.id, "دلیل باید کوتاه و حداکثر دو جمله باشد. دوباره وارد کنید:");
    const task = await Task.findById(reasonState.taskId); await TaskRecord.findOneAndUpdate({ taskId: task._id, date: reasonState.date }, { $set: { workerId: task.workerId, status: "NOT_DONE", reason, checkedBy: ADMIN_ID, checkedAt: new Date() } }, { upsert: true });
    pendingReasons.delete(ADMIN_ID); await bot.sendMessage(message.chat.id, "دلیل ثبت شد."); await sendTasks(message.chat.id, String(task.workerId), reasonState.date, reasonState.page); return;
  }
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id; if (!allowed({ from: query.from })) return bot.answerCallbackQuery(query.id, { text: "دسترسی ندارید." }); await bot.answerCallbackQuery(query.id);
  const [kind, a, b, c, d] = query.data.split(":");
  try {
    if (kind === "back" && a === "menu") { pendingReasons.delete(ADMIN_ID); reportStates.delete(ADMIN_ID); await bot.sendMessage(chatId, "مدیریت تسک‌ها", menu()); }
    else if (kind === "back" && a === "workers") await sendWorkers(chatId, b);
    else if (kind === "workers") await sendWorkers(chatId, a === "today" ? today() : (inputDate(a) || a));
    else if (kind === "worker") await sendTasks(chatId, a, b, 1);
    else if (kind === "tasks") await sendTasks(chatId, a, b, c);
    else if (kind === "set") {
      const task = await Task.findById(a); const page = Number(d) || 1;
      if (c === "NOT_DONE") { pendingReasons.set(ADMIN_ID, { taskId: a, date: b, page }); await bot.sendMessage(chatId, "دلیل انجام نشدن را در حداکثر دو جمله کوتاه بنویسید:", replyKeyboard([["↩️ بازگشت به منو"]])); }
      else { await TaskRecord.findOneAndUpdate({ taskId: task._id, date: b }, { $set: { workerId: task.workerId, status: "DONE", reason: "", checkedBy: ADMIN_ID, checkedAt: new Date() } }, { upsert: true }); await sendTasks(chatId, String(task.workerId), b, page); }
    } else if (kind === "report" && a === "start") await startReport(chatId);
    else if (kind === "report" && a === "month") await requestReportStart(chatId, Number(b));
    else if (kind === "report" && a === "day") {
      const state = reportStates.get(ADMIN_ID); const day = Number(c); const month = state.month; const year = currentYearMonthDay().year;
      if (b === "start") { state.start = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`; await requestReportEnd(chatId, month); }
      else { state.end = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`; if (state.end < state.start) return bot.sendMessage(chatId, "روز پایان نمی‌تواند قبل از روز شروع باشد.", replyKeyboard([["↩️ بازگشت به منو"]])); await reportWorker(chatId); }
    } else if (kind === "report" && a === "daypage") await bot.sendMessage(chatId, b === "start" ? "روز شروع:" : "روز پایان:", dayKeyboard(b, Number(c), Number(d)));
    else if (kind === "report" && a === "worker") await sendReportPdf(chatId, b);
  } catch (error) { console.error(error); }
});

bot.on("message", async (message) => {
  if (!allowed(message) || !message.text || message.text.startsWith("/")) return;
  const chatId = message.chat.id;
  const text = normalize(message.text);
  const state = uiStates.get(ADMIN_ID);

  if (text === "📋 بررسی تسک‌های امروز") return sendWorkers(chatId, today());
  if (text === "📄 ساخت گزارش PDF") return startReport(chatId);
  if (text === "↩️ بازگشت به منو") {
    pendingReasons.delete(ADMIN_ID); reportStates.delete(ADMIN_ID); uiStates.delete(ADMIN_ID);
    return bot.sendMessage(chatId, "مدیریت تسک‌ها", menu());
  }

  const reasonState = pendingReasons.get(ADMIN_ID);
  if (reasonState) {
    if (text === "↩️ بازگشت به تسک‌ها") {
      pendingReasons.delete(ADMIN_ID);
      return sendTasks(chatId, reasonState.workerId, reasonState.date, reasonState.page);
    }
    const reason = normalize(text);
    const sentences = reason.split(/[.!؟?]+/).map((item) => item.trim()).filter(Boolean);
    if (!reason || reason.length > 200 || sentences.length > 2) return bot.sendMessage(chatId, "دلیل باید کوتاه و حداکثر دو جمله باشد. دوباره وارد کنید:");
    const task = await Task.findById(reasonState.taskId);
    await TaskRecord.findOneAndUpdate({ taskId: task._id, date: reasonState.date }, { $set: { workerId: task.workerId, status: "NOT_DONE", reason, checkedBy: ADMIN_ID, checkedAt: new Date() } }, { upsert: true });
    pendingReasons.delete(ADMIN_ID);
    await bot.sendMessage(chatId, "دلیل ثبت شد.");
    return sendTasks(chatId, String(task.workerId), reasonState.date, reasonState.page);
  }

  if (!state) return;
  if (state.screen === "workers") {
    if (text === "↩️ بازگشت به انتخاب شخص") return bot.sendMessage(chatId, "مدیریت تسک‌ها", menu());
    const worker = state.workers.find((item) => item.name === text);
    if (worker) return sendTasks(chatId, worker.id, state.date, 1);
  }
  if (state.screen === "tasks") {
    if (text === "↩️ بازگشت به انتخاب شخص") return sendWorkers(chatId, state.date);
    if (text === "⬅️ صفحه قبل") return sendTasks(chatId, state.workerId, state.date, state.page - 1);
    if (text === "صفحه بعد ➡️") return sendTasks(chatId, state.workerId, state.date, state.page + 1);
    const action = text.match(/^(✅ انجام شد|❌ انجام نشد) \| (\d+)$/);
    if (action) {
      const taskInfo = state.tasks.find((item) => String(item.order) === action[2]);
      if (!taskInfo) return;
      const task = await Task.findById(taskInfo.id);
      if (action[1].startsWith("❌")) {
        pendingReasons.set(ADMIN_ID, { taskId: taskInfo.id, workerId: state.workerId, date: state.date, page: state.page });
        return bot.sendMessage(chatId, "دلیل انجام نشدن را در حداکثر دو جمله کوتاه بنویسید:", replyKeyboard([["↩️ بازگشت به تسک‌ها"], ["↩️ بازگشت به منو"]]));
      }
      await TaskRecord.findOneAndUpdate({ taskId: task._id, date: state.date }, { $set: { workerId: task.workerId, status: "DONE", reason: "", checkedBy: ADMIN_ID, checkedAt: new Date() } }, { upsert: true });
      return sendTasks(chatId, state.workerId, state.date, state.page);
    }
  }
  if (state.screen === "reportMonth") {
    const match = text.match(/^ماه (\d+)$/);
    if (match) return requestReportStart(chatId, Number(match[1]));
  }
  if (state.screen === "reportStart" || state.screen === "reportEnd") {
    if (text === "⬅️ صفحه قبل" || text === "صفحه بعد ➡️") {
      state.page += text.startsWith("⬅️") ? -1 : 1;
      const stage = state.screen === "reportStart" ? "start" : "end";
      return bot.sendMessage(chatId, stage === "start" ? "روز شروع:" : "روز پایان:", dayKeyboard(stage, state.month, state.page));
    }
    const day = Number(text);
    if (!Number.isInteger(day) || day < 1 || day > maxDayForMonth(state.month)) return;
    const year = currentYearMonthDay().year;
    const date = jalaliToGregorian(year, state.month, day);
    const reportState = reportStates.get(ADMIN_ID);
    if (state.screen === "reportStart") { reportState.start = date; return requestReportEnd(chatId, state.month); }
    reportState.end = date;
    if (reportState.end < reportState.start) return bot.sendMessage(chatId, "روز پایان نمی‌تواند قبل از روز شروع باشد.", replyKeyboard([["↩️ بازگشت به منو"]]));
    return reportWorker(chatId);
  }
  if (state.screen === "reportWorker") {
    const worker = state.workers.find((item) => item.name === text);
    if (worker) return sendReportPdf(chatId, worker.id);
  }
});

(async () => { await mongoose.connect(MONGO_URI); await seedFromDocx(); console.log("ربات آماده است."); })();

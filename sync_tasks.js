require("dotenv").config();

const AdmZip = require("adm-zip");
const mongoose = require("mongoose");
const Worker = require("./model/worker");
const Task = require("./model/task");

const days = { "شنبه": "SATURDAY", "یکشنبه": "SUNDAY", "دوشنبه": "MONDAY", "سه شنبه": "TUESDAY", "سه‌شنبه": "TUESDAY", "چهارشنبه": "WEDNESDAY", "پنج شنبه": "THURSDAY", "پنج‌شنبه": "THURSDAY", "جمعه": "FRIDAY" };
function scheduleFor(text, extraDay) {
  const value = `${text} ${extraDay || ""}`;
  const key = Object.keys(days).find((item) => value.includes(item));
  const weekday = key ? days[key] : null;
  if (/سالی\s*یک\s*بار/.test(value)) return { scheduleType: "YEARLY", weekdays: [] };
  if (/بعد\s*از\s*هر|هر\s*بار/.test(value)) return { scheduleType: "EVENT", weekdays: [] };
  if (value.includes("اولین") && value.includes("فصل")) return { scheduleType: "FIRST_SEASON_WEEKDAY", weekdays: weekday ? [weekday] : [] };
  if (value.includes("اولین") && value.includes("ماه")) return { scheduleType: "FIRST_MONTH_WEEKDAY", weekdays: weekday ? [weekday] : [] };
  if (weekday) return { scheduleType: "WEEKDAY", weekdays: [weekday] };
  return { scheduleType: "DAILY", weekdays: [] };
}

function parseTasks(file) {
  const xml = new AdmZip(file).readAsText("word/document.xml");
  const paragraphs = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((match) => {
    const paragraph = match[0];
    const text = [...paragraph.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((item) => item[1]).join("")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
    return { text, numbered: /<w:numPr[ >][\s\S]*?<\/w:numPr>/.test(paragraph) };
  }).filter((item) => item.text);

  const people = [];
  let person = null;
  let extraDay = null;
  let order = 0;
  for (const paragraph of paragraphs) {
    const personMatch = paragraph.text.match(/^(آقای|خانم)\s+(.+)$/);
    if (personMatch && !paragraph.numbered) {
      person = people.find((item) => item.name === paragraph.text);
      if (!person) { person = { name: paragraph.text, tasks: [] }; people.push(person); }
      extraDay = null; order = 0; continue;
    }
    const extraMatch = paragraph.text.match(/^کارهای\s+مازاد\s+روز\s+(.+)$/);
    if (extraMatch && person) { extraDay = extraMatch[1]; continue; }
    if (/^امضاء/.test(paragraph.text)) { extraDay = null; continue; }
    if (person && paragraph.numbered) {
      order += 1;
      person.tasks.push({ order, title: paragraph.text, ...scheduleFor(paragraph.text, extraDay) });
    }
  }
  return people;
}

(async () => {
  const people = parseTasks("./tasks.docx");
  if (!people.length || people.some((person) => !person.tasks.length)) throw new Error("ساختار شخص/تسک در فایل ورد معتبر نیست.");
  await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/oustabashi");
  const names = people.map((person) => person.name);
  await Worker.updateMany({ name: { $nin: names } }, { $set: { active: false } });
  let total = 0;
  let disabled = 0;
  for (const data of people) {
    const worker = await Worker.findOneAndUpdate({ name: data.name }, { $set: { name: data.name, active: true } }, { upsert: true, new: true });
    const sourceKeys = data.tasks.map((item) => `${worker.name}|${item.order}|${item.title}`);
    const old = await Task.updateMany({ workerId: worker._id, sourceKey: { $nin: sourceKeys } }, { $set: { active: false } });
    disabled += old.modifiedCount || 0;
    for (const item of data.tasks) {
      const sourceKey = `${worker.name}|${item.order}|${item.title}`;
      await Task.findOneAndUpdate({ sourceKey }, { $set: { ...item, workerId: worker._id, sourceKey, active: true } }, { upsert: true });
      total++;
    }
  }
  console.log(JSON.stringify({ people: people.length, totalTasks: total, disabledOldTasks: disabled, breakdown: people.map((person) => ({ name: person.name, tasks: person.tasks.length })) }, null, 2));
  await mongoose.disconnect();
})().catch(async (error) => { console.error(error); await mongoose.disconnect(); process.exitCode = 1; });

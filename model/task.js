const mongoose = require("mongoose");

module.exports = mongoose.model("Task", new mongoose.Schema({
  workerId: { type: mongoose.Schema.Types.ObjectId, ref: "Worker", required: true },
  sourceKey: { type: String, required: true, unique: true },
  order: Number,
  title: { type: String, required: true },
  scheduleType: { type: String, default: "DAILY" },
  weekdays: [String],
  active: { type: Boolean, default: true }
}));

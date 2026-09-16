const mongoose = require("mongoose");

module.exports = mongoose.model("TaskRecord", new mongoose.Schema({
  workerId: { type: mongoose.Schema.Types.ObjectId, ref: "Worker", required: true },
  taskId: { type: mongoose.Schema.Types.ObjectId, ref: "Task", required: true },
  date: { type: String, required: true },
  status: { type: String, enum: ["DONE", "NOT_DONE"], required: true },
  reason: { type: String, default: "" },
  checkedBy: String,
  checkedAt: Date
}, { timestamps: true }));

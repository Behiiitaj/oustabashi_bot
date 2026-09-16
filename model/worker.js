const mongoose = require("mongoose");

module.exports = mongoose.model("Worker", new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  active: { type: Boolean, default: true }
}));

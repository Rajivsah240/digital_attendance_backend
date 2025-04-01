const mongoose = require("mongoose");

const ArchiveSubjectSchema = new mongoose.Schema({}, { strict: false });
const ArchiveSubject = mongoose.model(
  "ArchiveSubject",
  ArchiveSubjectSchema,
  "archived_subjects"
);

module.exports = ArchiveSubject;

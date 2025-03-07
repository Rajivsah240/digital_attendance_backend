const mongoose = require("mongoose");
const SubjectSchema = new mongoose.Schema({
  subjectCode: { type: String, required: true },
  subjectName: { type: String, required: true },
  department: { type: String, required: true },
  course: { type: String, required: true },
  semester: { type: String, required: true },
  faculty: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  students: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  attendanceRecords: [
    {
      date: { type: Date, required: true },
      attendance: [
        {
          student: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
          },
          present: { type: Boolean, default: false },
        },
      ],
    },
  ],
  createdAt: {
    type: Date,
    default: () => new Date(),
  },
});

module.exports = mongoose.model("Subject", SubjectSchema);

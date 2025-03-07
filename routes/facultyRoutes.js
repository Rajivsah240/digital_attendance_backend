const express = require("express");
const router = express.Router();
const Subject = require("../models/Subject");
const User = require("../models/User");
const xlsx = require("xlsx");
const path = require("path");
const fs = require("fs");
const redisClient = require("../config/redis");
const transporter = require("../utils/emailService");


router.post("/add-subject", async (req, res) => {
  try {
    const {
      subjectCode,
      subjectName,
      course,
      semester,
      department,
      facultyEmail,
    } = req.body;
    if (
      !subjectCode ||
      !subjectName ||
      !course ||
      !department ||
      !semester ||
      !facultyEmail
    ) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const faculty = await User.findOne({ email: facultyEmail });

    const existingSubject = await Subject.findOne({
      subjectCode,
    });
    if (existingSubject) {
      return res.status(409).json({
        error: "Subject already exists for this course and semester",
      });
    }

    const newSubject = new Subject({
      subjectCode,
      subjectName,
      course,
      department,
      semester,
      faculty: faculty._id,
    });

    await newSubject.save();

    res.status(201).json({
      message: "Subject added successfully",
      subject: newSubject,
    });
  } catch (error) {
    console.error("Error adding subject:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/delete-subject/:subjectCode", async (req, res) => {
  try {
    const { subjectCode } = req.params;
    const subject = await Subject.findOneAndDelete({ subjectCode });
    if (!subject) {
      return res.status(404).json({ error: "Subject not found" });
    }

    res.status(200).json({ message: "Subject deleted successfully" });
  } catch (error) {
    console.error("Error deleting subject:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


router.get("/dashboard/:email", async (req, res) => {
  try {
    const faculty = await User.findOne({ email: req.params.email });
    if (!faculty) return res.status(404).json({ error: "Faculty not found" });

    const subjects = await Subject.find({ faculty: faculty._id })
      .populate("students")
      .populate("attendanceRecords.attendance.student");

    const response = subjects.map((subject) => {
      const records = subject.attendanceRecords;

      const attendancePercentages = records.map((record) => {
        const totalStudents = subject.students.length;
        const presentCount = record.attendance.filter(
          (entry) => entry.present
        ).length;
        return totalStudents > 0 ? (presentCount / totalStudents) * 100 : 0;
      });

      const averageAttendance =
        attendancePercentages.length > 0
          ? attendancePercentages.reduce((sum, percent) => sum + percent, 0) /
            attendancePercentages.length
          : 0;

      return {
        subjectCode: subject.subjectCode,
        subjectName: subject.subjectName,
        numberOfStudents: subject.students.length,
        numberOfClassesTaken: subject.attendanceRecords.length,
        averageAttendance: averageAttendance,
        lastClassDate: subject.attendanceRecords.length
          ? subject.attendanceRecords.at(-1).date
          : "No classes yet",
        attendanceRecords: subject.attendanceRecords.map((record) => ({
          date: record.date,
          Students: record.attendance.map((entry) => ({
            _id: entry.student._id,
            name: entry.student.name,
            scholarID: entry.student.registration_number,
            present: entry.present,
          })),
        })),
      };
    });

    res.json(response);
  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/attendanceRecord/:subjectCode", async (req, res) => {
  try {
    const { subjectCode } = req.params;

    const subject = await Subject.findOne({ subjectCode })
      .populate("students")
      .populate("attendanceRecords.attendance.student");

    if (!subject) {
      return res.status(404).json({ error: "Subject not found" });
    }

    const attendanceResponse = {
      subjectCode: subject.subjectCode,
      subjectName: subject.subjectName,
      attendanceRecords: subject.attendanceRecords.map((record) => ({
        date: record.date,
        Students: record.attendance.map((entry) => ({
          _id: entry.student._id,
          name: entry.student.name,
          scholarID: entry.student.registration_number,
          present: entry.present,
        })),
      })),
    };

    res.json(attendanceResponse);
  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});


router.post("/start-attendance", async (req, res) => {
  const { email, subjectCode, location } = req.body;

  const subject = await Subject.findOne({ subjectCode });
  if (!subject)
    return res.status(404).json({ success: false, error: "Subject not found" });

  const todayDate = new Date().toISOString().split("T")[0];

  const alreadyExists = subject.attendanceRecords.some(
    (record) => record.date.toISOString().split("T")[0] === todayDate
  );

  if (alreadyExists) {
    return res.status(400).json({
      success: false,
      error: "Attendance for today has already been done.",
    });
  }

  await redisClient.hSet(
    `attendance:${subjectCode}`,
    email,
    JSON.stringify(location)
  );
  await redisClient.expire(`attendance:${subjectCode}`, 300);

  const newAttendanceRecord = {
    date: new Date(),
    attendance: subject.students.map((studentId) => ({
      student: studentId,
      present: false,
    })),
  };

  subject.attendanceRecords.push(newAttendanceRecord);
  await subject.save();

  res.json({ success: true, message: "Attendance started" });
});


router.post("/stop-attendance", async (req, res) => {
  const { email, subjectCode } = req.body;

  if (!email || !subjectCode) {
    return res.status(400).json({ success: false, message: "Invalid data" });
  }

  await redisClient.hDel(`attendance:${subjectCode}`, email);
  res.json({ success: true, message: "Attendance stopped" });
});

router.post("/update-attendance", async (req, res) => {
  try {
    const { subjectCode, date, updatedAttendance } = req.body;

    if (!subjectCode || !date || !updatedAttendance) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const subject = await Subject.findOne({ subjectCode });
    if (!subject) {
      return res.status(404).json({ error: "Subject not found" });
    }

    const record = subject.attendanceRecords.find(
      (record) =>
        record.date.toISOString().split("T")[0] ===
        new Date(date).toISOString().split("T")[0]
    );

    if (!record) {
      return res
        .status(404)
        .json({ error: "Attendance record not found for this date" });
    }

    updatedAttendance.forEach(({ _id, present }) => {
      const studentRecord = record.attendance.find(
        (entry) => entry.student.toString() === _id
      );
      if (studentRecord) {
        studentRecord.present = present;
      }
    });

    await subject.save();

    return res.json({
      success: true,
      message: "Attendance updated successfully",
    });
  } catch (error) {
    console.error("Error updating attendance:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});


router.get("/email-attendance/:subjectCode", async (req, res) => {
  try {
    const { subjectCode } = req.params;

    const subject = await Subject.findOne({ subjectCode })
      .populate("faculty")
      .populate("students");
    if (!subject) {
      return res.status(404).json({ message: "Subject not found" });
    }

    const attendanceMap = new Map();
    subject.students.forEach((student) => {
      attendanceMap.set(student._id.toString(), {
        name: student.name,
        regNo: student.registration_number,
        presentDays: 0,
        totalDays: subject.attendanceRecords.length,
        attendance: [],
      });
    });

    subject.attendanceRecords.forEach((record) => {
      record.attendance.forEach((entry) => {
        if (attendanceMap.has(entry.student.toString())) {
          const studentData = attendanceMap.get(entry.student.toString());
          studentData.attendance.push(entry.present ? "P" : "A");
          if (entry.present) studentData.presentDays++;
        }
      });
    });

    const header = [
      [`Attendance Report for ${subject.subjectName}`],
      [`Total Classes Conducted: ${subject.attendanceRecords.length}`],
      [],
    ];
    const data = [
      [
        "Name",
        "Reg No",
        "Attendance %",
        ...subject.attendanceRecords.map(
          (r) => r.date.toISOString().split("T")[0]
        ),
      ],
    ];

    attendanceMap.forEach((value) => {
      const percentage = ((value.presentDays / value.totalDays) * 100).toFixed(
        2
      );
      data.push([value.name, value.regNo, percentage, ...value.attendance]);
    });

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.aoa_to_sheet([...header, ...data]);

    const range = xlsx.utils.decode_range(ws["!ref"]);
    for (let row = 3; row <= range.e.r; row++) {
      const cellRef = xlsx.utils.encode_cell({ r: row, c: 2 });
      if (!ws[cellRef]) continue;
      const value = parseFloat(ws[cellRef].v);
      let color = "";
      if (value <= 50) color = "FF0000";
      else if (value <= 75) color = "FFFF00";
      else if (value <= 85) color = "90EE90";
      else color = "008000";

      ws[cellRef].s = {
        fill: { patternType: "solid", fgColor: { rgb: color } },
        font: { bold: true, color: { rgb: "FFFFFF" } },
        alignment: { horizontal: "center", vertical: "center" },
      };
    }

    xlsx.utils.book_append_sheet(wb, ws, "Attendance");
    const filePath = path.join(__dirname, `Attendance_${subjectCode}.xlsx`);
    xlsx.writeFile(wb, filePath);

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: subject.faculty.email,
      subject: `Attendance Report for ${subject.subjectName}`,
      text: "Please find the attached attendance sheet.",
      attachments: [
        { filename: `Attendance_${subjectCode}.xlsx`, path: filePath },
      ],
    });

    fs.unlinkSync(filePath);
    res.json({ message: "Attendance sheet sent successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

module.exports = router;
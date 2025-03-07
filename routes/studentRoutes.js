const express = require("express");
const router = express.Router();

const User = require("../models/User");
const Subject = require("../models/Subject");
const redisClient = require("../config/redis");


router.get("/student/faculty-location/:subjectCode", async (req, res) => {
  const { subjectCode } = req.params;

  const facultyLocation = await redisClient.hGetAll(
    `attendance:${subjectCode}`
  );

  if (!facultyLocation || Object.keys(facultyLocation).length === 0) {
    return res
      .status(404)
      .json({ success: false, error: "Attendance not started yet" });
  }

  const firstFaculty = Object.keys(facultyLocation)[0];
  const location = JSON.parse(facultyLocation[firstFaculty]);

  res.json({ success: true, location });
});


router.get("/student/subjects", async (req, res) => {
  try {
    const subjects = await Subject.find({});
    const grouped = {};
    subjects.forEach((subject) => {
      const { course, department, semester, subjectCode } = subject;
      if (!grouped[course]) {
        grouped[course] = {};
      }
      if (!grouped[course][department]) {
        grouped[course][department] = {};
      }
      if (!grouped[course][department][semester]) {
        grouped[course][department][semester] = [];
      }
      grouped[course][department][semester].push(subjectCode);
    });
    res.json(grouped);
  } catch (error) {
    console.error("Error fetching subjects:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


router.post("/student/enroll", async (req, res) => {
  const { studentEmail, subjectCode } = req.body;
  try {
    const subject = await Subject.findOne({ subjectCode });
    if (!subject) return res.status(404).json({ error: "Subject not found" });

    const student = await User.findOne({ email: studentEmail });
    if (!student)
      return res.status(403).json({ error: "Invalid student account" });
    if (subject.students.includes(student._id)) {
      return res.status(400).json({ error: "Student already enrolled" });
    }
    subject.students.push(student._id);
    await subject.save();

    res.status(200).json({ message: "Enrollment successful" });
  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});


router.get("/student/dashboard/:email", async (req, res) => {
  try {
    const student = await User.findOne({ email: req.params.email });
    if (!student) {
      return res.status(404).json({ error: "Student not found" });
    }

    const subjects = await Subject.find({ students: student._id }).populate(
      "attendanceRecords.attendance.student",
      "name email registration_number"
    );

    const response = subjects.map((subject) => {
      const totalClasses = subject.attendanceRecords.length;
      let presentCount = 0;

      const cumulativeAttendance = subject.attendanceRecords.map(
        (record, index) => {
          const studentAttendance = record.attendance.find(
            (entry) => entry.student.email === student.email
          );

          const isPresent = studentAttendance
            ? studentAttendance.present
            : false;
          if (isPresent) presentCount++;

          return {
            value: Math.round((presentCount / (index + 1)) * 100), // Cumulative %
            label: new Date(record.date).toLocaleDateString("en-US", {
              day: "numeric",
              month: "short",
            }),
          };
        }
      );

      return {
        subjectCode: subject.subjectCode,
        subjectName: subject.subjectName,
        department: subject.department,
        course: subject.course,
        semester: subject.semester,
        faculty: subject.faculty,
        totalClasses,
        attendedClasses: presentCount,
        lastClassDate: totalClasses
          ? subject.attendanceRecords.at(-1).date
          : "No classes yet",
        cumulativeAttendance,
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
    console.error("Error fetching student dashboard:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


router.post("/student/mark-attendance", async (req, res) => {
  try {
    const { studentEmail, subjectCode } = req.body;

    if (!studentEmail || !subjectCode) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const subject = await Subject.findOne({ subjectCode });
    if (!subject) {
      return res.status(404).json({ error: "Subject not found" });
    }

    const student = await User.findOne({ email: studentEmail });
    if (!student) {
      return res.status(404).json({ error: "Student not found" });
    }

    if (!subject.attendanceRecords.length) {
      return res.status(400).json({ error: "No attendance records found" });
    }

    const latestRecord = subject.attendanceRecords.at(-1);

    const studentAttendance = latestRecord.attendance.find((entry) =>
      entry.student.equals(student._id)
    );

    if (!studentAttendance) {
      return res
        .status(400)
        .json({ error: "Student not listed in attendance" });
    }

    if (studentAttendance.present) {
      return res
        .status(400)
        .json({ error: "Attendance already marked for today" });
    }

    studentAttendance.present = true;
    await subject.save();

    res.status(200).json({ message: "Attendance marked successfully" });
  } catch (error) {
    console.error("Error marking attendance:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
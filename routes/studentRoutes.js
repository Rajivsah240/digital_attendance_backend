const express = require("express");
const router = express.Router();

const User = require("../models/User");
const Subject = require("../models/Subject");
const redisClient = require("../config/redis");

router.get("/faculty-location/:subjectID", async (req, res) => {
  const { subjectID } = req.params;

  const facultyLocation = await redisClient.hGetAll(`attendance:${subjectID}`);

  if (!facultyLocation || Object.keys(facultyLocation).length === 0) {
    return res
      .status(404)
      .json({ success: false, error: "Attendance not started yet" });
  }

  const firstFaculty = Object.keys(facultyLocation)[0];
  const location = JSON.parse(facultyLocation[firstFaculty]);

  res.json({ success: true, location });
});


router.get("/subjects", async (req, res) => {
  try {
    const subjects = await Subject.find({});
    const grouped = {};
    subjects.forEach((subject) => {
      const { programme, department, semester, subjectID } = subject;
      if (!grouped[programme]) {
        grouped[programme] = {};
      }
      if (!grouped[programme][department]) {
        grouped[programme][department] = {};
      }
      if (!grouped[programme][department][semester]) {
        grouped[programme][department][semester] = [];
      }
      grouped[programme][department][semester].push(subjectID);
    });
    res.json(grouped);
  } catch (error) {
    console.error("Error fetching subjects:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


router.post("/enroll", async (req, res) => {
  const { studentEmail, subjectID } = req.body;
  try {
    const subject = await Subject.findOne({ subjectID });
    if (!subject) return res.status(404).json({ error: "Subject not found" });

    const student = await User.findOne({ email: studentEmail });
    if (!student)
      return res.status(403).json({ error: "Invalid student account" });

    if (subject.students.includes(student._id)) {
      return res
        .status(409)
        .json({ error: "Student is already enrolled in this subject" });
    }

    const requestKey = `enrollment_requests:${subjectID}`;

    const existingRequest = await redisClient.hGet(requestKey, studentEmail);
    if (existingRequest) {
      return res
        .status(409)
        .json({ error: "Enrollment request already submitted" });
    }

    await redisClient.hSet(
      requestKey,
      studentEmail,
      JSON.stringify({
        email: studentEmail,
        name: student.name,
        scholarID: student.registration_number,
        timestamp: Date.now(),
      })
    );

    res.status(200).json({ message: "Enrollment request submitted" });
  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/pending-enrollments", async (req, res) => {
  const { studentEmail } = req.body;

  try {
    if (!studentEmail) {
      return res.status(400).json({ error: "Student email is required" });
    }

    const student = await User.findOne({ email: studentEmail });
    if (!student) {
      return res.status(403).json({ error: "Invalid student account" });
    }

    const keys = await redisClient.keys("enrollment_requests:*");
    const pendingSubjects = [];

    for (const key of keys) {
      const enrollmentRequests = await redisClient.hGetAll(key);
      if (enrollmentRequests[studentEmail]) {
        const subjectID = key.split(":")[1];
        const subject = await Subject.findOne(
          { subjectID },
          "subjectID subjectCode subjectName"
        );
        if (subject) {
          pendingSubjects.push(subject);
        }
      }
    }

    res.status(200).json({ pendingSubjects });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/unenroll", async (req, res) => {
  const { subjectID, email } = req.body;

  try {
    const subject = await Subject.findOne({ subjectID }).populate("students");

    if (!subject) {
      return res.status(404).json({ error: "Subject not found" });
    }

    const student = await User.findOne({ email });

    if (!student) {
      return res.status(404).json({ error: "Student not found" });
    }

    subject.students = subject.students.filter(
      (s) => s._id.toString() !== student._id.toString()
    );

    subject.attendanceRecords.forEach((record) => {
      record.attendance = record.attendance.filter(
        (entry) => entry.student.toString() !== student._id.toString()
      );
    });

    await subject.save();
    res.status(200).json({ message: "Student removed successfully!" });
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});


router.get("/dashboard/:email", async (req, res) => {
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
        subjectID: subject.subjectID,
        subjectCode: subject.subjectCode,
        subjectName: subject.subjectName,
        programme: subject.programme,
        department: subject.department,
        section: subject.section,
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
            email: entry.student.email,
            scholarID: entry.student.registration_number,
            present: entry.present,
          })),
        })),
      };
    });

    res.status(200).json(response);
  } catch (error) {
    console.error("Error fetching student dashboard:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


router.post("/mark-attendance", async (req, res) => {
  try {
    const { studentEmail, subjectID } = req.body;

    if (!studentEmail || !subjectID) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const subject = await Subject.findOne({ subjectID });
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

const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Subject = require("../models/Subject");
const ArchiveSubject = require("../models/ArchiveSubject");
const xlsx = require("xlsx");
const path = require("path");
const fs = require("fs");
const redisClient = require("../config/redis");
const transporter = require("../utils/emailService");

router.post("/add-subject", async (req, res) => {
  try {
    const {
      subjectID,
      subjectCode,
      subjectName,
      programme,
      semester,
      department,
      section,
      facultyEmail,
    } = req.body;
    if (
      !subjectID ||
      !subjectCode ||
      !subjectName ||
      !programme ||
      !department ||
      !section ||
      !semester ||
      !facultyEmail
    ) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const faculty = await User.findOne({ email: facultyEmail });

    const existingSubject = await Subject.findOne({
      subjectID,
    });
    if (existingSubject) {
      return res.status(409).json({
        error: "Subject already exists for this course and semester",
      });
    }

    const newSubject = new Subject({
      subjectID,
      subjectCode,
      subjectName,
      programme,
      department,
      section,
      semester,
      faculties: [faculty._id],
    });

    await newSubject.save();

    res.status(201).json({
      message: "Subject added successfully",
    });
  } catch (error) {
    console.error("Error adding subject:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/new-requests", async (req, res) => {
  const { facultyEmail } = req.query;
  try {
    const faculty = await User.findOne({ email: facultyEmail });
    const subjects = await Subject.find({ faculties: faculty._id });
    let enrollmentRequest = false;
    let collabRequest = false;

    for (const subject of subjects) {
      const requestKey = `enrollment_requests:${subject.subjectID}`;
      const requests = await redisClient.hGetAll(requestKey);

      if (Object.keys(requests).length > 0) {
        enrollmentRequest = true;
      }
    }
    const requestKey = `faculty_request:${facultyEmail}`;
    const requests = await redisClient.sMembers(requestKey);
    if (requests.length > 0) {
      collabRequest = true;
    }
    res.status(200).json({ enrollmentRequest, collabRequest });
  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/enrollment-requests", async (req, res) => {
  const { facultyEmail } = req.query;
  try {
    const faculty = await User.findOne({ email: facultyEmail });
    if (!faculty)
      return res.status(403).json({ error: "Invalid faculty account" });

    const subjects = await Subject.find({ faculties: faculty._id });
    if (!subjects.length)
      return res
        .status(404)
        .json({ error: "No subjects found for this faculty" });

    let enrollmentRequests = {};

    for (const subject of subjects) {
      const requestKey = `enrollment_requests:${subject.subjectID}`;
      const requests = await redisClient.hGetAll(requestKey);

      enrollmentRequests[subject.subjectID] = Object.keys(requests).map(
        (studentEmail) => ({
          studentEmail,
          name: JSON.parse(requests[studentEmail]).name,
          scholarID: JSON.parse(requests[studentEmail]).scholarID,
          timestamp: JSON.parse(requests[studentEmail]).timestamp,
        })
      );
    }

    res.status(200).json({ enrollmentRequests });
  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/enroll-student", async (req, res) => {
  const { facultyEmail, studentEmail, subjectID, action } = req.body;

  try {
    const faculty = await User.findOne({ email: facultyEmail });
    if (!faculty)
      return res.status(403).json({ error: "Invalid faculty account" });

    const subject = await Subject.findOne({
      subjectID,
      faculties: faculty._id,
    });
    if (!subject)
      return res
        .status(404)
        .json({ error: "Subject not found or unauthorized" });

    const student = await User.findOne({ email: studentEmail });
    if (!student)
      return res.status(403).json({ error: "Invalid student account" });

    const requestKey = `enrollment_requests:${subjectID}`;

    if (action === "approve") {
      subject.students.push(student._id);
      subject.attendanceRecords.forEach((record) => {
        record.attendance.push({ student: student._id, present: false });
      });
      await subject.save();
    }

    await redisClient.hDel(requestKey, studentEmail);

    res.status(200).json({ message: `Enrollment ${action}d successfully` });
  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/add-faculty", async (req, res) => {
  try {
    const { subjectID, email, requestedByEmail } = req.body;

    if (!subjectID || !email || !requestedByEmail) {
      return res.status(400).json({
        error: "Subject ID, Faculty Email, and Requester Email are required",
      });
    }

    const faculty = await User.findOne({ email, role: "Faculty" });
    if (!faculty) {
      return res.status(404).json({ error: "Faculty not found" });
    }

    const subject = await Subject.findOne({ subjectID });
    if (!subject) {
      return res.status(404).json({ error: "Subject not found" });
    }

    const requester = await User.findOne({ email: requestedByEmail });

    if (subject.faculties.includes(faculty._id)) {
      return res
        .status(409)
        .json({ error: "Faculty already assigned to this subject" });
    }

    const requestKey = `faculty_request:${email}`;
    const requestData = JSON.stringify({
      subjectID,
      email: requestedByEmail,
      name: requester.name,
      department: subject.department,
      subjectName: subject.subjectName,
      section: subject.section,
      programme: subject.programme,
      semester: subject.semester,
    });

    await redisClient.sAdd(requestKey, requestData);

    res.status(200).json({ message: "Request sent to faculty for approval" });
  } catch (error) {
    console.error("Error requesting faculty addition:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/pending-requests", async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ error: "Faculty email is required" });
    }

    const requestKey = `faculty_request:${email}`;
    const requests = await redisClient.sMembers(requestKey);

    if (!requests.length) {
      return res.status(200).json({ message: "No pending requests" });
    }

    const parsedRequests = requests.map((req) => JSON.parse(req));

    res.status(200).json({ pendingRequests: parsedRequests });
  } catch (error) {
    console.error("Error fetching faculty requests:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/respond-request", async (req, res) => {
  try {
    const { subjectID, email, action } = req.body;

    if (!subjectID || !email || !action) {
      return res.status(400).json({
        error: "Subject ID, Faculty Email, and Action are required",
      });
    }

    const requestKey = `faculty_request:${email}`;
    const requests = await redisClient.sMembers(requestKey);
    const requestData = requests.find(
      (req) => JSON.parse(req).subjectID === subjectID
    );

    if (!requestData) {
      return res.status(404).json({ error: "Request not found" });
    }

    if (action === "accept") {
      const faculty = await User.findOne({ email });
      if (!faculty) {
        return res.status(404).json({ error: "Faculty not found" });
      }

      const subject = await Subject.findOne({ subjectID });
      if (!subject) {
        return res.status(404).json({ error: "Subject not found" });
      }

      subject.faculties.push(faculty._id);
      await subject.save();

      await redisClient.sRem(requestKey, requestData);

      return res.status(200).json({ message: "Faculty added successfully" });
    }

    if (action === "reject") {
      await redisClient.sRem(requestKey, requestData);
      return res.status(200).json({ message: "Request rejected" });
    }

    res.status(400).json({ error: "Invalid action" });
  } catch (error) {
    console.error("Error processing faculty request:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/delete-subject/:subjectID", async (req, res) => {
  try {
    const { subjectID } = req.params;
    const subject = await ArchiveSubject.findOneAndDelete({ subjectID });
    if (!subject) {
      return res.status(404).json({ error: "Subject not found" });
    }

    res.status(200).json({ message: "Subject deleted successfully" });
  } catch (error) {
    console.error("Error deleting subject:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/archive-subject", async (req, res) => {
  try {
    const { subjectID, email } = req.body;

    if (!subjectID || !email) {
      return res
        .status(400)
        .json({ error: "SubjectID and Email are required" });
    }

    const faculty = await User.findOne({ email, role: "Faculty" });
    if (!faculty) {
      return res
        .status(404)
        .json({ error: "Faculty not found or not authorized" });
    }

    const subject = await Subject.findOne({ subjectID }).populate("faculties");
    if (!subject) {
      return res.status(404).json({ error: "Subject not found" });
    }

    const isFacultyAssigned = subject.faculties.some((fac) =>
      fac._id.equals(faculty._id)
    );
    if (!isFacultyAssigned) {
      return res
        .status(403)
        .json({ error: "Faculty is not assigned to this subject" });
    }

    await ArchiveSubject.create(subject.toObject());

    await Subject.deleteOne({ _id: subject._id });

    return res.status(200).json({ message: "Subject archived successfully" });
  } catch (error) {
    console.error("Error archiving subject:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/unarchive-subject", async (req, res) => {
  try {
    const { subjectID, email } = req.body;
    if (!subjectID || !email) {
      return res
        .status(400)
        .json({ error: "SubjectID and Email are required" });
    }
    const faculty = await User.findOne({ email, role: "Faculty" });
    if (!faculty) {
      return res
        .status(404)
        .json({ error: "Faculty not found or not authorized" });
    }
    const archivedSubject = await ArchiveSubject.findOne({ subjectID });
    if (!archivedSubject) {
      return res.status(404).json({ error: "Archived subject not found" });
    }
    await Subject.create(archivedSubject.toObject());
    await ArchiveSubject.deleteOne({ _id: archivedSubject._id });
    return res.status(200).json({ message: "Subject unarchived successfully" });
  } catch (error) {
    console.error("Error unarchiving subject:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/get-archived-subjects/:email", async (req, res) => {
  try {
    const { email } = req.params;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const faculty = await User.findOne({ email, role: "Faculty" });

    if (!faculty) {
      return res.status(404).json({ error: "Faculty not found" });
    }

    const archivedSubjects = await ArchiveSubject.find({
      "faculties._id": faculty._id,
    });

    return res.status(200).json({ archivedSubjects });
  } catch (error) {
    console.error("Error fetching archived s,ubjects:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});


router.get("/dashboard/:email", async (req, res) => {
  try {
    const faculty = await User.findOne({ email: req.params.email });
    if (!faculty) return res.status(404).json({ error: "Faculty not found" });

    const subjects = await Subject.find({ faculties: faculty._id })
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
        subjectID: subject.subjectID,
        subjectCode: subject.subjectCode,
        subjectName: subject.subjectName,
        department: subject.department,
        section: subject.section,
        programme: subject.programme,
        semester: subject.semester,
        numberOfStudents: subject.students.length,
        numberOfClassesTaken: subject.attendanceRecords.length,
        averageAttendance: averageAttendance,
        lastClassDate: subject.attendanceRecords.length
          ? subject.attendanceRecords.at(-1).date
          : "No classes yet",
        students: subject.students.map((student) => ({
          _id: student._id,
          name: student.name,
          scholarID: student.registration_number,
        })),
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

router.get("/attendanceRecord/:subjectID", async (req, res) => {
  try {
    const { subjectID } = req.params;

    const subject = await Subject.findOne({ subjectID })
      .populate("students")
      .populate("attendanceRecords.attendance.student");

    if (!subject) {
      return res.status(404).json({ error: "Subject not found" });
    }

    const attendanceResponse = {
      subjectID: subject.subjectID,
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

    res.status(200).json(attendanceResponse);
  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get(
  "/get-attendance/:subjectID/:selectedDate",
  async (req, res) => {
    try {
      const { subjectID, selectedDate } = req.params;
      const targetDate = new Date(selectedDate);

      const subject = await Subject.findOne({ subjectID })
        .populate("students")
        .populate("attendanceRecords.attendance.student");

      if (!subject) {
        return res.status(404).json({ error: "Subject not found" });
      }

      const attendanceRecord = subject.attendanceRecords.find(
        (record) =>
          record.date.toISOString().split("T")[0] ===
          targetDate.toISOString().split("T")[0]
      );

      if (!attendanceRecord) {
        return res
          .status(404)
          .json({ error: "Attendance record not found for the given date" });
      }

      const attendanceResponse = {
        subjectID: subject.subjectID,
        subjectCode: subject.subjectCode,
        subjectName: subject.subjectName,
        date: attendanceRecord.date,
        Students: attendanceRecord.attendance.map((entry) => ({
          _id: entry.student._id,
          name: entry.student.name,
          scholarID: entry.student.registration_number,
          present: entry.present,
        })),
      };

      res.status(200).json(attendanceResponse);
    } catch (error) {
      res.status(500).json({ error: "Internal Server Error" });
    }
  }
);


router.post("/start-attendance", async (req, res) => {
  const { email, subjectID, location } = req.body;

  const subject = await Subject.findOne({ subjectID });
  if (!subject)
    return res.status(404).json({ success: false, error: "Subject not found" });

  const todayDate = new Date().toISOString().split("T")[0];

  const alreadyExists = subject.attendanceRecords.some(
    (record) => record.date.toISOString().split("T")[0] === todayDate
  );

  await redisClient.hSet(
    `attendance:${subjectID}`,
    email,
    JSON.stringify(location)
  );
  await redisClient.expire(`attendance:${subjectID}`, 300);

  const newAttendanceRecord = {
    date: new Date(),
    attendance: subject.students.map((studentId) => ({
      student: studentId,
      present: false,
    })),
  };

  if (!alreadyExists) {
    subject.attendanceRecords.push(newAttendanceRecord);
  }
  await subject.save();

  res.json({ success: true, message: "Attendance started" });
});

router.post("/stop-attendance", async (req, res) => {
  const { email, subjectID } = req.body;

  if (!email || !subjectID) {
    return res.status(400).json({ success: false, error: "Invalid data" });
  }

  await redisClient.hDel(`attendance:${subjectID}`, email);
  res.json({ success: true, message: "Attendance stopped" });
});

router.delete("/delete-attendance", async (req, res) => {
  try {
    const { subjectID, date } = req.body;

    if (!subjectID || !date) {
      return res
        .status(400)
        .json({ error: "Subject code and date are required" });
    }

    const subject = await Subject.findOne({ subjectID });

    if (!subject) {
      return res.status(404).json({ error: "Subject not found" });
    }

    subject.attendanceRecords = subject.attendanceRecords.filter(
      (record) =>
        record.date.toISOString().split("T")[0] !==
        new Date(date).toISOString().split("T")[0]
    );

    await subject.save();

    res.status(200).json({
      success: true,
      message: "Attendance record deleted successfully",
    });
  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

router.post("/update-attendance", async (req, res) => {
  try {
    const { subjectID, date, updatedAttendance } = req.body;

    if (!subjectID || !date || !updatedAttendance) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const subject = await Subject.findOne({ subjectID });
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

    return res.status(200).json({
      success: true,
      message: "Attendance updated successfully",
    });
  } catch (error) {
    console.error("Error updating attendance:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});


router.post("/email-attendance", async (req, res) => {
  try {
    const { subjectID, email } = req.body;

    const subject = await Subject.findOne({ subjectID })
      .populate("faculties")
      .populate("students");
    if (!subject) {
      return res.status(404).json({ error: "Subject not found" });
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
    const filePath = path.join(__dirname, `Attendance_${subjectID}.xlsx`);
    xlsx.writeFile(wb, filePath);

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: `Attendance Report for ${subject.subjectName}`,
      text: "Please find the attached attendance sheet.",
      attachments: [
        { filename: `Attendance_${subjectID}.xlsx`, path: filePath },
      ],
    });

    fs.unlinkSync(filePath);
    res.json({ message: "Attendance sheet sent successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;

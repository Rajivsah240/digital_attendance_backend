const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const dotenv = require("dotenv");
const cors = require("cors");
const cluster = require("cluster");
const os = require("os");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const redis = require("redis");
const nodemailer = require("nodemailer");
const morgan = require("morgan");
const xlsx = require("xlsx");
const path = require("path");
const fs = require("fs");
dotenv.config();
const numCPUs = os.cpus().length;

if (cluster.isPrimary) {
  console.log(`Master ${process.pid} is running`);
  for (let i = 0; i < numCPUs; i++) cluster.fork();
  cluster.on("exit", (worker) => {
    console.log(`Worker ${worker.process.pid} died. Restarting...`);
    cluster.fork();
  });
} else {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(helmet());
  app.use(morgan("combined"));

  mongoose
    .connect(process.env.MONGO_URI)
    .then(() => console.log("MongoDB connected"))
    .catch((err) => console.log(err));

  const redisClient = redis.createClient({
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    socket: {
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
    },
  });
  redisClient
    .connect()
    .then(() => console.log("Redis connected"))
    .catch(console.error);

  //Schemas
  const UserSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true },
    password: String,
    registration_number: String,
    role: String,
  });
  const User = mongoose.model("User", UserSchema);

  const SubjectSchema = new mongoose.Schema({
    subjectCode: { type: String, required: true },
    subjectName: { type: String, required: true },
    department: { type: String, required: true },
    course: { type: String, required: true },
    semester: { type: String, required: true },
    faculties: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
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
  const Subject = mongoose.model("Subject", SubjectSchema);

  const generateToken = (user, expiresIn) =>
    jwt.sign(user, process.env.JWT_SECRET_KEY, { expiresIn });

  // const limiter = rateLimit({
  //   windowMs: 1 * 60 * 1000,
  //   max: 5000,
  //   handler: (req, res) => res.status(429).json({ error: "Too many requests" }),
  // });
  // app.use(limiter);

  //Routes
  app.get("/", async (req, res) => {
    res.send("Hello World");
  });

  app.post("/register", async (req, res) => {
    const { name, email, password, registration_number, selected_role } =
      req.body;
    if (!(name && email && password && registration_number && selected_role))
      return res.status(400).json({ error: "All fields required" });

    const hashedPassword = await bcrypt.hash(password, 10);
    try {
      const user = new User({
        name,
        email,
        password: hashedPassword,
        registration_number,
        role: selected_role,
      });
      await user.save();
      res.status(201).json({ message: "Registration successful" });
    } catch (err) {
      res.status(409).json({ error: "Email already registered" });
    }
  });

  app.post("/login", async (req, res) => {
    const { email, password, role } = req.body;
    const user = await User.findOne({ email, role });
    if (!user || !bcrypt.compare(password, user.password))
      return res.status(401).json({ error: "Invalid credentials" });

    const accessToken = generateToken({ email, role }, "15m");
    const refreshToken = generateToken({ email, role }, "7d");

    res.json({
      login: "success",
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  });

  app.post("/refresh", (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.sendStatus(401);
    jwt.verify(refreshToken, process.env.JWT_SECRET_KEY, (err, user) => {
      if (err) return res.sendStatus(403);
      const newAccessToken = generateToken(
        { email: user.email, role: user.role },
        "15m"
      );
      res.json({ access_token: newAccessToken });
    });
  });

  app.post("/logout", (req, res) =>
    res.json({ message: "Logged out successfully" })
  );

  const generateOTP = () => Math.floor(1000 + Math.random() * 9000).toString();

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });

  app.post("/send-otp-first-time", async (req, res) => {
    const { email } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists!" });
    }

    const otp = generateOTP();
    const hashedOtp = await bcrypt.hash(otp, 10);

    await redisClient.setEx(`otp:${email}`, 600, hashedOtp);

    const subject = "OTP Verification";
    const body = `Your OTP for Email Verification is: ${otp}\nUse this to proceed.`;

    try {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: subject,
        text: body,
      });

      return res
        .status(200)
        .json({ success: true, message: `OTP sent to ${email}` });
    } catch (error) {
      return res.status(500).json({ error: "Failed to send OTP email" });
    }
  });

  app.post("/send-otp", async (req, res) => {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "Email not found" });

    const otp = generateOTP();
    const hashedOtp = await bcrypt.hash(otp, 10);
    await redisClient.setEx(`otp:${email}`, 300, hashedOtp);

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "OTP Verification",
      text: `Your OTP is: ${otp}`,
    });

    res.json({ success: true, message: `OTP sent to ${email}` });
  });

  app.post("/verify-otp", async (req, res) => {
    const { email, otp } = req.body;
    const storedHash = await redisClient.get(`otp:${email}`);
    if (!storedHash || !(await bcrypt.compare(otp, storedHash)))
      return res.status(400).json({ error: "Invalid or expired OTP" });

    await redisClient.del(`otp:${email}`);
    res.json({ success: true, message: "OTP verified" });
  });

  app.post("/reset-password", async (req, res) => {
    const { email, newPassword } = req.body;
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await User.updateOne({ email }, { password: hashedPassword });
    res.json({ success: true, message: "Password reset successful" });
  });

  // Faculty - add subject
  app.post("/faculty/add-subject", async (req, res) => {
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
        faculties: [faculty._id],
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

  app.post("/faculty/add-faculty", async (req, res) => {
    try {
      const { subjectCode, email } = req.body;
  
      if (!subjectCode || !email) {
        return res.status(400).json({ error: "Subject Code and Faculty Email are required" });
      }
  
      const faculty = await User.findOne({ email });
      if (!faculty) {
        return res.status(404).json({ error: "Faculty not found" });
      }
  
      const subject = await Subject.findOne({ subjectCode });
      if (!subject) {
        return res.status(404).json({ error: "Subject not found" });
      }
  
      
      if (subject.faculties.includes(faculty._id)) {
        return res.status(409).json({ error: "Faculty already assigned to this subject" });
      }
  
      
      subject.faculties.push(faculty._id);
      await subject.save();
  
      res.status(200).json({ message: "Faculty added successfully", subject });
    } catch (error) {
      console.error("Error adding faculty:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.delete("/faculty/delete-subject/:subjectCode", async (req, res) => {
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

  app.post("/faculty/remove-student", async (req, res) => {
    const { subjectCode, scholarID } = req.body;

    try {
      const subject = await Subject.findOne({ subjectCode }).populate(
        "students"
      );

      if (!subject) {
        return res.status(404).json({success : false, message: "Subject not found" });
      }

      const student = await User.findOne({ registration_number: scholarID });

      if (!student) {
        return res.status(404).json({success : false, message: "Student not found" });
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
      res.status(200).json({success : true, message: "Student removed successfully!" });
    } catch (error) {
      res.status(500).json({success : false, message: "Server error" });
    }
  });

  // Faculty - Get Subjects with Stats
  app.get("/faculty/dashboard/:email", async (req, res) => {
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
          subjectCode: subject.subjectCode,
          subjectName: subject.subjectName,
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

  app.get("/faculty/attendanceRecord/:subjectCode", async (req, res) => {
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

  // Faculty - Start Attendance
  app.post("/faculty/start-attendance", async (req, res) => {
    const { email, subjectCode, location } = req.body;

    const subject = await Subject.findOne({ subjectCode });
    if (!subject)
      return res
        .status(404)
        .json({ success: false, error: "Subject not found" });

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

  // Faculty - Stop Attendance
  app.post("/faculty/stop-attendance", async (req, res) => {
    const { email, subjectCode } = req.body;

    if (!email || !subjectCode) {
      return res.status(400).json({ success: false, message: "Invalid data" });
    }

    await redisClient.hDel(`attendance:${subjectCode}`, email);
    res.json({ success: true, message: "Attendance stopped" });
  });

  app.post("/faculty/update-attendance", async (req, res) => {
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

  // Export Attendance Report
  app.get("/faculty/email-attendance/:subjectCode", async (req, res) => {
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
        const percentage = (
          (value.presentDays / value.totalDays) *
          100
        ).toFixed(2);
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

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      });

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

  app.get("/student/faculty-location/:subjectCode", async (req, res) => {
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

  //Fetch subjects grouped by course, department, and semester
  app.get("/student/subjects", async (req, res) => {
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

  // Student - Enroll in Subject
  app.post("/student/enroll", async (req, res) => {
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
      subject.attendanceRecords.forEach((record) => {
        record.attendance.push({ student: student._id, present: false });
      });
      await subject.save();

      res.status(200).json({ message: "Enrollment successful" });
    } catch (error) {
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.post("/student/unenroll", async (req, res) => {
    const { subjectCode, email } = req.body;

    try {
      const subject = await Subject.findOne({ subjectCode }).populate(
        "students"
      );

      if (!subject) {
        return res.status(404).json({ message: "Subject not found" });
      }

      const student = await User.findOne({ email });

      if (!student) {
        return res.status(404).json({ message: "Student not found" });
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
      res.json({ message: "Student removed successfully!" });
    } catch (error) {
      res.status(500).json({ message: "Server error" });
    }
  });


  // Student - Get Enrolled Subjects
  app.get("/student/dashboard/:email", async (req, res) => {
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
              email: entry.student.email,
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

  // Student - Mark Attendance
  app.post("/student/mark-attendance", async (req, res) => {
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

  // Start Server
  app.listen(process.env.PORT || 5000, () => {
    const os = require("os");
    const interfaces = os.networkInterfaces();
    let ipAddress = "localhost";

    for (let iface of Object.values(interfaces)) {
      for (let config of iface) {
        if (config.family === "IPv4" && !config.internal) {
          ipAddress = config.address;
          break;
        }
      }
    }

    console.log(
      `Worker ${process.pid} running on http://${ipAddress}:${
        process.env.PORT || 5000
      }`
    );
  });
}

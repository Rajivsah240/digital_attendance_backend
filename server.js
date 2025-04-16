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
const e = require("express");

//github listner
const bodyParser = require("body-parser");
const crypto = require("crypto");
const { exec } = require("child_process");
const versionPath = path.join(__dirname, "version.json");
const APK_LINK = process.env.APK_LINK;
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
  app.use((req, res, next) => {
    res.setHeader("ngrok-skip-browser-warning", "true");
    next();
  });

  //github listener code start
  app.use("/github-webhook", bodyParser.raw({ type: "*/*" }));
  app.post("/github-webhook", (req, res) => {
    console.log("GitHub webhook received. Pulling latest code...");
    exec(
      "cd /home/server/Server/digital_attendance_backend && git pull origin main",
      (err, stdout, stderr) => {
        if (err) {
          console.error(`Pull failed: ${stderr}`);
          return res.status(500).send("Pull failed");
        }
        console.log(`Pull success:\n${stdout}`);
        res.status(200).send("Pulled latest code");
      }
    );
  });
  //github listener code end

  const connectMongoDB = async () => {
    try {
      await mongoose.connect(process.env.MONGO_URI, {
        maxPoolSize: 100,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      });
      console.log("MongoDB connected");
    } catch (err) {
      console.error("MongoDB connection failed");
      setTimeout(connectMongoDB, 4000);
    }
  };

  connectMongoDB();

  mongoose.connection.on("disconnected", () => {
    console.error("MongoDB disconnected! Retrying...");
    connectMongoDB();
  });

  mongoose.connection.on("error", (err) => {
    console.error("MongoDB error");
  });

  const redisClient = redis.createClient({
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    socket: {
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
    },
  });

  const connectRedis = async () => {
    try {
      await redisClient.connect();
      console.log("Redis connected");
    } catch (err) {
      console.error("Redis connection failed");
      setTimeout(connectRedis, 5000);
    }
  };

  connectRedis();

  redisClient.on("error", (err) => {
    console.error("Redis error");
  });

  redisClient.on("end", () => {
    console.warn("Redis disconnected! Retrying...");
    connectRedis();
  });

  const UserSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true },
    password: String,
    registration_number: String,
    role: String,
  });
  const User = mongoose.model("User", UserSchema);

  const SubjectSchema = new mongoose.Schema({
    subjectID: { type: String, required: true },
    subjectCode: { type: String, required: true },
    subjectName: { type: String, required: true },
    department: { type: String, required: true },
    section: { type: String, required: true },
    programme: { type: String, required: true },
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

  const ArchiveSubjectSchema = new mongoose.Schema({}, { strict: false });
  const ArchiveSubject = mongoose.model(
    "ArchiveSubject",
    ArchiveSubjectSchema,
    "archived_subjects"
  );

  const downloadSchema = new mongoose.Schema({
    count: {
      type: Number,
      default: 0,
    },
  });

  const download = mongoose.model("Download", downloadSchema);

  // async function createMultipleUsers() {
  //   const users = [
  //     { name: "Test Faculty 1", email: "testfaculty1@example.com", password: "Test@faculty1", registration_number: "NITS12345", role: "Faculty" },
  //     { name: "Test Faculty 2", email: "testfaculty2@example.com", password: "Test@faculty2", registration_number: "NITS67890", role: "Faculty" },
  //     { name: "Test Student 1", email: "teststudent1@example.com", password: "Test@student1", registration_number: "NITS12354", role: "Student" },
  //     { name: "Test Student 2", email: "teststudent2@example.com", password: "Test@student2", registration_number: "NITS12435", role: "Student" }
  //   ];

  //   for (let user of users) {
  //     user.password = await bcrypt.hash(user.password, 10);
  //   }

  //   await User.insertMany(users);
  //   console.log("Multiple users inserted successfully!");
  // }

  // createMultipleUsers();

  const generateToken = (user, expiresIn) =>
    jwt.sign(user, process.env.JWT_SECRET_KEY, { expiresIn });

  app.get("/", async (req, res) => {
    res.send("Hello World");
  });

  // Website
  app.get("/stats", async (req, res) => {
    try {
      let Download = await download.findOne();
      if (!Download) Download = await download.create({});

      const userCount = await User.countDocuments();

      res.json({
        downloads: Download.count,
        activeUsers: userCount,
      });
    } catch (error) {
      console.error("Stats API error:", error);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  app.get("/download", async (req, res) => {
    let record = await download.findOne();
    if (!record) {
      record = await download.create({});
    }

    record.count += 1;
    await record.save();

    res.json({ apkUrl: APK_LINK });
  });

  app.get("/latest-version", (req, res) => {
    try {
      const versionData = JSON.parse(fs.readFileSync(versionPath, "utf-8"));
      res.json(versionData);
    } catch (err) {
      console.error("Error reading version.json:", err);
      res.status(500).json({ error: "Unable to fetch version data" });
    }
  });

  app.post("/register", async (req, res) => {
    const { name, email, password, registration_number, selected_role } =
      req.body;

    if (!(name && email && password && selected_role))
      return res.status(400).json({ error: "All fields required" });

    if (selected_role === "Student" && !registration_number)
      return res
        .status(400)
        .json({ error: "Registration number is required for students" });

    const hashedPassword = await bcrypt.hash(password, 10);

    try {
      const user = new User({
        name,
        email,
        password: hashedPassword,
        registration_number:
          selected_role === "Student" ? registration_number : undefined,
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
      name: user.name,
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
      return res.status(400).json({ error: "User already exists!" });
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
    res.status(200).json({ success: true, message: "OTP verified" });
  });

  app.post("/reset-password", async (req, res) => {
    const { email, newPassword } = req.body;
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await User.updateOne({ email }, { password: hashedPassword });
    res
      .status(200)
      .json({ success: true, message: "Password reset successful" });
  });


  // User - Get and Update

  app.get('/user/:email', async (req, res) => {
    try {
      const user = await User.findOne({email: req.params.email});
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.status(200).json(user);
    } catch (err) {
      res.status(500).send('Server error');
    }
  });

  app.put('/user/:email', async (req, res) => {
    try {
      const updated = await User.findOneAndUpdate(
        {email: req.params.email},
        req.body,
        {new: true}
      );
      if (!updated) return res.status(404).json({ error: 'User not found' });
      res.status(200).json(updated);
    } catch (err) {
      res.status(500).send('Update failed');
    }
  });

  // Faculty - add subject
  app.post("/faculty/add-subject", async (req, res) => {
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

  app.get("/faculty/new-requests", async (req, res) => {
    const { facultyEmail } = req.query;
    try {
      const faculty = await User.findOne({ email: facultyEmail });
      const subjects = await Subject.find({ faculties: faculty._id });
      // if (!subjects.length)
      //   return res
      //     .status(404)
      //     .json({ error: "No subjects found for this faculty" });

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

  app.get("/faculty/enrollment-requests", async (req, res) => {
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

  app.post("/faculty/enroll-student", async (req, res) => {
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

  app.post("/faculty/bulk-enroll", async (req, res) => {
    const { facultyEmail, subjectID, action } = req.body;

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

      const requestKey = `enrollment_requests:${subjectID}`;
      const requests = await redisClient.hGetAll(requestKey);

      for (const [studentEmail, data] of Object.entries(requests)) {
        const student = await User.findOne({ email: studentEmail });
        if (!student) continue;

        if (action === "approve") {
          subject.students.push(student._id);
          subject.attendanceRecords.forEach((record) => {
            record.attendance.push({ student: student._id, present: false });
          });
        }

        await redisClient.hDel(requestKey, studentEmail);
      }

      if (action === "approve") await subject.save();

      res.status(200).json({ message: `All students ${action}d successfully` });
    } catch (error) {
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.post("/faculty/add-faculty", async (req, res) => {
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

  app.get("/faculty/pending-requests", async (req, res) => {
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

  app.post("/faculty/respond-request", async (req, res) => {
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

  app.delete("/faculty/delete-subject/:subjectID", async (req, res) => {
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

  app.post("/faculty/archive-subject", async (req, res) => {
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

      const subject = await Subject.findOne({ subjectID }).populate(
        "faculties"
      );
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

  app.post("/faculty/unarchive-subject", async (req, res) => {
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
      return res
        .status(200)
        .json({ message: "Subject unarchived successfully" });
    } catch (error) {
      console.error("Error unarchiving subject:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/faculty/get-archived-subjects/:email", async (req, res) => {
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

  app.get("/faculty/attendanceRecord/:subjectID", async (req, res) => {
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

  app.get(
    "/faculty/get-attendance/:subjectID/:selectedDate",
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

  // Faculty - Start Attendance
  app.post("/faculty/start-attendance", async (req, res) => {
    const { email, subjectID, location } = req.body;

    const subject = await Subject.findOne({ subjectID });
    if (!subject)
      return res
        .status(404)
        .json({ success: false, error: "Subject not found" });

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

  app.post("/faculty/update-location", async (req, res) => {
    const { email, subjectID, location } = req.body;
  
    try {
      const key = `attendance:${subjectID}`;
      const exists = await redisClient.hExists(key, email);
  
      if (!exists) {
        return res.status(404).json({ success: false, error: "Email not found for subject" });
      }
  
      await redisClient.hSet(key, email, JSON.stringify(location));
  
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: "Failed to update location" });
    }
  });
  
  

  // Faculty - Stop Attendance
  app.post("/faculty/stop-attendance", async (req, res) => {
    const { email, subjectID } = req.body;

    if (!email || !subjectID) {
      return res.status(400).json({ success: false, error: "Invalid data" });
    }

    await redisClient.hDel(`attendance:${subjectID}`, email);
    res.json({ success: true, message: "Attendance stopped" });
  });

  app.delete("/faculty/delete-attendance", async (req, res) => {
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

  app.post("/faculty/update-attendance", async (req, res) => {
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

  // Export Attendance Report
  app.post("/faculty/email-attendance", async (req, res) => {
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
      const filePath = path.join(__dirname, `Attendance_${subjectID}.xlsx`);
      xlsx.writeFile(wb, filePath);

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      });

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

  app.get("/student/faculty-location/:subjectID", async (req, res) => {
    const { subjectID } = req.params;

    const facultyLocation = await redisClient.hGetAll(
      `attendance:${subjectID}`
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

  // Student - Enroll in Subject
  app.post("/student/enroll", async (req, res) => {
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

  app.post("/student/pending-enrollments", async (req, res) => {
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

  app.post("/student/unenroll", async (req, res) => {
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
              value: Math.round((presentCount / (index + 1)) * 100),
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

  // Student - Mark Attendance
  app.post("/student/mark-attendance", async (req, res) => {
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

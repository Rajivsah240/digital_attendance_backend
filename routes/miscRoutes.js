const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");

const User = require("../models/User");
const redisClient = require("../config/redis");
const transporter = require("../utils/emailService");

const generateOTP = () => Math.floor(1000 + Math.random() * 9000).toString();


router.post("/send-otp-first-time", async (req, res) => {
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

router.post("/send-otp", async (req, res) => {
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

router.post("/verify-otp", async (req, res) => {
  const { email, otp } = req.body;
  const storedHash = await redisClient.get(`otp:${email}`);
  if (!storedHash || !(await bcrypt.compare(otp, storedHash)))
    return res.status(400).json({ error: "Invalid or expired OTP" });

  await redisClient.del(`otp:${email}`);
  res.json({ success: true, message: "OTP verified" });
});

router.post("/reset-password", async (req, res) => {
  const { email, newPassword } = req.body;
  const hashedPassword = await bcrypt.hash(newPassword, 10);
  await User.updateOne({ email }, { password: hashedPassword });
  res.json({ success: true, message: "Password reset successful" });
});

module.exports = router;

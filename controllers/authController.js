const User = require("../models/User");
const bcrypt = require("bcrypt");

const generateToken = require("../utils/generateToken");

exports.register = async (req, res) => {
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
};

exports.login = async (req, res) => {
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
};

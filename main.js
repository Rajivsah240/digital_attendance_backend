const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const cluster = require("cluster");
const os = require("os");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const morgan = require("morgan");

const connectDB = require("./config/db");
const redisClient = require("./config/redis");

const facultyRoutes = require("./routes/facultyRoutes");
const studentRoutes = require("./routes/studentRoutes");
const authRoutes = require("./routes/authRoutes");
const miscRoutes = require("./routes/miscRoutes");

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

//   const limiter = rateLimit({
//     windowMs: 1 * 60 * 1000,
//     max: 5000,
//     handler: (req, res) => res.status(429).json({ error: "Too many requests" }),
//   });
//   app.use(limiter);

  connectDB();
  redisClient();

  app.use("/auth",authRoutes);
  app.use("/misc",miscRoutes);
  app.use("/faculty", facultyRoutes);
  app.use("/student", studentRoutes);

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

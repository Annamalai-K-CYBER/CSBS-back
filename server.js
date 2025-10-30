
const express = require("express");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const fs = require("fs");
const ImageKit = require("imagekit");

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors());

// ---------------------------
// MongoDB connection (Render-safe)
// ---------------------------
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// ---------------------------
// ImageKit config
// ---------------------------
const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
});

// ---------------------------
// Multer setup
// ---------------------------
const upload = multer({ dest: "uploads/" });

// ---------------------------
// Schemas & Models
// ---------------------------

// Users
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true }, // hashed
  name: { type: String },
  pb: { type: String }, // plain password saved earlier — consider removing in production
  isad: { type: Boolean, default: false },
});
const User = mongoose.model("User", userSchema);

// Material (study uploads)
const matSchema = new mongoose.Schema({
  link: { type: String, required: true },
  name: { type: String, required: true },
  matname: { type: String, required: true },
  subject: { type: String },
  format: { type: String },
  uploadDate: { type: Date, default: Date.now },
});
const Mat = mongoose.model("Mat", matSchema);

// Work schema: stores per-user statuses and a counts subdoc
const workStatusSubSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    username: String,
    state: {
      type: String,
      enum: ["completed", "doing", "not yet started"],
      default: "not yet started",
    },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const workCountsSubSchema = new mongoose.Schema(
  {
    completed: { type: Number, default: 0 },
    doing: { type: Number, default: 0 },
    notYetStarted: { type: Number, default: 0 },
  },
  { _id: false }
);

const workSchema = new mongoose.Schema({
  subject: { type: String, required: true },
  work: { type: String, required: true },
  deadline: { type: String, required: true },
  addedBy: { type: String, default: "Admin" },
  fileUrl: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
  // per-user status array
  status: { type: [workStatusSubSchema], default: [] },
  // stored counts for this work
  counts: { type: workCountsSubSchema, default: () => ({}) },
});
const Work = mongoose.model("Work", workSchema);

// Global totals across all works (kept in sync)
const workTotalsSchema = new mongoose.Schema({
  totalWorks: { type: Number, default: 0 }, // number of work documents
  // totals of per-work counts (sum of each work counts)
  completed: { type: Number, default: 0 },
  doing: { type: Number, default: 0 },
  notYetStarted: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now },
});
const WorkTotals = mongoose.model("WorkTotals", workTotalsSchema);

// ---------------------------
// Helper routines
// ---------------------------

/**
 * Recalculates counts for a single work document from its `status` array
 * and saves the aggregated counts into work.counts.
 * Returns the updated work document.
 */
async function recalcAndSaveWorkCounts(workDoc) {
  if (!workDoc) return null;
  const counts = { completed: 0, doing: 0, notYetStarted: 0 };

  (workDoc.status || []).forEach((s) => {
    if (s.state === "completed") counts.completed++;
    else if (s.state === "doing") counts.doing++;
    else counts.notYetStarted++;
  });

  workDoc.counts = {
    completed: counts.completed,
    doing: counts.doing,
    notYetStarted: counts.notYetStarted,
  };

  await workDoc.save();
  return workDoc;
}

/**
 * Recomputes global totals by aggregating Work.counts over all works.
 * Stores the result in the WorkTotals document (single doc).
 */
async function recomputeAndSaveGlobalTotals() {
  // aggregate totals using Mongo aggregation for efficiency
  const agg = await Work.aggregate([
    {
      $group: {
        _id: null,
        totalWorks: { $sum: 1 },
        completed: { $sum: "$counts.completed" },
        doing: { $sum: "$counts.doing" },
        notYetStarted: { $sum: "$counts.notYetStarted" },
      },
    },
  ]);

  let totalsDoc = await WorkTotals.findOne();
  if (!totalsDoc) totalsDoc = new WorkTotals();

  if (agg && agg.length > 0) {
    totalsDoc.totalWorks = agg[0].totalWorks || 0;
    totalsDoc.completed = agg[0].completed || 0;
    totalsDoc.doing = agg[0].doing || 0;
    totalsDoc.notYetStarted = agg[0].notYetStarted || 0;
  } else {
    totalsDoc.totalWorks = 0;
    totalsDoc.completed = 0;
    totalsDoc.doing = 0;
    totalsDoc.notYetStarted = 0;
  }

  totalsDoc.updatedAt = new Date();
  await totalsDoc.save();
  return totalsDoc;
}

// Validate state input
function isValidState(s) {
  return ["completed", "doing", "not yet started"].includes(s);
}

// ---------------------------
// Routes
// ---------------------------

// ---------------------------
// Landing / Health Check Route
// ---------------------------
app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "🚀 CSBS Backend is running successfully!",
    environment: process.env.NODE_ENV || "development",
    time: new Date().toISOString(),
  });
});

/* -----------------------------
   Register
--------------------------------*/
app.post("/api/register", async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ message: "email & password required" });

    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ message: "Email already exists" });

    const hashed = await bcrypt.hash(password, 10);
    const newUser = new User({ email, password: hashed, name, pb: password });
    await newUser.save();

    res.status(201).json({ success: true, message: "User registered" });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ success: false, message: "Registration failed", error: err.message });
  }
});

/* -----------------------------
   Login
--------------------------------*/
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "email & password required" });

    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      { userId: user._id, email: user.email, name: user.name, isad: user.isad },
      process.env.JWT_SECRET || "supersecret",
      { expiresIn: "1d" }
    );

    res.json({ success: true, token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ success: false, message: "Login failed", error: err.message });
  }
});

/* -----------------------------
   Upload Material -> ImageKit
   (Saves Mat doc with link)
--------------------------------*/
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

    const fileBuffer = fs.readFileSync(req.file.path);
    const ext = req.file.originalname.split(".").pop().toLowerCase();

    const uploadResponse = await imagekit.upload({
      file: fileBuffer,
      fileName: req.file.originalname,
      folder: "/csbs_uploads",
      tags: ["csbs", ext],
    });

    fs.unlinkSync(req.file.path);

    const newMat = new Mat({
      link: uploadResponse.url,
      name: req.body.username || "Anonymous",
      matname: req.body.materialName || req.file.originalname,
      subject: req.body.subject || "General",
      format: ext,
      uploadDate: new Date(),
    });

    await newMat.save();

    res.json({ success: true, fileUrl: uploadResponse.url, mat: newMat });
  } catch (err) {
    console.error("Material upload error:", err);
    res.status(500).json({ success: false, message: "Upload failed", error: err.message });
  }
});

/* -----------------------------
   Upload Work file -> ImageKit (work folder)
   (returns fileUrl, does NOT create Work doc)
--------------------------------*/
app.post("/api/work/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

    const fileBuffer = fs.readFileSync(req.file.path);

    const uploadResponse = await imagekit.upload({
      file: fileBuffer,
      fileName: req.file.originalname,
      folder: "/work_uploads",
      useUniqueFileName: true,
    });

    fs.unlinkSync(req.file.path);

    res.json({ success: true, fileUrl: uploadResponse.url });
  } catch (err) {
    console.error("Work upload error:", err);
    res.status(500).json({ success: false, message: "Work upload failed", error: err.message });
  }
});

/* -----------------------------
   Get Materials
--------------------------------*/
app.get("/api/materials", async (req, res) => {
  try {
    const mats = await Mat.find().sort({ uploadDate: -1 });
    res.json({ success: true, data: mats });
  } catch (err) {
    console.error("Fetch materials error:", err);
    res.status(500).json({ success: false, message: "Error fetching materials", error: err.message });
  }
});

/* -----------------------------
   Get Users (no password)
--------------------------------*/
app.get("/api/users", async (req, res) => {
  try {
    const users = await User.find({}, "-password -pb");
    res.json({ success: true, data: users });
  } catch (err) {
    console.error("Fetch users error:", err);
    res.status(500).json({ success: false, message: "Error fetching users", error: err.message });
  }
});

/* -----------------------------
   Add Work (creates Work doc)
   - After saving, recompute global totals
--------------------------------*/
app.post("/api/work/add", async (req, res) => {
  try {
    const { subject, work: workText, deadline, addedBy, fileUrl } = req.body;
    if (!subject || !workText || !deadline) return res.status(400).json({ success: false, message: "subject, work, deadline required" });

    const newWork = new Work({
      subject,
      work: workText,
      deadline,
      addedBy: addedBy || "Admin",
      fileUrl: fileUrl || "",
      status: [], // initially empty array of user statuses
      counts: { completed: 0, doing: 0, notYetStarted: 0 },
    });

    await newWork.save();

    // update global totals
    const totals = await recomputeAndSaveGlobalTotals();

    res.json({ success: true, message: "Work added", newWork, totals });
  } catch (err) {
    console.error("Add work error:", err);
    res.status(500).json({ success: false, message: "Failed to add work", error: err.message });
  }
});

/* -----------------------------
   Get all Works (includes each work.counts)
--------------------------------*/
app.get("/api/work", async (req, res) => {
  try {
    const works = await Work.find().sort({ createdAt: -1 });
    const totals = await WorkTotals.findOne();
    res.json({ success: true, works, totals });
  } catch (err) {
    console.error("Fetch works error:", err);
    res.status(500).json({ success: false, message: "Error fetching works", error: err.message });
  }
});

/* -----------------------------
   Delete a work
   - Also recompute global totals
--------------------------------*/
app.delete("/api/work/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const removed = await Work.findByIdAndDelete(id);
    if (!removed) return res.status(404).json({ success: false, message: "Work not found" });

    const totals = await recomputeAndSaveGlobalTotals();
    res.json({ success: true, message: "Work deleted", totals });
  } catch (err) {
    console.error("Delete work error:", err);
    res.status(500).json({ success: false, message: "Error deleting work", error: err.message });
  }
});

/* -----------------------------
   Update user's status for a specific work
   - body: { userId, username, state }
   - If the user already has a status entry -> update it
   - Otherwise add a new status entry
   - After change, recalc & save work.counts, then recompute global totals
--------------------------------*/
app.post("/api/work/status/:workId", async (req, res) => {
  try {
    const { workId } = req.params;
    const { userId, username, state } = req.body;

    if (!userId || !username || !state) return res.status(400).json({ success: false, message: "userId, username, state required" });
    if (!isValidState(state)) return res.status(400).json({ success: false, message: "Invalid state" });

    const workDoc = await Work.findById(workId);
    if (!workDoc) return res.status(404).json({ success: false, message: "Work not found" });

    // find existing status for this user
    const existingIndex = workDoc.status.findIndex((s) => s.userId?.toString() === userId?.toString());

    if (existingIndex >= 0) {
      // update existing
      workDoc.status[existingIndex].state = state;
      workDoc.status[existingIndex].username = username;
      workDoc.status[existingIndex].updatedAt = new Date();
    } else {
      // push new
      workDoc.status.push({ userId, username, state, updatedAt: new Date() });
    }

    // recalc per-work counts and save
    await recalcAndSaveWorkCounts(workDoc);

    // recompute global totals
    const totals = await recomputeAndSaveGlobalTotals();

    res.json({ success: true, message: "Status updated", work: workDoc, totals });
  } catch (err) {
    console.error("Update status error:", err);
    res.status(500).json({ success: false, message: "Failed to update status", error: err.message });
  }
});

/* -----------------------------
   Get per-work counts (stored in work.counts)
--------------------------------*/
app.get("/api/work/status/:workId", async (req, res) => {
  try {
    const { workId } = req.params;
    const workDoc = await Work.findById(workId);
    if (!workDoc) return res.status(404).json({ success: false, message: "Work not found" });

    // ensure counts are present (recalc if missing)
    if (!workDoc.counts) {
      await recalcAndSaveWorkCounts(workDoc);
    }

    res.json({ success: true, counts: workDoc.counts });
  } catch (err) {
    console.error("Get work counts error:", err);
    res.status(500).json({ success: false, message: "Error fetching counts", error: err.message });
  }
});

/* -----------------------------
   Get global totals (WorkTotals doc)
--------------------------------*/
app.get("/api/work/totals", async (req, res) => {
  try {
    const totals = await WorkTotals.findOne();
    res.json({ success: true, totals });
  } catch (err) {
    console.error("Get totals error:", err);
    res.status(500).json({ success: false, message: "Error fetching totals", error: err.message });
  }
});

/* -----------------------------
   (Optional) Endpoint to force recompute totals (admin use)
--------------------------------*/
app.post("/api/work/recompute-totals", async (req, res) => {
  try {
    // recompute per-work counts for all works first (defensive)
    const allWorks = await Work.find();
    await Promise.all(allWorks.map((w) => recalcAndSaveWorkCounts(w)));

    // then recompute global totals
    const totals = await recomputeAndSaveGlobalTotals();
    res.json({ success: true, message: "Recomputed totals", totals });
  } catch (err) {
    console.error("Recompute totals error:", err);
    res.status(500).json({ success: false, message: "Failed to recompute totals", error: err.message });
  }
});

// ---------------------------
// Start server
if (require.main === module) {
  // Local only
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running locally on port ${PORT}`);
  });
} else {
  // For Vercel
  module.exports = app;
}

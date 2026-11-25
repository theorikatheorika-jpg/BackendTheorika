require("dotenv").config();

const crypto = require("node:crypto");
const cors = require("cors");
const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const { z } = require("zod");
const { connectDatabase, isDatabaseConnected, query } = require("./database");
const {
  ClassOption,
  Enquiry,
  EnquiryRateLimit,
  SubjectOption,
  getNextSequence,
} = require("./models");
const { router: dashboardRoutes } = require("./dashboard-routes");

const PORT = Number(process.env.PORT || 3001);
const supabaseConfigured = Boolean(process.env.SUPABASE_DB_URL);
const cloudinaryConfigured = Boolean(process.env.CLOUDINARY_URL);
const rateLimitConfigured = Boolean(process.env.RATE_LIMIT_HASH_SECRET);
const authConfigured = Boolean(process.env.AUTH_TOKEN_SECRET);
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const effectiveAllowedOrigins = allowedOrigins.size
  ? allowedOrigins
  : new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);
const missingEnvironment = [
  ["SUPABASE_DB_URL", supabaseConfigured],
  ["RATE_LIMIT_HASH_SECRET", rateLimitConfigured],
  ["AUTH_TOKEN_SECRET", authConfigured],
].filter(([, configured]) => !configured).map(([name]) => name);

if (process.env.NODE_ENV === "production" && missingEnvironment.length > 0) {
  console.error(`Missing required production environment variables: ${missingEnvironment.join(", ")}`);
  process.exit(1);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("PORT must be a valid TCP port.");
  process.exit(1);
}
if (rateLimitConfigured && process.env.RATE_LIMIT_HASH_SECRET.length < 32) {
  console.error("RATE_LIMIT_HASH_SECRET must contain at least 32 characters.");
  process.exit(1);
}
if (authConfigured && process.env.AUTH_TOKEN_SECRET.length < 32) {
  console.error("AUTH_TOKEN_SECRET must contain at least 32 characters.");
  process.exit(1);
}
if (!supabaseConfigured) {
  console.warn("Starting API without Supabase. Configure SUPABASE_DB_URL in backend/.env to enable database-backed features.");
} else {
  if (!rateLimitConfigured) {
    console.warn("Enquiry saving is unavailable until RATE_LIMIT_HASH_SECRET is configured in backend/.env.");
  }
  if (!authConfigured) {
    console.warn("Account services are unavailable until AUTH_TOKEN_SECRET is configured in backend/.env.");
  }
  if (!cloudinaryConfigured) {
    console.warn("Faculty applications are unavailable until CLOUDINARY_URL is configured in the backend environment.");
  }
}

const enquirySchema = z.object({
  studentName: z.string().trim().min(2).max(120),
  phone: z.string().trim().regex(/^[+\d()\s.-]{7,20}$/).refine((phone) => {
    const digits = phone.replace(/\D/g, "");
    return digits.length >= 7 && digits.length <= 15;
  }),
  email: z.union([z.literal(""), z.string().trim().email().max(254)]).optional().default(""),
  className: z.string().trim().min(1).max(80),
  subjectName: z.string().trim().max(80).optional().default(""),
  message: z.string().trim().max(2000).optional().default(""),
  submissionKey: z.string().uuid(),
}).strict();
const facultySubjects = ["Physics", "Chemistry", "Mathematics", "Biology"];
const facultyClasses = ["Class 8", "Class 9", "Class 10", "Class 11", "Class 12"];
const facultyApplicationSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  phone: z.string().trim().regex(/^[+\d()\s.-]{7,20}$/).refine((phone) => {
    const digits = phone.replace(/\D/g, "");
    return digits.length >= 7 && digits.length <= 15;
  }),
  city: z.string().trim().min(2).max(100),
  qualification: z.string().trim().min(2).max(160),
  experienceYears: z.preprocess((value) => value === "" ? undefined : value,
    z.coerce.number().int().min(0).max(60)),
  subjects: z.preprocess((value) => typeof value === "string" ? [value] : value,
    z.array(z.enum(facultySubjects)).min(1).max(facultySubjects.length).refine((items) => new Set(items).size === items.length)),
  classes: z.preprocess((value) => typeof value === "string" ? [value] : value,
    z.array(z.enum(facultyClasses)).min(1).max(facultyClasses.length).refine((items) => new Set(items).size === items.length)),
  message: z.string().trim().max(1500).optional().default(""),
  consent: z.literal("true"),
}).strict();
const resumeTypes = Object.freeze({
  ".pdf": ["application/pdf"],
  ".doc": ["application/msword", "application/vnd.ms-word"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".odt": ["application/vnd.oasis.opendocument.text"],
  ".rtf": ["application/rtf", "text/rtf"],
  ".txt": ["text/plain"],
});
const facultyApplicationUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 20, parts: 21, fieldSize: 2000 },
  fileFilter(_request, file, callback) {
    const extension = file.originalname.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
    if (!extension || !resumeTypes[extension]?.includes(file.mimetype)) {
      const error = new Error("Upload your resume as a PDF, DOC, DOCX, ODT, RTF, or TXT file.");
      error.code = "UNSUPPORTED_RESUME_TYPE";
      return callback(error);
    }
    return callback(null, true);
  },
});

const app = express();
app.set("trust proxy", parseTrustProxyHops());
app.disable("x-powered-by");
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, false);
    return callback(null, effectiveAllowedOrigins.has(origin));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  credentials: true,
  maxAge: 86400,
}));
app.use(express.json({ limit: "16kb", strict: true }));
app.use(dashboardRoutes);

app.get("/health", (_request, response) => {
  const databaseConnected = isDatabaseConnected();
  response.status(databaseConnected ? 200 : 503).json({
    status: databaseConnected ? "ok" : "database unavailable",
  });
});

app.post("/api/enquiries", async (request, response, next) => {
  if (!supabaseConfigured || !rateLimitConfigured || !isDatabaseConnected()) {
    return response.status(503).json({
      error: "Enquiry saving is not configured yet. Please contact us directly or try again later.",
    });
  }

  try {
    const origin = request.get("Origin");
    if (!origin || !effectiveAllowedOrigins.has(origin)) {
      return response.status(403).json({ error: "This website is not allowed to submit enquiries." });
    }

    const parsed = enquirySchema.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({
        error: "Check the enquiry fields and try again.",
        fields: parsed.error.issues.map(({ path: fieldPath, message }) => ({
          field: fieldPath.join("."),
          message,
        })),
      });
    }
    const enquiry = parsed.data;
    const ipAddress = request.ip;
    if (!ipAddress) {
      return response.status(400).json({ error: "Unable to verify this request. Please contact us directly." });
    }

    const keyHash = crypto
      .createHmac("sha256", process.env.RATE_LIMIT_HASH_SECRET)
      .update(ipAddress)
      .digest("hex");
    const currentWindow = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    const rateLimit = await EnquiryRateLimit.findOneAndUpdate(
      { keyHash, windowStartedAt: currentWindow },
      {
        $inc: { requestCount: 1 },
        $setOnInsert: { expiresAt: new Date(currentWindow.getTime() + 48 * 3_600_000) },
      },
      { upsert: true, new: true },
    ).catch(async (error) => {
      if (error?.code !== 11000) throw error;
      return EnquiryRateLimit.findOneAndUpdate(
        { keyHash, windowStartedAt: currentWindow },
        { $inc: { requestCount: 1 } },
        { new: true },
      );
    });
    if (!rateLimit) {
      return response.status(503).json({ error: "The enquiry service is temporarily unavailable." });
    }
    if (rateLimit.requestCount > 10) {
      return response.status(429).json({ error: "Too many submissions. Please try again later." });
    }

    const [classOption, subjectOption] = await Promise.all([
      ClassOption.exists({ name: enquiry.className, isActive: true }),
      enquiry.subjectName && enquiry.subjectName !== "Not specified"
        ? SubjectOption.exists({ name: enquiry.subjectName, isActive: true })
        : Promise.resolve(true),
    ]);
    if (!classOption || !subjectOption) {
      return response.status(400).json({ error: "Choose a currently available class and subject." });
    }

    const existing = await Enquiry.findOne({ submissionKey: enquiry.submissionKey })
      .select("leadId")
      .lean();
    if (existing) {
      return response.status(200).json({ success: true, leadId: existing.leadId });
    }

    const year = new Date().getUTCFullYear();
    const counter = await getNextSequence(`enquiry-${year}`);
    const document = new Enquiry({
      leadId: `ENQ-${year}-${String(counter).padStart(6, "0")}`,
      submissionKey: enquiry.submissionKey,
      studentName: enquiry.studentName,
      phone: enquiry.phone,
      email: enquiry.email || undefined,
      className: enquiry.className,
      subjectName: enquiry.subjectName && enquiry.subjectName !== "Not specified"
        ? enquiry.subjectName
        : undefined,
      message: enquiry.message || undefined,
    });

    try {
      await document.save();
      return response.status(201).json({ success: true, leadId: document.leadId });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const duplicate = await Enquiry.findOne({ submissionKey: enquiry.submissionKey })
        .select("leadId")
        .lean();
      if (duplicate) {
        return response.status(200).json({ success: true, leadId: duplicate.leadId });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

app.post("/api/faculty-applications", async (request, response, next) => {
  if (!supabaseConfigured || !rateLimitConfigured || !isDatabaseConnected()) {
    return response.status(503).json({ error: "Applications are temporarily unavailable. Please try again later." });
  }
  if (!cloudinaryConfigured) {
    return response.status(503).json({ error: "Resume uploads are not configured yet. Please try again later." });
  }
  const origin = request.get("Origin");
  if (!origin || !effectiveAllowedOrigins.has(origin)) {
    return response.status(403).json({ error: "This website is not allowed to submit applications." });
  }
  const ipAddress = request.ip;
  if (!ipAddress) {
    return response.status(400).json({ error: "Unable to verify this request. Please try again later." });
  }

  try {
    const keyHash = crypto.createHmac("sha256", process.env.RATE_LIMIT_HASH_SECRET)
      .update(`faculty-application:${ipAddress}`)
      .digest("hex");
    const currentWindow = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    const rateLimit = await EnquiryRateLimit.findOneAndUpdate(
      { keyHash, windowStartedAt: currentWindow },
      {
        $inc: { requestCount: 1 },
        $setOnInsert: { expiresAt: new Date(currentWindow.getTime() + 48 * 3_600_000) },
      },
      { upsert: true, new: true },
    ).catch(async (error) => {
      if (error?.code !== 11000) throw error;
      return EnquiryRateLimit.findOneAndUpdate(
        { keyHash, windowStartedAt: currentWindow },
        { $inc: { requestCount: 1 } },
        { new: true },
      );
    });
    if (!rateLimit) return response.status(503).json({ error: "Applications are temporarily unavailable." });
    if (rateLimit.requestCount > 5) {
      return response.status(429).json({ error: "Too many applications from this connection. Please try again later." });
    }
    return facultyApplicationUpload.single("resume")(request, response, (uploadError) => {
      if (uploadError) return next(uploadError);
      return submitFacultyApplication(request, response, next);
    });
  } catch (error) {
    return next(error);
  }
});

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    const message = error.code === "LIMIT_FILE_SIZE"
      ? "Your resume must be 5 MB or smaller."
      : "Please upload one resume file and complete all application fields.";
    return response.status(status).json({ error: message });
  }
  if (error?.code === "UNSUPPORTED_RESUME_TYPE") {
    return response.status(400).json({ error: error.message });
  }
  if (error?.facultyApplicationStage === "cloudinary") {
    const cloudinaryError = error.cause;
    console.error("Faculty resume upload failed.", {
      code: cloudinaryError?.http_code || cloudinaryError?.code || "unavailable",
      name: cloudinaryError?.name || "CloudinaryError",
    });
    if ([401, 403].includes(cloudinaryError?.http_code)) {
      return response.status(503).json({ error: "Resume storage is not authorized. Check the Cloudinary credentials configured on the backend." });
    }
    return response.status(502).json({ error: "Resume storage could not accept this file. Please try again later." });
  }
  if (error?.facultyApplicationStage === "database") {
    const databaseError = error.cause;
    console.error("Faculty application database write failed.", {
      code: databaseError?.code || "unavailable",
      table: databaseError?.table || "unavailable",
      column: databaseError?.column || "unavailable",
      constraint: databaseError?.constraint || "unavailable",
    });
    if (["42P01", "42703", "23502", "23514"].includes(databaseError?.code)) {
      return response.status(503).json({ error: "Faculty application storage needs a database schema update. Please contact the site administrator." });
    }
    return response.status(503).json({ error: "Your resume was uploaded, but the application could not be saved. Please try again later." });
  }
  if (error instanceof SyntaxError && "body" in error) {
    return response.status(400).json({ error: "Please submit valid JSON." });
  }
  if (error?.type === "entity.too.large") {
    return response.status(413).json({ error: "The request is too large." });
  }
  console.error("Unhandled API error:", {
    name: error?.name || "Unknown error.",
    code: error?.code || "unavailable",
    table: error?.table || "unavailable",
    column: error?.column || "unavailable",
  });
  return response.status(500).json({ error: "An unexpected server error occurred." });
});

async function submitFacultyApplication(request, response, next) {
  try {
    const parsed = facultyApplicationSchema.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({
        error: "Check the application fields and try again.",
        fields: parsed.error.issues.map(({ path: fieldPath, message }) => ({
          field: fieldPath.join("."),
          message,
        })),
      });
    }
    const resume = request.file;
    if (!resume) return response.status(400).json({ error: "Please attach your resume as a supported document." });
    if (!isValidResumeFile(resume)) {
      return response.status(400).json({ error: "The selected file is not a valid document in its declared format." });
    }

    const application = parsed.data;
    const resumeName = resume.originalname
      .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
      .slice(-200);
    const extension = resume.originalname.toLowerCase().match(/\.[a-z0-9]+$/)[0];
    const publicId = `theorika/faculty-applications/${crypto.randomUUID()}${extension}`;
    let uploadedAsset;
    try {
      try {
        uploadedAsset = await uploadFacultyResume(resume.buffer, publicId);
      } catch (cause) {
        throw Object.assign(new Error("Cloudinary resume upload failed."), {
          cause,
          facultyApplicationStage: "cloudinary",
        });
      }
      let result;
      try {
        result = await query(
          `INSERT INTO "faculty_applications" ("fullName", "email", "phone", "city", "qualification", "experienceYears", "subjects", "classes", "message", "resumeFilename", "resumeContentType", "resumeUrl", "resumePublicId", "resumeResourceType", "consentAt") VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14, now()) RETURNING "_id"`,
          [
            application.fullName,
            application.email,
            application.phone,
            application.city,
            application.qualification,
            application.experienceYears,
            JSON.stringify(application.subjects),
            JSON.stringify(application.classes),
            application.message,
            resumeName,
            resume.mimetype,
            uploadedAsset.secure_url,
            uploadedAsset.public_id,
            uploadedAsset.resource_type,
          ],
        );
      } catch (cause) {
        throw Object.assign(new Error("Faculty application database write failed."), {
          cause,
          facultyApplicationStage: "database",
        });
      }
      return response.status(201).json({ success: true, applicationId: result.rows[0]._id });
    } catch (error) {
      if (uploadedAsset) {
        try {
          await cloudinary.uploader.destroy(uploadedAsset.public_id, {
            resource_type: uploadedAsset.resource_type,
            type: "authenticated",
            invalidate: true,
          });
        } catch (cleanupError) {
          console.error("Could not remove an unlinked faculty resume from Cloudinary.", {
            code: cleanupError?.http_code || "unavailable",
          });
        }
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
}

function isValidResumeFile(file) {
  const extension = file.originalname.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  if (!extension || !resumeTypes[extension]?.includes(file.mimetype)) return false;
  if (extension === ".pdf") return file.buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  if (extension === ".doc") return file.buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if ([".docx", ".odt"].includes(extension)) return file.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (extension === ".rtf") return /^\s*\{\\rtf/i.test(file.buffer.subarray(0, 16).toString("ascii"));
  return extension === ".txt" && !file.buffer.includes(0);
}

function uploadFacultyResume(buffer, publicId) {
  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream({
      resource_type: "raw",
      type: "authenticated",
      public_id: publicId,
      use_filename: false,
      unique_filename: false,
      overwrite: false,
    }, (error, result) => {
      if (error) return reject(error);
      if (!result?.secure_url || !result.public_id || !result.resource_type) {
        return reject(new Error("Cloudinary returned incomplete resume upload details."));
      }
      return resolve(result);
    });
    upload.end(buffer);
  });
}

async function start() {
  if (supabaseConfigured) {
    await connectDatabase();
    console.log("Supabase database connected.");
  }

  app.listen(PORT, () => {
    console.log(`Theorika API listening on port ${PORT}.`);
  });
}

start().catch((error) => {
  const safeMessage = typeof error?.message === "string"
    ? error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted Supabase database URL]")
    : "Unknown connection error.";
  if (error?.code === "ENETUNREACH") {
    console.error(
      "The database host is unreachable from this network. On Render, set SUPABASE_DB_URL to the Supabase Session pooler connection string (port 5432), not the direct database connection string.",
    );
  }
  console.error("Could not connect to Supabase:", {
    name: error?.name || "Unknown error",
    code: error?.codeName || error?.code || "unavailable",
    message: safeMessage,
  });
  process.exit(1);
});

function parseTrustProxyHops() {
  const value = process.env.TRUST_PROXY_HOPS || "0";
  const hops = Number(value);
  if (!Number.isInteger(hops) || hops < 0) {
    console.error("TRUST_PROXY_HOPS must be a non-negative integer.");
    process.exit(1);
  }
  return hops;
}

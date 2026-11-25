require("dotenv").config();

const crypto = require("node:crypto");
const cors = require("cors");
const express = require("express");
const helmet = require("helmet");
const { z } = require("zod");
const { connectDatabase, isDatabaseConnected } = require("./database");
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

app.use((error, _request, response, _next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return response.status(400).json({ error: "Please submit valid JSON." });
  }
  if (error?.type === "entity.too.large") {
    return response.status(413).json({ error: "The request is too large." });
  }
  console.error("Unhandled API error:", error?.name || "Unknown error.");
  return response.status(500).json({ error: "An unexpected server error occurred." });
});

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

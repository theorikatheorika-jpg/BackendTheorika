const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const cloudinary = require("cloudinary").v2;
const express = require("express");
const nodemailer = require("nodemailer");
const { z } = require("zod");
const {
  ActivityLog,
  Attendance,
  Batch,
  Course,
  Enquiry,
  FeeRecord,
  FollowUpRecord,
  Material,
  Notice,
  PortalEnrollment,
  User,
  UserSession,
} = require("./models");
const { isDatabaseConnected, isDatabaseConfigured, query } = require("./database");
const {
  clearSessionCookie,
  createSession,
  requireAuth,
} = require("./auth");

const router = express.Router();
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
    .split(",").map((origin) => origin.trim()).filter(Boolean),
);
const classes = ["Class 8", "Class 9", "Class 10", "Class 11", "Class 12"];
const subjects = ["Physics", "Chemistry", "Mathematics", "Biology"];
const permissionNames = [
  "canLogin",
  "viewBatches",
  "viewLiveLinks",
  "downloadMaterials",
  "viewAttendanceFees",
  "askDoubts",
  "manageAssignedBatches",
  "showOnFaculty",
];
const learnerPermissions = Object.freeze({
  canLogin: true,
  viewBatches: true,
  viewLiveLinks: true,
  downloadMaterials: true,
  viewAttendanceFees: true,
  askDoubts: true,
  manageAssignedBatches: false,
  showOnFaculty: false,
});
const instructorPermissions = Object.freeze({ ...learnerPermissions, manageAssignedBatches: true });

const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const phoneSchema = z.string().trim().regex(/^[+\d()\s.-]{7,20}$/).refine((value) => {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
});
const safeUrlSchema = z.string().trim().url().max(1000).refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
});

const mailTransport = createMailTransport();
const dummyPasswordHash = bcrypt.hashSync("not-a-real-password", 12);

router.use("/api/public", (_request, response, next) => {
  response.set("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
  return next();
});

router.use((request, response, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && !allowedOrigins.has(request.get("Origin"))) {
    return response.status(403).json({ error: "This website is not allowed to change dashboard data." });
  }
  return next();
});

router.get("/api/public/courses", async (_request, response, next) => {
  try {
    if (!isDatabaseConnected()) return response.status(503).json({ error: "Course listings are temporarily unavailable." });
    const courses = await Course.find({ status: "Published" })
      .select("title slug className subjectName description syllabus featured")
      .sort({ featured: -1, subjectName: 1, className: 1 })
      .lean();
    return response.json({ courses });
  } catch (error) {
    return next(error);
  }
});

router.get("/api/public/courses/:slug", async (request, response, next) => {
  try {
    if (!isDatabaseConnected()) return response.status(503).json({ error: "Course details are temporarily unavailable." });
    const course = await Course.findOne({ slug: request.params.slug, status: "Published" })
      .select("title slug className subjectName description syllabus featured")
      .lean();
    if (!course) return response.status(404).json({ error: "Course not found." });
    return response.json({ course });
  } catch (error) {
    return next(error);
  }
});

router.get("/api/public/batches", async (_request, response, next) => {
  try {
    if (!isDatabaseConnected()) return response.status(503).json({ error: "Batch listings are temporarily unavailable." });
    const batches = await Batch.find({ status: { $in: ["Upcoming", "Ongoing", "Started"] }, archivedAt: { $exists: false } })
      .select("batchId name className subjectName startDate endDate schedule days capacity status description")
      .sort({ startDate: 1 })
      .lean();
    const activeEnrollments = await PortalEnrollment.find({
      status: "Active",
      batch: { $in: batches.map((batch) => batch._id) },
    }).select("batch").lean();
    const countByBatch = new Map();
    for (const enrollment of activeEnrollments) {
      const batchId = String(enrollment.batch);
      countByBatch.set(batchId, (countByBatch.get(batchId) || 0) + 1);
    }
    return response.json({ batches: batches.map((batch) => ({
      ...batch,
      seatsLeft: Math.max(0, batch.capacity - (countByBatch.get(String(batch._id)) || 0)),
    })) });
  } catch (error) {
    return next(error);
  }
});

router.get("/api/public/notices", async (_request, response, next) => {
  try {
    if (!isDatabaseConnected()) return response.status(503).json({ error: "Announcements are temporarily unavailable." });
    const now = new Date();
    const notices = await Notice.find({
      publicationStatus: "Published",
      batch: { $exists: false },
      $and: [
        { $or: [{ publishAt: { $exists: false } }, { publishAt: { $lte: now } }] },
        { $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }] },
      ],
    }).select("noticeId title content category publishAt createdAt").sort({ createdAt: -1 }).limit(20).lean();
    return response.json({ notices });
  } catch (error) {
    return next(error);
  }
});

router.get("/api/public/faculty", async (_request, response, next) => {
  try {
    if (!isDatabaseConnected()) return response.status(503).json({ error: "Faculty listings are temporarily unavailable." });
    const faculty = await User.find({
      role: "user",
      status: "active",
      "permissions.showOnFaculty": true,
    }).select("fullName bio subjects experienceYears").sort({ fullName: 1 }).lean();
    return response.json({ faculty });
  } catch (error) {
    return next(error);
  }
});

router.post("/api/auth/register", async (request, response, next) => {
  try {
    if (!hasDatabaseAndAuth()) return configurationUnavailable(response);
    const parsed = registrationSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error);
    const registration = parsed.data;
    if (!registration.parentConsent || !registration.parentName || !registration.parentPhone) {
      return response.status(400).json({ error: "A parent or guardian contact and consent are required for student registration." });
    }
    if (Buffer.byteLength(registration.password, "utf8") > 72) {
      return response.status(400).json({ error: "Password must be 72 bytes or fewer." });
    }
    if (process.env.NODE_ENV === "production" && !mailTransport) {
      return response.status(503).json({ error: "Email verification is not configured. Please contact the institute." });
    }
    const alreadyBlocked = await User.exists({
      status: "blocked",
      $or: [{ email: registration.email }, { phone: registration.phone }],
    });
    if (alreadyBlocked) return response.status(409).json({ error: "This email or phone number cannot be registered." });

    const existing = await User.exists({ email: registration.email });
    if (existing) return response.status(409).json({ error: "An account with this email already exists. Sign in or contact the institute." });

    const verificationToken = crypto.randomBytes(32).toString("base64url");
    const user = new User({
      fullName: registration.fullName,
      email: registration.email,
      phone: registration.phone,
      passwordHash: await bcrypt.hash(registration.password, 12),
      role: "user",
      status: "pending",
      preset: "custom",
      permissions: Object.fromEntries(permissionNames.map((name) => [name, false])),
      className: registration.className,
      school: registration.school,
      parentName: registration.parentName,
      parentPhone: registration.parentPhone,
      parentConsentAt: new Date(),
      verificationTokenHash: hashToken(verificationToken),
      verificationExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await user.save();

    const verificationUrl = `${getFrontendOrigin(request)}/verify-email?token=${encodeURIComponent(verificationToken)}`;
    if (mailTransport) {
      await mailTransport.sendMail({
        from: process.env.EMAIL_FROM,
        to: user.email,
        subject: "Verify your Theorika Academy account",
        text: `Verify your email within 24 hours: ${verificationUrl}`,
      });
    }
    await writeAudit(user._id, "account.registered", "User", user._id, { status: user.status });
    return response.status(201).json({
      success: true,
      message: "Registration received. Verify your email; an administrator must approve the account before sign-in.",
      ...(process.env.NODE_ENV !== "production" && !mailTransport ? { developmentVerificationUrl: verificationUrl } : {}),
    });
  } catch (error) {
    if (error?.code === 11000) return response.status(409).json({ error: "An account with these details already exists." });
    return next(error);
  }
});

router.post("/api/auth/verify-email", async (request, response, next) => {
  try {
    if (!hasDatabaseAndAuth()) return configurationUnavailable(response);
    const token = z.string().min(32).max(200).safeParse(request.body?.token);
    if (!token.success) return response.status(400).json({ error: "This verification link is invalid or expired." });
    const user = await User.findOneAndUpdate(
      { verificationTokenHash: hashToken(token.data), verificationExpiresAt: { $gt: new Date() }, status: "pending" },
      { $set: { emailVerifiedAt: new Date() }, $unset: { verificationTokenHash: 1, verificationExpiresAt: 1 } },
      { new: true },
    ).select("_id emailVerifiedAt");
    if (!user) return response.status(400).json({ error: "This verification link is invalid or expired." });
    return response.json({ success: true, message: "Email verified. Your account is waiting for administrator approval." });
  } catch (error) {
    return next(error);
  }
});

router.post("/api/auth/resend-verification", async (request, response, next) => {
  try {
    if (!hasDatabaseAndAuth()) return configurationUnavailable(response);
    const parsed = z.object({ email: emailSchema }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Enter a valid email address." });
    const user = await User.findOne({ email: parsed.data.email, role: "user", status: "pending", emailVerifiedAt: { $exists: false } });
    if (user) {
      if (process.env.NODE_ENV === "production" && !mailTransport) return response.status(503).json({ error: "Email verification is not configured." });
      const token = crypto.randomBytes(32).toString("base64url");
      user.verificationTokenHash = hashToken(token);
      user.verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await user.save();
      const verificationUrl = `${getFrontendOrigin(request)}/verify-email?token=${encodeURIComponent(token)}`;
      if (mailTransport) {
        await mailTransport.sendMail({
          from: process.env.EMAIL_FROM,
          to: user.email,
          subject: "Verify your Theorika Academy account",
          text: `Verify your email within 24 hours: ${verificationUrl}`,
        });
      }
      return response.json({
        success: true,
        message: "If this account is awaiting verification, a new verification link has been sent.",
        ...(process.env.NODE_ENV !== "production" && !mailTransport ? { developmentVerificationUrl: verificationUrl } : {}),
      });
    }
    return response.json({ success: true, message: "If this account is awaiting verification, a new verification link has been sent." });
  } catch (error) {
    return next(error);
  }
});

router.post("/api/auth/forgot-password", async (request, response, next) => {
  try {
    if (!hasDatabaseAndAuth()) return configurationUnavailable(response);
    if (!mailTransport) return response.status(503).json({ error: "Password recovery email is not configured. Contact the academy administrator." });
    const parsed = z.object({ email: emailSchema }).strict().safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Enter a valid email address." });
    const user = await User.findOne({ email: parsed.data.email, status: "active", deletedAt: { $exists: false } });
    if (user) {
      const token = crypto.randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      await User.updateOne({ _id: user._id }, {
        $set: { passwordResetTokenHash: hashToken(token), passwordResetExpiresAt: expiresAt },
      });
      const resetUrl = new URL("/reset-password", getFrontendOrigin(request));
      resetUrl.searchParams.set("token", token);
      await mailTransport.sendMail({
        from: process.env.EMAIL_FROM,
        to: user.email,
        subject: "Reset your Theorika account password",
        text: `Use this link within 30 minutes to reset your password: ${resetUrl.toString()}`,
      });
    }
    return response.json({ success: true, message: "If an active account uses that email, a password reset link has been sent." });
  } catch (error) {
    return next(error);
  }
});

router.post("/api/auth/reset-password", async (request, response, next) => {
  try {
    if (!hasDatabaseAndAuth()) return configurationUnavailable(response);
    const parsed = z.object({ token: z.string().min(20).max(200), password: z.string().min(12).max(72) }).strict().safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Use a valid reset link and a password of at least 12 characters." });
    const user = await User.findOne({
      passwordResetTokenHash: hashToken(parsed.data.token),
      passwordResetExpiresAt: { $gt: new Date() },
      status: "active",
      deletedAt: { $exists: false },
    });
    if (!user) return response.status(400).json({ error: "This password reset link is invalid or expired." });
    await User.updateOne({ _id: user._id }, {
      $set: { passwordHash: await bcrypt.hash(parsed.data.password, 12) },
      $unset: { passwordResetTokenHash: 1, passwordResetExpiresAt: 1 },
    });
    await UserSession.updateMany({ user: user._id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    await writeAudit(user._id, "auth.password_reset", "User", user._id, {});
    return response.json({ success: true, message: "Password updated. Sign in with your new password." });
  } catch (error) {
    return next(error);
  }
});

router.post("/api/auth/login", async (request, response, next) => {
  try {
    if (!hasDatabaseAndAuth()) return configurationUnavailable(response);
    const parsed = z.object({ email: emailSchema, password: z.string().min(1).max(72) }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Enter a valid email address and password." });
    const { email, password } = parsed.data;
    const user = await User.findOne({ email }).select("+passwordHash");
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      return response.status(423).json({ error: "Sign-in is temporarily locked. Try again in 15 minutes." });
    }
    const passwordMatches = await bcrypt.compare(password, user?.passwordHash || dummyPasswordHash);
    if (!user || !passwordMatches) {
      if (user && user.status !== "blocked" && user.status !== "deleted") {
        const failedLogins = (user.failedLogins || 0) + 1;
        await User.updateOne({ _id: user._id }, {
          $set: {
            failedLogins: failedLogins >= 5 ? 0 : failedLogins,
            ...(failedLogins >= 5 ? { lockedUntil: new Date(Date.now() + 15 * 60 * 1000) } : {}),
          },
        });
      }
      return response.status(401).json({ error: "Email or password is incorrect." });
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return response.status(423).json({ error: "Sign-in is temporarily locked. Try again in 15 minutes." });
    }
    if (!user.emailVerifiedAt) return response.status(403).json({ status: "unverified", error: "Verify your email before signing in." });
    if (user.status === "pending") return response.status(403).json({ status: "pending", error: "Your email is verified. Your account is waiting for administrator approval." });
    if (user.status !== "active" || !user.permissions.canLogin) {
      return response.status(403).json({ status: user.status, error: "This account is not currently allowed to sign in." });
    }
    const now = new Date();
    await User.updateOne({ _id: user._id }, { $set: { failedLogins: 0, lastLoginAt: now }, $unset: { lockedUntil: 1 } });
    await createSession(user, request, response);
    await writeAudit(user._id, "auth.login", "User", user._id, {});
    return response.json({ success: true, user: publicUser(user) });
  } catch (error) {
    return next(error);
  }
});

router.post("/api/auth/logout", requireAuth(), async (request, response, next) => {
  try {
    await UserSession.updateOne({ _id: request.auth.sessionId }, { $set: { revokedAt: new Date() } });
    clearSessionCookie(response);
    await writeAudit(request.auth.user._id, "auth.logout", "User", request.auth.user._id, {});
    return response.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

router.post("/api/auth/logout-all", requireAuth(), async (request, response, next) => {
  try {
    await UserSession.updateMany({ user: request.auth.user._id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    clearSessionCookie(response);
    await writeAudit(request.auth.user._id, "auth.logout_all", "User", request.auth.user._id, {});
    return response.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

router.get("/api/auth/me", requireAuth(), (request, response) => {
  return response.json({ user: publicUser(request.auth.user) });
});

router.get("/api/admin/dashboard", requireAuth({ roles: ["admin", "superadmin"] }), async (request, response, next) => {
  try {
    const [activeUsers, pendingApprovals, runningBatches, newEnquiries, feesDue, recentEnquiries, recentActivity, leadStats, studentsPerClass, popularSubject, enquiryTrend] = await Promise.all([
      User.countDocuments({ role: "user", status: "active" }),
      User.countDocuments({ role: "user", status: "pending" }),
      Batch.countDocuments({ status: { $in: ["Ongoing", "Started"] }, archivedAt: { $exists: false } }),
      Enquiry.countDocuments({ status: { $in: ["New Enquiry", "Contacted", "Follow-up Required"] } }),
      request.auth.user.role === "superadmin"
        ? FeeRecord.find({ status: { $in: ["Due", "Partial"] } }).select("amountPaise amountPaidPaise").lean()
        : Promise.resolve([]),
      Enquiry.find().select("leadId studentName className subjectName status createdAt").sort({ createdAt: -1 }).limit(8).lean(),
      ActivityLog.find().sort({ createdAt: -1 }).limit(8).populate("actor", "fullName email").lean(),
      query(`SELECT count(*)::integer AS total, count(*) FILTER (WHERE "createdAt" >= date_trunc('day', now()))::integer AS today, count(*) FILTER (WHERE "createdAt" >= now() - interval '7 days')::integer AS this_week FROM "enquiries"`),
      query(`SELECT "className", count(*)::integer AS total FROM "students" WHERE "archivedAt" IS NULL GROUP BY "className" ORDER BY "className"`),
      query(`SELECT "subjectName", count(*)::integer AS total FROM "enquiries" WHERE "subjectName" IS NOT NULL AND "subjectName" <> '' GROUP BY "subjectName" ORDER BY total DESC LIMIT 1`),
      query(`SELECT date_trunc('day', "createdAt")::date AS day, count(*)::integer AS total FROM "enquiries" WHERE "createdAt" >= current_date - interval '13 days' GROUP BY day ORDER BY day`),
    ]);
    return response.json({
      counts: {
        activeUsers,
        pendingApprovals,
        runningBatches,
        newEnquiries,
        totalEnquiries: leadStats.rows[0].total,
        enquiriesToday: leadStats.rows[0].today,
        enquiriesThisWeek: leadStats.rows[0].this_week,
        ...(request.auth.user.role === "superadmin" ? {
          feesDuePaise: feesDue.reduce((total, fee) => total + fee.amountPaise - fee.amountPaidPaise, 0),
        } : {}),
      },
      recentEnquiries,
      recentActivity,
      studentsPerClass: studentsPerClass.rows,
      popularSubject: popularSubject.rows[0] || null,
      enquiryTrend: enquiryTrend.rows,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/api/admin/settings", requireAuth({ roles: ["superadmin"] }), (_request, response) => {
  return response.json({
    settings: {
      databaseConnected: isDatabaseConnected(),
      authenticationSecretConfigured: process.env.AUTH_TOKEN_SECRET?.length >= 32,
      emailVerificationConfigured: Boolean(mailTransport),
      publicAppUrl: process.env.PUBLIC_APP_URL || "http://localhost:5173",
      allowedOrigins: [...allowedOrigins],
      paymentsEnabled: false,
      noticeDeliveryIntegrationsEnabled: false,
    },
  });
});

router.get("/api/admin/users", requireAuth({ roles: ["admin", "superadmin"] }), async (request, response, next) => {
  try {
    const status = z.enum(["pending", "active", "rejected", "suspended", "blocked", "deleted"]).optional().safeParse(request.query.status);
    const search = z.string().trim().max(100).optional().safeParse(request.query.search);
    if (!status.success || !search.success) return response.status(400).json({ error: "Invalid user filters." });
    const filter = {
      role: request.auth.user.role === "superadmin" ? { $in: ["admin", "editor", "user"] } : "user",
      ...(status.data ? { status: status.data } : {}),
      ...(search.data ? { $or: [
        { fullName: { $regex: escapeRegex(search.data), $options: "i" } },
        { email: { $regex: escapeRegex(search.data), $options: "i" } },
        { phone: { $regex: escapeRegex(search.data), $options: "i" } },
      ] } : {}),
    };
    const users = await User.find(filter)
      .select("-passwordHash -verificationTokenHash -verificationExpiresAt -passwordResetTokenHash -passwordResetExpiresAt")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    return response.json({ users });
  } catch (error) {
    return next(error);
  }
});

router.patch("/api/admin/users/:userId/access", requireAuth({ roles: ["admin", "superadmin"] }), async (request, response, next) => {
  try {
    const parsed = accessUpdateSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error);
    const target = await User.findById(request.params.userId);
    if (!target || target.role === "superadmin") return response.status(404).json({ error: "User not found." });
    if (["admin", "editor"].includes(target.role) && request.auth.user.role !== "superadmin") {
      return response.status(403).json({ error: "Only a Super Admin can change administrator accounts." });
    }
    const before = { status: target.status, preset: target.preset, permissions: target.permissions.toObject?.() || target.permissions };
    const changes = parsed.data;
    const willManageAssignedBatches = changes.permissions?.manageAssignedBatches ?? (
      changes.preset === "instructor"
        ? true
        : changes.preset === "learner"
          ? false
          : target.permissions.manageAssignedBatches
    );
    if (changes.permissions?.showOnFaculty && !willManageAssignedBatches) {
      return response.status(400).json({ error: "Only an instructor account can be featured on the faculty page." });
    }
    if (changes.status === "active" && !target.emailVerifiedAt) {
      return response.status(400).json({ error: "The user must verify their email before approval." });
    }
    if (changes.role && changes.role !== "user" && request.auth.user.role !== "superadmin") {
      return response.status(403).json({ error: "Only a Super Admin can assign administrator roles." });
    }
    if (changes.role) target.role = changes.role;
    if (changes.status) {
      target.status = changes.status;
      if (changes.status === "active") {
        target.approvedBy = request.auth.user._id;
        target.approvedAt = new Date();
        target.rejectReason = undefined;
      }
      if (changes.status === "rejected") target.rejectReason = changes.rejectReason;
      if (["suspended", "blocked", "deleted"].includes(changes.status)) {
        await UserSession.updateMany({ user: target._id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
      }
    }
    if (changes.preset) {
      target.preset = changes.preset;
      if (changes.preset === "learner") target.permissions = learnerPermissions;
      if (changes.preset === "instructor") target.permissions = instructorPermissions;
    }
    if (changes.permissions) {
      target.permissions = { ...target.permissions.toObject?.(), ...changes.permissions };
      target.preset = "custom";
    }
    if (changes.bio !== undefined) target.bio = changes.bio;
    if (changes.subjects) target.subjects = changes.subjects;
    if (changes.experienceYears !== undefined) target.experienceYears = changes.experienceYears;
    if (changes.batchIds) {
      const batches = await Batch.find({ _id: { $in: changes.batchIds }, archivedAt: { $exists: false } }).select("_id");
      if (batches.length !== new Set(changes.batchIds).size) return response.status(400).json({ error: "One or more batches were not found." });
      await Batch.updateMany({ assignedUsers: target._id }, { $pull: { assignedUsers: target._id } });
      await Batch.updateMany({ _id: { $in: changes.batchIds } }, { $addToSet: { assignedUsers: target._id } });
    }
    await target.save();
    await writeAudit(request.auth.user._id, "user.access_changed", "User", target._id, {
      before,
      after: { status: target.status, preset: target.preset, permissions: target.permissions.toObject?.() || target.permissions },
    });
    return response.json({ success: true, user: publicUser(target) });
  } catch (error) {
    return next(error);
  }
});

router.get("/api/admin/courses", requireAuth({ roles: ["admin", "superadmin"] }), async (_request, response, next) => {
  try {
    const courses = await Course.find().sort({ updatedAt: -1 }).lean();
    return response.json({ courses });
  } catch (error) {
    return next(error);
  }
});

router.patch("/api/admin/courses/:courseId", requireAuth({ roles: ["admin", "superadmin"] }), async (request, response, next) => {
  try {
    const parsed = z.object({ status: z.enum(["Draft", "Published", "Archived"]), featured: z.boolean().optional() }).strict().safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error);
    const course = await Course.findByIdAndUpdate(request.params.courseId, { $set: parsed.data }, { new: true, runValidators: true });
    if (!course) return response.status(404).json({ error: "Course not found." });
    await writeAudit(request.auth.user._id, "course.updated", "Course", course._id, parsed.data);
    return response.json({ course });
  } catch (error) {
    return next(error);
  }
});

router.post("/api/admin/courses", requireAuth({ roles: ["admin", "superadmin"] }), async (request, response, next) => {
  try {
    const parsed = courseSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error);
    const course = await Course.create({ ...parsed.data, createdBy: request.auth.user._id });
    await writeAudit(request.auth.user._id, "course.created", "Course", course._id, {});
    return response.status(201).json({ course });
  } catch (error) {
    return next(error);
  }
});

router.get("/api/admin/batches", requireAuth({ roles: ["admin", "superadmin"] }), async (_request, response, next) => {
  try {
    const [batches, instructors] = await Promise.all([
      Batch.find({ archivedAt: { $exists: false } }).sort({ startDate: -1 }).lean(),
      User.find({ role: "user", status: "active", "permissions.manageAssignedBatches": true })
        .select("fullName email subjects").sort({ fullName: 1 }).lean(),
    ]);
    return response.json({ batches, instructors });
  } catch (error) {
    return next(error);
  }
});

router.patch("/api/admin/batches/:batchId", requireAuth({ roles: ["admin", "superadmin"] }), async (request, response, next) => {
  try {
    const parsed = z.object({
      status: z.enum(["Upcoming", "Ongoing", "Started", "Completed", "Cancelled"]),
      assignedUserIds: z.array(z.string().uuid()).max(30).optional(),
    }).strict().safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error);
    if (parsed.data.assignedUserIds) {
      const instructors = await User.find({
        _id: { $in: parsed.data.assignedUserIds },
        role: "user",
        status: "active",
        "permissions.manageAssignedBatches": true,
      }).select("_id");
      if (instructors.length !== new Set(parsed.data.assignedUserIds).size) {
        return response.status(400).json({ error: "Each assigned instructor must be active and have Manage assigned batches permission." });
      }
    }
    const set = {
      status: parsed.data.status,
      ...(parsed.data.assignedUserIds ? { assignedUsers: parsed.data.assignedUserIds } : {}),
    };
    const batch = await Batch.findByIdAndUpdate(request.params.batchId, { $set: set }, { new: true, runValidators: true });
    if (!batch) return response.status(404).json({ error: "Batch not found." });
    await writeAudit(request.auth.user._id, "batch.updated", "Batch", batch._id, { status: batch.status });
    return response.json({ batch });
  } catch (error) {
    return next(error);
  }
});

router.post("/api/admin/batches", requireAuth({ roles: ["admin", "superadmin"] }), async (request, response, next) => {
  try {
    const parsed = batchSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error);
    const assignedUserIds = parsed.data.assignedUserIds;
    const instructors = await User.find({
      _id: { $in: assignedUserIds },
      role: "user",
      status: "active",
      "permissions.manageAssignedBatches": true,
    }).select("_id");
    if (instructors.length !== new Set(assignedUserIds).size) {
      return response.status(400).json({ error: "Assigned instructors must be active Users with Manage assigned batches permission." });
    }
    const { assignedUserIds: _assignedUserIds, feeRupees, ...batchData } = parsed.data;
    const batch = await Batch.create({
      ...batchData,
      assignedUsers: assignedUserIds,
      feePaise: feeRupees === undefined ? undefined : Math.round(feeRupees * 100),
    });
    await writeAudit(request.auth.user._id, "batch.created", "Batch", batch._id, {});
    return response.status(201).json({ batch });
  } catch (error) {
    return next(error);
  }
});

router.get("/api/admin/enrollments", requireAuth({ roles: ["admin", "superadmin"] }), async (request, response, next) => {
  try {
    const status = z.enum(["Requested", "Active", "Completed", "Withdrawn"]).optional().safeParse(request.query.status);
    if (!status.success) return response.status(400).json({ error: "Invalid enrolment filter." });
    const enrollments = await PortalEnrollment.find(status.data ? { status: status.data } : {})
      .populate("user", "fullName email phone className status")
      .populate("batch", "name className subjectName startDate schedule status")
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    return response.json({ enrollments });
  } catch (error) {
    return next(error);
  }
});

router.patch("/api/admin/enrollments/:enrollmentId", requireAuth({ roles: ["admin", "superadmin"] }), async (request, response, next) => {
  try {
    const parsed = z.object({ status: z.enum(["Active", "Completed", "Withdrawn"]) }).strict().safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error);
    const enrollment = await PortalEnrollment.findById(request.params.enrollmentId);
    if (!enrollment) return response.status(404).json({ error: "Enrolment not found." });
    if (parsed.data.status === "Active" && enrollment.status !== "Active") {
      const [batch, activeCount] = await Promise.all([
        Batch.findById(enrollment.batch).select("capacity status").lean(),
        PortalEnrollment.countDocuments({ batch: enrollment.batch, status: "Active" }),
      ]);
      if (!batch || !["Upcoming", "Ongoing", "Started"].includes(batch.status)) {
        return response.status(409).json({ error: "This batch is no longer accepting enrolments." });
      }
      if (activeCount >= batch.capacity) return response.status(409).json({ error: "This batch is full. Increase its capacity or choose another batch." });
    }
    enrollment.status = parsed.data.status;
    if (parsed.data.status === "Active") enrollment.joinedAt = new Date();
    if (parsed.data.status === "Withdrawn") enrollment.joinedAt = undefined;
    await enrollment.save();
    await writeAudit(request.auth.user._id, "enrollment.status_changed", "PortalEnrollment", enrollment._id, { status: enrollment.status });
    return response.json({ enrollment });
  } catch (error) {
    return next(error);
  }
});

router.get("/api/admin/notices", requireAuth({ roles: ["admin", "superadmin"] }), async (_request, response, next) => {
  try {
    const [notices, batches] = await Promise.all([
      Notice.find().sort({ createdAt: -1 }).limit(200).lean(),
      Batch.find({ archivedAt: { $exists: false } }).select("name className subjectName").sort({ startDate: -1 }).lean(),
    ]);
    return response.json({ notices, batches });
  } catch (error) {
    return next(error);
  }
});

router.post("/api/admin/notices", requireAuth({ roles: ["admin", "superadmin"] }), async (request, response, next) => {
  try {
    const parsed = noticeSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error);
    if (parsed.data.batchId && !(await Batch.exists({ _id: parsed.data.batchId }))) {
      return response.status(400).json({ error: "Choose an existing batch for this notice." });
    }
    const { batchId, ...noticeData } = parsed.data;
    const notice = await Notice.create({
      ...noticeData,
      ...(batchId ? { batch: batchId } : {}),
      createdBy: request.auth.user._id,
    });
    await writeAudit(request.auth.user._id, "notice.created", "Notice", notice._id, { publicationStatus: notice.publicationStatus });
    return response.status(201).json({ notice });
  } catch (error) {
    return next(error);
  }
});

router.patch("/api/admin/notices/:noticeId", requireAuth({ roles: ["admin", "superadmin"] }), async (request, response, next) => {
  try {
    const parsed = z.object({
      publicationStatus: z.enum(["Draft", "Scheduled", "Published", "Unpublished", "Archived"]),
    }).strict().safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error);
    const notice = await Notice.findByIdAndUpdate(request.params.noticeId, { $set: parsed.data }, { new: true, runValidators: true });
    if (!notice) return response.status(404).json({ error: "Notice not found." });
    await writeAudit(request.auth.user._id, "notice.status_changed", "Notice", notice._id, parsed.data);
    return response.json({ notice });
  } catch (error) {
    return next(error);
  }
});

router.get("/api/admin/enquiries", requireAuth({ roles: ["admin", "superadmin"] }), async (request, response, next) => {
  try {
    const parsed = z.object({
      status: z.string().trim().max(80).optional(),
      className: z.string().trim().max(80).optional(),
      subjectName: z.string().trim().max(80).optional(),
      search: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().min(1).max(10000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).safeParse(request.query);
    if (!parsed.success) return response.status(400).json({ error: "Invalid enquiry filter." });
    const { status, className, subjectName, search, page, limit } = parsed.data;
    const filters = [];
    const values = [];
    for (const [column, value] of [["status", status], ["className", className], ["subjectName", subjectName]]) {
      if (value) {
        values.push(value);
        filters.push(`"${column}" = $${values.length}`);
      }
    }
    if (search) {
      values.push(`%${search}%`);
      filters.push(`("studentName" ILIKE $${values.length} OR "phone" ILIKE $${values.length} OR COALESCE("email", '') ILIKE $${values.length})`);
    }
    const where = filters.length ? filters.join(" AND ") : "TRUE";
    const countResult = await query(`SELECT count(*)::integer AS total FROM "enquiries" WHERE ${where}`, values);
    values.push(limit, (page - 1) * limit);
    const rows = await query(
      `SELECT * FROM "enquiries" WHERE ${where} ORDER BY "createdAt" DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    const enquiryIds = rows.rows.map((item) => item._id);
    const followUps = enquiryIds.length
      ? await query(`SELECT "_id", "enquiry", "note", "followUpAt", "createdAt" FROM "follow_up_records" WHERE "enquiry" = ANY($1::uuid[]) ORDER BY "createdAt" DESC`, [enquiryIds])
      : { rows: [] };
    const notesByEnquiry = new Map();
    for (const note of followUps.rows) {
      const key = String(note.enquiry);
      if (!notesByEnquiry.has(key)) notesByEnquiry.set(key, []);
      notesByEnquiry.get(key).push(note);
    }
    const enquiries = rows.rows.map((item) => ({ ...item, notes: notesByEnquiry.get(String(item._id)) || [] }));
    return response.json({ enquiries, pagination: { page, limit, total: countResult.rows[0].total, pages: Math.ceil(countResult.rows[0].total / limit) } });
  } catch (error) {
    return next(error);
  }
});

router.get("/api/admin/enquiries/export.csv", requireAuth({ roles: ["admin", "superadmin"] }), async (_request, response, next) => {
  try {
    const result = await query(`SELECT "leadId", "studentName", "phone", "email", "className", "subjectName", "status", "message", "createdAt" FROM "enquiries" ORDER BY "createdAt" DESC LIMIT 10000`);
    const csv = [
      ["Lead ID", "Student", "Phone", "Email", "Class", "Subject", "Status", "Message", "Received"],
      ...result.rows.map((item) => [item.leadId, item.studentName, item.phone, item.email, item.className, item.subjectName, item.status, item.message, item.createdAt]),
    ].map((row) => row.map(csvValue).join(",")).join("\r\n");
    response.set("Content-Type", "text/csv; charset=utf-8");
    response.set("Content-Disposition", 'attachment; filename="theorika-enquiries.csv"');
    return response.send(`\uFEFF${csv}`);
  } catch (error) {
    return next(error);
  }
});

router.patch("/api/admin/enquiries/:enquiryId", requireAuth({ roles: ["admin", "superadmin"] }), async (request, response, next) => {
  try {
    const parsed = z.object({ status: z.enum(["New Enquiry", "Contacted", "Demo Done", "Enrolled", "Not Interested", "Follow-up Required"]) }).strict().safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error);
    const enquiry = await Enquiry.findById(request.params.enquiryId);
    if (!enquiry) return response.status(404).json({ error: "Enquiry not found." });
    const previousStatus = enquiry.status;
    enquiry.status = parsed.data.status;
    await enquiry.save();
    await writeAudit(request.auth.user._id, "enquiry.status_changed", "Enquiry", enquiry._id, { previousStatus, status: enquiry.status });
    return response.json({ enquiry });
  } catch (error) {
    return next(error);
  }
});

router.post("/api/admin/enquiries/:enquiryId/notes", requireAuth({ roles: ["admin", "superadmin"] }), async (request, response, next) => {
  try {
    const parsed = z.object({ note: z.string().trim().min(1).max(4000), followUpAt: z.string().datetime().optional() }).strict().safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error);
    const enquiry = await Enquiry.findById(request.params.enquiryId).select("_id");
    if (!enquiry) return response.status(404).json({ error: "Enquiry not found." });
    const followUp = await FollowUpRecord.create({
      enquiry: enquiry._id,
      createdBy: request.auth.user._id,
      note: parsed.data.note,
      ...(parsed.data.followUpAt ? { followUpAt: new Date(parsed.data.followUpAt) } : {}),
    });
    await writeAudit(request.auth.user._id, "enquiry.note_added", "Enquiry", enquiry._id, { noteId: followUp._id });
    return response.status(201).json({ followUp });
  } catch (error) {
    return next(error);
  }
});

router.get("/api/admin/faculty-applications", requireAuth({ roles: ["admin", "superadmin"] }), async (_request, response, next) => {
  try {
    const result = await query(
      `SELECT "_id", "fullName", "email", "phone", "city", "qualification", "experienceYears", "subjects", "classes", "message", "resumeFilename", "status", "createdAt" FROM "faculty_applications" ORDER BY "createdAt" DESC LIMIT 100`,
    );
    return response.json({ applications: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.get("/api/admin/faculty-applications/:applicationId/resume", requireAuth({ roles: ["admin", "superadmin"] }), async (request, response, next) => {
  try {
    const applicationId = z.string().uuid().safeParse(request.params.applicationId);
    if (!applicationId.success) return response.status(400).json({ error: "Invalid application." });
    const result = await query(
      `SELECT "resumeFilename", "resumeContentType", "resumeData", "resumePublicId", "resumeResourceType" FROM "faculty_applications" WHERE "_id" = $1`,
      [applicationId.data],
    );
    const application = result.rows[0];
    if (!application) return response.status(404).json({ error: "Application not found." });
    const filename = application.resumeFilename.replace(/[^A-Za-z0-9._-]/g, "_");
    response.set({
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": application.resumeContentType,
      "X-Content-Type-Options": "nosniff",
    });
    if (application.resumeData) return response.send(application.resumeData);
    if (!application.resumePublicId || !process.env.CLOUDINARY_URL) {
      return response.status(503).json({ error: "The resume storage service is unavailable." });
    }
    const temporaryUrl = cloudinary.utils.private_download_url(application.resumePublicId, null, {
      resource_type: application.resumeResourceType || "raw",
      type: "authenticated",
      expires_at: Math.floor(Date.now() / 1000) + 300,
      attachment: true,
    });
    const fileResponse = await fetch(temporaryUrl);
    if (!fileResponse.ok) {
      console.error("Could not retrieve a faculty resume from Cloudinary.", { status: fileResponse.status });
      return response.status(502).json({ error: "The resume could not be retrieved. Please try again later." });
    }
    return response.send(Buffer.from(await fileResponse.arrayBuffer()));
  } catch (error) {
    return next(error);
  }
});

router.patch("/api/admin/faculty-applications/:applicationId", requireAuth({ roles: ["admin", "superadmin"] }), async (request, response, next) => {
  try {
    const applicationId = z.string().uuid().safeParse(request.params.applicationId);
    const parsed = z.object({
      status: z.enum(["Received", "Reviewing", "Shortlisted", "Rejected", "Hired"]),
    }).strict().safeParse(request.body);
    if (!applicationId.success) return response.status(400).json({ error: "Invalid application." });
    if (!parsed.success) return validationError(response, parsed.error);
    const result = await query(
      `UPDATE "faculty_applications" SET "status" = $1 WHERE "_id" = $2 RETURNING "_id"`,
      [parsed.data.status, applicationId.data],
    );
    if (!result.rows[0]) return response.status(404).json({ error: "Application not found." });
    await writeAudit(request.auth.user._id, "faculty_application.status_changed", "FacultyApplication", applicationId.data, parsed.data);
    return response.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

router.get("/api/admin/fees", requireAuth({ roles: ["superadmin"] }), async (_request, response, next) => {
  try {
    const [fees, users, batches] = await Promise.all([
      FeeRecord.find().populate("user", "fullName email phone").populate("batch", "name className subjectName").sort({ dueDate: 1 }).limit(200).lean(),
      User.find({ role: "user", status: "active", "permissions.manageAssignedBatches": false }).select("fullName className").sort({ fullName: 1 }).lean(),
      Batch.find({ archivedAt: { $exists: false } }).select("name className subjectName").sort({ startDate: -1 }).lean(),
    ]);
    return response.json({ fees, users, batches });
  } catch (error) {
    return next(error);
  }
});

router.post("/api/admin/fees", requireAuth({ roles: ["superadmin"] }), async (request, response, next) => {
  try {
    const parsed = feeSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error);
    const user = await User.findOne({ _id: parsed.data.userId, role: "user", status: "active" }).select("_id");
    const batch = await Batch.findById(parsed.data.batchId).select("_id");
    if (!user || !batch) return response.status(400).json({ error: "Choose an active user and an existing batch." });
    const fee = await FeeRecord.create({
      user: user._id,
      batch: batch._id,
      description: parsed.data.description,
      amountPaise: Math.round(parsed.data.amountRupees * 100),
      dueDate: new Date(parsed.data.dueDate),
      createdBy: request.auth.user._id,
    });
    await writeAudit(request.auth.user._id, "fee.created", "FeeRecord", fee._id, {});
    return response.status(201).json({ fee });
  } catch (error) {
    return next(error);
  }
});

router.patch("/api/admin/fees/:feeId/payment", requireAuth({ roles: ["superadmin"] }), async (request, response, next) => {
  try {
    const parsed = z.object({
      amountPaidRupees: z.number().finite().min(0).max(10000000),
      receiptNumber: z.string().trim().max(80).optional(),
    }).safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error);
    const fee = await FeeRecord.findById(request.params.feeId);
    if (!fee) return response.status(404).json({ error: "Fee record not found." });
    const amountPaidPaise = Math.round(parsed.data.amountPaidRupees * 100);
    if (amountPaidPaise > fee.amountPaise) return response.status(400).json({ error: "Paid amount cannot exceed the fee amount." });
    fee.amountPaidPaise = amountPaidPaise;
    fee.status = amountPaidPaise === 0 ? "Due" : amountPaidPaise === fee.amountPaise ? "Paid" : "Partial";
    fee.paidAt = fee.status === "Paid" ? new Date() : undefined;
    fee.receiptNumber = parsed.data.receiptNumber;
    await fee.save();
    await writeAudit(request.auth.user._id, "fee.payment_recorded", "FeeRecord", fee._id, { status: fee.status });
    return response.json({ fee });
  } catch (error) {
    return next(error);
  }
});

router.post("/api/admin/materials", requireAuth({ roles: ["admin", "superadmin"] }), async (request, response, next) => {
  try {
    const parsed = materialSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error);
    const batch = await Batch.findOne({
      _id: parsed.data.batchId,
      ...(request.auth.user.role === "superadmin" || request.auth.user.role === "admin"
        ? {}
        : { assignedUsers: request.auth.user._id }),
    }).select("_id");
    if (!batch) return response.status(404).json({ error: "Batch not found." });
    const material = await Material.create({
      batch: batch._id,
      type: parsed.data.type,
      title: parsed.data.title,
      url: parsed.data.url,
      uploadedBy: request.auth.user._id,
    });
    await writeAudit(request.auth.user._id, "material.created", "Material", material._id, { batch: batch._id });
    return response.status(201).json({ material });
  } catch (error) {
    return next(error);
  }
});

router.post("/api/portal/materials", requireAuth({ roles: ["user"], permission: "manageAssignedBatches" }), async (request, response, next) => {
  try {
    const parsed = materialSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error);
    const batch = await Batch.findOne({ _id: parsed.data.batchId, assignedUsers: request.auth.user._id }).select("_id");
    if (!batch) return response.status(404).json({ error: "Assigned batch not found." });
    const material = await Material.create({
      batch: batch._id,
      type: parsed.data.type,
      title: parsed.data.title,
      url: parsed.data.url,
      uploadedBy: request.auth.user._id,
    });
    await writeAudit(request.auth.user._id, "material.created", "Material", material._id, { batch: batch._id });
    return response.status(201).json({ material });
  } catch (error) {
    return next(error);
  }
});

router.get("/api/portal/dashboard", requireAuth({ roles: ["user"], permission: "viewBatches" }), async (request, response, next) => {
  try {
    const user = request.auth.user;
    const enrollments = await PortalEnrollment.find({ user: user._id, status: "Active" }).populate({
      path: "batch",
      select: "batchId name className subjectName startDate endDate schedule days status liveLink",
    }).lean();
    const batchIds = enrollments.map((enrollment) => enrollment.batch?._id).filter(Boolean);
    const batches = enrollments.map(({ batch }) => {
      if (!batch) return null;
      const view = { ...batch };
      if (!user.permissions.viewLiveLinks) delete view.liveLink;
      return view;
    }).filter(Boolean);
    const [materials, attendance, fees, announcements] = await Promise.all([
      user.permissions.downloadMaterials
        ? Material.find({ batch: { $in: batchIds } }).select("batch type title url publishedAt").sort({ publishedAt: -1 }).lean()
        : [],
      user.permissions.viewAttendanceFees
        ? Attendance.find({ user: user._id }).select("batch classDate present").sort({ classDate: -1 }).limit(100).lean()
        : [],
      user.permissions.viewAttendanceFees
        ? FeeRecord.find({ user: user._id }).select("batch description amountPaise amountPaidPaise dueDate paidAt receiptNumber status").sort({ dueDate: -1 }).lean()
        : [],
      Notice.find({
        publicationStatus: "Published",
        $and: [
          { $or: [{ publishAt: { $exists: false } }, { publishAt: { $lte: new Date() } }] },
          { $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }] },
          { $or: [{ batch: { $exists: false } }, { batch: { $in: batchIds } }] },
        ],
      }).select("title content category batch publishAt").sort({ publishAt: -1 }).limit(30).lean(),
    ]);
    return response.json({
      user: publicUser(user),
      batches,
      materials,
      attendance,
      fees,
      announcements,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/api/portal/enrollments", requireAuth({ roles: ["user"], permission: "viewBatches" }), async (request, response, next) => {
  try {
    const parsed = z.object({ batchId: z.string().uuid() }).safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Choose a valid batch." });
    const batch = await Batch.findOne({ _id: parsed.data.batchId, status: { $in: ["Upcoming", "Ongoing", "Started"] }, archivedAt: { $exists: false } });
    if (!batch) return response.status(404).json({ error: "Batch is not available for enrolment." });
    if (batch.className !== request.auth.user.className) {
      return response.status(403).json({ error: "This batch is not listed for your registered class." });
    }
    if (batch.className !== request.auth.user.className) {
      return response.status(403).json({ error: "This batch is not listed for your registered class." });
    }
    const activeCount = await PortalEnrollment.countDocuments({ batch: batch._id, status: "Active" });
    if (activeCount >= batch.capacity) return response.status(409).json({ error: "This batch is full." });
    let enrollment = await PortalEnrollment.findOne({ user: request.auth.user._id, batch: batch._id });
    if (enrollment) {
      if (["Requested", "Active"].includes(enrollment.status)) {
        return response.status(409).json({ error: "An enrolment request already exists for this batch." });
      }
      enrollment.status = "Requested";
      enrollment.joinedAt = undefined;
      await enrollment.save();
    } else {
      enrollment = await PortalEnrollment.create({ user: request.auth.user._id, batch: batch._id, status: "Requested" });
    }
    await writeAudit(request.auth.user._id, "enrollment.requested", "PortalEnrollment", enrollment._id, { batch: batch._id });
    return response.status(201).json({ enrollment });
  } catch (error) {
    if (error?.code === 11000) return response.status(409).json({ error: "An enrolment request already exists." });
    return next(error);
  }
});

router.get("/api/portal/teaching", requireAuth({ roles: ["user"], permission: "manageAssignedBatches" }), async (request, response, next) => {
  try {
    const batches = await Batch.find({ assignedUsers: request.auth.user._id, archivedAt: { $exists: false } })
      .select("batchId name className subjectName startDate endDate schedule days status")
      .lean();
    const batchIds = batches.map((batch) => batch._id);
    const enrollments = await PortalEnrollment.find({ batch: { $in: batchIds }, status: "Active" })
      .populate("user", "fullName email className")
      .populate("batch", "name className subjectName")
      .lean();
    return response.json({ batches, learners: enrollments.map((enrollment) => ({ enrollmentId: enrollment._id, user: enrollment.user, batch: enrollment.batch })) });
  } catch (error) {
    return next(error);
  }
});

router.post("/api/portal/attendance", requireAuth({ roles: ["user"], permission: "manageAssignedBatches" }), async (request, response, next) => {
  try {
    const parsed = attendanceSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response, parsed.error);
    const batch = await Batch.findOne({ _id: parsed.data.batchId, assignedUsers: request.auth.user._id }).select("_id");
    if (!batch) return response.status(404).json({ error: "Assigned batch not found." });
    const userIds = parsed.data.records.map((record) => record.userId);
    const enrolled = await PortalEnrollment.find({ batch: batch._id, user: { $in: userIds }, status: "Active" }).select("user").lean();
    if (enrolled.length !== new Set(userIds).size) return response.status(400).json({ error: "Attendance can only be recorded for enrolled users." });
    const classDate = new Date(parsed.data.classDate);
    await Attendance.bulkWrite(parsed.data.records.map((record) => ({
      updateOne: {
        filter: { batch: batch._id, user: record.userId, classDate },
        update: { $set: { present: record.present, markedBy: request.auth.user._id, note: record.note } },
        upsert: true,
      },
    })));
    await writeAudit(request.auth.user._id, "attendance.marked", "Batch", batch._id, { classDate, count: userIds.length });
    return response.json({ success: true, count: userIds.length });
  } catch (error) {
    return next(error);
  }
});

router.get("/api/admin/audit-log", requireAuth({ roles: ["admin", "superadmin"] }), async (_request, response, next) => {
  try {
    const entries = await ActivityLog.find().sort({ createdAt: -1 }).limit(200).populate("actor", "fullName email").lean();
    return response.json({ entries });
  } catch (error) {
    return next(error);
  }
});

router.use((error, _request, response, _next) => {
  if (error?.code === 11000) return response.status(409).json({ error: "A record with these details already exists." });
  if (["22P02", "23502", "23503", "23514"].includes(error?.code)) {
    return response.status(400).json({ error: "One or more fields are invalid." });
  }
  if (error?.name === "ValidationError") return response.status(400).json({ error: "One or more fields are invalid." });
  if (error?.name === "CastError") return response.status(400).json({ error: "The requested record was not found." });
  return response.status(500).json({ error: "An unexpected dashboard service error occurred." });
});

function createMailTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, EMAIL_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASSWORD || !EMAIL_FROM) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  });
}

function hasDatabaseAndAuth() {
  return Boolean(
    isDatabaseConfigured() &&
    process.env.AUTH_TOKEN_SECRET?.length >= 32 &&
    isDatabaseConnected(),
  );
}

function configurationUnavailable(response) {
  return response.status(503).json({ error: "Account services are unavailable until the API, Supabase database and authentication secret are configured." });
}

function validationError(response, error) {
  return response.status(400).json({
    error: "Check the submitted fields and try again.",
    fields: error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
  });
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function publicUser(user) {
  return {
    id: String(user._id),
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    preset: user.preset,
    permissions: user.permissions,
    className: user.className,
    parentName: user.parentName,
    parentPhone: user.parentPhone,
    school: user.school,
    bio: user.bio,
    subjects: user.subjects,
    experienceYears: user.experienceYears,
    emailVerified: Boolean(user.emailVerifiedAt),
    passwordChangeRequired: Boolean(user.passwordChangeRequired),
  };
}

function getFrontendOrigin(request) {
  const origin = request.get("Origin");
  return origin && origin.startsWith("http") ? origin : process.env.PUBLIC_APP_URL || "http://localhost:5173";
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function csvValue(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

async function writeAudit(actor, action, entityType, entityId, details) {
  await ActivityLog.create({ actor, action, entityType, entityId: String(entityId), details });
}

const registrationSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: emailSchema,
  phone: phoneSchema,
  password: z.string().min(12).max(72),
  className: z.enum(classes),
  school: z.string().trim().max(160).optional().default(""),
  parentName: z.string().trim().min(2).max(120),
  parentPhone: phoneSchema,
  parentConsent: z.literal(true),
}).strict();

const accessUpdateSchema = z.object({
  status: z.enum(["active", "rejected", "suspended", "blocked", "deleted"]).optional(),
  role: z.enum(["user", "admin", "editor"]).optional(),
  preset: z.enum(["learner", "instructor", "custom"]).optional(),
  permissions: z.object(Object.fromEntries(permissionNames.map((name) => [name, z.boolean().optional()]))).strict().optional(),
  bio: z.string().trim().max(2000).optional(),
  subjects: z.array(z.enum(subjects)).max(4).optional(),
  experienceYears: z.number().int().min(0).max(80).optional(),
  batchIds: z.array(z.string().uuid()).max(100).optional(),
  rejectReason: z.string().trim().max(1000).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one access change is required.");

const courseSchema = z.object({
  title: z.string().trim().min(2).max(160),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(180),
  className: z.enum(classes),
  subjectName: z.enum(subjects),
  description: z.string().trim().max(4000).optional().default(""),
  syllabus: z.array(z.string().trim().min(1).max(200)).max(100).optional().default([]),
  status: z.enum(["Draft", "Published", "Archived"]).default("Draft"),
  featured: z.boolean().default(false),
}).strict();

const batchSchema = z.object({
  name: z.string().trim().min(2).max(120),
  className: z.enum(classes),
  subjectName: z.enum(subjects),
  startDate: z.string().datetime(),
  endDate: z.string().datetime().optional(),
  schedule: z.string().trim().max(500).optional().default(""),
  days: z.array(z.enum(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"])).max(7).optional().default([]),
  capacity: z.number().int().min(1).max(10000),
  feeRupees: z.number().finite().min(0).max(10000000).optional(),
  description: z.string().trim().max(4000).optional().default(""),
  status: z.enum(["Upcoming", "Ongoing", "Started", "Completed", "Cancelled"]).default("Upcoming"),
  liveLink: safeUrlSchema.optional(),
  assignedUserIds: z.array(z.string().uuid()).max(30).optional().default([]),
}).strict();

const feeSchema = z.object({
  userId: z.string().uuid(),
  batchId: z.string().uuid(),
  description: z.string().trim().min(2).max(200),
  amountRupees: z.number().finite().min(1).max(10000000),
  dueDate: z.string().date(),
}).strict();

const materialSchema = z.object({
  batchId: z.string().uuid(),
  type: z.enum(["note", "recording", "link"]),
  title: z.string().trim().min(2).max(200),
  url: safeUrlSchema,
}).strict();

const noticeSchema = z.object({
  title: z.string().trim().min(2).max(200),
  content: z.string().trim().min(1).max(10000),
  category: z.string().trim().max(80).optional().default("General"),
  batchId: z.string().uuid().optional(),
  publishAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  publicationStatus: z.enum(["Draft", "Scheduled", "Published"]).default("Draft"),
}).strict().refine((value) => !value.publishAt || !value.expiresAt || new Date(value.expiresAt) > new Date(value.publishAt), "Expiration must be after publication.");

const attendanceSchema = z.object({
  batchId: z.string().uuid(),
  classDate: z.string().datetime(),
  records: z.array(z.object({
    userId: z.string().uuid(),
    present: z.boolean(),
    note: z.string().trim().max(500).optional(),
  }).strict()).min(1).max(300),
}).strict().refine((value) => new Set(value.records.map((record) => record.userId)).size === value.records.length, "Duplicate users are not allowed in one attendance submission.");

module.exports = { router, learnerPermissions, instructorPermissions };

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS "counters" (
  "_id" text PRIMARY KEY,
  "sequence" integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "users" (
  "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "fullName" varchar(120) NOT NULL,
  "email" varchar(254) NOT NULL UNIQUE,
  "phone" varchar(20) NOT NULL,
  "passwordHash" text NOT NULL,
  "role" text NOT NULL DEFAULT 'user' CHECK ("role" IN ('superadmin', 'admin', 'user')),
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'active', 'rejected', 'suspended', 'blocked', 'deleted')),
  "permissions" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "preset" text NOT NULL DEFAULT 'custom' CHECK ("preset" IN ('learner', 'instructor', 'custom')),
  "className" varchar(80),
  "parentName" varchar(120),
  "parentPhone" varchar(20),
  "parentConsentAt" timestamptz,
  "school" varchar(160),
  "bio" varchar(2000),
  "subjects" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "experienceYears" integer CHECK ("experienceYears" BETWEEN 0 AND 80),
  "emailVerifiedAt" timestamptz,
  "verificationTokenHash" text,
  "verificationExpiresAt" timestamptz,
  "rejectReason" varchar(1000),
  "approvedBy" uuid REFERENCES "users"("_id") ON DELETE SET NULL,
  "approvedAt" timestamptz,
  "lastLoginAt" timestamptz,
  "failedLogins" integer NOT NULL DEFAULT 0,
  "lockedUntil" timestamptz,
  "passwordResetTokenHash" text,
  "passwordResetExpiresAt" timestamptz,
  "passwordChangeRequired" boolean NOT NULL DEFAULT false,
  "deletedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_one_superadmin" ON "users" ("role") WHERE "role" = 'superadmin';
CREATE INDEX IF NOT EXISTS "users_role_status_created" ON "users" ("role", "status", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "users_phone" ON "users" ("phone");

CREATE TABLE IF NOT EXISTS "class_options" (
  "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" varchar(80) NOT NULL UNIQUE,
  "isActive" boolean NOT NULL DEFAULT true,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "subject_options" (
  "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" varchar(80) NOT NULL UNIQUE,
  "isActive" boolean NOT NULL DEFAULT true,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "students" (
  "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "studentId" varchar(40) NOT NULL UNIQUE,
  "fullName" varchar(120) NOT NULL,
  "phone" varchar(20) NOT NULL,
  "email" varchar(254),
  "className" varchar(80) NOT NULL,
  "subjectName" varchar(80),
  "address" varchar(1000),
  "assignedTo" uuid REFERENCES "users"("_id") ON DELETE SET NULL,
  "status" text NOT NULL DEFAULT 'Admitted',
  "admissionDate" timestamptz,
  "archivedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "enquiries" (
  "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "leadId" varchar(40) NOT NULL UNIQUE,
  "submissionKey" uuid NOT NULL UNIQUE,
  "student" uuid REFERENCES "students"("_id") ON DELETE SET NULL,
  "assignedTo" uuid REFERENCES "users"("_id") ON DELETE SET NULL,
  "studentName" varchar(120) NOT NULL,
  "phone" varchar(20) NOT NULL,
  "email" varchar(254),
  "className" varchar(80) NOT NULL,
  "subjectName" varchar(80),
  "message" varchar(2000),
  "status" text NOT NULL DEFAULT 'New Enquiry',
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "enquiries_status_created" ON "enquiries" ("status", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "enquiries_phone" ON "enquiries" ("phone");

CREATE TABLE IF NOT EXISTS "follow_up_records" (
  "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "enquiry" uuid REFERENCES "enquiries"("_id") ON DELETE CASCADE,
  "student" uuid REFERENCES "students"("_id") ON DELETE CASCADE,
  "createdBy" uuid REFERENCES "users"("_id") ON DELETE SET NULL,
  "note" varchar(4000) NOT NULL,
  "followUpAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CHECK ("enquiry" IS NOT NULL OR "student" IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS "teachers" (
  "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "teacherId" varchar(40) NOT NULL UNIQUE,
  "fullName" varchar(120) NOT NULL,
  "phone" varchar(20) NOT NULL,
  "email" varchar(254),
  "address" varchar(1000),
  "qualification" varchar(300),
  "experienceYears" integer CHECK ("experienceYears" BETWEEN 0 AND 80),
  "subjects" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "classes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "resumePath" varchar(500),
  "profilePhotoPath" varchar(500),
  "joiningDate" timestamptz,
  "employmentStatus" text NOT NULL DEFAULT 'Active',
  "notes" varchar(4000),
  "archivedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "batches" (
  "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "batchId" varchar(40) NOT NULL UNIQUE,
  "name" varchar(120) NOT NULL,
  "className" varchar(80) NOT NULL,
  "subjectName" varchar(80) NOT NULL,
  "startDate" timestamptz NOT NULL,
  "endDate" timestamptz,
  "schedule" varchar(500),
  "days" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "feePaise" integer CHECK ("feePaise" >= 0),
  "liveLink" varchar(1000),
  "assignedUsers" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "capacity" integer NOT NULL CHECK ("capacity" BETWEEN 1 AND 10000),
  "description" varchar(4000),
  "status" text NOT NULL DEFAULT 'Upcoming' CHECK ("status" IN ('Upcoming', 'Ongoing', 'Started', 'Completed', 'Cancelled')),
  "archivedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CHECK ("endDate" IS NULL OR "endDate" >= "startDate")
);
CREATE INDEX IF NOT EXISTS "batches_start_status" ON "batches" ("startDate", "status");

CREATE TABLE IF NOT EXISTS "teacher_batch_assignments" (
  "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "teacher" uuid NOT NULL REFERENCES "teachers"("_id") ON DELETE CASCADE,
  "batch" uuid NOT NULL REFERENCES "batches"("_id") ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("teacher", "batch")
);

CREATE TABLE IF NOT EXISTS "batch_enrollments" (
  "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "student" uuid REFERENCES "students"("_id") ON DELETE CASCADE,
  "batch" uuid NOT NULL REFERENCES "batches"("_id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'Active',
  "enrolledAt" timestamptz NOT NULL DEFAULT now(),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("student", "batch")
);

CREATE TABLE IF NOT EXISTS "portal_enrollments" (
  "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user" uuid NOT NULL REFERENCES "users"("_id") ON DELETE CASCADE,
  "batch" uuid NOT NULL REFERENCES "batches"("_id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'Requested' CHECK ("status" IN ('Requested', 'Active', 'Completed', 'Withdrawn')),
  "joinedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("user", "batch")
);
CREATE INDEX IF NOT EXISTS "portal_enrollments_batch_status" ON "portal_enrollments" ("batch", "status");

CREATE TABLE IF NOT EXISTS "courses" (
  "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "title" varchar(160) NOT NULL,
  "slug" varchar(180) NOT NULL UNIQUE,
  "className" varchar(80) NOT NULL,
  "subjectName" varchar(80) NOT NULL,
  "description" varchar(4000),
  "syllabus" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" text NOT NULL DEFAULT 'Draft' CHECK ("status" IN ('Draft', 'Published', 'Archived')),
  "featured" boolean NOT NULL DEFAULT false,
  "createdBy" uuid REFERENCES "users"("_id") ON DELETE SET NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "courses_status_class_subject" ON "courses" ("status", "className", "subjectName");

CREATE TABLE IF NOT EXISTS "user_sessions" (
  "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user" uuid NOT NULL REFERENCES "users"("_id") ON DELETE CASCADE,
  "tokenIdHash" varchar(64) NOT NULL UNIQUE,
  "device" varchar(300),
  "ipAddress" varchar(80),
  "expiresAt" timestamptz NOT NULL,
  "revokedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "user_sessions_user" ON "user_sessions" ("user");
CREATE INDEX IF NOT EXISTS "user_sessions_expiry" ON "user_sessions" ("expiresAt");

CREATE TABLE IF NOT EXISTS "materials" (
  "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "batch" uuid NOT NULL REFERENCES "batches"("_id") ON DELETE CASCADE,
  "type" text NOT NULL CHECK ("type" IN ('note', 'recording', 'link')),
  "title" varchar(200) NOT NULL,
  "url" varchar(1000) NOT NULL,
  "uploadedBy" uuid NOT NULL REFERENCES "users"("_id") ON DELETE RESTRICT,
  "publishedAt" timestamptz NOT NULL DEFAULT now(),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "materials_batch" ON "materials" ("batch");

CREATE TABLE IF NOT EXISTS "attendance" (
  "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "batch" uuid NOT NULL REFERENCES "batches"("_id") ON DELETE CASCADE,
  "user" uuid NOT NULL REFERENCES "users"("_id") ON DELETE CASCADE,
  "classDate" timestamptz NOT NULL,
  "present" boolean NOT NULL,
  "markedBy" uuid NOT NULL REFERENCES "users"("_id") ON DELETE RESTRICT,
  "note" varchar(500),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("batch", "user", "classDate")
);
CREATE INDEX IF NOT EXISTS "attendance_user_date" ON "attendance" ("user", "classDate" DESC);

CREATE TABLE IF NOT EXISTS "fee_records" (
  "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user" uuid NOT NULL REFERENCES "users"("_id") ON DELETE CASCADE,
  "batch" uuid NOT NULL REFERENCES "batches"("_id") ON DELETE CASCADE,
  "description" varchar(200) NOT NULL,
  "amountPaise" integer NOT NULL CHECK ("amountPaise" >= 1),
  "amountPaidPaise" integer NOT NULL DEFAULT 0 CHECK ("amountPaidPaise" >= 0),
  "dueDate" timestamptz NOT NULL,
  "paidAt" timestamptz,
  "receiptNumber" varchar(80),
  "status" text NOT NULL DEFAULT 'Due' CHECK ("status" IN ('Due', 'Partial', 'Paid', 'Waived')),
  "createdBy" uuid NOT NULL REFERENCES "users"("_id") ON DELETE RESTRICT,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "fee_records_user_due" ON "fee_records" ("user", "dueDate");

CREATE TABLE IF NOT EXISTS "notices" (
  "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "noticeId" varchar(40) NOT NULL UNIQUE,
  "title" varchar(200) NOT NULL,
  "content" varchar(10000) NOT NULL,
  "category" varchar(80) NOT NULL DEFAULT 'General',
  "batch" uuid REFERENCES "batches"("_id") ON DELETE SET NULL,
  "publishAt" timestamptz,
  "expiresAt" timestamptz,
  "publicationStatus" text NOT NULL DEFAULT 'Draft' CHECK ("publicationStatus" IN ('Draft', 'Scheduled', 'Published', 'Unpublished', 'Archived')),
  "createdBy" uuid NOT NULL REFERENCES "users"("_id") ON DELETE RESTRICT,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CHECK ("publishAt" IS NULL OR "expiresAt" IS NULL OR "expiresAt" > "publishAt")
);
CREATE INDEX IF NOT EXISTS "notices_publication" ON "notices" ("publicationStatus", "publishAt", "expiresAt");

CREATE TABLE IF NOT EXISTS "activity_logs" (
  "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "actor" uuid REFERENCES "users"("_id") ON DELETE SET NULL,
  "action" varchar(120) NOT NULL,
  "entityType" varchar(80) NOT NULL,
  "entityId" varchar(120),
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "activity_logs_created" ON "activity_logs" ("createdAt" DESC);
CREATE INDEX IF NOT EXISTS "activity_logs_entity" ON "activity_logs" ("entityType", "entityId");

CREATE TABLE IF NOT EXISTS "enquiry_rate_limits" (
  "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "keyHash" varchar(64) NOT NULL,
  "windowStartedAt" timestamptz NOT NULL,
  "requestCount" integer NOT NULL DEFAULT 0,
  "expiresAt" timestamptz NOT NULL,
  UNIQUE ("keyHash", "windowStartedAt")
);
CREATE INDEX IF NOT EXISTS "enquiry_rate_limits_expiry" ON "enquiry_rate_limits" ("expiresAt");

ALTER TABLE "counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "class_options" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subject_options" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "students" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "enquiries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "follow_up_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "teachers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "teacher_batch_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "batch_enrollments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "portal_enrollments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "courses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "materials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fee_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "activity_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "enquiry_rate_limits" ENABLE ROW LEVEL SECURITY;

const cloudinary = require("cloudinary").v2;
const express = require("express");
const multer = require("multer");
const { z } = require("zod");
const { query } = require("./database");
const { requireAuth } = require("./auth");
const { ActivityLog } = require("./models");

const router = express.Router();
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
    .split(",").map((origin) => origin.trim()).filter(Boolean),
);
const collections = new Set([
  "site-settings",
  "home-sections",
  "subjects",
  "courses",
  "batches",
  "faculty",
  "results",
  "testimonials",
  "fee-plans",
  "faqs",
  "pages",
  "announcements",
  "blog",
  "media",
]);
const editorRoles = ["admin", "superadmin", "editor"];
const contentSchema = z.object({
  slug: z.string().trim().min(1).max(160).regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().trim().min(1).max(200),
  content: z.record(z.string(), z.unknown()).default({}),
  displayOrder: z.number().int().min(0).max(10000).default(0),
  isVisible: z.boolean().default(true),
  status: z.enum(["Draft", "Published"]).default("Draft"),
}).strict();
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(_request, file, callback) {
    if (!["image/jpeg", "image/png", "image/webp", "image/avif"].includes(file.mimetype)) {
      return callback(new Error("Upload an image in JPG, PNG, WebP, or AVIF format."));
    }
    return callback(null, true);
  },
});

router.use((request, response, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && !allowedOrigins.has(request.get("Origin"))) {
    return response.status(403).json({ error: "This website is not allowed to change content." });
  }
  return next();
});

router.get("/api/public/site-content", async (_request, response, next) => {
  try {
    const result = await query(
      `SELECT "collection", "slug", "title",
              CASE WHEN "isVisible" THEN "content" ELSE '{}'::jsonb END AS "content",
              "displayOrder", "isVisible", "updatedAt"
       FROM "site_content"
       WHERE "status" = 'Published' AND ("isVisible" = true OR "collection" = 'home-sections')
       ORDER BY "collection", "displayOrder", "title"`,
    );
    const content = {};
    for (const item of result.rows) {
      if (!content[item.collection]) content[item.collection] = [];
      content[item.collection].push(item);
    }
    response.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return response.json({ content });
  } catch (error) {
    return next(error);
  }
});

router.get("/api/admin/content/:collection", requireAuth({ roles: editorRoles }), async (request, response, next) => {
  try {
    const collection = parseCollection(request.params.collection);
    if (!collection) return response.status(404).json({ error: "Content collection not found." });
    const result = await query(
      `SELECT "_id", "collection", "slug", "title", "content", "displayOrder", "isVisible", "status", "createdAt", "updatedAt"
       FROM "site_content" WHERE "collection" = $1 ORDER BY "displayOrder", "title"`,
      [collection],
    );
    return response.json({ items: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.post("/api/admin/content/:collection", requireAuth({ roles: editorRoles }), async (request, response, next) => {
  try {
    const collection = parseCollection(request.params.collection);
    if (!collection) return response.status(404).json({ error: "Content collection not found." });
    const parsed = contentSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Check the content fields and try again." });
    const item = parsed.data;
    const result = await query(
      `INSERT INTO "site_content" ("collection", "slug", "title", "content", "displayOrder", "isVisible", "status", "createdBy")
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
       RETURNING "_id", "collection", "slug", "title", "content", "displayOrder", "isVisible", "status", "createdAt", "updatedAt"`,
      [collection, item.slug, item.title, JSON.stringify(item.content), item.displayOrder, item.isVisible, item.status, request.auth.user._id],
    );
    await logChange(request.auth.user._id, "cms.content_created", result.rows[0]);
    return response.status(201).json({ item: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.put("/api/admin/content/:collection/:contentId", requireAuth({ roles: editorRoles }), async (request, response, next) => {
  try {
    const collection = parseCollection(request.params.collection);
    if (!collection) return response.status(404).json({ error: "Content collection not found." });
    const parsed = contentSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Check the content fields and try again." });
    const item = parsed.data;
    const result = await query(
      `UPDATE "site_content"
       SET "slug" = $3, "title" = $4, "content" = $5::jsonb, "displayOrder" = $6,
           "isVisible" = $7, "status" = $8, "updatedAt" = now()
       WHERE "collection" = $1 AND "_id" = $2
       RETURNING "_id", "collection", "slug", "title", "content", "displayOrder", "isVisible", "status", "createdAt", "updatedAt"`,
      [collection, request.params.contentId, item.slug, item.title, JSON.stringify(item.content), item.displayOrder, item.isVisible, item.status],
    );
    if (!result.rowCount) return response.status(404).json({ error: "Content item not found." });
    await logChange(request.auth.user._id, "cms.content_updated", result.rows[0]);
    return response.json({ item: result.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.delete("/api/admin/content/:collection/:contentId", requireAuth({ roles: editorRoles }), async (request, response, next) => {
  try {
    const collection = parseCollection(request.params.collection);
    if (!collection) return response.status(404).json({ error: "Content collection not found." });
    const result = await query(
      `DELETE FROM "site_content" WHERE "collection" = $1 AND "_id" = $2 RETURNING "_id", "slug", "title"`,
      [collection, request.params.contentId],
    );
    if (!result.rowCount) return response.status(404).json({ error: "Content item not found." });
    await logChange(request.auth.user._id, "cms.content_deleted", { ...result.rows[0], collection });
    return response.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

router.post("/api/admin/media", requireAuth({ roles: editorRoles }), mediaUpload.single("file"), async (request, response, next) => {
  try {
    if (!process.env.CLOUDINARY_URL) return response.status(503).json({ error: "Media uploads are not configured." });
    if (!request.file) return response.status(400).json({ error: "Select an image to upload." });
    const asset = await uploadImage(request.file.buffer);
    const slug = asset.public_id.replace(/[^a-zA-Z0-9-]+/g, "-").toLowerCase().slice(0, 160);
    const inserted = await query(
      `INSERT INTO "site_content" ("collection", "slug", "title", "content", "displayOrder", "isVisible", "status", "createdBy")
       VALUES ('media', $1, $2, $3::jsonb, 0, true, 'Published', $4)
       RETURNING "_id", "collection", "slug", "title", "content", "displayOrder", "isVisible", "status", "createdAt", "updatedAt"`,
      [slug, request.file.originalname.slice(0, 200), JSON.stringify({ publicId: asset.public_id, url: asset.secure_url, width: asset.width, height: asset.height }), request.auth.user._id],
    );
    await logChange(request.auth.user._id, "cms.media_uploaded", { ...inserted.rows[0], publicId: asset.public_id });
    return response.status(201).json({ media: inserted.rows[0] });
  } catch (error) {
    return next(error);
  }
});

router.delete("/api/admin/media", requireAuth({ roles: editorRoles }), async (request, response, next) => {
  try {
    if (!process.env.CLOUDINARY_URL) return response.status(503).json({ error: "Media storage is not configured." });
    const parsed = z.object({ publicId: z.string().min(1).max(255).startsWith("theorika/site-media/") }).strict().safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({ error: "The media identifier is invalid." });
    }
    const { publicId } = parsed.data;
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true });
    if (result.result !== "ok" && result.result !== "not found") {
      return response.status(502).json({ error: "The image could not be deleted from media storage." });
    }
    await query(`DELETE FROM "site_content" WHERE "collection" = 'media' AND "content"->>'publicId' = $1`, [publicId]);
    await logChange(request.auth.user._id, "cms.media_deleted", { publicId });
    return response.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

function parseCollection(value) {
  return collections.has(value) ? value : null;
}

function uploadImage(buffer) {
  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream({
      resource_type: "image",
      folder: "theorika/site-media",
      transformation: [{ quality: "auto", fetch_format: "auto" }],
      use_filename: false,
      unique_filename: true,
    }, (error, result) => {
      if (error) return reject(error);
      if (!result?.secure_url || !result.public_id) return reject(new Error("Media storage returned incomplete image details."));
      return resolve(result);
    });
    upload.end(buffer);
  });
}

async function logChange(actor, action, item) {
  await ActivityLog.create({
    actor,
    action,
    entityType: item.collection || "Media",
    entityId: item._id || item.publicId,
    details: { title: item.title, slug: item.slug, publicId: item.publicId },
  });
}

router.use((error, request, response, _next) => {
  if (error?.code === "23505") return response.status(409).json({ error: "A content item with this slug already exists." });
  if (["22P02", "23502", "23503", "23514"].includes(error?.code)) {
    return response.status(400).json({ error: "One or more content fields are invalid." });
  }
  if (error?.name === "MulterError" || error?.message?.startsWith("Upload an image")) {
    return response.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "Images must be 5 MB or smaller." : error.message });
  }
  console.error("CMS API request failed.", {
    method: request.method,
    path: request.path,
    name: error?.name || "UnknownError",
    code: error?.code || "unavailable",
  });
  return response.status(500).json({ error: "An unexpected content service error occurred." });
});

module.exports = { router };

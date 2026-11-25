const crypto = require("node:crypto");
const { query } = require("./database");

const definitions = {
  ActivityLog: { table: "activity_logs", columns: ["actor", "action", "entityType", "entityId", "details"], hidden: [], defaults: { details: {} }, timestamps: "created" },
  Attendance: { table: "attendance", columns: ["batch", "user", "classDate", "present", "markedBy", "note"], hidden: [], defaults: {}, timestamps: true, conflict: ["batch", "user", "classDate"] },
  Batch: { table: "batches", columns: ["batchId", "name", "className", "subjectName", "startDate", "endDate", "schedule", "days", "feePaise", "liveLink", "assignedUsers", "capacity", "description", "status", "archivedAt"], hidden: [], defaults: { days: [], assignedUsers: [], status: "Upcoming" }, timestamps: true, generated: ["batchId", "BAT"] },
  BatchEnrollment: { table: "batch_enrollments", columns: ["student", "batch", "status", "enrolledAt"], hidden: [], defaults: { status: "Active", enrolledAt: () => new Date() }, timestamps: true },
  ClassOption: { table: "class_options", columns: ["name", "isActive"], hidden: [], defaults: { isActive: true }, timestamps: true },
  Course: { table: "courses", columns: ["title", "slug", "className", "subjectName", "description", "syllabus", "status", "featured", "createdBy"], hidden: [], defaults: { syllabus: [], status: "Draft", featured: false }, timestamps: true },
  Counter: { table: "counters", columns: ["sequence"], hidden: [], defaults: { sequence: 0 }, timestamps: false, textId: true },
  Enquiry: { table: "enquiries", columns: ["leadId", "submissionKey", "student", "assignedTo", "studentName", "phone", "email", "className", "subjectName", "message", "status"], hidden: [], defaults: { status: "New Enquiry" }, timestamps: true },
  EnquiryRateLimit: { table: "enquiry_rate_limits", columns: ["keyHash", "windowStartedAt", "requestCount", "expiresAt"], hidden: [], defaults: { requestCount: 0 }, timestamps: false, conflict: ["keyHash", "windowStartedAt"] },
  FeeRecord: { table: "fee_records", columns: ["user", "batch", "description", "amountPaise", "amountPaidPaise", "dueDate", "paidAt", "receiptNumber", "status", "createdBy"], hidden: [], defaults: { amountPaidPaise: 0, status: "Due" }, timestamps: true },
  FollowUpRecord: { table: "follow_up_records", columns: ["enquiry", "student", "createdBy", "note", "followUpAt"], hidden: [], defaults: {}, timestamps: true },
  Material: { table: "materials", columns: ["batch", "type", "title", "url", "uploadedBy", "publishedAt"], hidden: [], defaults: { publishedAt: () => new Date() }, timestamps: true },
  Notice: { table: "notices", columns: ["noticeId", "title", "content", "category", "batch", "publishAt", "expiresAt", "publicationStatus", "createdBy"], hidden: [], defaults: { category: "General", publicationStatus: "Draft" }, timestamps: true, generated: ["noticeId", "NOT"] },
  PortalEnrollment: { table: "portal_enrollments", columns: ["user", "batch", "status", "joinedAt"], hidden: [], defaults: { status: "Requested" }, timestamps: true, conflict: ["user", "batch"] },
  Student: { table: "students", columns: ["studentId", "fullName", "phone", "email", "className", "subjectName", "address", "assignedTo", "status", "admissionDate", "archivedAt"], hidden: [], defaults: { status: "Admitted" }, timestamps: true, generated: ["studentId", "THE"] },
  SubjectOption: { table: "subject_options", columns: ["name", "isActive"], hidden: [], defaults: { isActive: true }, timestamps: true },
  Teacher: { table: "teachers", columns: ["teacherId", "fullName", "phone", "email", "address", "qualification", "experienceYears", "subjects", "classes", "resumePath", "profilePhotoPath", "joiningDate", "employmentStatus", "notes", "archivedAt"], hidden: [], defaults: { subjects: [], classes: [], employmentStatus: "Active" }, timestamps: true, generated: ["teacherId", "TEA"] },
  TeacherBatchAssignment: { table: "teacher_batch_assignments", columns: ["teacher", "batch"], hidden: [], defaults: {}, timestamps: true, conflict: ["teacher", "batch"] },
  User: {
    table: "users",
    columns: ["fullName", "email", "phone", "passwordHash", "role", "status", "permissions", "preset", "className", "parentName", "parentPhone", "parentConsentAt", "school", "bio", "subjects", "experienceYears", "emailVerifiedAt", "verificationTokenHash", "verificationExpiresAt", "rejectReason", "approvedBy", "approvedAt", "lastLoginAt", "failedLogins", "lockedUntil", "passwordResetTokenHash", "passwordResetExpiresAt", "passwordChangeRequired", "deletedAt"],
    hidden: ["passwordHash", "verificationTokenHash", "verificationExpiresAt", "passwordResetTokenHash", "passwordResetExpiresAt"],
    defaults: { role: "user", status: "pending", permissions: {}, preset: "custom", subjects: [], failedLogins: 0, passwordChangeRequired: false },
    timestamps: true,
    conflict: ["email"],
  },
  UserSession: { table: "user_sessions", columns: ["user", "tokenIdHash", "device", "ipAddress", "expiresAt", "revokedAt"], hidden: ["tokenIdHash"], defaults: {}, timestamps: "created" },
};

const populationTargets = {
  ActivityLog: { actor: "User" },
  FeeRecord: { user: "User", batch: "Batch" },
  PortalEnrollment: { user: "User", batch: "Batch" },
};

function quoteIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error("Invalid database identifier.");
  return `"${identifier}"`;
}

function sqlField(field) {
  const [base, nested] = field.split(".");
  const quoted = quoteIdentifier(base);
  return nested ? `(${quoted}->>'${nested.replace(/'/g, "''")}')` : quoted;
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function compileFilter(definition, filter, values) {
  if (!filter || Object.keys(filter).length === 0) return "TRUE";
  const clauses = [];
  for (const [field, condition] of Object.entries(filter)) {
    if (field === "$or" || field === "$and") {
      if (!Array.isArray(condition) || condition.length === 0) {
        clauses.push(field === "$or" ? "FALSE" : "TRUE");
        continue;
      }
      const parts = condition.map((entry) => `(${compileFilter(definition, entry, values)})`);
      clauses.push(parts.join(field === "$or" ? " OR " : " AND "));
      continue;
    }

    const column = sqlField(field);
    const jsonArray = field === "assignedUsers";
    if (condition && typeof condition === "object" && !Array.isArray(condition) && !(condition instanceof Date)) {
      for (const [operator, operand] of Object.entries(condition)) {
        if (operator === "$options") continue;
        if (operator === "$exists") {
          clauses.push(`${column} IS ${operand ? "NOT " : ""}NULL`);
        } else if (operator === "$in") {
          if (!Array.isArray(operand) || operand.length === 0) {
            clauses.push("FALSE");
          } else if (jsonArray) {
            clauses.push(`(${operand.map((item) => {
              values.push(JSON.stringify([String(item)]));
              return `${column} @> $${values.length}::jsonb`;
            }).join(" OR ")})`);
          } else {
            const placeholders = operand.map((item) => {
              values.push(field.includes(".") ? String(item) : item);
              return `$${values.length}`;
            });
            clauses.push(`${column} IN (${placeholders.join(", ")})`);
          }
        } else if (operator === "$ne") {
          values.push(field.includes(".") ? String(operand) : operand);
          clauses.push(`${column} IS DISTINCT FROM $${values.length}${field.includes(".") ? "::text" : ""}`);
        } else if (["$gt", "$gte", "$lt", "$lte"].includes(operator)) {
          values.push(field.includes(".") ? String(operand) : operand);
          const sqlOperator = { $gt: ">", $gte: ">=", $lt: "<", $lte: "<=" }[operator];
          clauses.push(`${column} ${sqlOperator} $${values.length}`);
        } else if (operator === "$regex") {
          const searchText = String(operand).replace(/\\(.)/g, "$1");
          values.push(searchText);
          clauses.push(`position(lower($${values.length}::text) in lower(${column})) > 0`);
        } else {
          throw new Error(`Unsupported database filter operator: ${operator}`);
        }
      }
    } else if (condition === null || condition === undefined) {
      clauses.push(`${column} IS NULL`);
    } else if (jsonArray) {
      values.push(JSON.stringify([String(condition)]));
      clauses.push(`${column} @> $${values.length}::jsonb`);
    } else if (field === "_id" && !definition.textId && !isUuid(condition)) {
      clauses.push("FALSE");
    } else {
      values.push(field.includes(".") ? String(condition) : condition);
      clauses.push(`${column} = $${values.length}`);
    }
  }
  return clauses.length ? clauses.join(" AND ") : "TRUE";
}

function cleanRow(row, definition, selection, lean) {
  let result = { ...row };
  if (selection) {
    const parts = selection.split(/\s+/).filter(Boolean);
    const inclusions = parts.filter((part) => !part.startsWith("-") && !part.startsWith("+"));
    if (inclusions.length) {
      const allowed = new Set(["_id", ...inclusions]);
      result = Object.fromEntries(Object.entries(result).filter(([key]) => allowed.has(key)));
    }
    for (const part of parts.filter((item) => item.startsWith("-"))) delete result[part.slice(1)];
  }
  const explicitlyIncludedHidden = new Set((selection || "").split(/\s+/).filter((part) => part.startsWith("+")).map((part) => part.slice(1)));
  for (const field of definition.hidden) {
    if (!explicitlyIncludedHidden.has(field) && !(selection || "").split(/\s+/).includes(field)) delete result[field];
  }
  for (const [field, value] of Object.entries(result)) {
    if (value === null) delete result[field];
  }
  return lean ? result : createDocument(definition, result, false, row);
}

function createDocument(definition, data, isNew, persisted = {}) {
  const document = { ...data };
  Object.defineProperties(document, {
    __definition: { value: definition },
    __isNew: { value: isNew, writable: true },
    __persisted: { value: { ...persisted }, writable: true },
    save: {
      enumerable: false,
      value: async function save() {
        await saveDocument(this);
        return this;
      },
    },
  });
  return document;
}

function currentDocumentValues(document) {
  const definition = document.__definition;
  const persisted = document.__persisted || {};
  const values = { ...persisted };
  const timestampColumns = [
    ...(definition.timestamps ? ["createdAt"] : []),
    ...(definition.timestamps === true ? ["updatedAt"] : []),
  ];
  for (const key of ["_id", ...definition.columns, ...timestampColumns]) {
    if (Object.prototype.hasOwnProperty.call(document, key)) values[key] = document[key];
    else if (!document.__isNew && Object.prototype.hasOwnProperty.call(persisted, key)) values[key] = persisted[key];
  }
  return values;
}

async function saveDocument(document) {
  const definition = document.__definition;
  if (definition.generated && !document[definition.generated[0]]) {
    const [field, prefix] = definition.generated;
    const year = new Date().getUTCFullYear();
    const sequence = await getNextSequence(`${field}-${year}`);
    document[field] = `${prefix}-${year}-${String(sequence).padStart(6, "0")}`;
  }
  const now = new Date();
  if (definition.timestamps) {
    if (!document.createdAt) document.createdAt = now;
    if (definition.timestamps === true) document.updatedAt = now;
  }
  if (!document._id) document._id = definition.textId ? crypto.randomUUID() : crypto.randomUUID();

  const values = currentDocumentValues(document);
  const columns = ["_id", ...definition.columns];
  if (definition.timestamps) columns.push("createdAt");
  if (definition.timestamps === true) columns.push("updatedAt");
  if (definition.textId && !values._id) values._id = document._id;
  if (document.__isNew) {
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    const params = columns.map((column) => values[column] === undefined ? null : values[column]);
    const result = await query(
      `INSERT INTO ${quoteIdentifier(definition.table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`,
      params,
    );
    Object.assign(document, result.rows[0]);
    for (const [field, value] of Object.entries(result.rows[0])) {
      if (value === null) delete document[field];
    }
    document.__isNew = false;
    document.__persisted = { ...result.rows[0] };
    return;
  }

  values.updatedAt = definition.timestamps === true ? now : values.updatedAt;
  const updatable = definition.columns.concat(definition.timestamps === true ? ["updatedAt"] : []);
  const params = updatable.map((column) => values[column] === undefined ? null : values[column]);
  params.push(document._id);
  const assignments = updatable.map((column, index) => `${quoteIdentifier(column)} = $${index + 1}`);
  const result = await query(
    `UPDATE ${quoteIdentifier(definition.table)} SET ${assignments.join(", ")} WHERE "_id" = $${params.length} RETURNING *`,
    params,
  );
  if (!result.rows[0]) throw new Error("The record no longer exists.");
  Object.assign(document, result.rows[0]);
  for (const [field, value] of Object.entries(result.rows[0])) {
    if (value === null) delete document[field];
  }
  document.__persisted = { ...result.rows[0] };
}

function createModel(name, definition) {
  class Model {
    constructor(data = {}) {
      const defaults = Object.fromEntries(
        Object.entries(definition.defaults).map(([field, value]) => [field, typeof value === "function" ? value() : structuredClone(value)]),
      );
      const now = new Date();
      const initialized = { ...defaults, ...data };
      if (!initialized._id) initialized._id = definition.textId && typeof data._id === "string" ? data._id : crypto.randomUUID();
      if (definition.timestamps && !initialized.createdAt) initialized.createdAt = now;
      if (definition.timestamps === true && !initialized.updatedAt) initialized.updatedAt = now;
      return createDocument(definition, initialized, true);
    }

    static find(filter = {}) {
      return new DatabaseQuery(definition, filter, false);
    }

    static findOne(filter = {}) {
      return new DatabaseQuery(definition, filter, true);
    }

    static findById(id) {
      return this.findOne({ _id: id });
    }

    static async exists(filter = {}) {
      const values = [];
      const result = await query(
        `SELECT "_id" FROM ${quoteIdentifier(definition.table)} WHERE ${compileFilter(definition, filter, values)} LIMIT 1`,
        values,
      );
      return result.rows[0] || null;
    }

    static async countDocuments(filter = {}) {
      const values = [];
      const result = await query(
        `SELECT count(*)::integer AS count FROM ${quoteIdentifier(definition.table)} WHERE ${compileFilter(definition, filter, values)}`,
        values,
      );
      return result.rows[0].count;
    }

    static async create(data) {
      const document = new Model(data);
      await document.save();
      return document;
    }

    static findOneAndUpdate(filter, update, options = {}) {
      return new MutationQuery(definition, async () => {
        const existing = await Model.findOne(filter);
        if (existing) {
          applyUpdate(existing, update);
          await existing.save();
          return existing;
        }
        if (!options.upsert) return null;
        const data = equalityFields(filter);
        applyUpdate(data, update, true);
        const document = new Model(data);
        await document.save();
        return document;
      });
    }

    static findByIdAndUpdate(id, update, options = {}) {
      return Model.findOneAndUpdate({ _id: id }, update, options);
    }

    static async updateOne(filter, update, options = {}) {
      const existing = await Model.findOne(filter);
      if (existing) {
        applyUpdate(existing, update);
        await existing.save();
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      if (options.upsert) {
        const data = equalityFields(filter);
        applyUpdate(data, update, true);
        await Model.create(data);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    }

    static async updateMany(filter, update) {
      const records = await Model.find(filter).lean();
      for (const record of records) {
        applyUpdate(record, update);
        const values = {};
        for (const field of definition.columns) {
          if (Object.prototype.hasOwnProperty.call(record, field)) values[field] = record[field];
        }
        if (definition.timestamps === true) values.updatedAt = new Date();
        await updateRecord(definition, record._id, values);
      }
      return { matchedCount: records.length, modifiedCount: records.length };
    }

    static async bulkWrite(operations) {
      for (const operation of operations) {
        const { filter, update, upsert } = operation.updateOne;
        const existing = await Model.findOne(filter);
        if (existing) {
          applyUpdate(existing, update);
          await existing.save();
        } else if (upsert) {
          const data = equalityFields(filter);
          applyUpdate(data, update, true);
          await Model.create(data);
        }
      }
      return { acknowledged: true };
    }
  }
  Object.defineProperty(Model, "modelName", { value: name });
  return Model;
}

class DatabaseQuery {
  constructor(definition, filter, single) {
    this.definition = definition;
    this.filter = filter;
    this.single = single;
    this.selection = "";
    this.sorting = "";
    this.rowLimit = null;
    this.populations = [];
    this.asLean = false;
  }

  select(selection) {
    this.selection = selection || "";
    return this;
  }

  sort(sorting) {
    this.sorting = sorting;
    return this;
  }

  limit(count) {
    this.rowLimit = count;
    return this;
  }

  lean() {
    this.asLean = true;
    return this;
  }

  populate(path, selection) {
    this.populations.push(typeof path === "string" ? { path, select: selection } : path);
    return this;
  }

  async execute() {
    const values = [];
    const where = compileFilter(this.definition, this.filter, values);
    let sql = `SELECT * FROM ${quoteIdentifier(this.definition.table)} WHERE ${where}`;
    if (this.sorting && typeof this.sorting === "object") {
      const order = Object.entries(this.sorting).map(([field, direction]) => `${sqlField(field)} ${direction < 0 ? "DESC" : "ASC"}`);
      if (order.length) sql += ` ORDER BY ${order.join(", ")}`;
    }
    if (this.single || this.rowLimit) {
      values.push(this.single ? 1 : this.rowLimit);
      sql += ` LIMIT $${values.length}`;
    }
    const result = await query(sql, values);
    let rows = result.rows;
    if (this.single) rows = rows.slice(0, 1);
    const populated = [];
    for (const row of rows) {
      const value = { ...row };
      for (const population of this.populations) {
        await populateField(this.definition, value, population);
      }
      populated.push(cleanRow(value, this.definition, this.selection, this.asLean));
    }
    return this.single ? (populated[0] || null) : populated;
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  catch(reject) {
    return this.execute().catch(reject);
  }

  finally(callback) {
    return this.execute().finally(callback);
  }
}

class MutationQuery {
  constructor(definition, mutate) {
    this.definition = definition;
    this.mutate = mutate;
    this.selection = "";
    this.asLean = false;
  }

  select(selection) {
    this.selection = selection || "";
    return this;
  }

  lean() {
    this.asLean = true;
    return this;
  }

  async execute() {
    const record = await this.mutate();
    return record ? cleanRow(record, this.definition, this.selection, this.asLean) : null;
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  catch(reject) {
    return this.execute().catch(reject);
  }

  finally(callback) {
    return this.execute().finally(callback);
  }
}

async function populateField(definition, record, population) {
  const path = population.path;
  const targetName = populationTargets[definition.name]?.[path];
  if (!targetName || !record[path]) return;
  const target = definitions[targetName];
  const values = [];
  const where = compileFilter(target, { _id: record[path] }, values);
  const result = await query(`SELECT * FROM ${quoteIdentifier(target.table)} WHERE ${where} LIMIT 1`, values);
  record[path] = result.rows[0]
    ? cleanRow(result.rows[0], target, population.select || "", true)
    : null;
}

function equalityFields(filter) {
  const data = {};
  for (const [field, value] of Object.entries(filter)) {
    if (!field.startsWith("$") && (!value || typeof value !== "object" || value instanceof Date)) data[field] = value;
  }
  return data;
}

function applyUpdate(record, update, inserting = false) {
  for (const [operator, fields] of Object.entries(update)) {
    if (operator === "$set" || (inserting && operator === "$setOnInsert")) {
      Object.assign(record, fields);
    } else if (operator === "$unset") {
      for (const field of Object.keys(fields)) record[field] = undefined;
    } else if (operator === "$inc") {
      for (const [field, amount] of Object.entries(fields)) record[field] = (record[field] || 0) + amount;
    } else if (operator === "$addToSet") {
      for (const [field, value] of Object.entries(fields)) {
        const current = Array.isArray(record[field]) ? record[field] : [];
        const additions = value && typeof value === "object" && Array.isArray(value.$each) ? value.$each : [value];
        record[field] = [...current, ...additions.filter((item) => !current.some((entry) => String(entry) === String(item)))];
      }
    } else if (operator === "$pull") {
      for (const [field, value] of Object.entries(fields)) {
        record[field] = (record[field] || []).filter((entry) => String(entry) !== String(value));
      }
    } else if (!operator.startsWith("$")) {
      Object.assign(record, update);
      break;
    }
  }
}

async function updateRecord(definition, id, fields) {
  const columns = Object.keys(fields).filter((field) => definition.columns.includes(field) || field === "updatedAt");
  if (!columns.length) return;
  const values = columns.map((column) => fields[column] === undefined ? null : fields[column]);
  values.push(id);
  await query(
    `UPDATE ${quoteIdentifier(definition.table)} SET ${columns.map((column, index) => `${quoteIdentifier(column)} = $${index + 1}`).join(", ")} WHERE "_id" = $${values.length}`,
    values,
  );
}

async function getNextSequence(counterId) {
  const result = await query(
    `INSERT INTO "counters" ("_id", "sequence") VALUES ($1, 1) ON CONFLICT ("_id") DO UPDATE SET "sequence" = "counters"."sequence" + 1 RETURNING "sequence"`,
    [counterId],
  );
  return result.rows[0].sequence;
}

const models = Object.fromEntries(Object.entries(definitions).map(([name, definition]) => {
  definition.name = name;
  return [name, createModel(name, definition)];
}));

module.exports = {
  ...models,
  Profile: models.User,
  getNextSequence,
};

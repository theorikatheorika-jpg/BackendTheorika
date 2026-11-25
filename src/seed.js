require("dotenv").config();

const { closeDatabase, connectDatabase } = require("./database");
const { ClassOption, SubjectOption, Course } = require("./models");

async function seed() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed development options in production.");
  }
  if (!process.env.SUPABASE_DB_URL) {
    throw new Error("SUPABASE_DB_URL is required.");
  }

  await connectDatabase();
  await Promise.all([
    ...["Class 8", "Class 9", "Class 10", "Class 11", "Class 12"].map((name) =>
      ClassOption.updateOne({ name }, { $setOnInsert: { name, isActive: true } }, { upsert: true })),
    ...["Physics", "Chemistry", "Mathematics", "Biology", "All four subjects"].map((name) =>
      SubjectOption.updateOne({ name }, { $setOnInsert: { name, isActive: true } }, { upsert: true })),
    ...["Class 8", "Class 9", "Class 10", "Class 11", "Class 12"].flatMap((className) =>
      ["Physics", "Chemistry", "Mathematics", "Biology"].map((subjectName) => {
        const slug = `${subjectName}-${className}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        return Course.updateOne(
          { slug },
          { $setOnInsert: { title: `${subjectName} · ${className}`, slug, className, subjectName, status: "Published", featured: false } },
          { upsert: true },
        );
      })),
  ]);
  console.log("Development options and factual course catalog are ready.");
}

seed()
  .catch((error) => {
    const message = String(error?.message || "Unknown error.")
      .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted Supabase database URL]");
    console.error("Could not seed development options:", {
      name: error?.name || "Unknown error",
      code: error?.code || "unavailable",
      message,
    });
    process.exitCode = 1;
  })
  .finally(closeDatabase);

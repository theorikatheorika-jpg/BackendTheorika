require("dotenv").config();

const bcrypt = require("bcryptjs");
const { closeDatabase, connectDatabase } = require("./database");
const { User } = require("./models");

async function readInput(label, hidden = false) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run this command in an interactive terminal.");
  }
  process.stdout.write(label);
  if (hidden) process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") {
          value += character;
          if (!hidden) process.stdout.write(character);
        }
      }
    };
    function cleanup() {
      process.stdin.off("data", onData);
      if (hidden) process.stdin.setRawMode(false);
    }
    process.stdin.on("data", onData);
  });
}

async function bootstrapSuperadmin() {
  if (!process.env.SUPABASE_DB_URL) throw new Error("Configure backend/.env before creating the Super Admin.");
  const authSecret = process.env.AUTH_TOKEN_SECRET;
  if (!authSecret || authSecret.length < 32) throw new Error("AUTH_TOKEN_SECRET must contain at least 32 characters.");
  await connectDatabase();
  if (await User.exists({ role: "superadmin", status: { $ne: "deleted" } })) {
    throw new Error("A Super Admin already exists. Use the existing account to manage access.");
  }

  const fullName = await readInput("Super Admin name: ");
  const email = (await readInput("Super Admin email: ")).toLowerCase();
  const phone = await readInput("Super Admin phone: ");
  const password = await readInput("Password (12+ characters; input hidden): ", true);
  if (fullName.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || Buffer.byteLength(password, "utf8") > 72) {
    throw new Error("Name, email, and password did not meet the required format.");
  }

  await User.create({
    fullName,
    email,
    phone,
    passwordHash: await bcrypt.hash(password, 12),
    role: "superadmin",
    status: "active",
    preset: "custom",
    emailVerifiedAt: new Date(),
    permissions: {
      canLogin: true,
      viewBatches: true,
      viewLiveLinks: true,
      downloadMaterials: true,
      viewAttendanceFees: true,
      askDoubts: true,
      manageAssignedBatches: true,
      showOnFaculty: true,
    },
  });
  console.log("Super Admin account created. The password was not displayed or saved in a file.");
}

bootstrapSuperadmin()
  .catch((error) => {
    console.error(`Could not create Super Admin: ${error?.message || "Unknown error."}`);
    process.exitCode = 1;
  })
  .finally(closeDatabase);

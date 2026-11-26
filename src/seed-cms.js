require("dotenv").config();

const { closeDatabase, connectDatabase, query } = require("./database");

const initialContent = [
  {
    collection: "site-settings",
    slug: "theorika-academy",
    title: "Theorika Academy",
    content: {
      siteName: "Theorika",
      tagline: "Success begins with understanding.",
      whatsapp: "919183319594",
    },
  },
  {
    collection: "home-sections",
    slug: "hero",
    title: "Homepage hero",
    content: {
      headline: "Understand Concepts. Score Higher.",
      subtext: "Concept-first Physics, Chemistry, Mathematics and Biology—taught live, with room to ask questions and practise with confidence.",
      ctaText: "Book Free Demo",
      ctaLink: "/enquiry",
      enabled: true,
    },
  },
  {
    collection: "subjects",
    slug: "physics",
    title: "Physics",
    displayOrder: 1,
    content: {
      icon: "Φ",
      banner: "/img/Theorika%20Academy%20Physics%20Banner.png",
      imageUrl: "/img/physics.avif",
      description: "Understand motion, energy, electricity and the world around you.",
    },
  },
  {
    collection: "subjects",
    slug: "chemistry",
    title: "Chemistry",
    displayOrder: 2,
    content: {
      icon: "C",
      banner: "/img/theorika-chemistry-banner.png",
      imageUrl: "/img/chem.jpg",
      description: "Learn reactions and mechanisms through clear, practical explanations.",
    },
  },
  {
    collection: "subjects",
    slug: "mathematics",
    title: "Mathematics",
    displayOrder: 3,
    content: {
      icon: "π",
      banner: "/img/theorika-mathematics-banner.png",
      imageUrl: "/img/maths.webp",
      description: "Build confidence in algebra, calculus, geometry and problem solving.",
    },
  },
  {
    collection: "subjects",
    slug: "biology",
    title: "Biology",
    displayOrder: 4,
    content: {
      icon: "β",
      banner: "/img/theorika-biology-banner.png",
      imageUrl: "/img/biology.jpg",
      description: "Explore living systems with clear explanations and meaningful examples.",
    },
  },
  {
    collection: "pages",
    slug: "about",
    title: "About Theorika",
    content: {
      metaTitle: "About Theorika Academy",
      metaDescription: "Learn about Theorika Academy's live online CBSE classes for Classes 8–12.",
      body: "At Theorika Academy, our goal is to help every student truly understand Physics, Chemistry, Mathematics and Biology. Live online classes for Classes 8–12 combine concept building with practical learning and personal attention. Students can revisit recordings and get doubt support.",
    },
  },
  ...[
    ["which-classes", "Which classes do you teach?", "Theorika offers live online CBSE coaching for Classes 8–12."],
    ["available-subjects", "Which subjects are available?", "Physics, Chemistry, Mathematics and Biology."],
    ["how-classes-work", "How are classes conducted?", "Classes are live and interactive. Recordings and doubt support help students revisit and practise."],
    ["demo-enquiry", "How do I ask about a batch or demo?", "Send an enquiry with your class and subject. The admissions team can share current availability and demo details."],
  ].map(([slug, question, answer], index) => ({
    collection: "faqs",
    slug,
    title: question,
    displayOrder: index + 1,
    content: { question, answer, category: "General" },
  })),
];

async function seedCms() {
  if (!process.env.SUPABASE_DB_URL) throw new Error("SUPABASE_DB_URL is required.");
  await connectDatabase();
  for (const item of initialContent) {
    await query(
      `INSERT INTO "site_content" ("collection", "slug", "title", "content", "displayOrder", "isVisible", "status")
       VALUES ($1, $2, $3, $4::jsonb, $5, true, 'Published')
       ON CONFLICT ("collection", "slug") DO NOTHING`,
      [item.collection, item.slug, item.title, JSON.stringify(item.content), item.displayOrder || 0],
    );
  }
  console.log(`Seeded ${initialContent.length} factual website content records without overwriting existing CMS content.`);
}

seedCms()
  .catch((error) => {
    const message = String(error?.message || "Unknown error.")
      .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted Supabase database URL]");
    console.error("Could not seed initial website content:", {
      name: error?.name || "Unknown error",
      code: error?.code || "unavailable",
      message,
    });
    process.exitCode = 1;
  })
  .finally(closeDatabase);

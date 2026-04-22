import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import multer from "multer";
import * as xlsx from "xlsx";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Body parsing for JSON and Large Payloads
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Safe load for Multer
// @ts-ignore
const m = (multer.default || multer) as any;
const upload = m({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB limit per file
});

let admin: any = null;
let authInitialized = false;

// Delayed Firebase Init
async function initFirebase() {
  try {
    const { default: fAdmin } = await import("firebase-admin");
    admin = fAdmin;
    const configPath = path.join(process.cwd(), "firebase-applet-config.json");
    if (fs.existsSync(configPath)) {
      const firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (admin.apps.length === 0) {
        admin.initializeApp({
          projectId: firebaseConfig.projectId,
        });
        authInitialized = true;
        console.log("Firebase Admin initialized via dynamic import.");
      }
    }
  } catch (e) {
    console.error("Firebase Admin Error:", e);
  }
}

// Middleware: Authenticate
const authenticate = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!authInitialized) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const idToken = authHeader.split("Bearer ")[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    if (decodedToken.email !== 'ketan.thaker@gmail.com' || !decodedToken.email_verified) {
      return res.status(403).json({ error: "Forbidden" });
    }
    (req as any).user = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Unauthorized" });
  }
};

const cacheFile = path.join(process.cwd(), "extraction_cache.json");
let extractionCache: Record<string, any> = {};
try {
  if (fs.existsSync(cacheFile)) extractionCache = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
} catch (e) {}

function saveCache() {
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(extractionCache, null, 2));
  } catch (e) {}
}

function calculateHash(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function scoreText(text: string): number {
  let score = 0;
  const lowerText = text.toLowerCase();

  // +2 points for keywords
  const highValue = ["ebitda", "consolidated statement", "md&a", "segmental analysis", "outlook"];
  highValue.forEach(kw => {
    if (lowerText.includes(kw)) score += 2;
  });

  // +1 point for numeric density (>10%) or currency symbols
  const digits = (text.match(/\d/g) || []).length;
  if (digits / (text.length || 1) > 0.1) score += 1;
  if (/[\$€£]/.test(text)) score += 1;

  // -2 points for boilerplate
  const boilerplate = ["proxy form", "voting rights", "shareholder information"];
  boilerplate.forEach(kw => {
    if (lowerText.includes(kw)) score -= 2;
  });

  return score;
}

function excelToMarkdown(buffer: Buffer): string {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  let markdown = "";
  workbook.SheetNames.forEach(sheetName => {
    markdown += `### Sheet: ${sheetName}\n\n`;
    const sheet = workbook.Sheets[sheetName];
    const json = xlsx.utils.sheet_to_json(sheet, { header: 1 }) as any[][];
    if (json.length > 0) {
      const headers = json[0];
      markdown += `| ${headers.map(h => String(h || "")).join(" | ")} |\n`;
      markdown += `| ${headers.map(() => "---").join(" | ") || ""} |\n`;
      json.slice(1).forEach(row => {
        markdown += `| ${row.map(c => String(c ?? "").replace(/\|/g, "\\|")).join(" | ")} |\n`;
      });
      markdown += "\n";
    }
  });
  return markdown;
}

const AI_MODEL = "gemini-3-flash-preview";


async function startServer() {
  console.log("Starting server process...");

  // Health check
  app.get("/api/health", (req, res) => res.json({ status: "ok", stage: "boot" }));

  // Global Error Handler to catch any errors and return JSON
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("[CRITICAL ERROR]:", err);
    res.status(err.status || 500).json({
      error: err.message || "Pipeline execution fault",
      type: "SERVER_ERROR"
    });
  });

  // Bind early to port 3000
  app.listen(PORT, "0.0.0.0", async () => {
    console.log(`Initial port bind success at 0.0.0.0:${PORT}`);
    
    // Background init
    initFirebase();
    
    if (process.env.NODE_ENV !== "production") {
      console.log("Loading Vite...");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
      console.log("Vite ready.");
    } else {
      const distPath = path.join(process.cwd(), "dist");
      app.use(express.static(distPath));
      app.get("*", (req, res) => res.sendFile(path.join(distPath, "index.html")));
    }
  });
}

startServer();

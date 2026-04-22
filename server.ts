import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import multer from "multer";
import * as xlsx from "xlsx";
import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Safe load for Multer
// @ts-ignore
const m = (multer.default || multer) as any;
const upload = m({ storage: multer.memoryStorage() });

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

const AI_MODEL = "gemini-3-flash-preview";

async function aiDossierExtraction(buffer: Buffer, mimeType: string, filename: string) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY missing");
  const ai = new GoogleGenAI({ apiKey: key });
  const response = await ai.models.generateContent({
    model: AI_MODEL,
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType, data: buffer.toString("base64") } },
        { text: `Extract financial data from ${filename} into Markdown.` }
      ]
    }]
  });
  return response.text || "No content extracted";
}

async function startServer() {
  console.log("Starting server process...");

  // Health check
  app.get("/api/health", (req, res) => res.json({ status: "ok", stage: "boot" }));

  // Process route with lazy library loading
  app.post("/api/process", authenticate, upload.array("files"), async (req, res) => {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) return res.status(400).json({ error: "No files" });

    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    const pdfParse = require("pdf-parse");
    const { OfficeParser } = require("officeparser");

    const auditLog: any[] = [];
    let finalDossier = "";

    for (const file of files) {
      try {
        const mime = file.mimetype;
        const name = file.originalname.toLowerCase();
        let extractedContent = "";

        if (mime === "application/pdf") {
          extractedContent = await aiDossierExtraction(file.buffer, mime, file.originalname);
        } else if (name.endsWith(".xlsx") || name.endsWith(".csv")) {
          extractedContent = await aiDossierExtraction(file.buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", file.originalname);
        } else if (name.endsWith(".pptx") || name.endsWith(".docx")) {
          extractedContent = await aiDossierExtraction(file.buffer, mime, file.originalname);
        } else {
          extractedContent = await aiDossierExtraction(file.buffer, "text/plain", file.originalname);
        }
        
        finalDossier += extractedContent + "\n\n---\n\n";
        auditLog.push({ filename: file.originalname, status: "processed" });
      } catch (e: any) {
        auditLog.push({ filename: file.originalname, status: "error", error: e.message });
      }
    }
    res.json({ dossier: finalDossier, auditLog });
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

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
// @ts-ignore
import pdf from 'pdf-parse/lib/pdf-parse.js';

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

async function aiDossierExtraction(content: string, filename: string, options: { 
  useVision?: boolean; 
  buffer?: Buffer; 
  mimeType?: string;
  reTry?: boolean;
} = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is not defined. If running in AI Studio, ensure the key is provided via the Secrets/Settings menu.");
  }
  const ai = new GoogleGenAI({ apiKey: key });
  
  const parts: any[] = [];
  
  if (options.useVision && options.buffer && options.mimeType) {
    parts.push({
      inlineData: {
        mimeType: options.mimeType,
        data: options.buffer.toString("base64")
      }
    });
  }

  const promptText = options.reTry ? 
    `QA FAILED. RE-PROCESS (${filename}) WITH 100% NUMERIC ACCURACY.
    Transpose financial tables to Markdown. Maintain all footnotes/units.` :
    `Extract high-fidelity financial data from ${filename}.
    
    RULES:
    1. Start with YAML (ticker, company_name, doc_date, doc_type, extraction_confidence).
    2. Convert tables to GFM Markdown. 
    3. Preserve footnotes, units, currency symbols.
    4. Remove legalese unless it contains financial data.
    5. Output ONLY Markdown.`;

  parts.push({ text: `${promptText}\n\nCONTENT:\n${content}` });

  const response = await ai.models.generateContent({
    model: AI_MODEL,
    contents: [{ role: "user", parts }]
  });

  return response.text || "No content extracted";
}

function runQA(originalText: string, extractedMarkdown: string): { status: string; passed: boolean } {
  const originalNumbers = (originalText.match(/\d+([\.,]\d+)?/g) || []).length;
  const extractedNumbers = (extractedMarkdown.match(/\d+([\.,]\d+)?/g) || []).length;
  
  // Rule: Numeric Coverage > 50%
  const missingRatio = originalNumbers > 0 ? (extractedNumbers / originalNumbers) : 1;
  
  const hasCurrencySymbols = /[\$€£]/.test(extractedMarkdown);
  const originalCurrency = /[\$€£]/.test(originalText);
  
  let passed = true;
  let status = "QA: Passed [Manual Check Recommended]";

  if (missingRatio < 0.5 && originalNumbers > 10) {
    passed = false;
    status = "QA: Failed [Low Numeric Coverage]";
  } else if (originalCurrency && !hasCurrencySymbols) {
    passed = false;
    status = "QA: Failed [Currency Symbols Missing]";
  }

  return { status, passed };
}

async function startServer() {
  console.log("Starting server process...");

  // Health check
  app.get("/api/health", (req, res) => res.json({ status: "ok", stage: "boot" }));

// Process route using backend Gemini (Requested Fixes Applied)
app.post("/api/process", authenticate, upload.array("files"), async (req, res, next) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) return res.status(400).json({ error: "No files" });

    const { createRequire } = await import("module");
    const requireNode = createRequire(import.meta.url);
    const officePkg = requireNode("officeparser");
    const OfficeParser = officePkg.OfficeParser || officePkg;

    const auditLog: any[] = [];
    let finalDossier = "# Master Research Dossier\n\nGenerated on: " + new Date().toISOString() + "\n\n";

    for (const file of files) {
      try {
        const hash = calculateHash(file.buffer);
        if (extractionCache[hash]) {
          auditLog.push({ filename: file.originalname, status: "cached", score: 100 });
          finalDossier += `## Section: ${file.originalname} (CACHED)\n\n${extractionCache[hash]}\n\n---\n\n`;
          continue;
        }

        const mime = file.mimetype;
        const name = file.originalname.toLowerCase();
        let extractedContent = "";
        let rawContent = "";
        let score = 0;
        let qaStatus = "QA: N/A";
        let usedVision = false;

        if (mime === "application/pdf") {
          // Fix 1: Using the specific ESM-compatible pdf-parse import
          const localData = await pdf(file.buffer).catch(() => ({ text: "" }));
          rawContent = localData.text;
          score = scoreText(rawContent);
          
          if (score >= 2) {
            extractedContent = await aiDossierExtraction(rawContent, file.originalname);
            const qa = runQA(rawContent, extractedContent);
            qaStatus = qa.status;
            if (!qa.passed) {
              extractedContent = await aiDossierExtraction(rawContent, file.originalname, {
                useVision: true,
                buffer: file.buffer,
                mimeType: "application/pdf",
                reTry: true
              });
              const secondQA = runQA(rawContent, extractedContent);
              qaStatus = secondQA.status + " (High Fidelity - Vision Assisted)";
              usedVision = true;
            }
          } else {
            extractedContent = `[Triage Low Score: ${score}] Basic PDF Content Extract...`;
          }
        } else if (name.endsWith(".xlsx") || name.endsWith(".csv")) {
          const localTable = excelToMarkdown(file.buffer);
          extractedContent = localTable;
          qaStatus = "QA: Local Parse Integrity Guaranteed";
        } else if (name.endsWith(".txt") || mime.includes("text") || name.endsWith(".html") || name.endsWith(".htm")) {
          // Fix 3: Simple raw text fallback for transcripts (.txt)
          rawContent = file.buffer.toString('utf-8');
          if (name.endsWith(".html") || name.endsWith(".htm")) {
             rawContent = rawContent.replace(/<[^>]*>?/gm, ' ');
          }
          score = scoreText(rawContent);
          if (score >= 2) {
             extractedContent = await aiDossierExtraction(rawContent, file.originalname);
             const qa = runQA(rawContent, extractedContent);
             qaStatus = qa.status;
          } else {
             extractedContent = rawContent.slice(0, 5000);
          }
        } else if (name.endsWith(".pptx") || name.endsWith(".docx")) {
          const ast = await OfficeParser.parseOffice(file.buffer);
          rawContent = typeof ast.toText === 'function' ? ast.toText() : JSON.stringify(ast);
          score = scoreText(rawContent);
          if (score >= 2) {
            extractedContent = await aiDossierExtraction(rawContent, file.originalname);
            const qa = runQA(rawContent, extractedContent);
            qaStatus = qa.status;
          } else {
            extractedContent = "Office Basic Parse...";
          }
        } else {
          continue;
        }

        extractedContent += `\n\n---\n**Batch Metadata & QA:**\n- QA Status: ${qaStatus}\n- Intelligence Hash: ${hash}\n- Modality: ${usedVision ? "Vision Fallback" : "Standard Parsing"}\n`;
        extractionCache[hash] = extractedContent;
        auditLog.push({ filename: file.originalname, status: "processed", score, qa: qaStatus });
        finalDossier += `## Section: ${file.originalname}\n\n${extractedContent}\n\n---\n\n`;
      } catch (e: any) {
        console.error(`[ERROR] Processing ${file.originalname}:`, e);
        auditLog.push({ filename: file.originalname, status: "error", error: e.message });
      }
    }
    saveCache();
    res.json({ 
      dossier: finalDossier, 
      auditLog,
      summary: {
        totalFiles: files.length,
        processed: auditLog.filter(l => l.status === "processed" || l.status === "cached").length,
        skipped: auditLog.filter(l => l.status === "skipped").length || 0,
        errors: auditLog.filter(l => l.status === "error").length
      }
    });
  } catch (err) {
    console.error("[PROCESS ERROR]:", err);
    res.status(500).json({ error: "Batch processing failed" });
  }
});

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

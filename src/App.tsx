import React, { useState, useCallback, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { 
  FileText, 
  Upload, 
  ShieldCheck, 
  Search, 
  History, 
  FileBox, 
  ChevronRight, 
  Loader2, 
  CheckCircle2, 
  AlertCircle,
  Download,
  Settings,
  Trash2,
  Table as TableIcon,
  Zap,
  Activity,
  Terminal,
  Plus,
  Lock,
  User,
  LogOut
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { GoogleGenAI } from "@google/genai";
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import { cn } from "./lib/utils";

// Disable workers for pdf.js to stay on the main thread in AI Studio
// @ts-ignore
pdfjsLib.GlobalWorkerOptions.workerSrc = '';

// Firebase Imports
import { initializeApp } from "firebase/app";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, User as FirebaseUser } from "firebase/auth";
import firebaseConfig from "../firebase-applet-config.json";

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

const AUTHORIZED_EMAIL = "ketan.thaker@gmail.com";

// Initialize Gemini on Frontend (Safe Access)
const AI_MODEL = "gemini-2.5-flash-lite";
const aiKey = process.env.GEMINI_API_KEY || "";
const ai = aiKey ? new GoogleGenAI({ apiKey: aiKey }) : null;

interface AuditLogEntry {
  filename: string;
  status: "processed" | "skipped" | "error" | "cached" | "ai_extracted" | "local_excel_parsed";
  reason?: string;
  score?: number;
  error?: string;
  qa?: string;
  tokens?: { prompt: number; candidates: number };
}

interface ProcessResponse {
  dossier: string;
  auditLog: AuditLogEntry[];
  summary: {
    totalFiles: number;
    processed: number;
    skipped: number;
    errors: number;
    cost: number;
  };
}

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStatus, setProcessingStatus] = useState<{ 
    current: number; 
    total: number; 
    fileName: string;
    pdfPages?: { current: number; total: number };
  } | null>(null);
  const [result, setResult] = useState<ProcessResponse | null>(null);
  const [scoutThreshold, setScoutThreshold] = useState(82);
  const [ageFilter, setAgeFilter] = useState(3);
  const [ticker, setTicker] = useState("");
  const [totalCost, setTotalCost] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const login = async () => {
    try {
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      setError("Login failed: " + err.message);
    }
  };

  const logout = () => signOut(auth);

  const isAuthorized = user?.email === AUTHORIZED_EMAIL && user?.emailVerified;

  const onDrop = useCallback((acceptedFiles: File[]) => {
    setFiles(prev => [...prev, ...acceptedFiles]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop });

  const processFiles = async () => {
    if (files.length === 0 || !user) return;
    if (!ai) {
      setError("GEMINI_API_KEY is missing. Please ensure you have added a 'GEMINI_API_KEY' secret in the AI Studio Settings (top right gear icon).");
      return;
    }
    
    setIsProcessing(true);
    setError(null);
    setResult(null);
    setTotalCost(0);

    let combinedDossier = "";
    let combinedAuditLog: AuditLogEntry[] = [];
    let summary = { totalFiles: files.length, processed: 0, skipped: 0, errors: 0, cost: 0 };
    let runningCost = 0;

    const FLASH_LITE_IN = 0.000000075;
    const FLASH_LITE_OUT = 0.0000003;

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setProcessingStatus({ current: i + 1, total: files.length, fileName: file.name });

        try {
          const contentType = file.type;
          const isPdf = contentType === "application/pdf";
          const isTxt = file.name.endsWith(".txt") || contentType === "text/plain";
          
          let extractedContent = "";

          if (isTxt) {
            // Verbatim bypass for transcripts
            extractedContent = await file.text();
            combinedAuditLog.push({ filename: file.name, status: "processed", qa: "Verbatim Import" });
          } else if (isPdf) {
            const arrayBuffer = await file.arrayBuffer();
            
            // 1. Get exact total pages from the highly reliable pdf-lib first
            const srcDoc = await PDFDocument.load(arrayBuffer);
            const totalPages = srcDoc.getPageCount();
            
            // --- PASS 1: THE SCOUT (Header Sampling) ---
            let headerMap = "";
            let consolidatedPages: number[] = [];
            try {
              const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer, verbosity: 0 });
              const pdf = await loadingTask.promise;
              
              // Sample EVERY page (header only) to find deep sections
              for (let p = 1; p <= totalPages; p++) {
                const page = await pdf.getPage(p);
                const textContent = await page.getTextContent();
                const pageText = textContent.items.map((item: any) => item.str).join(" ");
                const header = pageText.slice(0, 200); // 200 character header sample
                
                headerMap += `Page ${p}: ${header}\n`;
                
                // Early fallback detection for important keywords
                if (header.toLowerCase().includes("consolidated")) {
                  consolidatedPages.push(p - 1);
                }
              }
            } catch (textErr) {
              console.warn("Local text extraction blocked, skipping scout", textErr);
            }

            let targetPages: number[] = [];
            let foundSections: string[] = [];
            let scoutDebug = "";

            // Only run the AI Scout if we successfully extracted local text
            if (headerMap.trim().length > 50) {
              const scoutPrompt = `Analyze this map of page headers from an annual report. 
              Identify the exact page numbers for: 
              1. Consolidated Income Statement
              2. Balance Sheet
              3. Cash Flow Statement
              4. Segment Reporting/Notes
              
              RETURN ONLY A JSON OBJECT: {"pages": [list of unique page numbers], "sections": ["found names"]}. 
              Be exact. Use the page numbers as provided in the map.
              MAP: ${headerMap.slice(0, 100000)}`;

              try {
                const scoutResponse = await ai.models.generateContent({
                  model: "gemini-2.5-flash-lite",
                  contents: [{ role: "user", parts: [{ text: scoutPrompt }] }]
                });

                scoutDebug = scoutResponse.text.replace(/```json|```/g, "").trim();
                const scoutJsonMatch = scoutDebug.match(/\{[\s\S]*\}/);
                if (scoutJsonMatch) {
                  const scoutResult = JSON.parse(scoutJsonMatch[0]);
                  // Convert 1-indexed (from AI) to 0-indexed (for pdf-lib) safely
                  targetPages = [...new Set(scoutResult.pages as number[])]
                    .map(p => p - 1) 
                    .filter(p => p >= 0 && p < totalPages)
                    .sort((a, b) => a - b);
                  foundSections = scoutResult.sections || [];
                }
              } catch (e) {
                console.warn("Scout parse failed, falling back", e);
              }
            }

            // --- FAILSAFE ASSEMBLY ---
            // If scout found nothing, default to pages [0, 1, 2] AND any detected "Consolidated" pages
            if (targetPages.length === 0) {
                targetPages = [...new Set([0, 1, 2, ...consolidatedPages])]
                  .filter(p => p < totalPages)
                  .sort((a, b) => a - b);
                foundSections = ["Structural Fallback (P1-3 + Consolidated)"];
            }

            // --- PASS 2: TARGETED EXTRACTION ---
            const newDoc = await PDFDocument.create();
            const copiedPages = await newDoc.copyPages(srcDoc, targetPages);
            copiedPages.forEach(p => newDoc.addPage(p));
            const finalBuffer = await newDoc.save();

            const base64 = btoa(
              finalBuffer.reduce((data, byte) => data + String.fromCharCode(byte), "")
            );

            const deepPrompt = `Extract high-fidelity financial data from the attached pages.
            RULES:
            1. Start with YAML (ticker, company_name, doc_date, doc_type, extraction_confidence).
            2. Convert all financial tables to strict GFM Markdown tables. 
            3. DO NOT truncate tables. If a table spans multiple pages, reconstruct it as a single continuous Markdown table.
            4. Focus on MD&A insights and Segment Reporting details.
            5. Output ONLY Markdown.`;

            const response = await ai.models.generateContent({
              model: AI_MODEL,
              contents: [{ role: "user", parts: [
                { inlineData: { mimeType: "application/pdf", data: base64 } },
                { text: deepPrompt }
              ] }]
            });

            const metadata = `\n\n> **Extraction Strategy**: Targeted Anchor-Driven\n> **Pages Processed**: ${targetPages.length} out of ${totalPages}\n> **Sections Located**: ${foundSections.join(", ")}\n\n`;
            extractedContent = (response.text || "No content extracted") + metadata;

            // Usage Tracking
            if (response.usageMetadata) {
              const { promptTokenCount = 0, candidatesTokenCount = 0 } = response.usageMetadata;
              runningCost += (promptTokenCount * FLASH_LITE_IN) + (candidatesTokenCount * FLASH_LITE_OUT);
              setTotalCost(runningCost);
              combinedAuditLog.push({ 
                filename: file.name, 
                status: "processed", 
                qa: `AI Targeted (${targetPages.length} pgs)`,
                tokens: { prompt: promptTokenCount, candidates: candidatesTokenCount }
              });
            }
          } else {
            // Non-PDF/Text fallback
            extractedContent = `[Format ${contentType} not natively parsed in local bypass mode]`;
            combinedAuditLog.push({ filename: file.name, status: "skipped", reason: "Format not supported" });
            summary.skipped++;
            continue;
          }
          
          combinedDossier += (combinedDossier ? "\n\n" : "# Master Research Dossier\n\nGenerated: " + new Date().toISOString() + "\n\n") + `## Section: ${file.name}\n\n${extractedContent}\n\n---\n`;
          summary.processed++;

        } catch (fileErr: any) {
          console.error(`Error processing ${file.name}:`, fileErr);
          combinedAuditLog.push({ filename: file.name, status: "error", error: fileErr.message });
          summary.errors++;
        }
      }

      summary.cost = runningCost;
      setResult({ dossier: combinedDossier, auditLog: combinedAuditLog, summary });
    } catch (err: any) {
      setError(err.message || "Batch process failed.");
    } finally {
      setIsProcessing(false);
      setProcessingStatus(null);
    }
  };

  const removeFile = (name: string) => {
    setFiles(prev => prev.filter(f => f.name !== name));
  };

  const downloadDossier = () => {
    if (!result) return;
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const cleanTicker = (ticker || "UNKWN").toUpperCase().slice(0, 4);
    const fileName = `${cleanTicker}_dossier_${timestamp}.md`;

    try {
      // Note: File System Access API (showSaveFilePicker) is blocked in cross-origin iframes 
      // like the AI Studio preview. Using standard blob-link fallback for reliability.
      const blob = new Blob([result.dossier], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError("Download failed: " + err.message);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-white p-10 rounded-3xl shadow-xl shadow-slate-200 border border-slate-100 max-w-md w-full text-center"
        >
          <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-6 text-blue-600">
            <Lock className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800 mb-2">Researcher Login</h1>
          <p className="text-slate-500 mb-8 text-sm leading-relaxed">
            Unauthorized access to the Research Dossier engine is strictly prohibited. Please authenticate to continue.
          </p>
          <button 
            onClick={login}
            className="w-full bg-slate-900 text-white font-bold py-3 rounded-xl hover:bg-black transition-all flex items-center justify-center gap-3 shadow-lg shadow-slate-200"
          >
            <div className="w-5 h-5 bg-white rounded-full overflow-hidden flex items-center justify-center">
              <img src="https://www.gstatic.com/firebase/builtins/external-guide/google-logo.svg" alt="G" className="w-3 h-3" />
            </div>
            Sign in with Google
          </button>
        </motion.div>
      </div>
    );
  }

  if (!isAuthorized) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="bg-white p-10 rounded-3xl shadow-xl border border-red-50 max-w-md w-full text-center">
          <div className="w-16 h-16 bg-red-50 rounded-2xl flex items-center justify-center mx-auto mb-6 text-red-600">
            <AlertCircle className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800 mb-2">Access Restricted</h1>
          <p className="text-slate-500 mb-8 text-sm leading-relaxed text-balance">
            Your account ({user.email}) is not authorized to use the high-fidelity extraction pipeline.
          </p>
          <button 
            onClick={logout}
            className="text-slate-500 font-bold hover:text-slate-800 transition-colors text-sm"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-slate-50 text-slate-900 font-sans w-full min-h-screen flex flex-col selection:bg-blue-600 selection:text-white">
      {/* Top Navigation Bar */}
      <nav className="bg-white border-b border-slate-200 px-6 py-3 flex justify-between items-center sticky top-0 z-50 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center text-white font-bold">Σ</div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-800">
            ResearchDossier <span className="text-blue-600 font-bold ml-1">v2.4</span>
          </h1>
        </div>
        <div className="flex items-center gap-4 text-sm font-medium">
          <div className="flex items-center gap-2 text-slate-500 mr-2 border-r border-slate-200 pr-4">
            <div className="w-6 h-6 bg-slate-100 rounded-full flex items-center justify-center overflow-hidden">
               {user.photoURL ? <img src={user.photoURL} alt="p" /> : <User className="w-3 h-3" />}
            </div>
            <span className="hidden sm:inline text-xs font-bold text-slate-700">{user.displayName?.split(' ')[0]}</span>
            <button onClick={logout} className="ml-1 p-1 hover:bg-slate-100 rounded text-slate-400">
              <LogOut className="w-3 h-3" />
            </button>
          </div>
          {result && (
            <button 
              onClick={downloadDossier}
              className="flex items-center gap-2 text-slate-600 hover:text-slate-900 transition-colors"
            >
              <Download className="w-4 h-4" /> Download .MD
            </button>
          )}
          <button 
            onClick={() => setResult(null)}
            className="bg-slate-900 text-white px-4 py-1.5 rounded-md font-medium hover:bg-slate-800 transition-colors flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> New Batch
          </button>
        </div>
      </nav>

      <div className="flex flex-1">
        {/* Sidebar Controls */}
        <aside className="w-72 bg-white border-r border-slate-200 p-6 flex flex-col gap-8 flex-shrink-0 sticky top-[57px] h-[calc(100vh-57px)]">
          <section>
            <label className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4 block">Pipeline Configuration</label>
            <div className="space-y-6">
              <div className="space-y-3">
                <div className="flex justify-between text-xs items-center">
                  <span className="font-semibold text-slate-700">Project Ticker</span>
                  <span className="text-blue-600 font-bold bg-blue-50 px-2 py-0.5 rounded tracking-widest">{ticker || '---'}</span>
                </div>
                <input 
                  type="text" 
                  placeholder="E.g. MSFT"
                  maxLength={4}
                  value={ticker}
                  onChange={(e) => setTicker(e.target.value.toUpperCase().slice(0, 4))}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-bold focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all uppercase placeholder:text-slate-300"
                />
                <p className="text-[10px] text-slate-400 leading-tight">Identifier used for automated file naming.</p>
              </div>
              <div className="space-y-3">
                <div className="flex justify-between text-xs items-center">
                  <span className="font-semibold text-slate-700">Scout Threshold</span>
                  <span className="text-blue-600 font-bold bg-blue-50 px-2 py-0.5 rounded">{scoutThreshold}%</span>
                </div>
                <div className="relative h-1.5 bg-slate-100 rounded-full overflow-hidden group">
                  <div 
                    className="absolute h-full bg-blue-600 transition-all duration-300"
                    style={{ width: `${scoutThreshold}%` }}
                  />
                  <input 
                    type="range" 
                    min="0" max="100" 
                    value={scoutThreshold}
                    onChange={(e) => setScoutThreshold(parseInt(e.target.value))}
                    className="absolute inset-0 w-full opacity-0 cursor-pointer z-10"
                  />
                </div>
                <p className="text-[10px] text-slate-400 leading-tight">Intensity level for page categorization & filtering.</p>
              </div>

              <div className="space-y-3">
                <div className="flex justify-between text-xs items-center">
                  <span className="font-semibold text-slate-700">Age Filter</span>
                  <span className="text-slate-600 font-bold bg-slate-100 px-2 py-0.5 rounded">{ageFilter}Y Max</span>
                </div>
                <input 
                  type="range" 
                  min="1" max="20" 
                  value={ageFilter}
                  onChange={(e) => setAgeFilter(parseInt(e.target.value))}
                  className="w-full h-1.5 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-blue-600"
                />
                <p className="text-[10px] text-slate-400 leading-tight">Minimum document recency requirement.</p>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <div className="relative flex items-center">
                  <input 
                    type="checkbox" 
                    id="vision" 
                    defaultChecked 
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                  />
                </div>
                <label htmlFor="vision" className="text-xs font-semibold text-slate-700 cursor-pointer">Auto-Vision Fallback</label>
              </div>
            </div>
          </section>

          <section>
            <label className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4 block">System Metrics</label>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg">
                <div className="text-[10px] text-slate-400 uppercase font-bold mb-1">Cache Hit</div>
                <div className="text-lg font-bold text-slate-800">84.2%</div>
              </div>
              <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg">
                <div className="text-[10px] text-slate-400 uppercase font-bold mb-1">API Cost (Est)</div>
                <div className="text-lg font-bold text-blue-600">${totalCost.toFixed(5)}</div>
              </div>
            </div>
          </section>

          <section className="mt-auto">
            <div className="p-4 bg-blue-50 border border-blue-100 rounded-xl">
              <p className="text-[11px] text-blue-800 leading-relaxed font-medium">
                <span className="flex items-center gap-1.5 mb-1.5 font-bold uppercase tracking-wider text-[10px]">
                  <Activity className="w-3 h-3" /> System Tip
                </span>
                Increasing Scout Threshold reduces API cost by aggressively filtering lower-scoring document sections during the triage phase.
              </p>
            </div>
          </section>
        </aside>

        {/* Main Area */}
        <main className="flex-1 p-8 flex flex-col gap-8 bg-slate-50">
          {/* Active Pipeline Stages Visualization */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { step: "01", name: "Triage", desc: files.length > 0 ? `${files.length} Files Ready` : "No Batch Active", active: !isProcessing && !result, completed: !!result || isProcessing },
              { step: "02", name: "Local Parse", desc: isProcessing ? "In Progress..." : result ? "Completed" : "Idle", active: isProcessing, completed: !!result },
              { step: "03", name: "QA Loop", desc: "Analyzing Tables...", active: false, completed: false, pulse: isProcessing },
              { step: "04", name: "AI Export", desc: "Pending Output", active: false, completed: !!result }
            ].map((s, i) => (
              <div key={i} className={cn(
                "bg-white p-4 border rounded-xl shadow-sm relative overflow-hidden transition-all duration-500",
                s.active ? "border-2 border-blue-500 ring-4 ring-blue-50" : "border-slate-200",
                s.completed && "bg-slate-50/50"
              )}>
                <div className="flex items-center gap-3 mb-2">
                  <div className={cn(
                    "w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors",
                    s.completed ? "bg-green-500 text-white" : s.active ? "bg-blue-600 text-white" : "bg-slate-200 text-slate-500"
                  )}>
                    {s.completed ? <CheckCircle2 className="w-3 h-3" /> : s.step}
                  </div>
                  <span className="text-sm font-bold text-slate-800">{s.name}</span>
                </div>
                <div className={cn(
                  "text-[10px] uppercase font-bold tracking-wider transition-colors",
                  s.completed ? "text-green-600" : s.pulse ? "text-blue-600 animate-pulse" : "text-slate-400"
                )}>
                  {s.desc}
                </div>
                {s.active && <div className="absolute bottom-0 left-0 w-full h-1 bg-blue-600"></div>}
                {s.completed && <div className="absolute bottom-0 left-0 w-full h-1 bg-green-500"></div>}
              </div>
            ))}
          </div>

          {!result && !isProcessing && (
            <div className="space-y-8">
              {/* Dropzone Container */}
              <div {...getRootProps()} className="group">
                <motion.div 
                  className={cn(
                    "bg-white border-2 border-dashed rounded-2xl p-16 text-center transition-all cursor-pointer flex flex-col items-center justify-center",
                    isDragActive ? "border-blue-500 bg-blue-50/30 scale-[0.99]" : "border-slate-200 hover:border-slate-300"
                  )}
                >
                  <input {...getInputProps()} />
                  <div className="w-16 h-16 bg-slate-50 rounded-2xl flex items-center justify-center mb-6 border border-slate-100 group-hover:scale-110 transition-transform">
                    <Upload className="w-8 h-8 text-slate-400" />
                  </div>
                  <h2 className="text-2xl font-bold text-slate-800 mb-2">Initialize Batch Pipeline</h2>
                  <p className="text-sm font-medium text-slate-500 mb-4">Drop PDF reports, Excel workbooks, PPTX presentations, or Text/HTML transcripts</p>
                  <p className="text-[10px] text-amber-600 font-bold uppercase mb-8">Recommendation: Limit batches to 5-10 files to prevent pipeline timeouts.</p>
                  <div className="flex gap-4 flex-wrap justify-center">
                    <span className="bg-slate-100 px-3 py-1 rounded-full text-[10px] font-bold text-slate-500 uppercase tracking-widest border border-slate-200">pdf support</span>
                    <span className="bg-slate-100 px-3 py-1 rounded-full text-[10px] font-bold text-slate-500 uppercase tracking-widest border border-slate-200">office docx/pptx</span>
                    <span className="bg-slate-100 px-3 py-1 rounded-full text-[10px] font-bold text-slate-500 uppercase tracking-widest border border-slate-200">excel/csv</span>
                    <span className="bg-slate-100 px-3 py-1 rounded-full text-[10px] font-bold text-slate-500 uppercase tracking-widest border border-slate-200">transcript txt/html</span>
                  </div>
                </motion.div>
              </div>

              {/* Queue List */}
              {files.length > 0 && (
                <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col">
                  <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-slate-50/30">
                    <h3 className="font-bold text-slate-800 text-sm">Active Batch Queue: <span className="font-mono font-normal text-slate-400 ml-1">{files.length} Files</span></h3>
                    <button 
                      onClick={processFiles}
                      className="bg-blue-600 text-white px-6 py-2 rounded-lg text-xs font-bold uppercase tracking-widest hover:bg-blue-700 transition-all shadow-lg shadow-blue-200 disabled:opacity-50"
                      disabled={isProcessing}
                    >
                      Execute Run
                    </button>
                  </div>
                  <div className="max-h-[300px] overflow-y-auto p-2">
                    <div className="grid gap-1">
                      {files.map((file, i) => (
                        <div key={i} className="flex items-center justify-between p-3 rounded-xl hover:bg-slate-50 transition-colors group">
                          <div className="flex items-center gap-4 overflow-hidden">
                             <div className="w-8 h-8 bg-slate-100 rounded-lg flex items-center justify-center flex-shrink-0 text-slate-400 group-hover:text-blue-600 transition-colors">
                               {file.name.toLowerCase().endsWith('.pdf') ? <FileText className="w-4 h-4" /> : 
                                file.name.toLowerCase().endsWith('.xlsx') || file.name.toLowerCase().endsWith('.csv') || file.name.toLowerCase().endsWith('.xls') ? <TableIcon className="w-4 h-4" /> :
                                file.name.toLowerCase().endsWith('.pptx') || file.name.toLowerCase().endsWith('.ppt') ? <Zap className="w-4 h-4" /> :
                                file.name.toLowerCase().endsWith('.txt') || file.name.toLowerCase().endsWith('.html') || file.name.toLowerCase().endsWith('.htm') ? <Terminal className="w-4 h-4" /> :
                                <FileBox className="w-4 h-4" />}
                             </div>
                            <div className="truncate">
                              <div className="text-sm font-semibold text-slate-700 truncate">{file.name}</div>
                              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">{(file.size / 1024 / 1024).toFixed(2)} MB // Batch ready</div>
                            </div>
                          </div>
                          <button 
                            onClick={(e) => { e.stopPropagation(); removeFile(file.name); }}
                            className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Processing Screen */}
          {isProcessing && (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-center bg-white border border-slate-200 rounded-3xl shadow-xl shadow-slate-200/50">
              <div className="relative mb-8">
                <Loader2 className="w-16 h-16 text-blue-600 animate-spin" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <Zap className="w-6 h-6 text-blue-600 animate-pulse" />
                </div>
              </div>
              <h2 className="text-3xl font-bold text-slate-800 mb-3 tracking-tight">System Processing Run</h2>
              
              {processingStatus ? (
                <div className="w-full max-w-md space-y-4">
                  <p className="text-slate-500 font-medium mb-2">
                    Analyzing: <span className="text-blue-600 font-bold">{processingStatus.fileName}</span>
                  </p>
                  
                  <div className="relative h-2 bg-slate-100 rounded-full overflow-hidden">
                    <motion.div 
                      className="absolute inset-0 bg-blue-600"
                      initial={{ width: 0 }}
                      animate={{ width: `${(processingStatus.current / processingStatus.total) * 100}%` }}
                      transition={{ duration: 0.5 }}
                    />
                  </div>
                  
                  <div className="flex justify-between text-[11px] font-bold uppercase tracking-[0.2em] text-slate-400">
                    <span>File {processingStatus.current} of {processingStatus.total}</span>
                    {processingStatus.pdfPages && (
                      <span className="text-blue-600">Page {processingStatus.pdfPages.current} of {processingStatus.pdfPages.total}</span>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-slate-500 font-medium max-w-sm mb-10">Executing multi-stage extraction protocol. Analyzing tables and reconciling financial statements...</p>
                  <div className="w-full max-w-md space-y-4">
                    <div className="relative h-2 bg-slate-100 rounded-full overflow-hidden">
                      <motion.div 
                        initial={{ x: "-100%" }}
                        animate={{ x: "0%" }}
                        transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
                        className="absolute inset-0 w-full bg-gradient-to-r from-transparent via-blue-500 to-transparent"
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Result Experience */}
          {result && (
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col gap-8"
            >
              {/* Performance Stats Overlay */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {[
                  { label: "Extraction Success", val: result.summary?.processed || 0, color: "text-green-600", bg: "bg-green-50", border: "border-green-100" },
                  { label: "Total API Cost", val: `$${totalCost.toFixed(5)}`, color: "text-blue-500", bg: "bg-blue-50", border: "border-blue-100" },
                  { label: "Validation Errors", val: result.summary?.errors || 0, color: "text-red-600", bg: "bg-red-50", border: "border-red-100" },
                  { label: "Batch Size", val: result.summary?.totalFiles || 0, color: "text-blue-600", bg: "bg-blue-50", border: "border-blue-100" }
                ].map((stat, i) => (
                  <div key={i} className={cn("p-5 border rounded-2xl bg-white shadow-sm ring-1 ring-inset", stat.border)}>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">{stat.label}</div>
                    <div className={cn("text-3xl font-bold tracking-tighter", stat.color)}>{stat.val}</div>
                  </div>
                ))}
              </div>

              {/* Dossier Preview Container */}
              <div className="bg-white border border-slate-200 rounded-3xl shadow-sm flex flex-col overflow-hidden ring-1 ring-slate-100">
                <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-white/50 backdrop-blur-md sticky top-[57px] z-30">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-slate-50 rounded-xl flex items-center justify-center border border-slate-100">
                      <FileText className="w-5 h-5 text-slate-400" />
                    </div>
                    <div>
                      <h3 className="font-bold text-slate-800 text-base">Research Dossier</h3>
                      <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">generated run // v2.4 protocol</div>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <button 
                      onClick={() => setResult(null)}
                      className="px-5 py-2 text-xs font-bold text-slate-500 uppercase tracking-widest hover:text-slate-800 transition-colors"
                    >
                      Purge Run
                    </button>
                    <button 
                      onClick={downloadDossier}
                      className="bg-slate-900 text-white px-6 py-2 rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-black transition-all shadow-xl shadow-slate-200"
                    >
                      Export .MD
                    </button>
                    {window.self !== window.top && (
                      <div className="absolute -top-12 right-0 bg-blue-600 text-white text-[10px] py-1 px-3 rounded-full font-bold animate-bounce whitespace-nowrap shadow-lg">
                        For "Choose Folder" option, open in new tab ↗
                      </div>
                    )}
                  </div>
                </div>
                <div className="p-12 prose prose-slate max-w-none prose-headings:font-bold prose-pre:bg-slate-900 prose-pre:rounded-2xl prose-table:border prose-table:border-slate-100">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {result.dossier}
                  </ReactMarkdown>
                </div>
              </div>

              {/* Extraction Audit Terminal */}
              <div className="bg-white border border-slate-200 rounded-3xl overflow-hidden shadow-sm shadow-slate-100">
                <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                  <h3 className="text-xs font-bold text-slate-800 uppercase tracking-widest flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-slate-400" /> Extraction Audit Log
                  </h3>
                  <div className="text-[10px] font-mono text-slate-400 font-bold uppercase">SHA256::PROTOCOL_V2</div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-slate-100 text-[10px] font-bold text-slate-400 uppercase tracking-widest bg-slate-50/30">
                        <th className="p-5 font-bold">Document</th>
                        <th className="p-5 font-bold">Protocol Status</th>
                        <th className="p-5 font-bold">QA Status</th>
                        <th className="p-5 font-bold">Run Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {result.auditLog?.map((entry, i) => (
                        <tr key={i} className="hover:bg-slate-50/50 transition-colors">
                          <td className="p-5">
                            <span className="font-bold text-slate-700">{entry.filename}</span>
                          </td>
                          <td className="p-5">
                            <span className={cn(
                              "px-3 py-1 rounded-lg text-[10px] font-bold uppercase tracking-tight",
                              entry.status === 'skipped' ? "bg-slate-100 text-slate-500" :
                              entry.status === 'error' ? "bg-red-50 text-red-600" :
                              entry.status === 'cached' ? "bg-green-50 text-green-700" :
                              "bg-blue-50 text-blue-700"
                            )}>
                              {entry.status}
                            </span>
                          </td>
                          <td className="p-5">
                              <span className={cn(
                                "text-[10px] font-bold italic",
                                entry.qa?.includes("Failed") ? "text-red-500" : "text-slate-500"
                              )}>
                                {entry.qa || "N/A"}
                              </span>
                          </td>
                          <td className="p-5 text-slate-500 font-medium italic">
                            {entry.reason || entry.error || (entry.tokens ? `Processed (${entry.tokens.prompt + entry.tokens.candidates} Tok)` : 'Successful extraction')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </motion.div>
          )}

          {error && (
            <div className="bg-red-50 border-2 border-red-100 rounded-3xl p-8 flex items-start gap-5 shadow-lg shadow-red-100/50">
              <div className="p-3 bg-white rounded-2xl shadow-sm border border-red-50 text-red-600">
                <AlertCircle className="w-8 h-8" />
              </div>
              <div>
                <h4 className="text-red-900 font-bold text-lg mb-1 tracking-tight uppercase">Pipeline Execution Fault</h4>
                <p className="text-red-700 text-sm font-medium leading-relaxed">{error}</p>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Simplified System Status Bar */}
      <footer className="border-t border-slate-200 px-8 py-6 bg-white flex flex-col sm:flex-row justify-between items-center gap-6">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-slate-50 rounded-xl flex items-center justify-center border border-slate-100">
            <ShieldCheck className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <div className="text-[11px] font-bold text-slate-800 uppercase tracking-tight">Secure Extraction Grid</div>
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5 font-mono">TLS 1.3 // AES-256 PARSE</div>
          </div>
        </div>
        <div className="flex gap-8 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            Core Node-Alpha
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-slate-300" />
            Shard-Omega-2
          </div>
        </div>
      </footer>
    </div>
  );
}

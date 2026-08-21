/**
 * Dispatch Fill companion server — the minimal backend the browser extension needs.
 * Endpoints: /api/fill-data, /api/resume, /api/answers, /api/cover-letter, /api/health.
 * LLM calls go through the Claude Code CLI (`claude -p`), so a logged-in `claude`
 * is the only credential required. Personal data lives in ../local/ (gitignored).
 */
import http from "http";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 4310);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Private-Network": "true",
};

function loadProfile() {
  const p = path.join(ROOT, "local", "profile.json");
  if (!fs.existsSync(p)) throw new Error("local/profile.json missing — copy templates/profile.template.json there and fill it in");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function llm(prompt, model = "sonnet") {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      ["-p", "--model", model, "--output-format", "text"],
      { timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error(`claude CLI failed: ${stderr || err.message}`)) : resolve(stdout.trim()))
    );
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function extractJson(text) {
  const m = text.match(/[\[{][\s\S]*[\]}]/);
  if (!m) throw new Error("no JSON in LLM output");
  return JSON.parse(m[0]);
}

function answersPrompt(profile, fields, jobContext) {
  const fieldList = fields
    .slice(0, 20)
    .map((f) =>
      `- key "${f.key}": ${f.type}${f.type === "multiselect" ? ` (pick up to ${f.maxChoices || 3})` : ""}${f.required ? " (required)" : ""} — "${(f.label || "").slice(0, 250)}"` +
      (f.options?.length ? ` options: [${f.options.slice(0, 30).map((o) => `"${o}"`).join(", ")}]` : "")
    )
    .join("\n");

  return `You fill job application form fields for this candidate. Facts about the candidate:

${profile.resumeSummary}

Contact/personal: name ${profile.name}, email ${profile.email}, phone ${profile.phone}, github ${profile.github || "none"}, location ${profile.location}.
Standard answers: ${JSON.stringify(profile.commonAnswers || {})}

${jobContext}

Form fields to answer:
${fieldList}

Rules:
- Ground every answer in the facts above. NEVER invent facts, links, IDs, or credentials. If the candidate has no answer or answering truthfully is impossible, return an empty string for that key.
- For select/radio/buttons fields, the value MUST be copied EXACTLY from the given options (choose the truthful one; prefer the option meaning "no/none" for disqualifiers, and the truthful bracket for experience ranges).
- For multiselect fields, value must be a JSON ARRAY of up to the stated number of options, each copied EXACTLY from the list, choosing the ones truest to the candidate.
- Free-text answers: specific, first person, plain sentences, no em-dashes, no exclamation marks, never the words "excited", "passionate", or "thrilled". Short factual fields get one line. "Why this company" gets 2-3 concrete sentences from the job context.
- "Describe your experience/project..." essay questions get 3-6 sentences of real substance drawn from the candidate facts. Specific projects and stacks beat adjectives.
- Salary/CTC questions: use the standard answers; if a numeric-only field demands salary, leave it empty rather than guessing.
- Fields with type "date" need YYYY-MM-DD. Other date-style text fields: use the format the label asks for, else DD/MM/YYYY.

Reply with ONLY a JSON array: [{"key": "<key>", "value": "<answer, empty string, or array for multiselect>"}]`;
}

function coverLetterPrompt(profile, ctx) {
  return `Write a cover letter for this candidate:

${profile.resumeSummary}

Job:
Company: ${ctx.company || "unknown (infer from description)"}
Title: ${ctx.title || ""}
Description/context: ${(ctx.description || "").slice(0, 2500)}

Rules:
- 180-260 words, 3-4 short paragraphs: why this company specifically, the most relevant experience with concrete specifics, what they can expect in the first months, a low-friction close.
- Plain confident sentences. NO em-dashes, no "excited", "passionate", "thrilled", "resonates", "aligns", no bullet points.
- Ground everything in the facts above; never invent employers, dates, or credentials.
- Start with "Dear ${ctx.company ? ctx.company + " team" : "Hiring team"}," and end with "Sincerely,\\n${profile.name}".
- Output ONLY the letter text, no commentary, no address block, no date.`;
}

function coverLetterPdf(text, profile) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 64, left: 68, right: 68, bottom: 64 } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.font("Helvetica-Bold").fontSize(16).fillColor("#111").text(profile.name);
    doc.font("Helvetica").fontSize(9).fillColor("#555").text(`${profile.email}  ·  ${profile.phone}${profile.github ? `  ·  ${profile.github}` : ""}`);
    doc.moveDown(0.4);
    doc.moveTo(doc.x, doc.y).lineTo(doc.page.width - 68, doc.y).strokeColor("#cccccc").lineWidth(0.7).stroke();
    doc.moveDown(1.2);
    doc.font("Helvetica").fontSize(10.5).fillColor("#111");
    for (const para of text.split(/\n\s*\n/)) {
      doc.text(para.trim(), { lineGap: 2.5 });
      doc.moveDown(0.8);
    }
    doc.end();
  });
}

const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b ? JSON.parse(b) : {}));
  });

const json = (res, code, obj) => {
  res.writeHead(code, { ...CORS, "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS);
        return res.end();
      }
      if (url.pathname === "/api/health") {
        return json(res, 200, { db: true, claude: true, standalone: true });
      }
      if (url.pathname === "/api/fill-data") {
        const profile = loadProfile();
        const [firstName, ...rest] = profile.name.split(" ");
        return json(res, 200, {
          firstName,
          lastName: rest.join(" ") || firstName,
          name: profile.name,
          email: profile.email,
          phone: profile.phone,
          github: profile.github ? `https://${profile.github.replace(/^https?:\/\//, "")}` : "",
          linkedin: profile.commonAnswers?.linkedin || "",
          location: profile.location,
          draft: "", // no job pipeline in standalone mode; cover letters use the page itself
          matched: null,
          resumeName: `${profile.name.replace(/\s+/g, "_")}_Resume.pdf`,
        });
      }
      if (url.pathname === "/api/resume") {
        const profile = loadProfile();
        const f = path.join(ROOT, "local", "resume.pdf");
        if (!fs.existsSync(f)) return json(res, 404, { error: "local/resume.pdf missing" });
        res.writeHead(200, { ...CORS, "Content-Type": "application/pdf" });
        return res.end(fs.readFileSync(f));
      }
      if (url.pathname === "/api/answers" && req.method === "POST") {
        const { fields, title, pageText } = await readBody(req);
        if (!fields?.length) return json(res, 200, { answers: [] });
        const profile = loadProfile();
        const jobContext = title || pageText ? `Job context (from the application page itself): ${title || ""}\n${(pageText || "").slice(0, 1500)}` : "";
        const out = await llm(answersPrompt(profile, fields, jobContext));
        const clean = (s) => String(s).replace(/—|–/g, ",");
        const answers = extractJson(out)
          .filter((a) => a && typeof a.key === "string")
          .map((a) => ({ key: a.key, value: Array.isArray(a.value) ? a.value.map(clean) : clean(a.value ?? "") }));
        return json(res, 200, { answers });
      }
      if (url.pathname === "/api/cover-letter" && req.method === "POST") {
        const { title, pageText } = await readBody(req);
        const profile = loadProfile();
        const text = (await llm(coverLetterPrompt(profile, { company: "", title, description: pageText || title || "" }))).replace(/—|–/g, ",").trim();
        const pdf = await coverLetterPdf(text, profile);
        return json(res, 200, {
          pdfB64: pdf.toString("base64"),
          filename: `${profile.name.replace(/\s+/g, "_")}_Cover_Letter.pdf`,
          text,
          matched: null,
        });
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: String(e.message || e).slice(0, 300) });
    }
  })
  .listen(PORT, () => console.log(`Dispatch Fill server on http://localhost:${PORT}`));

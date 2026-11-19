import express from "express";
import cors from "cors";
import { readFileSync } from "node:fs";

const { GEMINI_API_KEY, PORT = 3000, MODEL = "gemini-3.8-flash", TTS_MODEL = "gemini-3.1-flash-tts-preview", TTS_VOICE = "Kore" } = process.env;
if (!GEMINI_API_KEY) { console.error("Missing GEMINI_API_KEY environment variable."); process.exit(1); }

const FALLBACKS = (process.env.FALLBACK_MODELS || "gemini-flash-latest").split(",").map((x) => x.trim()).filter(Boolean);

const BASE_SYSTEM =
  "You are Cruzr, a friendly service robot. Reply in the same language the user spoke or wrote in " +
  "(Arabic or English; for Arabic use simple, clear, natural Arabic). Keep answers short (1 to 3 sentences) " +
  "because they are spoken aloud. Plain text only: no markdown, no emojis, no lists.";

// Company knowledge lives in persona.txt (edit it on GitHub, no code changes needed).
let PERSONA = "";
try { PERSONA = readFileSync(new URL("./persona.txt", import.meta.url), "utf-8").trim().slice(0, 20000); } catch { /* optional file */ }
const SYSTEM = PERSONA
  ? BASE_SYSTEM + "\n\nYou represent the company described below. When greeted or asked who you are, introduce yourself and the company briefly. " +
    "Answer questions about the company, its services, hours, location and contact using ONLY the information below. " +
    "If the answer is not there, say politely that you do not have that detail and suggest asking a staff member; never invent prices, hours, names or promises. " +
    "For unrelated general questions, answer briefly and helpfully. Follow the name and tone described below.\n\n--- COMPANY INFORMATION ---\n" + PERSONA
  : BASE_SYSTEM;

const AUDIO_INSTR =
  "The user is speaking to you; their message is the attached audio. First transcribe exactly what they said, " +
  "then answer as the robot. Reply with ONLY a JSON object: {\"heard\":\"<transcript>\",\"reply\":\"<your short spoken answer>\"}. " +
  "If the audio has no intelligible speech, use empty strings for both.";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();
const limited = (ip) => { const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > 30; };

const okTurns = (m, start) =>
  m.every((x, i) => x && x.role === ((i + start) % 2 === 0 ? "user" : "assistant") &&
    typeof x.content === "string" && x.content.length > 0 && x.content.length <= 2000);
const toContent = (m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] });

app.post("/chat", async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: "Too many requests" });
  const { messages, audio } = req.body ?? {};
  const voice = audio !== undefined;
  const tts = req.body?.tts === true;
  let contents;

  if (voice) {
    const hist = messages ?? [];
    if (typeof audio !== "string" || audio.length > 1_000_000 || !Array.isArray(hist) ||
        hist.length > 20 || hist.length % 2 || !okTurns(hist, 0))
      return res.status(400).json({ error: "Invalid audio request" });
    contents = [...hist.map(toContent),
      { role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: audio } }, { text: AUDIO_INSTR }] }];
  } else {
    if (!Array.isArray(messages) || !messages.length || messages.length > 20 ||
        messages.length % 2 === 0 || !okTurns(messages, 0))
      return res.status(400).json({ error: "Invalid messages" });
    contents = messages.map(toContent);
  }

  const models = [MODEL, ...FALLBACKS.filter((m) => m !== MODEL)];
  try {
    let text = "", lastErr = "";
    for (const model of models) {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
            signal: AbortSignal.timeout(15000), // per model; then try the next one
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: SYSTEM }] },
              contents,
              generationConfig: {
                maxOutputTokens: 2000,
                ...(/gemini-3/.test(model) ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
                ...(voice ? { responseMimeType: "application/json" } : {}),
              },
            }),
          }
        );
        const data = await r.json();
        const t = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
        if (r.ok && t) { text = t; if (model !== MODEL) console.log("Used fallback model:", model); break; }
        lastErr = `${model}: ${data.error?.message || (r.ok ? "empty reply" : "HTTP " + r.status)}`;
        console.error("Gemini API error:", r.status, JSON.stringify(data).slice(0, 500));
      } catch (e) {
        lastErr = `${model}: ${e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout (15s)" : e?.message}`;
        console.error("Gemini call failed:", lastErr);
      }
    }
    if (!text) return res.status(502).json({ error: "Upstream error", detail: lastErr.slice(0, 300) });
    if (!voice) return text ? res.json(await addAudio({ reply: text }, tts)) : res.status(502).json({ error: "Empty reply" });

    let out = { heard: "", reply: text };
    try {
      const j = JSON.parse(text.replace(/^```(?:json)?|```$/g, "").trim());
      out = { heard: String(j.heard ?? ""), reply: String(j.reply ?? "") };
    } catch { /* model ignored JSON; use raw text as the reply */ }
    res.json(await addAudio(out, tts));
  } catch (err) {
    console.error(err);
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    res.status(timedOut ? 504 : 500).json({
      error: timedOut ? "Gemini timeout" : "Server error",
      detail: timedOut ? "Gemini did not answer within 25 seconds" : String(err?.cause?.code || err?.message || ""),
    });
  }
});

// ---- Text-to-speech with Gemini: returns raw PCM (24 kHz, 16-bit, mono) as base64 ----
const TTS_MODELS = [...new Set([TTS_MODEL, ...(process.env.TTS_FALLBACKS || "gemini-3.8-flash-tts,gemini-2.5-flash-preview-tts").split(",").map((x) => x.trim()).filter(Boolean)])];
async function synthWith(model, text, ms = 10000) {
  const ar = /[\u0600-\u06FF]/.test(text);
  const prompt = `Say in a warm, natural, conversational human voice, not robotic${ar ? ", with a natural Gulf Arabic accent" : ""}: ${text}`;
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      signal: AbortSignal.timeout(ms),
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } } },
        },
      }),
    }
  );
  const data = await r.json();
  const b64 = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
  if (!r.ok || !b64) throw new Error(data.error?.message || "TTS returned no audio");
  return b64;
}
// Tries each TTS model in turn so the natural Gemini voice keeps working if one is busy or rate-limited.
async function synth(text) {
  let last;
  for (const m of TTS_MODELS) {
    try { const a = await synthWith(m, text); if (m !== TTS_MODEL) console.log("Used TTS fallback:", m); return a; }
    catch (e) { last = e; console.error(`TTS error (${m}):`, e?.name === "TimeoutError" ? "timeout" : e?.message || e); }
  }
  throw last;
}
async function addAudio(o, want) {
  if (want && o.reply) {
    try { o.audio = await synth(o.reply); } catch (e) { console.error("TTS error:", e?.message || e); }
  }
  return o;
}
app.post("/tts", async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: "Too many requests" });
  const text = req.body?.text;
  if (typeof text !== "string" || !text.trim() || text.length > 500) return res.status(400).json({ error: "Invalid text" });
  try { res.json({ audio: await synth(text) }); }
  catch (e) { console.error("TTS error:", e?.message || e); res.status(502).json({ error: "TTS failed", detail: String(e?.message || "") }); }
});

// Open /diag in a browser: lists the Flash models your key can use and times a tiny request to each.
app.get("/diag", async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: "Too many requests" });
  const base = "https://generativelanguage.googleapis.com/v1beta";
  const h = { "x-goog-api-key": GEMINI_API_KEY, "content-type": "application/json" };
  const out = { version: "v5", configured: MODEL, fallbacks: FALLBACKS, available: [], tests: [] };
  try {
    const r = await fetch(`${base}/models?pageSize=200`, { headers: h, signal: AbortSignal.timeout(10000) });
    const d = await r.json();
    out.listStatus = r.status;
    if (!r.ok) out.listError = d.error?.message;
    out.available = (d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent") && /flash/.test(m.name))
      .map((m) => m.name.replace("models/", ""));
  } catch (e) { out.listError = e?.name === "TimeoutError" ? "timeout (10s)" : String(e?.message || e); }
  const cands = [...new Set([MODEL, ...FALLBACKS, ...out.available.filter((n) => !/tts|image|live|audio|embed/.test(n)).slice(0, 3)])].slice(0, 5);
  out.tests = await Promise.all(cands.map(async (model) => {
    const t0 = Date.now();
    try {
      const r = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", headers: h, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Say hi" }] }], generationConfig: { maxOutputTokens: 50 } }),
      });
      const d = await r.json();
      return { model, status: r.status, ms: Date.now() - t0, ok: r.ok && !!d.candidates, error: d.error?.message?.slice(0, 160) };
    } catch (e) {
      return { model, ms: Date.now() - t0, ok: false, error: e?.name === "TimeoutError" ? "timeout (10s)" : String(e?.message || e) };
    }
  }));
  out.tts = await Promise.all(TTS_MODELS.map(async (model) => {
    const t0 = Date.now();
    try { const a = await synthWith(model, "مرحبا", 10000); return { model, ok: true, ms: Date.now() - t0, bytes: a.length }; }
    catch (e) { return { model, ok: false, ms: Date.now() - t0, error: e?.name === "TimeoutError" ? "timeout (10s)" : String(e?.message || e).slice(0, 160) }; }
  }));
  res.json(out);
});

app.get("/health", (_req, res) => res.json({ ok: true, version: "v5-fallback", bodyLimit: "2mb" }));
app.listen(PORT, () => console.log(`Cruzr backend v5-fallback running on port ${PORT} (model: ${MODEL}, persona: ${PERSONA ? PERSONA.length + " chars" : "none"})`));

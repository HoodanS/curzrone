import express from "express";
import cors from "cors";

const { GEMINI_API_KEY, PORT = 3000, MODEL = "gemini-3.8-flash", TTS_MODEL = "gemini-3.1-flash-tts-preview", TTS_VOICE = "Kore" } = process.env;
if (!GEMINI_API_KEY) { console.error("Missing GEMINI_API_KEY environment variable."); process.exit(1); }

const SYSTEM =
  "You are Cruzr, a friendly service robot. Reply in the same language the user spoke or wrote in " +
  "(Arabic or English; for Arabic use simple, clear, natural Arabic). Keep answers short (1 to 3 sentences) " +
  "because they are spoken aloud. Plain text only: no markdown, no emojis, no lists.";

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

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
        signal: AbortSignal.timeout(25000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents,
          generationConfig: {
            maxOutputTokens: 2000,
            thinkingConfig: { thinkingLevel: "low" },
            ...(voice ? { responseMimeType: "application/json" } : {}),
          },
        }),
      }
    );
    const data = await r.json();
    if (!r.ok) {
      console.error("Gemini API error:", r.status, JSON.stringify(data));
      return res.status(502).json({ error: "Upstream error", detail: data.error?.message || "" });
    }
    const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
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
async function synth(text) {
  const ar = /[\u0600-\u06FF]/.test(text);
  const prompt = `Say in a warm, natural, conversational human voice, not robotic${ar ? ", with a natural Gulf Arabic accent" : ""}: ${text}`;
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(TTS_MODEL)}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      signal: AbortSignal.timeout(20000),
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

app.get("/health", (_req, res) => res.json({ ok: true, version: "v4-audio-tts", bodyLimit: "2mb" }));
app.listen(PORT, () => console.log(`Cruzr backend v4-audio-tts running on port ${PORT} (model: ${MODEL}, body limit 2mb)`));

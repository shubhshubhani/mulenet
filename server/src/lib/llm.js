/**
 * LLM client — Groq / Gemini / Ollama, plus a deterministic fallback.
 *
 * The fallback is not a nicety. Hackathon wifi dies, free-tier quotas run out,
 * and a demo that crashes on a 429 is a dead demo. If no provider answers,
 * every feature still returns a usable (blunter) result, and the UI says so.
 */
import dotenv from "dotenv";
dotenv.config();

const PROVIDER = (process.env.LLM_PROVIDER || "none").toLowerCase();

export function providerInfo() {
  return {
    provider: PROVIDER,
    configured:
      (PROVIDER === "groq" && !!process.env.GROQ_API_KEY) ||
      (PROVIDER === "gemini" && !!process.env.GEMINI_API_KEY) ||
      PROVIDER === "ollama"
  };
}

async function openAICompatible({ baseUrl, apiKey, model, messages, json }) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model, messages, temperature: 0.2,
      ...(json ? { response_format: { type: "json_object" } } : {})
    })
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 240)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function gemini({ apiKey, model, messages, json }) {
  const system = messages.find((m) => m.role === "system")?.content || "";
  const rest = messages.filter((m) => m.role !== "system");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents: rest.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }]
        })),
        generationConfig: {
          temperature: 0.2,
          ...(json ? { responseMimeType: "application/json" } : {})
        }
      })
    });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 240)}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

export async function chat(messages, { json = false } = {}) {
  try {
    let text = "";
    if (PROVIDER === "groq") {
      if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY missing");
      text = await openAICompatible({
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: process.env.GROQ_API_KEY,
        model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
        messages, json
      });
    } else if (PROVIDER === "gemini") {
      if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
      text = await gemini({
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
        messages, json
      });
    } else if (PROVIDER === "ollama") {
      text = await openAICompatible({
        baseUrl: process.env.OLLAMA_URL || "http://localhost:11434/v1",
        apiKey: null,
        model: process.env.OLLAMA_MODEL || "llama3.1",
        messages, json
      });
    } else {
      throw new Error("no provider configured");
    }
    return { ok: true, text };
  } catch (e) {
    console.warn("[llm] fallback:", e.message);
    return { ok: false, text: "", error: e.message };
  }
}

export function parseJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const c = fenced ? fenced[1] : text;
  try { return JSON.parse(c); } catch { /* keep digging */ }
  const s = c.search(/[{[]/);
  const e = Math.max(c.lastIndexOf("}"), c.lastIndexOf("]"));
  if (s === -1 || e <= s) return null;
  try { return JSON.parse(c.slice(s, e + 1)); } catch { return null; }
}

import { NextResponse } from "next/server";

const DEFAULT_MODEL = "gpt-4o-mini";

function jsonResponse(data, status = 200) {
  return NextResponse.json(data, { status });
}

function buildTitlePrompt(contentType) {
  const shorts = contentType === "shorts";
  return `You generate YouTube metadata for CS2 / competitive gaming clips.
Return ONLY valid JSON: {"titles":["...", ...]} with exactly 5 strings.
Rules for each title:
- Short, clickable, emotional, curiosity-driving (no clickbait lies).
- Prefer active voice; hint at clutch moment, skill, or twist.
${shorts ? "- Shorts: at most ONE emoji in the whole set of 5 (0 is ok); keep under ~60 chars each." : "- No emoji; keep punchy, under ~70 chars each."}
- No quotes around titles, no numbering, no explanations.`;
}

function buildDescriptionPrompt(contentType, title) {
  return `You write YouTube descriptions for CS2 / gaming videos.
Return ONLY valid JSON: {"description":"..."}.
Title (use for context): ${JSON.stringify(title)}
Rules:
- 2-4 short lines: hook, what happens, soft CTA (subscribe / more CS2) optional.
- No hashtag spam in description body; plain readable lines.
${contentType === "shorts" ? "- Punchy, Shorts-friendly pacing." : ""}`;
}

function buildTagsPrompt(contentType, title, description) {
  return `You pick YouTube tags for CS2 / gaming videos.
Return ONLY valid JSON: {"tags":["tag1", ...]} with 10-14 tags.
Rules:
- Lowercase or mixed case as typical on YouTube; include cs2, counter-strike, gaming variants where relevant.
- Short phrases without # prefix.
Title: ${JSON.stringify(title)}
Description (for context): ${JSON.stringify(description ?? "")}`;
}

function buildBatchPrompt(contentType, title) {
  return `You generate YouTube description AND tags together for CS2 / gaming videos.
Return ONLY valid JSON: {"description":"...","tags":["tag1", ...]}.
Title: ${JSON.stringify(title)}
Content style: ${contentType === "shorts" ? "Shorts: tight lines, energetic." : "Long-form: clear hook then detail."}

Description rules:
- 2-4 short lines, no hashtags in the description text.

Tags rules:
- 10-14 tags, CS2/gaming relevant, no # prefix.`;
}

async function callOpenAI(system, user) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.85,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${text.slice(0, 400)}`);
  }
  const body = await res.json();
  const raw = body.choices?.[0]?.message?.content;
  if (!raw) throw new Error("Empty model response");
  return JSON.parse(raw);
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { type, payload } = body ?? {};
  if (!type || typeof payload !== "object" || !payload) {
    return jsonResponse({ error: "Expected { type, payload }" }, 400);
  }

  const contentType = payload.contentType === "shorts" ? "shorts" : "long";

  try {
    switch (type) {
      case "title": {
        const system =
          "You output compact JSON only. No markdown fences. English.";
        const userPrompt = buildTitlePrompt(contentType);
        const data = await callOpenAI(system, userPrompt);
        const titles = Array.isArray(data.titles) ? data.titles : [];
        const cleaned = titles
          .map((t) => String(t).trim())
          .filter(Boolean)
          .slice(0, 5);
        while (cleaned.length < 5 && cleaned.length > 0) {
          cleaned.push(cleaned[0]);
        }
        return jsonResponse({ titles: cleaned });
      }
      case "description": {
        const title = String(payload.title ?? "").trim();
        if (!title) return jsonResponse({ error: "title required" }, 400);
        const system =
          "You output compact JSON only. No markdown fences. English.";
        const userPrompt = buildDescriptionPrompt(contentType, title);
        const data = await callOpenAI(system, userPrompt);
        return jsonResponse({
          description: String(data.description ?? "").trim(),
        });
      }
      case "tags": {
        const title = String(payload.title ?? "").trim();
        if (!title) return jsonResponse({ error: "title required" }, 400);
        const description = String(payload.description ?? "").trim();
        const system =
          "You output compact JSON only. No markdown fences. English.";
        const userPrompt = buildTagsPrompt(contentType, title, description);
        const data = await callOpenAI(system, userPrompt);
        let tags = Array.isArray(data.tags) ? data.tags : [];
        tags = tags.map((t) => String(t).trim()).filter(Boolean);
        return jsonResponse({ tags });
      }
      case "batch": {
        const title = String(payload.title ?? "").trim();
        if (!title) return jsonResponse({ error: "title required" }, 400);
        const gen = payload.generate;
        if (
          !Array.isArray(gen) ||
          !gen.includes("description") ||
          !gen.includes("tags")
        ) {
          return jsonResponse(
            { error: "generate must include description and tags" },
            400
          );
        }
        const system =
          "You output compact JSON only. No markdown fences. English.";
        const userPrompt = buildBatchPrompt(contentType, title);
        const data = await callOpenAI(system, userPrompt);
        let tags = Array.isArray(data.tags) ? data.tags : [];
        tags = tags.map((t) => String(t).trim()).filter(Boolean);
        return jsonResponse({
          description: String(data.description ?? "").trim(),
          tags,
        });
      }
      default:
        return jsonResponse({ error: "Unknown type" }, 400);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "Server error";
    return jsonResponse({ error: message }, 500);
  }
}

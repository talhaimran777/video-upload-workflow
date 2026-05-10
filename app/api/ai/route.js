import { NextResponse } from "next/server";

const DEFAULT_MODEL = "gpt-4o-mini";

/** Minimal system message: output shape only; creative/format rules come from the client. */
const JSON_ONLY_SYSTEM =
  "Return only valid JSON matching the schema in the user message. No markdown code fences.";

function jsonResponse(data, status = 200) {
  return NextResponse.json(data, { status });
}

function normalizeTagArray(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => String(t).trim().replace(/^#+/, ""))
    .filter(Boolean);
}

/** Client sends labeled sections or legacy plain string. */
function parseStructuredContext(context) {
  const raw = String(context ?? "").trim();
  if (!raw) {
    return { clip: "", instructions: "" };
  }
  const lower = raw.toLowerCase();
  const clipTag = "[clip context]";
  const instrTag = "[regeneration instructions]";
  const iClip = lower.indexOf(clipTag);
  const iInstr = lower.indexOf(instrTag);

  if (iInstr !== -1) {
    const beforeInstr = raw.slice(0, iInstr).trim();
    let clipText = beforeInstr;
    if (iClip !== -1 && iClip < iInstr) {
      clipText = raw
        .slice(iClip + clipTag.length, iInstr)
        .replace(/^\s*\n*/, "")
        .trim();
    } else if (iClip === -1) {
      clipText = beforeInstr.replace(/^\s*\n*/, "").trim();
    }
    const instrText = raw
      .slice(iInstr + instrTag.length)
      .replace(/^\s*\n*/, "")
      .trim();
    return {
      clip: clipText,
      instructions: instrText,
    };
  }

  if (iClip !== -1) {
    return {
      clip: raw.slice(iClip + clipTag.length).trim(),
      instructions: "",
    };
  }

  return { clip: raw, instructions: "" };
}

function buildTitlePrompt(clip, instructions) {
  const blocks = [
    `Return ONLY valid JSON: {"titles":["...","...","...","...","..."]} — exactly five strings.`,
  ];
  if (clip) {
    blocks.push(`[CLIP CONTEXT]\n${JSON.stringify(clip)}`);
  }
  if (instructions) {
    blocks.push(`[INSTRUCTIONS]\n${JSON.stringify(instructions)}`);
  }
  return blocks.join("\n\n");
}

function buildDescriptionPrompt(title, clip, instructions) {
  const blocks = [
    `Return ONLY valid JSON: {"description":"..."}.
Title: ${JSON.stringify(title)}`,
  ];
  if (clip) {
    blocks.push(`[CLIP CONTEXT]\n${JSON.stringify(clip)}`);
  }
  if (instructions) {
    blocks.push(`[INSTRUCTIONS]\n${JSON.stringify(instructions)}`);
  }
  return blocks.join("\n\n");
}

function buildTagsPrompt(title, description, clip, instructions) {
  const blocks = [
    `Return ONLY valid JSON: {"tags":["..."]} — array of strings.
Title: ${JSON.stringify(title)}
Description: ${JSON.stringify(description ?? "")}`,
  ];
  if (clip) {
    blocks.push(`[CLIP CONTEXT]\n${JSON.stringify(clip)}`);
  }
  if (instructions) {
    blocks.push(`[INSTRUCTIONS]\n${JSON.stringify(instructions)}`);
  }
  return blocks.join("\n\n");
}

function buildBatchPrompt(
  title,
  clip,
  instructionsDescription,
  instructionsTags
) {
  const blocks = [
    `Return ONLY valid JSON: {"description":"...","tags":["..."]}.
Title: ${JSON.stringify(title)}`,
  ];
  if (clip) {
    blocks.push(`[CLIP CONTEXT]\n${JSON.stringify(clip)}`);
  }
  if (instructionsDescription) {
    blocks.push(
      `[INSTRUCTIONS — DESCRIPTION]\n${JSON.stringify(instructionsDescription)}`
    );
  }
  if (instructionsTags) {
    blocks.push(
      `[INSTRUCTIONS — TAGS]\n${JSON.stringify(instructionsTags)}`
    );
  }
  return blocks.join("\n\n");
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
      // temperature: 0.85,
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

  const rawContext = String(payload.context ?? "").trim();
  const { clip, instructions } = parseStructuredContext(rawContext);

  try {
    switch (type) {
      case "title": {
        const userPrompt = buildTitlePrompt(clip, instructions);
        const data = await callOpenAI(JSON_ONLY_SYSTEM, userPrompt);
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
        const userPrompt = buildDescriptionPrompt(title, clip, instructions);
        const data = await callOpenAI(JSON_ONLY_SYSTEM, userPrompt);
        return jsonResponse({
          description: String(data.description ?? "").trim(),
        });
      }
      case "tags": {
        const title = String(payload.title ?? "").trim();
        if (!title) return jsonResponse({ error: "title required" }, 400);
        const description = String(payload.description ?? "").trim();
        const userPrompt = buildTagsPrompt(
          title,
          description,
          clip,
          instructions
        );
        const data = await callOpenAI(JSON_ONLY_SYSTEM, userPrompt);
        const tags = normalizeTagArray(data.tags);
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
        const instrDescOpt = String(
          payload.instructionsDescription ?? ""
        ).trim();
        const instrTagsOpt = String(payload.instructionsTags ?? "").trim();
        let instructionsDescription = instrDescOpt;
        let instructionsTags = instrTagsOpt;
        if (!instrDescOpt && !instrTagsOpt && instructions) {
          instructionsDescription = instructions;
          instructionsTags = instructions;
        }
        const userPrompt = buildBatchPrompt(
          title,
          clip,
          instructionsDescription,
          instructionsTags
        );
        const data = await callOpenAI(JSON_ONLY_SYSTEM, userPrompt);
        const tags = normalizeTagArray(data.tags);
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

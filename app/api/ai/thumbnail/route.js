import { NextResponse } from "next/server";
import sharp from "sharp";

export const runtime = "nodejs";
export const maxDuration = 120;

const YT_W = 1280;
const YT_H = 720;
/** Raw upload safety cap (after client downscale this should stay small). */
const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;

const DEFAULT_GEN_MODEL = "dall-e-3";
const DEFAULT_EDIT_MODEL = "gpt-image-1.5";

function jsonError(message, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Prompt is only session context + optional title from the client — no preset creative rules. */
function buildThumbnailPrompt(context, title) {
  const c = String(context ?? "").trim();
  const t = String(title ?? "").trim();
  if (!c && !t) return null;
  if (c && t) return `${c}\n\n${t}`;
  return c || t;
}

async function bufferFromOpenAiImageData(data) {
  const item = data?.data?.[0];
  if (!item) {
    throw new Error("Empty image response");
  }
  if (item.b64_json) {
    return Buffer.from(item.b64_json, "base64");
  }
  if (item.url) {
    const r = await fetch(item.url);
    if (!r.ok) {
      throw new Error("Failed to fetch generated image URL");
    }
    return Buffer.from(await r.arrayBuffer());
  }
  throw new Error("No image data in model response");
}

async function resizeToYouTube(buffer) {
  return sharp(buffer)
    .resize(YT_W, YT_H, { fit: "cover", position: "attention" })
    .jpeg({ quality: 91, mozjpeg: true })
    .toBuffer();
}

function isFileLike(v) {
  return (
    v &&
    typeof v === "object" &&
    typeof v.arrayBuffer === "function" &&
    typeof v.size === "number"
  );
}

export async function POST(request) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return jsonError("OPENAI_API_KEY is not set", 500);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return jsonError("Expected multipart form data", 400);
  }

  const contentType = String(form.get("contentType") ?? "").trim();
  if (contentType !== "long") {
    return jsonError(
      "Thumbnails are only available for long-form content",
      400
    );
  }

  const thumbnailContext = String(form.get("thumbnailContext") ?? "");
  const titleHint = String(form.get("title") ?? "").trim();
  const ref = form.get("reference");

  const genModel =
    process.env.OPENAI_IMAGE_MODEL?.trim() || DEFAULT_GEN_MODEL;
  const editModel =
    process.env.OPENAI_IMAGE_EDIT_MODEL?.trim() || DEFAULT_EDIT_MODEL;

  const hasRef = isFileLike(ref) && ref.size > 0;
  if (hasRef && ref.size > MAX_REFERENCE_BYTES) {
    return jsonError("Reference image too large (max ~12MB)", 400);
  }

  try {
    let rawBuffer;

    if (hasRef) {
      const ab = await ref.arrayBuffer();
      const inputBuf = Buffer.from(ab);
      const pngBuf = await sharp(inputBuf).rotate().png().toBuffer();
      const prompt = buildThumbnailPrompt(thumbnailContext, titleHint);
      if (!prompt) {
        return jsonError(
          "Add thumbnail instructions in the AI command bar and/or set a video title before generating.",
          400
        );
      }

      const openaiForm = new FormData();
      openaiForm.append("model", editModel);
      openaiForm.append("prompt", prompt);
      openaiForm.append("size", "1536x1024");
      openaiForm.append("n", "1");
      openaiForm.append(
        "image",
        new Blob([pngBuf], { type: "image/png" }),
        "reference.png"
      );

      const res = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: openaiForm,
      });
      if (!res.ok) {
        const text = await res.text();
        return jsonError(
          `OpenAI image edit error ${res.status}: ${text.slice(0, 400)}`,
          502
        );
      }
      const data = await res.json();
      rawBuffer = await bufferFromOpenAiImageData(data);
    } else {
      const prompt = buildThumbnailPrompt(thumbnailContext, titleHint);
      if (!prompt) {
        return jsonError(
          "Add thumbnail instructions in the AI command bar and/or set a video title before generating.",
          400
        );
      }
      const isDalle3 =
        genModel === "dall-e-3" || genModel.startsWith("dall-e-3");
      const body = {
        model: genModel,
        prompt,
        n: 1,
      };
      if (isDalle3) {
        body.size = "1792x1024";
        body.response_format = "url";
      } else {
        body.size = "1536x1024";
        body.output_format = "jpeg";
      }

      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        return jsonError(
          `OpenAI image generation error ${res.status}: ${text.slice(0, 400)}`,
          502
        );
      }
      const data = await res.json();
      rawBuffer = await bufferFromOpenAiImageData(data);
    }

    const jpegBuf = await resizeToYouTube(rawBuffer);
    return NextResponse.json({
      imageBase64: jpegBuf.toString("base64"),
      mimeType: "image/jpeg",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Thumbnail error";
    return jsonError(message, 500);
  }
}

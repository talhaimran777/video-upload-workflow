/** YouTube Data API v3 — client-side resumable upload helpers */

export const YOUTUBE_GAMING_CATEGORY_ID = "20";

/** Minimum lead time before publishAt (YouTube enforces a similar window). */
export const YOUTUBE_SCHEDULE_MIN_LEAD_MS = 15 * 60 * 1000;
const YOUTUBE_SCHEDULE_MAX_LEAD_MS = 365 * 24 * 60 * 60 * 1000;

const TITLE_MAX = 100;
const DESC_MAX = 5000;
const TAG_MAX_LEN = 30;
const TAG_COUNT_MAX = 30;

function sanitizeTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const raw of tags) {
    if (out.length >= TAG_COUNT_MAX) {
      break;
    }
    let t = String(raw).trim().replace(/^#+/, "");
    if (!t) {
      continue;
    }
    if (t.length > TAG_MAX_LEN) {
      t = t.slice(0, TAG_MAX_LEN);
    }
    const key = t.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * Ensures `publishAt` is valid for YouTube videos.insert scheduling.
 * @param {Date} date — wall-clock instant (e.g. from `new Date(datetimeLocalValue)`).
 */
export function assertScheduledPublishAt(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error("Pick a valid date and time for scheduling.");
  }
  const now = Date.now();
  const t = date.getTime();
  if (t <= now) {
    throw new Error("Schedule time must be in the future.");
  }
  if (t < now + YOUTUBE_SCHEDULE_MIN_LEAD_MS) {
    throw new Error(
      "YouTube needs at least 15 minutes between upload and the scheduled publish time."
    );
  }
  if (t > now + YOUTUBE_SCHEDULE_MAX_LEAD_MS) {
    throw new Error("Schedule time cannot be more than one year ahead.");
  }
}

/**
 * Shorten Google API error JSON for display (e.g. invalid publishAt).
 * @param {string} raw
 */
export function formatYoutubeApiErrorDetail(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  try {
    const j = JSON.parse(s);
    const msg = j?.error?.message;
    if (typeof msg === "string" && msg) {
      return msg;
    }
    const err0 = j?.error?.errors?.[0];
    if (err0 && typeof err0.reason === "string") {
      return err0.reason + (err0.message ? `: ${err0.message}` : "");
    }
  } catch {
    /* not JSON */
  }
  return s.slice(0, 400);
}

/**
 * Builds snippet + status for videos.insert.
 * Shorts: appends " #Shorts" when missing (helps shelf behavior).
 * @param {{ publishAt?: Date | string | null }} [opts] — When set, video is private until this UTC instant (API: status.publishAt).
 */
export function buildYouTubeUploadBody({
  title,
  description,
  tags,
  contentType,
  publishAt = null,
}) {
  let t = String(title ?? "").trim();
  if (!t) {
    throw new Error("Title is required for YouTube upload");
  }

  if (
    contentType === "shorts" &&
    !/\s#Shorts\b/i.test(t) &&
    !/#Shorts$/i.test(t)
  ) {
    const suffix = " #Shorts";
    const maxBase = TITLE_MAX - suffix.length;
    const base = t.length > maxBase ? t.slice(0, maxBase).trim() : t;
    t = (base + suffix).slice(0, TITLE_MAX);
  } else if (t.length > TITLE_MAX) {
    t = t.slice(0, TITLE_MAX).trim();
  }

  let desc = String(description ?? "").trim();
  if (desc.length > DESC_MAX) {
    desc = desc.slice(0, DESC_MAX);
  }

  const cleanTags = sanitizeTags(tags);

  const status = {
    privacyStatus: "private",
    selfDeclaredMadeForKids: false,
  };

  if (publishAt != null && publishAt !== "") {
    const d =
      publishAt instanceof Date ? publishAt : new Date(String(publishAt));
    assertScheduledPublishAt(d);
    status.publishAt = d.toISOString();
  }

  return {
    snippet: {
      title: t,
      description: desc,
      tags: cleanTags,
      categoryId: YOUTUBE_GAMING_CATEGORY_ID,
    },
    status,
  };
}

function xhrPutWithProgress(url, file, videoContentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", videoContentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && typeof onProgress === "function") {
        onProgress(Math.min(100, Math.round((100 * e.loaded) / e.total)));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText || "{}"));
        } catch {
          reject(new Error("Invalid response from YouTube upload"));
        }
      } else {
        reject(
          new Error(
            `YouTube upload failed (${xhr.status}): ${
              formatYoutubeApiErrorDetail(xhr.responseText) ||
              (xhr.responseText || "").slice(0, 400)
            }`
          )
        );
      }
    };
    xhr.onerror = () =>
      reject(new Error("Network error during video upload"));
    xhr.send(file);
  });
}

/**
 * Browser resumable upload (metadata POST, then PUT bytes to Location URL).
 * @param {object} opts
 * @param {string} opts.accessToken
 * @param {File} opts.file
 * @param {ReturnType<buildYouTubeUploadBody>} opts.body - { snippet, status }
 * @param {(pct: number) => void} [opts.onProgress]
 */
export async function uploadVideoResumable({
  accessToken,
  file,
  body,
  onProgress,
}) {
  if (!file || !(file instanceof File)) {
    throw new Error("Video file missing");
  }

  const videoContentType = file.type || "video/mp4";

  const initRes = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(file.size),
        "X-Upload-Content-Type": videoContentType,
      },
      body: JSON.stringify(body),
    }
  );

  if (!initRes.ok) {
    const errText = await initRes.text();
    const detail = formatYoutubeApiErrorDetail(errText) || errText.slice(0, 500);
    throw new Error(`Could not start upload (${initRes.status}): ${detail}`);
  }

  const location = initRes.headers.get("Location");
  if (!location) {
    throw new Error("YouTube did not return an upload URL");
  }

  if (typeof onProgress === "function") {
    onProgress(0);
  }

  const result = await xhrPutWithProgress(
    location,
    file,
    videoContentType,
    onProgress
  );

  if (!result.id) {
    throw new Error("Upload finished but no video id returned");
  }

  return result.id;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * POST thumbnail image bytes (data URL) for an uploaded video.
 * Retries once after a short delay if the first attempt fails (processing window).
 */
export async function uploadCustomThumbnail({ accessToken, videoId, dataUrl }) {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl);
  if (!m) {
    throw new Error("Thumbnail must be a base64 data URL");
  }
  const mime = m[1].trim();
  const b64 = m[2].replace(/\s/g, "");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  const url = `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`;

  async function tryOnce() {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": mime,
      },
      body: bytes,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Thumbnail upload (${res.status}): ${text.slice(0, 300)}`
      );
    }
  }

  try {
    await tryOnce();
  } catch {
    await sleep(3500);
    await tryOnce();
  }
}

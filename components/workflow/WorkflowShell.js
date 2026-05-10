"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  assertScheduledPublishAt,
  buildYouTubeUploadBody,
  formatYoutubeApiErrorDetail,
  uploadCustomThumbnail,
  uploadVideoResumable,
} from "../../lib/youtubeUpload.js";

const CONFIRM_MS = 1600;
const TITLE_DEBOUNCE_MS = 500;
const REGEN_DEBOUNCE_MS = 400;
const SESSION_MEMORY_MAX_CHARS = 12000;
const SESSION_MEMORY_MAX_ENTRIES = 48;

/** Pro: scheduled upload. On in development; in production set NEXT_PUBLIC_ENABLE_SCHEDULED_UPLOAD=true */
const SCHEDULE_UPLOAD_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_SCHEDULED_UPLOAD === "true" ||
  process.env.NODE_ENV === "development";

function defaultDatetimeLocalOneHourAhead() {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/** @typedef {{ target: string; text: string; at: number }} ConversationEntry */

const COMMAND_TARGET_LABELS = {
  clip: "Clip context",
  title: "Title",
  description: "Description",
  tags: "Tags",
  thumbnail: "Thumbnail",
};

function truncateSessionMemoryLines(lines) {
  const text = lines.join("\n");
  if (text.length <= SESSION_MEMORY_MAX_CHARS) return text;
  return `…(earlier messages omitted)\n${text.slice(
    text.length - SESSION_MEMORY_MAX_CHARS
  )}`;
}

/** Numbered transcript for regeneration prompts (bounded size). */
function formatSessionMemoryBlock(history) {
  const slice =
    history.length > SESSION_MEMORY_MAX_ENTRIES
      ? history.slice(history.length - SESSION_MEMORY_MAX_ENTRIES)
      : history;
  const lines = slice.map(
    (e, i) =>
      `${i + 1}. [${COMMAND_TARGET_LABELS[e.target] ?? e.target}] ${e.text}`
  );
  return truncateSessionMemoryLines(lines);
}

function buildClipFromHistory(history) {
  return history
    .filter((e) => e.target === "clip")
    .map((e) => e.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function buildThumbnailContextFromHistory(history, memoryBlock) {
  const thumbLines = history
    .filter((e) => e.target === "thumbnail")
    .map((e) => e.text.trim())
    .filter(Boolean);
  const thumbFocus =
    thumbLines.length > 0
      ? `\n\n[THUMBNAIL FOCUS]\n${thumbLines.join("\n")}`
      : "";
  return `${memoryBlock}${thumbFocus}`.trim();
}

/** Same recent window as formatSessionMemoryBlock, but omit "clip" lines so
 *  buildApiContextString does not repeat clip text under REGENERATION INSTRUCTIONS. */
function formatInstructionsMemoryBlock(history) {
  const slice =
    history.length > SESSION_MEMORY_MAX_ENTRIES
      ? history.slice(history.length - SESSION_MEMORY_MAX_ENTRIES)
      : history;
  const noClip = slice.filter((e) => e.target !== "clip");
  const lines = noClip.map(
    (e, i) =>
      `${i + 1}. [${COMMAND_TARGET_LABELS[e.target] ?? e.target}] ${e.text}`
  );
  return truncateSessionMemoryLines(lines);
}

/** Keeps /api/ai and /api/ai/thumbnail payload shapes unchanged. */
function draftPatchFromConversationHistory(history, contentType) {
  const clipContext = buildClipFromHistory(history);
  const memoryBlock = formatSessionMemoryBlock(history);
  const instructionsBlock = formatInstructionsMemoryBlock(history);
  const thumbnailContext =
    contentType === "long"
      ? buildThumbnailContextFromHistory(history, memoryBlock)
      : "";
  return {
    clipContext,
    instructionsTitle: instructionsBlock,
    instructionsDescription: instructionsBlock,
    instructionsTags: instructionsBlock,
    thumbnailContext,
  };
}

function parseTagsInput(str) {
  return str
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function resetGeneratedMetadata() {
  return {
    title: "",
    description: "",
    tags: [],
    tagsInput: "",
  };
}

/** Single payload.context string for the API (labeled sections). */
function buildApiContextString(clip, instructions) {
  const c = (clip ?? "").trim();
  const i = (instructions ?? "").trim();
  if (!c && !i) return "";
  if (!c) return `[REGENERATION INSTRUCTIONS]\n${i}`;
  if (!i) return `[CLIP CONTEXT]\n${c}`;
  return `[CLIP CONTEXT]\n${c}\n\n[REGENERATION INSTRUCTIONS]\n${i}`;
}

/** JPEG downscale so multipart stays small (max long edge). */
function downscaleImageFileIfLarge(file, maxEdge = 2048) {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      resolve(file);
      return;
    }
    const img = new window.Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      const max = Math.max(nw, nh);
      if (max <= maxEdge) {
        resolve(file);
        return;
      }
      const scale = maxEdge / max;
      const w = Math.round(nw * scale);
      const h = Math.round(nh * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas unsupported"));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("Encode failed"));
            return;
          }
          const base =
            (file.name && file.name.replace(/\.[^.]+$/, "")) || "reference";
          resolve(
            new File([blob], `${base}-upload.jpg`, { type: "image/jpeg" })
          );
        },
        "image/jpeg",
        0.88
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image"));
    };
    img.src = url;
  });
}

function initialState() {
  return {
    draft: {
      videoFile: null,
      videoObjectUrl: null,
      contentType: "long",
      clipContext: "",
      instructionsTitle: "",
      instructionsDescription: "",
      instructionsTags: "",
      title: "",
      description: "",
      tags: [],
      tagsInput: "",
      thumbnailContext: "",
      thumbnailReferenceFile: null,
      thumbnailReferenceObjectUrl: null,
      thumbnailResultDataUrl: "",
    },
    ai: {
      titleOptions: [],
      loadingTitle: false,
      loadingDescription: false,
      loadingTags: false,
      loadingThumbnail: false,
    },
  };
}

export default function WorkflowShell() {
  const [state, setState] = useState(initialState);
  const [clipNotice, setClipNotice] = useState("");
  const [youtubeConnected, setYoutubeConnected] = useState(false);
  const [youtubeUploading, setYoutubeUploading] = useState(false);
  const [youtubeUploadProgress, setYoutubeUploadProgress] = useState(null);
  const [youtubeErr, setYoutubeErr] = useState("");
  const [youtubeLastVideoId, setYoutubeLastVideoId] = useState(null);
  const [youtubePublishMode, setYoutubePublishMode] = useState("private_now");
  const [youtubeScheduleLocal, setYoutubeScheduleLocal] = useState(
    defaultDatetimeLocalOneHourAhead
  );
  /** null | 'command' while dictating into the unified command bar */
  const [micActive, setMicActive] = useState(null);
  const [speechSupported, setSpeechSupported] = useState(false);
  /** @type {[ConversationEntry[], React.Dispatch<React.SetStateAction<ConversationEntry[]>>]} */
  const [conversationHistory, setConversationHistory] = useState([]);
  /** clip | title | description | tags | thumbnail */
  const [commandTarget, setCommandTarget] = useState("clip");
  const [commandDraft, setCommandDraft] = useState("");

  const titleAbortRef = useRef(null);
  const batchAbortRef = useRef(null);
  const batchReqIdRef = useRef(0);
  const titleReqIdRef = useRef(0);
  const confirmTimerRef = useRef(null);
  const titleDebounceRef = useRef(null);
  const regenDebounceRef = useRef(null);
  const recognitionRef = useRef(null);
  const pendingInterimCommandRef = useRef("");
  const conversationHistoryRef = useRef(
    /** @type {ConversationEntry[]} */ ([])
  );
  const thumbnailAbortRef = useRef(null);
  const thumbnailFileInputRef = useRef(null);

  const draft = state.draft;
  const ai = state.ai;

  const schedulePublishDateValid = useMemo(() => {
    if (!SCHEDULE_UPLOAD_ENABLED || youtubePublishMode !== "schedule") {
      return true;
    }
    try {
      assertScheduledPublishAt(new Date(youtubeScheduleLocal));
      return true;
    } catch {
      return false;
    }
  }, [youtubePublishMode, youtubeScheduleLocal]);

  const setDraft = useCallback((patch) => {
    setState((s) => ({
      ...s,
      draft: { ...s.draft, ...patch },
    }));
  }, []);

  const setAi = useCallback((patch) => {
    setState((s) => ({
      ...s,
      ai: { ...s.ai, ...patch },
    }));
  }, []);

  useEffect(() => {
    conversationHistoryRef.current = conversationHistory;
  }, [conversationHistory]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.SpeechRecognition || window.webkitSpeechRecognition) {
      setSpeechSupported(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/youtube/session");
        const d = await r.json().catch(() => ({}));
        if (!cancelled) {
          setYoutubeConnected(!!d.connected);
        }
      } catch {
        if (!cancelled) {
          setYoutubeConnected(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const conn = params.get("youtube_connected");
    const err = params.get("youtube_error");
    if (conn) {
      setYoutubeConnected(true);
      setClipNotice("YouTube account connected");
      setTimeout(() => setClipNotice(""), 3500);
    }
    if (err) {
      setYoutubeErr(
        `YouTube sign-in: ${decodeURIComponent(err.replace(/\+/g, " "))}`
      );
      setTimeout(() => setYoutubeErr(""), 10000);
    }
    if (conn || err) {
      params.delete("youtube_connected");
      params.delete("youtube_error");
      const q = params.toString();
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}${q ? `?${q}` : ""}`
      );
    }
  }, []);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          /* ignore */
        }
        recognitionRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!draft.videoFile) {
      setState((s) => ({
        ...s,
        draft: { ...s.draft, videoObjectUrl: null },
      }));
      return;
    }
    const objectUrl = URL.createObjectURL(draft.videoFile);
    setState((s) => ({
      ...s,
      draft: { ...s.draft, videoObjectUrl: objectUrl },
    }));
    return () => URL.revokeObjectURL(objectUrl);
  }, [draft.videoFile]);

  useEffect(() => {
    if (!draft.thumbnailReferenceFile) {
      setState((s) => ({
        ...s,
        draft: { ...s.draft, thumbnailReferenceObjectUrl: null },
      }));
      return;
    }
    const objectUrl = URL.createObjectURL(draft.thumbnailReferenceFile);
    setState((s) => ({
      ...s,
      draft: { ...s.draft, thumbnailReferenceObjectUrl: objectUrl },
    }));
    return () => URL.revokeObjectURL(objectUrl);
  }, [draft.thumbnailReferenceFile]);

  const titleConfirmedForRef = useRef("");

  const clearConfirmTimer = useCallback(() => {
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, []);

  const startConfirmWindow = useCallback((titleSnapshot) => {
    clearConfirmTimer();
    confirmTimerRef.current = setTimeout(() => {
      confirmTimerRef.current = null;
      titleConfirmedForRef.current = titleSnapshot;
    }, CONFIRM_MS);
  }, [clearConfirmTimer]);

  const postAi = useCallback(async (body, signal) => {
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Request failed: ${res.status}`);
    }
    return data;
  }, []);

  const stateRef = useRef(state);
  stateRef.current = state;
  const stateRefGet = () => stateRef.current;

  const flushSpeechRecognition = useCallback(() => {
    return new Promise((resolve) => {
      const rec = recognitionRef.current;
      if (!rec) {
        resolve();
        return;
      }
      const t = setTimeout(() => {
        recognitionRef.current = null;
        setMicActive(null);
        resolve();
      }, 900);
      rec.onend = () => {
        clearTimeout(t);
        recognitionRef.current = null;
        setMicActive(null);
        resolve();
      };
      try {
        rec.stop();
      } catch {
        clearTimeout(t);
        recognitionRef.current = null;
        setMicActive(null);
        resolve();
      }
    });
  }, []);

  const prepareDraftForAi = useCallback(async () => {
    await flushSpeechRecognition();
    pendingInterimCommandRef.current = "";
    const d = stateRefGet().draft;
    return {
      clip: (d.clipContext ?? "").trim(),
      instructionsTitle: (d.instructionsTitle ?? "").trim(),
      instructionsDescription: (d.instructionsDescription ?? "").trim(),
      instructionsTags: (d.instructionsTags ?? "").trim(),
    };
  }, [flushSpeechRecognition]);

  const fetchBatch = useCallback(
    async (titleText, sourceSignal) => {
      const {
        clip,
        instructionsDescription,
        instructionsTags,
      } = await prepareDraftForAi();
      const context = buildApiContextString(clip, "");
      const myId = ++batchReqIdRef.current;
      if (batchAbortRef.current) {
        batchAbortRef.current.abort();
      }
      const ac = new AbortController();
      batchAbortRef.current = ac;
      const signal = sourceSignal || ac.signal;

      setAi({ loadingDescription: true, loadingTags: true });
      startConfirmWindow(titleText);

      const contentType = stateRefGet().draft.contentType;
      const descContext = buildApiContextString(
        clip,
        instructionsDescription
      );
      const tagsContext = buildApiContextString(clip, instructionsTags);

      const applyDescriptionTags = (description, tags) => {
        if (myId !== batchReqIdRef.current) return;
        setDraft({ description, tags, tagsInput: tags.join(", ") });
      };

      try {
        const data = await postAi(
          {
            type: "batch",
            payload: {
              contentType,
              title: titleText,
              context,
              instructionsDescription,
              instructionsTags,
              generate: ["description", "tags"],
            },
          },
          signal
        );
        if (signal.aborted || myId !== batchReqIdRef.current) return;
        applyDescriptionTags(data.description || "", data.tags || []);
      } catch {
        if (signal.aborted || myId !== batchReqIdRef.current) return;
        try {
          const dData = await postAi(
            {
              type: "description",
              payload: {
                contentType,
                title: titleText,
                context: descContext,
              },
            },
            signal
          );
          if (signal.aborted || myId !== batchReqIdRef.current) return;
          const desc = dData.description || "";
          const tData = await postAi(
            {
              type: "tags",
              payload: {
                contentType,
                title: titleText,
                description: desc,
                context: tagsContext,
              },
            },
            signal
          );
          if (signal.aborted || myId !== batchReqIdRef.current) return;
          applyDescriptionTags(desc, tData.tags || []);
        } catch {
          if (!signal.aborted && myId === batchReqIdRef.current) {
            setClipNotice("Could not refresh description/tags. Try again.");
            setTimeout(() => setClipNotice(""), 3500);
          }
        }
      } finally {
        if (myId === batchReqIdRef.current) {
          setAi({ loadingDescription: false, loadingTags: false });
        }
      }
    },
    [prepareDraftForAi, postAi, setAi, setDraft, startConfirmWindow]
  );

  const scheduleDebouncedBatch = useCallback(
    (titleText) => {
      if (titleDebounceRef.current) {
        clearTimeout(titleDebounceRef.current);
      }
      titleDebounceRef.current = setTimeout(() => {
        titleDebounceRef.current = null;
        if (titleText.trim()) {
          fetchBatch(titleText.trim());
        }
      }, TITLE_DEBOUNCE_MS);
    },
    [fetchBatch]
  );

  const onTitleCardClick = useCallback(
    (t) => {
      if (titleDebounceRef.current) {
        clearTimeout(titleDebounceRef.current);
        titleDebounceRef.current = null;
      }
      clearConfirmTimer();
      titleConfirmedForRef.current = "";
      if (batchAbortRef.current) {
        batchAbortRef.current.abort();
        batchAbortRef.current = null;
      }
      setDraft({ title: t });
      fetchBatch(t);
    },
    [clearConfirmTimer, fetchBatch, setDraft]
  );

  const onTitleInput = useCallback(
    (e) => {
      const v = e.target.value;
      setDraft({ title: v });
      scheduleDebouncedBatch(v);
    },
    [scheduleDebouncedBatch, setDraft]
  );

  const regenerateTitles = useCallback(() => {
    if (regenDebounceRef.current) return;
    regenDebounceRef.current = setTimeout(() => {
      regenDebounceRef.current = null;
    }, REGEN_DEBOUNCE_MS);

    if (!draft.videoFile || !draft.contentType) return;
    if (titleAbortRef.current) {
      titleAbortRef.current.abort();
    }
    const ac = new AbortController();
    titleAbortRef.current = ac;
    const myTid = ++titleReqIdRef.current;
    setAi({ loadingTitle: true });
    setDraft({ description: "", tags: [], tagsInput: "" });

    const contentType = draft.contentType;

    (async () => {
      try {
        const { clip, instructionsTitle } = await prepareDraftForAi();
        const context = buildApiContextString(clip, instructionsTitle);
        const data = await postAi(
          {
            type: "title",
            payload: { contentType, context },
          },
          ac.signal
        );
        if (ac.signal.aborted || myTid !== titleReqIdRef.current) return;
        const titles = data.titles || [];
        const first = titles[0] || "";
        setAi({ titleOptions: titles, loadingTitle: false });
        setDraft({ title: first, ...(!first ? resetGeneratedMetadata() : {}) });
        if (first) {
          await fetchBatch(first, ac.signal);
        }
      } catch {
        if (!ac.signal.aborted && myTid === titleReqIdRef.current) {
          setAi({ loadingTitle: false });
        }
      }
    })();
  }, [
    draft.contentType,
    draft.videoFile,
    fetchBatch,
    postAi,
    prepareDraftForAi,
    setAi,
    setDraft,
  ]);

  const regenerateDescription = useCallback(() => {
    if (regenDebounceRef.current) return;
    regenDebounceRef.current = setTimeout(() => {
      regenDebounceRef.current = null;
    }, REGEN_DEBOUNCE_MS);

    if (!draft.videoFile || !draft.contentType) return;
    const titleText = (draft.title ?? "").trim();
    if (!titleText) {
      setClipNotice("Add or select a title first");
      setTimeout(() => setClipNotice(""), 2500);
      return;
    }
    if (batchAbortRef.current) {
      batchAbortRef.current.abort();
      batchAbortRef.current = null;
    }

    (async () => {
      setAi({ loadingDescription: true });
      try {
        const { clip, instructionsDescription } = await prepareDraftForAi();
        const context = buildApiContextString(clip, instructionsDescription);
        const data = await postAi({
          type: "description",
          payload: {
            contentType: stateRefGet().draft.contentType,
            title: titleText,
            context,
          },
        });
        setDraft({ description: String(data.description ?? "").trim() });
      } catch {
        setClipNotice("Could not regenerate description. Try again.");
        setTimeout(() => setClipNotice(""), 3500);
      } finally {
        setAi({ loadingDescription: false });
      }
    })();
  }, [draft.contentType, draft.title, draft.videoFile, postAi, prepareDraftForAi, setAi, setDraft]);

  const regenerateTags = useCallback(() => {
    if (regenDebounceRef.current) return;
    regenDebounceRef.current = setTimeout(() => {
      regenDebounceRef.current = null;
    }, REGEN_DEBOUNCE_MS);

    if (!draft.videoFile || !draft.contentType) return;
    const titleText = (draft.title ?? "").trim();
    if (!titleText) {
      setClipNotice("Add or select a title first");
      setTimeout(() => setClipNotice(""), 2500);
      return;
    }
    if (batchAbortRef.current) {
      batchAbortRef.current.abort();
      batchAbortRef.current = null;
    }

    (async () => {
      setAi({ loadingTags: true });
      try {
        const { clip, instructionsTags } = await prepareDraftForAi();
        const context = buildApiContextString(clip, instructionsTags);
        const desc = (stateRefGet().draft.description ?? "").trim();
        const data = await postAi({
          type: "tags",
          payload: {
            contentType: stateRefGet().draft.contentType,
            title: titleText,
            description: desc,
            context,
          },
        });
        const tags = Array.isArray(data.tags) ? data.tags : [];
        const cleaned = tags.map((t) => String(t).trim()).filter(Boolean);
        setDraft({ tags: cleaned, tagsInput: cleaned.join(", ") });
      } catch {
        setClipNotice("Could not regenerate tags. Try again.");
        setTimeout(() => setClipNotice(""), 3500);
      } finally {
        setAi({ loadingTags: false });
      }
    })();
  }, [draft.contentType, draft.title, draft.videoFile, postAi, prepareDraftForAi, setAi, setDraft]);

  const onFile = useCallback((e) => {
    const f = e.target.files?.[0];
    if (!f) {
      if (titleAbortRef.current) {
        titleAbortRef.current.abort();
        titleAbortRef.current = null;
      }
      if (thumbnailAbortRef.current) {
        thumbnailAbortRef.current.abort();
        thumbnailAbortRef.current = null;
      }
      if (thumbnailFileInputRef.current) {
        thumbnailFileInputRef.current.value = "";
      }
      conversationHistoryRef.current = [];
      setConversationHistory([]);
      setCommandDraft("");
      setCommandTarget("clip");
      setState((s) => ({
        ...s,
        draft: {
          ...s.draft,
          videoFile: null,
          clipContext: "",
          instructionsTitle: "",
          instructionsDescription: "",
          instructionsTags: "",
          thumbnailContext: "",
          thumbnailReferenceFile: null,
          thumbnailResultDataUrl: "",
          ...resetGeneratedMetadata(),
        },
        ai: {
          ...s.ai,
          titleOptions: [],
          loadingTitle: false,
          loadingDescription: false,
          loadingTags: false,
          loadingThumbnail: false,
        },
      }));
      return;
    }
    if (titleAbortRef.current) {
      titleAbortRef.current.abort();
      titleAbortRef.current = null;
    }
    if (thumbnailAbortRef.current) {
      thumbnailAbortRef.current.abort();
      thumbnailAbortRef.current = null;
    }
    if (thumbnailFileInputRef.current) {
      thumbnailFileInputRef.current.value = "";
    }
    conversationHistoryRef.current = [];
    setConversationHistory([]);
    setCommandDraft("");
    setCommandTarget("clip");
    setState((s) => ({
      ...s,
      draft: {
        ...s.draft,
        videoFile: f,
        clipContext: "",
        instructionsTitle: "",
        instructionsDescription: "",
        instructionsTags: "",
        thumbnailContext: "",
        thumbnailReferenceFile: null,
        thumbnailResultDataUrl: "",
        ...resetGeneratedMetadata(),
      },
      ai: {
        ...s.ai,
        titleOptions: [],
        loadingTitle: false,
        loadingDescription: false,
        loadingTags: false,
        loadingThumbnail: false,
      },
    }));
  }, []);

  const onContentType = useCallback(
    (v) => {
      if (v === draft.contentType) return;
      if (titleAbortRef.current) {
        titleAbortRef.current.abort();
        titleAbortRef.current = null;
      }
      if (thumbnailAbortRef.current) {
        thumbnailAbortRef.current.abort();
        thumbnailAbortRef.current = null;
      }
      if (v === "shorts" && thumbnailFileInputRef.current) {
        thumbnailFileInputRef.current.value = "";
      }
      conversationHistoryRef.current = [];
      setConversationHistory([]);
      setCommandDraft("");
      setCommandTarget("clip");
      const patch = draftPatchFromConversationHistory([], v);
      setState((s) => ({
        ...s,
        draft: {
          ...s.draft,
          contentType: v,
          ...(v === "shorts"
            ? {
                thumbnailReferenceFile: null,
                thumbnailResultDataUrl: "",
              }
            : {}),
          ...resetGeneratedMetadata(),
          ...patch,
        },
        ai: {
          ...s.ai,
          titleOptions: [],
          loadingTitle: false,
          loadingThumbnail: false,
        },
      }));
    },
    [draft.contentType]
  );

  const onThumbnailReferenceChange = useCallback(
    (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      setDraft({ thumbnailReferenceFile: f });
    },
    [setDraft]
  );

  const clearThumbnailReference = useCallback(() => {
    setDraft({ thumbnailReferenceFile: null });
    if (thumbnailFileInputRef.current) {
      thumbnailFileInputRef.current.value = "";
    }
  }, [setDraft]);

  const generateThumbnail = useCallback(async () => {
    if (!draft.videoFile || draft.contentType !== "long") return;
    if (thumbnailAbortRef.current) {
      thumbnailAbortRef.current.abort();
      thumbnailAbortRef.current = null;
    }
    const ac = new AbortController();
    thumbnailAbortRef.current = ac;
    await flushSpeechRecognition();
    pendingInterimCommandRef.current = "";
    const thumbCtx = (stateRefGet().draft.thumbnailContext ?? "").trim();
    const titleSnap = (stateRefGet().draft.title ?? "").trim();
    setAi({ loadingThumbnail: true });
    try {
      const fd = new FormData();
      fd.append("contentType", "long");
      fd.append("thumbnailContext", thumbCtx);
      fd.append("title", titleSnap);
      const refFile = stateRefGet().draft.thumbnailReferenceFile;
      if (refFile) {
        const prepared = await downscaleImageFileIfLarge(refFile);
        fd.append("reference", prepared);
      }
      const res = await fetch("/api/ai/thumbnail", {
        method: "POST",
        body: fd,
        signal: ac.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Thumbnail failed (${res.status})`);
      }
      const b64 = data.imageBase64;
      if (!b64 || typeof b64 !== "string") {
        throw new Error("No image returned");
      }
      setDraft({
        thumbnailResultDataUrl: `data:image/jpeg;base64,${b64}`,
      });
    } catch (e) {
      if (e?.name === "AbortError") return;
      setClipNotice(
        e instanceof Error ? e.message : "Thumbnail generation failed"
      );
      setTimeout(() => setClipNotice(""), 5000);
    } finally {
      setAi({ loadingThumbnail: false });
      thumbnailAbortRef.current = null;
    }
  }, [
    draft.videoFile,
    draft.contentType,
    flushSpeechRecognition,
    setAi,
    setDraft,
  ]);

  const downloadThumbnail = useCallback(() => {
    const url = draft.thumbnailResultDataUrl;
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = "thumbnail-1280x720.jpg";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [draft.thumbnailResultDataUrl]);

  const submitCommand = useCallback(() => {
    (async () => {
      await flushSpeechRecognition();
      const pending = (pendingInterimCommandRef.current ?? "").trim();
      pendingInterimCommandRef.current = "";
      const typed = (commandDraft ?? "").trim();
      const rawText = [typed, pending].filter(Boolean).join(" ").trim();
      if (!rawText) {
        setClipNotice("Type a message to send");
        setTimeout(() => setClipNotice(""), 2200);
        return;
      }
      const target = commandTarget;
      const entry = {
        target,
        text: rawText,
        at: Date.now(),
      };
      const next = [...conversationHistoryRef.current, entry];
      conversationHistoryRef.current = next;
      setConversationHistory(next);
      const ct = stateRefGet().draft.contentType;
      setDraft(draftPatchFromConversationHistory(next, ct));
      setCommandDraft("");

      const runAfterSync = () => {
        if (target === "clip") {
          setClipNotice("Saved to session");
          setTimeout(() => setClipNotice(""), 2000);
          return;
        }
        if (target === "title") {
          regenerateTitles();
          return;
        }
        if (target === "description") {
          regenerateDescription();
          return;
        }
        if (target === "tags") {
          regenerateTags();
          return;
        }
        if (target === "thumbnail") {
          generateThumbnail();
        }
      };
      setTimeout(runAfterSync, 0);
    })();
  }, [
    commandDraft,
    commandTarget,
    flushSpeechRecognition,
    generateThumbnail,
    regenerateDescription,
    regenerateTags,
    regenerateTitles,
    setDraft,
  ]);

  const toggleMic = useCallback(() => {
    const SR =
      typeof window !== "undefined" &&
      (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!SR) return;

    const field = "command";

    if (recognitionRef.current && micActive === field) {
      try {
        recognitionRef.current.stop();
      } catch {
        /* ignore */
      }
      recognitionRef.current = null;
      setMicActive(null);
      return;
    }

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        /* ignore */
      }
      recognitionRef.current = null;
      setMicActive(null);
    }

    const Rec = SR;
    const rec = new Rec();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (event) => {
      let finalPiece = "";
      let interimPiece = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const r = event.results[i];
        const text = r[0].transcript;
        if (r.isFinal) finalPiece += text;
        else interimPiece += text;
      }
      if (finalPiece.trim()) {
        pendingInterimCommandRef.current = "";
        const trimmed = finalPiece.trim();
        setCommandDraft((prev) =>
          prev ? `${prev.trimEnd()} ${trimmed}` : trimmed
        );
      }
      if (interimPiece.trim()) {
        pendingInterimCommandRef.current = interimPiece.trim();
      }
    };
    rec.onend = () => {
      recognitionRef.current = null;
      setMicActive(null);
    };
    rec.onerror = () => {
      recognitionRef.current = null;
      setMicActive(null);
    };
    recognitionRef.current = rec;
    try {
      rec.start();
      setMicActive(field);
    } catch {
      recognitionRef.current = null;
      setMicActive(null);
    }
  }, [micActive]);

  const micButtonClass = (active) =>
    `flex h-10 w-10 shrink-0 items-center justify-center self-start rounded-lg border text-lg leading-none transition disabled:cursor-not-allowed disabled:opacity-40 ${
      active
        ? "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
        : "border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
    }`;

  const onTagsInput = useCallback(
    (e) => {
      const v = e.target.value;
      const tags = parseTagsInput(v);
      setDraft({ tagsInput: v, tags });
    },
    [setDraft]
  );

  const onDescriptionInput = useCallback(
    (e) => {
      setDraft({ description: e.target.value });
    },
    [setDraft]
  );

  const copyText = useCallback(async (label, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setClipNotice(`${label} copied`);
      setTimeout(() => setClipNotice(""), 2000);
    } catch {
      setClipNotice("Clipboard blocked");
      setTimeout(() => setClipNotice(""), 2500);
    }
  }, []);

  const disconnectYouTube = useCallback(async () => {
    try {
      await fetch("/api/youtube/revoke", { method: "POST" });
    } catch {
      /* ignore */
    }
    setYoutubeConnected(false);
    setYoutubeLastVideoId(null);
    setYoutubeErr("");
  }, []);

  const uploadToYouTube = useCallback(async () => {
    if (!draft.videoFile || !(draft.title ?? "").trim()) {
      return;
    }
    if (!youtubeConnected) {
      setYoutubeErr("Connect YouTube first");
      return;
    }
    setYoutubeErr("");
    setYoutubeUploading(true);
    setYoutubeUploadProgress(0);
    try {
      const tokenRes = await fetch("/api/youtube/token", { method: "POST" });
      const tokenData = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok) {
        throw new Error(
          tokenData.error || "Could not refresh access — try Connect again"
        );
      }
      const accessToken = tokenData.access_token;
      if (!accessToken) {
        throw new Error("No access token from server");
      }

      const useSchedule =
        SCHEDULE_UPLOAD_ENABLED && youtubePublishMode === "schedule";
      const scheduleDate = useSchedule
        ? new Date(youtubeScheduleLocal)
        : null;

      const body = buildYouTubeUploadBody({
        title: draft.title,
        description: draft.description,
        tags: draft.tags,
        contentType: draft.contentType,
        publishAt:
          useSchedule &&
          scheduleDate &&
          !Number.isNaN(scheduleDate.getTime())
            ? scheduleDate
            : null,
      });

      const videoId = await uploadVideoResumable({
        accessToken,
        file: draft.videoFile,
        body,
        onProgress: (p) => setYoutubeUploadProgress(p),
      });

      const thumb = (draft.thumbnailResultDataUrl ?? "").trim();
      if (thumb) {
        setYoutubeUploadProgress(null);
        await uploadCustomThumbnail({
          accessToken,
          videoId,
          dataUrl: thumb,
        });
      }

      setYoutubeLastVideoId(videoId);
      if (useSchedule) {
        const when = new Date(youtubeScheduleLocal);
        setClipNotice(
          `Video scheduled on YouTube — publishes ${when.toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })} (your local time). Stays private until then.`
        );
      } else {
        setClipNotice("Video uploaded to YouTube as private.");
      }
      setTimeout(() => setClipNotice(""), 5000);
    } catch (e) {
      let msg =
        e instanceof Error ? e.message : "YouTube upload failed";
      const brace = msg.indexOf("{");
      if (brace !== -1) {
        const maybeJson = msg.slice(brace);
        const detail = formatYoutubeApiErrorDetail(maybeJson);
        if (detail) {
          msg = msg.slice(0, brace) + detail;
        }
      }
      setYoutubeErr(msg);
    } finally {
      setYoutubeUploading(false);
      setYoutubeUploadProgress(null);
    }
  }, [
    draft.contentType,
    draft.description,
    draft.tags,
    draft.thumbnailResultDataUrl,
    draft.title,
    draft.videoFile,
    youtubeConnected,
    youtubePublishMode,
    youtubeScheduleLocal,
  ]);

  const copyAll = useCallback(() => {
    const tagsLine = draft.tags.join(", ");
    const blob = `${draft.title}\n\n${draft.description}\n\n${tagsLine}`;
    return copyText("All metadata", blob);
  }, [copyText, draft.description, draft.tags, draft.title]);

  const hasFile = !!draft.videoFile;
  const hasTitle = !!(draft.title ?? "").trim();
  const hasLongForm = draft.contentType === "long";
  const showTitleGrid =
    ai.loadingTitle || (ai.titleOptions && ai.titleOptions.length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      <header className="shrink-0 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h1 className="text-lg font-semibold tracking-tight">
          Video metadata accelerator
        </h1>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          CS2 / gaming — one screen, AI runs ahead of you
        </p>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-12">
        <aside className="flex flex-col gap-4 lg:col-span-3">
          <div className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Video
            </h2>
            <input
              type="file"
              accept="video/*"
              onChange={onFile}
              className="mb-3 w-full text-sm file:mr-2 file:rounded-lg file:border-0 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-sm file:text-white dark:file:bg-zinc-100 dark:file:text-zinc-900"
            />
            {draft.videoObjectUrl ? (
              <video
                className="max-h-48 w-full rounded-lg border border-zinc-200 dark:border-zinc-700"
                src={draft.videoObjectUrl}
                controls
                muted
              />
            ) : (
              <div className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-zinc-300 text-xs text-zinc-400 dark:border-zinc-600">
                No video selected
              </div>
            )}
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Format
            </h2>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onContentType("long")}
                className={`flex-1 h-8 rounded-lg border text-xs font-medium transition ${
                  draft.contentType === "long"
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800"
                }`}
              >
                Long
              </button>
              <button
                type="button"
                onClick={() => onContentType("shorts")}
                className={`flex-1 h-8 rounded-lg border text-xs font-medium transition ${
                  draft.contentType === "shorts"
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800"
                }`}
              >
                Shorts
              </button>
            </div>
            <p className="mt-2 text-[10px] text-zinc-400">
              One AI command bar (main column) holds clip context and instructions
              for every model call. Session clears when you pick a new video or
              switch Long/Shorts.
            </p>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-semibold">5 — Review & copy</h2>
            <p className="mb-2 text-[10px] text-zinc-400">
              {SCHEDULE_UPLOAD_ENABLED ? (
                <>
                  Upload the current video as{" "}
                  <span className="font-medium text-zinc-500">private</span>, or
                  choose <span className="font-medium text-zinc-500">Schedule</span>{" "}
                  to publish at a future time (stays private until then). Connect
                  with Google (YouTube upload scope). Title, description, and tags
                  are sent with the upload. Long-form: a generated thumbnail is set
                  after upload.
                </>
              ) : (
                <>
                  Upload the current video file to your channel as{" "}
                  <span className="font-medium text-zinc-500">private</span>. Connect
                  with Google (YouTube upload scope). Current title, description, and
                  tags are sent with the upload. If a thumbnail was generated
                  (long-form), it is set after the video is uploaded.
                </>
              )}
            </p>
            {SCHEDULE_UPLOAD_ENABLED ? (
              <div className="mb-3 space-y-2 rounded-lg border border-zinc-100 bg-zinc-50/80 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
                <div className="text-[10px] font-medium uppercase text-zinc-400">
                  Publish
                </div>
                <div className="flex flex-col gap-2">
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-700 dark:text-zinc-200">
                    <input
                      type="radio"
                      name="yt-publish"
                      className="shrink-0"
                      checked={youtubePublishMode === "private_now"}
                      onChange={() => setYoutubePublishMode("private_now")}
                    />
                    Private now
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-700 dark:text-zinc-200">
                    <input
                      type="radio"
                      name="yt-publish"
                      className="shrink-0"
                      checked={youtubePublishMode === "schedule"}
                      onChange={() => {
                        setYoutubePublishMode("schedule");
                        setYoutubeScheduleLocal((v) =>
                          v || defaultDatetimeLocalOneHourAhead()
                        );
                      }}
                    />
                    Schedule
                  </label>
                </div>
                {youtubePublishMode === "schedule" ? (
                  <div>
                    <label className="block text-[10px] font-medium uppercase text-zinc-400">
                      Go live at (local time)
                    </label>
                    <input
                      type="datetime-local"
                      value={youtubeScheduleLocal}
                      onChange={(e) => setYoutubeScheduleLocal(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-950"
                    />
                    <p className="mt-1 text-[10px] text-zinc-400">
                      YouTube requires at least 15 minutes between now and this
                      time. You can change details anytime in Studio.
                    </p>
                    {!schedulePublishDateValid && youtubeScheduleLocal ? (
                      <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-400">
                        Adjust the time so it is at least 15 minutes from now.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            {youtubeErr ? (
              <p className="mb-2 text-xs text-red-600 dark:text-red-400">
                {youtubeErr}
              </p>
            ) : null}
            <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-zinc-100 pb-4 dark:border-zinc-800">
              {youtubeConnected ? (
                <>
                  <button
                    type="button"
                    onClick={uploadToYouTube}
                    disabled={
                      !hasFile ||
                      !hasTitle ||
                      youtubeUploading ||
                      !schedulePublishDateValid
                    }
                    className="rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {youtubeUploading
                      ? youtubeUploadProgress != null
                        ? `Uploading… ${youtubeUploadProgress}%`
                        : "Uploading…"
                      : SCHEDULE_UPLOAD_ENABLED &&
                          youtubePublishMode === "schedule"
                        ? "Schedule on YouTube"
                        : "Upload to YouTube (private)"}
                  </button>
                  <button
                    type="button"
                    onClick={disconnectYouTube}
                    className="rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
                  >
                    Disconnect YouTube
                  </button>
                  {youtubeLastVideoId ? (
                    <a
                      href={`https://studio.youtube.com/video/${youtubeLastVideoId}/edit`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-medium text-blue-600 underline dark:text-blue-400"
                    >
                      Open in YouTube Studio
                    </a>
                  ) : null}
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    window.location.href = "/api/youtube/oauth/start";
                  }}
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200 dark:hover:bg-red-950"
                >
                  Connect YouTube
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={copyAll}
                className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900"
              >
                Copy all
              </button>
              <button
                type="button"
                onClick={() => copyText("Title", draft.title)}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium dark:border-zinc-600"
              >
                Copy title
              </button>
              <button
                type="button"
                onClick={() =>
                  copyText("Description", draft.description)
                }
                className="rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium dark:border-zinc-600"
              >
                Copy description
              </button>
              <button
                type="button"
                onClick={() =>
                  copyText(
                    "Tags",
                    draft.tags.join(", ")
                  )
                }
                className="rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium dark:border-zinc-600"
              >
                Copy tags
              </button>
            </div>
          </div>
        </aside>

        <main className="flex min-h-0 flex-col gap-6 overflow-y-auto lg:col-span-9">
          {clipNotice ? (
            <p className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
              {clipNotice}
            </p>
          ) : null}
          <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold">AI command</h2>
                <p className="mt-0.5 text-[10px] text-zinc-400">
                  Enter sends; Shift+Enter for a new line. Chosen target decides
                  what runs after send (clip = save only).
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <label className="flex shrink-0 flex-col gap-1 sm:w-36">
                <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                  Target
                </span>
                <select
                  value={commandTarget}
                  onChange={(e) => setCommandTarget(e.target.value)}
                  className="rounded-lg border border-zinc-200 bg-white px-2 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-950"
                >
                  <option value="clip">Clip context</option>
                  <option value="title">Title</option>
                  <option value="description">Description</option>
                  <option value="tags">Tags</option>
                  <option value="thumbnail">Thumbnail</option>
                </select>
              </label>
              <div className="flex min-w-0 flex-1 gap-2">
                <textarea
                  value={commandDraft}
                  onChange={(e) => setCommandDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submitCommand();
                    }
                  }}
                  rows={3}
                  placeholder="Context or instructions for the selected target…"
                  className="min-h-20 flex-1 resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                />
                <button
                  type="button"
                  onClick={toggleMic}
                  disabled={!speechSupported}
                  title={
                    speechSupported
                      ? micActive === "command"
                        ? "Stop recording"
                        : "Dictate into command"
                      : "Speech recognition not supported in this browser"
                  }
                  aria-pressed={micActive === "command"}
                  className={micButtonClass(micActive === "command")}
                >
                  🎤
                </button>
              </div>
            </div>
          </section>
          <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">1 — Title</h2>
              {hasFile ? (
                <button
                  type="button"
                  onClick={regenerateTitles}
                  className="rounded-lg border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                  Regenerate titles
                </button>
              ) : (
                <span className="text-[10px] text-zinc-400">
                  Select a video to enable AI
                </span>
              )}
            </div>
            <p className="mb-2 text-[10px] text-zinc-400">
              Use AI command (target Title) or Regenerate. Full run updates title,
              description, and tags. Metadata resets when you switch format.
            </p>
            <label className="mb-3 block text-xs text-zinc-500">
              Selected / edit
              <input
                type="text"
                value={draft.title}
                onChange={onTitleInput}
                placeholder="Title appears after you click Regenerate titles…"
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
            </label>
            {showTitleGrid ? (
              <div className="grid gap-2 sm:grid-cols-1">
                {ai.loadingTitle
                  ? Array.from({ length: 5 }).map((_, i) => (
                      <div
                        key={`sk-${i}`}
                        className="h-12 animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800"
                      />
                    ))
                  : ai.titleOptions.map((t, idx) => (
                      <button
                        key={`${idx}-${t}`}
                        type="button"
                        onClick={() => onTitleCardClick(t)}
                        className={`rounded-lg border px-3 py-2 text-left text-sm transition hover:border-zinc-400 dark:hover:border-zinc-500 ${
                          draft.title === t
                            ? "border-zinc-900 bg-zinc-100 dark:border-zinc-200 dark:bg-zinc-800"
                            : "border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/50"
                        }`}
                      >
                        {t}
                      </button>
                    ))}
              </div>
            ) : (
              <p className="text-xs text-zinc-400">
                Select a video and format, then Regenerate titles.
              </p>
            )}
          </section>

          <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">2 — Description</h2>
              <button
                type="button"
                onClick={regenerateDescription}
                disabled={!hasFile || !hasTitle}
                className="rounded-lg border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                Regenerate description
              </button>
            </div>
            <p className="mb-2 text-[10px] text-zinc-400">
              Use AI command (target Description) or Regenerate. Requires a title.
            </p>
            <div className="relative">
              <textarea
                value={draft.description}
                onChange={onDescriptionInput}
                rows={5}
                placeholder={
                  ai.loadingDescription
                    ? "Generating description…"
                    : "Description…"
                }
                className="w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
              {ai.loadingDescription ? (
                <div
                  className="pointer-events-none absolute inset-0 rounded-lg bg-zinc-100/40 backdrop-blur-[0.5px] dark:bg-zinc-900/30"
                  aria-hidden
                />
              ) : null}
            </div>
          </section>

          <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">3 — Tags</h2>
              <button
                type="button"
                onClick={regenerateTags}
                disabled={!hasFile || !hasTitle}
                className="rounded-lg border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                Regenerate tags
              </button>
            </div>
            <p className="mb-2 text-[10px] text-zinc-400">
              Use AI command (target Tags) or Regenerate from current title and
              description.
            </p>
            <div className="relative">
              <textarea
                value={draft.tagsInput}
                onChange={onTagsInput}
                rows={3}
                placeholder={
                  ai.loadingTags
                    ? "Generating tags…"
                    : "comma, separated, tags"
                }
                className="w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-950"
              />
              {ai.loadingTags ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <span
                      key={`tg-${i}`}
                      className="inline-block h-6 w-14 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-700"
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </section>

          {hasLongForm ? (
            <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">
                  4 — Thumbnail (1280×720)
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={generateThumbnail}
                    disabled={!hasFile || ai.loadingThumbnail}
                    className="rounded-lg border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
                  >
                    {ai.loadingThumbnail ? "Generating…" : "Generate thumbnail"}
                  </button>
                  {draft.thumbnailResultDataUrl ? (
                    <button
                      type="button"
                      onClick={downloadThumbnail}
                      className="rounded-lg bg-zinc-900 px-3 py-1 text-xs font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900"
                    >
                      Download JPEG
                    </button>
                  ) : null}
                </div>
              </div>
              <p className="mb-3 text-[10px] text-zinc-400">
                Long-form only. Use AI command (target Thumbnail) or Generate.
                Output is normalized to YouTube-friendly{" "}
                <span className="font-medium text-zinc-500">1280×720</span>. Current
                title is passed as a hint when you generate.
              </p>
              <div className="mt-3 rounded-lg border border-zinc-100 bg-zinc-50/80 p-3 dark:border-zinc-800 dark:bg-zinc-950/50">
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                  Your photo for thumbnail (optional)
                </label>
                <p className="mb-2 text-[10px] text-zinc-400">
                  Upload a portrait or selfie so the AI can place you into a gaming-style
                  thumbnail. Your image is sent to the image model (OpenAI).
                </p>
                <div className="flex flex-wrap items-start gap-3">
                  <input
                    ref={thumbnailFileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={onThumbnailReferenceChange}
                    className="max-w-full text-xs file:mr-2 file:rounded-lg file:border-0 file:bg-zinc-200 file:px-2 file:py-1 dark:file:bg-zinc-700"
                  />
                  {draft.thumbnailReferenceObjectUrl ? (
                    <>
                      <img
                        src={draft.thumbnailReferenceObjectUrl}
                        alt="Reference preview"
                        className="h-20 w-auto max-w-28 rounded-md border border-zinc-200 object-cover dark:border-zinc-700"
                      />
                      <button
                        type="button"
                        onClick={clearThumbnailReference}
                        className="self-center rounded-lg border border-zinc-200 px-2 py-1 text-[10px] font-medium dark:border-zinc-600"
                      >
                        Remove photo
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="relative mt-4">
                {draft.thumbnailResultDataUrl ? (
                  <img
                    src={draft.thumbnailResultDataUrl}
                    alt="Generated thumbnail"
                    className="w-full max-w-2xl rounded-lg border border-zinc-200 object-cover dark:border-zinc-700"
                    style={{ aspectRatio: "16 / 9" }}
                  />
                ) : (
                  <div className="flex max-w-2xl flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 py-12 text-center text-xs text-zinc-400 dark:border-zinc-600 dark:bg-zinc-950/40 dark:text-zinc-500">
                    {hasFile
                      ? "Generated thumbnail preview will appear here."
                      : "Select a video to enable thumbnail generation."}
                  </div>
                )}
                {ai.loadingThumbnail ? (
                  <div
                    className="pointer-events-none absolute inset-0 flex max-w-2xl items-center justify-center rounded-lg bg-zinc-100/50 backdrop-blur-[1px] dark:bg-zinc-900/40"
                    aria-busy
                  >
                    <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                      Generating…
                    </span>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
        </main>
      </div>
    </div>
  );
}

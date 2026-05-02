"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const CONFIRM_MS = 1600;
const TITLE_DEBOUNCE_MS = 500;
const REGEN_DEBOUNCE_MS = 400;

function parseTagsInput(str) {
  return str
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function initialState() {
  return {
    draft: {
      videoFile: null,
      videoObjectUrl: null,
      contentType: "long",
      title: "",
      description: "",
      tags: [],
      tagsInput: "",
    },
    ai: {
      titleOptions: [],
      loadingTitle: false,
      loadingDescription: false,
      loadingTags: false,
    },
  };
}

export default function WorkflowShell() {
  const [state, setState] = useState(initialState);
  const [videoEpoch, setVideoEpoch] = useState(0);
  const [clipNotice, setClipNotice] = useState("");

  const lastCompletedAutoKeyRef = useRef("");
  const titleAbortRef = useRef(null);
  const batchAbortRef = useRef(null);
  const batchReqIdRef = useRef(0);
  const titleReqIdRef = useRef(0);
  const confirmTimerRef = useRef(null);
  const titleDebounceRef = useRef(null);
  const regenDebounceRef = useRef(null);

  const draft = state.draft;
  const ai = state.ai;

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

  /** Confirmed title snapshot after CONFIRM_MS — for stale-guard / future use */
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

  const fetchBatch = useCallback(
    async (titleText, sourceSignal) => {
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
              generate: ["description", "tags"],
            },
          },
          signal
        );
        if (signal.aborted || myId !== batchReqIdRef.current) return;
        applyDescriptionTags(data.description || "", data.tags || []);
      } catch (e) {
        if (signal.aborted || myId !== batchReqIdRef.current) return;
        try {
          const dData = await postAi(
            {
              type: "description",
              payload: { contentType, title: titleText },
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
    [postAi, setAi, setDraft, startConfirmWindow]
  );

  /** Auto-fetch titles when file + contentType; dedupe per videoEpoch+type */
  useEffect(() => {
    if (!draft.videoFile || !draft.contentType) return;
    const key = `${videoEpoch}-${draft.contentType}`;
    if (lastCompletedAutoKeyRef.current === key) return;

    if (titleAbortRef.current) {
      titleAbortRef.current.abort();
    }
    const ac = new AbortController();
    titleAbortRef.current = ac;

    const myTid = ++titleReqIdRef.current;
    setAi({ loadingTitle: true });

    (async () => {
      try {
        const data = await postAi(
          {
            type: "title",
            payload: { contentType: draft.contentType },
          },
          ac.signal
        );
        if (ac.signal.aborted || myTid !== titleReqIdRef.current) return;
        const titles = data.titles || [];
        const first = titles[0] || "";
        lastCompletedAutoKeyRef.current = key;
        setAi({ titleOptions: titles, loadingTitle: false });
        setDraft({ title: first });
        if (first) {
          await fetchBatch(first, ac.signal);
        }
      } catch {
        if (!ac.signal.aborted && myTid === titleReqIdRef.current) {
          setAi({ loadingTitle: false });
        }
      }
    })();

    return () => ac.abort();
  }, [draft.videoFile, draft.contentType, videoEpoch, postAi, setAi, setDraft, fetchBatch]);

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

    if (!draft.contentType) return;
    if (titleAbortRef.current) {
      titleAbortRef.current.abort();
    }
    const ac = new AbortController();
    titleAbortRef.current = ac;
    const myTid = ++titleReqIdRef.current;
    setAi({ loadingTitle: true });

    (async () => {
      try {
        const data = await postAi(
          {
            type: "title",
            payload: { contentType: draft.contentType },
          },
          ac.signal
        );
        if (ac.signal.aborted || myTid !== titleReqIdRef.current) return;
        setAi({ titleOptions: data.titles || [], loadingTitle: false });
      } catch {
        if (!ac.signal.aborted && myTid === titleReqIdRef.current) {
          setAi({ loadingTitle: false });
        }
      }
    })();
  }, [draft.contentType, postAi, setAi]);

  const onFile = useCallback((e) => {
    const f = e.target.files?.[0];
    if (!f) {
      setDraft({
        videoFile: null,
      });
      return;
    }
    setVideoEpoch((n) => n + 1);
    lastCompletedAutoKeyRef.current = "";
    setDraft({ videoFile: f });
  }, [setDraft]);

  const onContentType = useCallback(
    (v) => {
      if (v === draft.contentType) return;
      lastCompletedAutoKeyRef.current = "";
      setDraft({ contentType: v });
    },
    [draft.contentType, setDraft]
  );

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

  const copyAll = useCallback(() => {
    const tagsLine = draft.tags.join(", ");
    const blob = `${draft.title}\n\n${draft.description}\n\n${tagsLine}`;
    return copyText("All metadata", blob);
  }, [copyText, draft.description, draft.tags, draft.title]);

  const hasFile = !!draft.videoFile;
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
              Pick a video — your titles start generating automatically.
            </p>
          </div>
        </aside>

        <main className="flex min-h-0 flex-col gap-6 overflow-y-auto lg:col-span-6">
          <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">1 — Title</h2>
              {hasFile ? (
                <button
                  type="button"
                  onClick={regenerateTitles}
                  className="rounded-lg border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                  Regenerate titles
                </button>
              ) : null}
            </div>
            <label className="mb-3 block text-xs text-zinc-500">
              Selected / edit
              <input
                type="text"
                value={draft.title}
                onChange={onTitleInput}
                placeholder="Title appears after AI run…"
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
                Select a video to generate title options.
              </p>
            )}
          </section>

          <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-semibold">2 — Description</h2>
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
            <h2 className="mb-3 text-sm font-semibold">3 — Tags</h2>
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

          <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-semibold">4 — Review & copy</h2>
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
          </section>
        </main>

        <aside className="lg:col-span-3">
          <div className="sticky top-4 max-h-[calc(100vh-2rem)] space-y-3 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Live preview
            </h2>
            {clipNotice ? (
              <p className="text-xs text-emerald-600 dark:text-emerald-400">
                {clipNotice}
              </p>
            ) : null}
            <div>
              <div className="text-[10px] uppercase text-zinc-400">Title</div>
              <div className="text-sm font-medium">
                {draft.title || "—"}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-zinc-400">
                Description
              </div>
              <p className="whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-300">
                {draft.description || "—"}
              </p>
            </div>
            <div>
              <div className="text-[10px] uppercase text-zinc-400">Tags</div>
              <div className="flex flex-wrap gap-1">
                {draft.tags.length ? (
                  draft.tags.map((t) => (
                    <span
                      key={t}
                      className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                    >
                      {t}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-zinc-400">—</span>
                )}
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

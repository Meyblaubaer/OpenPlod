import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, AudioLines, Bluetooth, FileAudio, FileText, FolderHeart, Home, Loader2, MessageSquare, Mic, NotebookPen, Rocket, Search, Settings, Smartphone, Upload, Workflow, X } from "@/components/icons";
import { ONBOARDING_EVENT } from "@/lib/ai-settings";
import { api } from "@/lib/api";
import { apiUrl, authenticatedHeaders } from "@/lib/runtime";
import { knowledgeApi, recordingLink } from "@/lib/knowledge";
import { formatDuration } from "@/lib/utils";
import { t } from "@/i18n";
import "./knowledge.css";

type Result = { id: string; title: string; kind: string; to: string; detail?: string };
/** `keyword`: titles and words; `passages`: hybrid search returning cited passages (KB-04). */
type SearchMode = "keyword" | "passages";
type Action = { id: string; label: string; hint: string; icon: typeof Home; to?: string; event?: string; keywords: string };
/** Quick actions shown before and alongside search results; a function so labels follow the current language. */
const quickActions = (): Action[] => [
  { id: "home", label: t("Home"), hint: t("Go to"), icon: Home, to: "/", keywords: "dashboard start" },
  { id: "recordings", label: t("Recordings"), hint: t("Go to"), icon: FolderHeart, to: "/recordings", keywords: "library audio" },
  { id: "transcripts", label: t("Transcripts"), hint: t("Go to"), icon: FileText, to: "/transcripts", keywords: "text studio" },
  { id: "documents", label: t("Documents"), hint: t("Go to"), icon: NotebookPen, to: "/notes", keywords: "notes markdown obsidian" },
  { id: "chat", label: t("AI Chat"), hint: t("Go to"), icon: MessageSquare, to: "/ai", keywords: "ask question conversation" },
  { id: "import", label: t("Import audio files"), hint: t("Action"), icon: Upload, to: "/import", keywords: "upload mp3 m4a wav" },
  { id: "record", label: t("Record with the microphone"), hint: t("Action"), icon: Mic, to: "/record", keywords: "capture new recording" },
  { id: "plaud", label: t("Plaud device"), hint: t("Action"), icon: Bluetooth, to: "/devices", keywords: "bluetooth sync note pro" },
  { id: "android", label: t("Pair an Android phone"), hint: t("Action"), icon: Smartphone, to: "/android", keywords: "mobile qr" },
  { id: "profiles", label: t("Transcription profiles"), hint: t("Settings"), icon: AudioLines, to: "/settings#profiles", keywords: "prompt vocabulary model whisper voxtral" },
  { id: "settings", label: t("Settings"), hint: t("Go to"), icon: Settings, to: "/settings", keywords: "ai providers keys privacy" },
  { id: "developer", label: t("API and MCP"), hint: t("Go to"), icon: Workflow, to: "/developer", keywords: "developer token claude" },
  { id: "setup", label: t("Run the setup guide"), hint: t("Action"), icon: Rocket, event: ONBOARDING_EVENT, keywords: "onboarding welcome start" },
];
type Item = { kind: "action"; key: string; action: Action } | { kind: "result"; key: string; row: Result };
const matches = (action: Action, query: string) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${action.label} ${action.keywords}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
};
export function WorkspaceSearch() {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [rows, setRows] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [active, setActive] = useState(0),
    [mode, setMode] = useState<SearchMode>("keyword"),
    [note, setNote] = useState("");
  const navigate = useNavigate();
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (!open || query.trim().length < 2) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError("");
      setNote("");
      if (mode === "passages") {
        try {
          const result = await knowledgeApi.search(query.trim(), { mode: "hybrid", limit: 12, signal: abort.signal });
          if (abort.signal.aborted) return;
          setNote(result.embedding.kind === "lexical" ? t("Lexical index (built-in, offline)") : result.embedding.kind === "local" ? t("Local embeddings: {model}", { model: result.embedding.model }) : t("Cloud embeddings: {model}", { model: result.embedding.model }));
          setRows(result.passages.map((passage) => passage.sourceType === "transcript" && passage.recordingId
            ? {
                id: passage.id,
                title: passage.recordingTitle?.replace(/\.[^.]+$/, "") || t("Recording"),
                kind: passage.startTime === null ? t("Passage") : t("Passage {time}", { time: formatDuration(passage.startTime) }),
                to: recordingLink(passage.recordingId, passage.startTime, passage.versionId),
                detail: passage.text.slice(0, 180),
              }
            : { id: passage.id, title: passage.documentTitle || t("Document"), kind: t("Document passage"), to: `/notes?document=${passage.documentId}`, detail: passage.text.slice(0, 180) }));
        } catch (e) {
          if (!abort.signal.aborted) setError((e as Error).message);
        } finally {
          if (!abort.signal.aborted) setLoading(false);
        }
        return;
      }
      try {
        const headers = authenticatedHeaders();
        const [recordings, transcripts, documents] = await Promise.all([
          fetch(
            apiUrl(`/recordings?limit=20&search=${encodeURIComponent(query)}`),
            { headers, signal: abort.signal },
          ).then(async (r) => {
            if (!r.ok) throw new Error(t("Recording search unavailable."));
            return r.json();
          }),
          api.search(query, abort.signal),
          fetch(
            apiUrl(`/v1/documents?q=${encodeURIComponent(query)}&limit=20`),
            { headers, signal: abort.signal },
          ).then(async (r) => {
            if (!r.ok) throw new Error(t("Document search unavailable."));
            return r.json();
          }),
        ]);
        const results: Result[] = recordings.data.map(
          (r: { id: string; originalFilename: string }) => ({
            id: r.id,
            title: r.originalFilename,
            kind: t("Recording"),
            to: `/recording/${r.id}`,
          }),
        );
        for (const row of transcripts)
          if (!results.some((r) => r.id === row.recordingId))
            results.push({
              id: row.recordingId,
              title: row.recordingTitle,
              kind: t("Transcript"),
              to: `/recording/${row.recordingId}`,
            });
        for (const row of documents.data.documents)
          results.push({
            id: row.id,
            title: row.title,
            kind: t("Document"),
            to: `/notes?document=${row.id}`,
          });
        if (!abort.signal.aborted) setRows(results);
      } catch (e) {
        if (!abort.signal.aborted) setError((e as Error).message);
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, open, mode]);
  const term = query.trim();
  const allActions = quickActions();
  const actions = (term ? allActions.filter((action) => matches(action, term)).slice(0, 5) : allActions);
  const visible: Item[] = [
    ...actions.map((action) => ({ kind: "action" as const, key: `action-${action.id}`, action })),
    ...(term.length >= 2 ? rows.map((row) => ({ kind: "result" as const, key: `${row.kind}-${row.id}`, row })) : []),
  ];
  const choose = (item: Item) => {
    setOpen(false);
    if (item.kind === "result") navigate(item.row.to);
    else if (item.action.event) window.dispatchEvent(new Event(item.action.event));
    else if (item.action.to) navigate(item.action.to);
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        setActive(0);
        setLoading(false);
        setError("");
      }}
    >
      <Dialog.Trigger className="command-search">
        <Search />
        <span>{t("Search recordings, transcripts, documents...")}</span>
        <kbd>⌘ K</kbd>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="command-overlay" />
        <Dialog.Content className="command-dialog" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">{t("Search workspace")}</Dialog.Title>
          <div className="command-input">
            <Search />
            <input
              autoFocus
              aria-label={t("Search workspace")}
              placeholder={t("Search, or type a command…")}
              value={query}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  if (visible.length) setActive((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length);
                } else if (event.key === "Enter" && visible[active]) {
                  event.preventDefault();
                  choose(visible[active]);
                }
              }}
              onChange={(e) => {
                setActive(0);
                setQuery(e.target.value);
                setRows([]);
                setError("");
                setLoading(e.target.value.trim().length >= 2);
              }}
            />
            <div className="command-mode" role="radiogroup" aria-label={t("Search mode")}>
              {(["keyword", "passages"] as const).map((value) => (
                <button key={value} type="button" role="radio" aria-checked={mode === value} onClick={() => { setMode(value); setRows([]); setActive(0); setLoading(query.trim().length >= 2); }}>
                  {value === "keyword" ? t("Keyword") : t("Passages")}
                </button>
              ))}
            </div>
            <Dialog.Close aria-label={t("Close search")}>
              <X />
            </Dialog.Close>
          </div>
          <div className="command-results" role="listbox" aria-label={t("Commands and results")}>
            {visible.map((item, index) => {
              const Icon = item.kind === "action" ? item.action.icon : item.row.kind === t("Recording") ? FileAudio : FileText;
              const title = item.kind === "action" ? item.action.label : item.row.title;
              const kind = item.kind === "action" ? item.action.hint : item.row.kind;
              return (
                <button
                  key={item.key}
                  role="option"
                  aria-selected={index === active}
                  data-active={index === active || undefined}
                  onMouseMove={() => setActive(index)}
                  onClick={() => choose(item)}
                >
                  <Icon />
                  <span>
                    {title}
                    <small>{kind}</small>
                    {item.kind === "result" && item.row.detail && <small className="command-detail">{item.row.detail}</small>}
                  </span>
                  {item.kind === "action" && <ArrowRight className="command-go" />}
                </button>
              );
            })}
            {loading && <Loader2 className="animate-spin" />}
            {error && <p role="alert">{error}</p>}
            {mode === "passages" && note && !loading && <p className="command-note">{note}</p>}
            {query.trim().length >= 2 && !loading && !rows.length && !error && !visible.length && (
              <p>{t("No results found.")}</p>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

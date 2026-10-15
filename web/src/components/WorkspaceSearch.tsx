import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, AudioLines, Bluetooth, FileAudio, FileText, FolderHeart, Home, Loader2, MessageSquare, Mic, NotebookPen, Rocket, Search, Settings, Smartphone, Upload, Workflow, X } from "@/components/icons";
import { ONBOARDING_EVENT } from "@/lib/ai-settings";
import { api } from "@/lib/api";
import { apiUrl, authenticatedHeaders } from "@/lib/runtime";
import { knowledgeApi, recordingLink } from "@/lib/knowledge";
import { formatDuration } from "@/lib/utils";
import "./knowledge.css";

type Result = { id: string; title: string; kind: string; to: string; detail?: string };
/** `keyword`: titles and words; `passages`: hybrid search returning cited passages (KB-04). */
type SearchMode = "keyword" | "passages";
type Action = { id: string; label: string; hint: string; icon: typeof Home; to?: string; event?: string; keywords: string };
/** Quick actions shown before and alongside search results. */
const ACTIONS: Action[] = [
  { id: "home", label: "Home", hint: "Go to", icon: Home, to: "/", keywords: "dashboard start" },
  { id: "recordings", label: "Recordings", hint: "Go to", icon: FolderHeart, to: "/recordings", keywords: "library audio" },
  { id: "transcripts", label: "Transcripts", hint: "Go to", icon: FileText, to: "/transcripts", keywords: "text studio" },
  { id: "documents", label: "Documents", hint: "Go to", icon: NotebookPen, to: "/notes", keywords: "notes markdown obsidian" },
  { id: "chat", label: "AI Chat", hint: "Go to", icon: MessageSquare, to: "/ai", keywords: "ask question conversation" },
  { id: "import", label: "Import audio files", hint: "Action", icon: Upload, to: "/import", keywords: "upload mp3 m4a wav" },
  { id: "record", label: "Record with the microphone", hint: "Action", icon: Mic, to: "/record", keywords: "capture new recording" },
  { id: "plaud", label: "Plaud device", hint: "Action", icon: Bluetooth, to: "/devices", keywords: "bluetooth sync note pro" },
  { id: "android", label: "Pair an Android phone", hint: "Action", icon: Smartphone, to: "/android", keywords: "mobile qr" },
  { id: "profiles", label: "Transcription profiles", hint: "Settings", icon: AudioLines, to: "/settings#profiles", keywords: "prompt vocabulary model whisper voxtral" },
  { id: "settings", label: "Settings", hint: "Go to", icon: Settings, to: "/settings", keywords: "ai providers keys privacy" },
  { id: "developer", label: "API and MCP", hint: "Go to", icon: Workflow, to: "/developer", keywords: "developer token claude" },
  { id: "setup", label: "Run the setup guide", hint: "Action", icon: Rocket, event: ONBOARDING_EVENT, keywords: "onboarding welcome start" },
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
          setNote(result.embedding.kind === "lexical" ? "Lexical index (built-in, offline)" : `${result.embedding.kind === "local" ? "Local" : "Cloud"} embeddings: ${result.embedding.model}`);
          setRows(result.passages.map((passage) => passage.sourceType === "transcript" && passage.recordingId
            ? {
                id: passage.id,
                title: passage.recordingTitle?.replace(/\.[^.]+$/, "") || "Recording",
                kind: passage.startTime === null ? "Passage" : `Passage ${formatDuration(passage.startTime)}`,
                to: recordingLink(passage.recordingId, passage.startTime, passage.versionId),
                detail: passage.text.slice(0, 180),
              }
            : { id: passage.id, title: passage.documentTitle || "Document", kind: "Document passage", to: `/notes?document=${passage.documentId}`, detail: passage.text.slice(0, 180) }));
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
            if (!r.ok) throw new Error("Recording search unavailable.");
            return r.json();
          }),
          api.search(query, abort.signal),
          fetch(
            apiUrl(`/v1/documents?q=${encodeURIComponent(query)}&limit=20`),
            { headers, signal: abort.signal },
          ).then(async (r) => {
            if (!r.ok) throw new Error("Document search unavailable.");
            return r.json();
          }),
        ]);
        const results: Result[] = recordings.data.map(
          (r: { id: string; originalFilename: string }) => ({
            id: r.id,
            title: r.originalFilename,
            kind: "Recording",
            to: `/recording/${r.id}`,
          }),
        );
        for (const row of transcripts)
          if (!results.some((r) => r.id === row.recordingId))
            results.push({
              id: row.recordingId,
              title: row.recordingTitle,
              kind: "Transcript",
              to: `/recording/${row.recordingId}`,
            });
        for (const row of documents.data.documents)
          results.push({
            id: row.id,
            title: row.title,
            kind: "Document",
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
  const actions = (term ? ACTIONS.filter((action) => matches(action, term)).slice(0, 5) : ACTIONS);
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
        <span>Search recordings, transcripts, documents...</span>
        <kbd>⌘ K</kbd>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="command-overlay" />
        <Dialog.Content className="command-dialog" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">Search workspace</Dialog.Title>
          <div className="command-input">
            <Search />
            <input
              autoFocus
              aria-label="Search workspace"
              placeholder="Search, or type a command…"
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
            <div className="command-mode" role="radiogroup" aria-label="Search mode">
              {(["keyword", "passages"] as const).map((value) => (
                <button key={value} type="button" role="radio" aria-checked={mode === value} onClick={() => { setMode(value); setRows([]); setActive(0); setLoading(query.trim().length >= 2); }}>
                  {value === "keyword" ? "Keyword" : "Passages"}
                </button>
              ))}
            </div>
            <Dialog.Close aria-label="Close search">
              <X />
            </Dialog.Close>
          </div>
          <div className="command-results" role="listbox" aria-label="Commands and results">
            {visible.map((item, index) => {
              const Icon = item.kind === "action" ? item.action.icon : item.row.kind === "Recording" ? FileAudio : FileText;
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
              <p>No results found.</p>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

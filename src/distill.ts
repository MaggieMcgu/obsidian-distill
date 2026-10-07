// ── Distill: turn a passage you read into a note in your own words ──
//
// Moved here from Cairn (2026-10) so one plugin makes ideas:
// Distill (source → your idea) and Strike (idea × idea → new idea).
// Works on a selection in a markdown note (Readwise, PDF++ highlights,
// clippings) or directly inside Obsidian's PDF viewer.

import { App, Modal, Notice, Platform, TFile, setIcon } from "obsidian";

// ── Source metadata ─────────────────────────────────────────

export interface SourceMetadata {
  title: string;
  author: string;
  url: string;
}

/** Readwise-style `## Metadata` block, falling back to the note's properties. */
export function noteMetadata(app: App, file: TFile, content: string): SourceMetadata {
  const meta: SourceMetadata = { title: "", author: "", url: "" };

  const h1 = content.match(/^# (.+)$/m);
  if (h1) meta.title = h1[1].trim();

  const start = content.indexOf("## Metadata");
  if (start !== -1) {
    const end = content.indexOf("\n## ", start + 1);
    const block = end !== -1 ? content.slice(start, end) : content.slice(start);
    const title = block.match(/^- Full Title:\s*(.+)$/m);
    if (title) meta.title = title[1].trim();
    const author = block.match(/^- Author:\s*(.+)$/m);
    if (author) meta.author = author[1].trim().replace(/\[\[|\]\]/g, "");
    const url = block.match(/^- URL:\s*(.+)$/m);
    if (url) meta.url = url[1].trim();
  }

  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  if (fm) {
    const fmAuthor = fm.author ?? fm.Author;
    if (!meta.author && fmAuthor) meta.author = String(fmAuthor).replace(/\[\[|\]\]/g, "");
    if (!meta.title && fm.title) meta.title = String(fm.title);
    if (!meta.url && fm.url) meta.url = String(fm.url);
  }
  return meta;
}

// ── Matching a selection to a Readwise highlight ────────────

export interface HighlightMatch {
  cleanText: string;
  linkMarkdown: string;
}

/** Find the Readwise highlight bullet the selection came from, with its link. */
export function findMatchingHighlight(selection: string, content: string): HighlightMatch | null {
  const start = content.indexOf("## Highlights");
  if (start === -1) return null;
  const end = content.indexOf("\n## ", start + 1);
  const block = end !== -1 ? content.slice(start, end) : content.slice(start);

  const bullets: string[] = [];
  let current = "";
  for (const line of block.split("\n").slice(1)) {
    if (line.startsWith("- ")) {
      if (current) bullets.push(current);
      current = line.slice(2);
    } else if (current && line.startsWith("  ")) {
      current += " " + line.trim();
    } else if (line.trim() === "") {
      if (current) bullets.push(current);
      current = "";
    }
  }
  if (current) bullets.push(current);

  const wanted = selection.replace(/\s+/g, " ").trim();
  for (const bullet of bullets) {
    const flat = bullet.replace(/\s+/g, " ").trim();
    if (!flat.includes(wanted) && !wanted.includes(flat.replace(/\s*\(?\[.*$/, "").trim())) continue;

    const link = bullet.match(/\(\[(View Highlight|Location \d+)]\((https?:\/\/[^)]+)\)\)\s*$/);
    let cleanText = link && link.index !== undefined ? bullet.slice(0, link.index).trim() : bullet;
    cleanText = cleanText.replace(/==/g, "");
    return { cleanText, linkMarkdown: link ? `[${link[1]}](${link[2]})` : "" };
  }
  return null;
}

/** Strip blockquote markers and PDF++ "— p.N" attributions from a selection. */
export function cleanEditorSelection(raw: string): string {
  return raw
    .split("\n")
    .map((l) => l.replace(/^\s*>\s?/, ""))
    .filter((l) => !/^\s*—\s*\[\[.*\]\]\s*$/.test(l))
    .map((l) => l.replace(/^\s*(#+|[-*+]|\d+\.)\s+/, "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

// ── PDF selections ──────────────────────────────────────────

export interface PdfSelection {
  text: string;
  file: TFile;
  page: number;
  pageLabel: string;
}

/** Undo PDF line breaks: rejoin hyphenated words, turn breaks into spaces. */
export function cleanPdfText(raw: string): string {
  return raw
    .replace(/(\w)-\s*\n\s*(\w)/g, "$1$2")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Text currently selected inside an open PDF view, with its page.
 * Relies on Obsidian's PDF.js markup (`.page[data-page-number]`); if that
 * ever changes, this returns null rather than throwing.
 */
export function readPdfSelection(app: App): PdfSelection | null {
  try {
    const sel = window.getSelection();
    const raw = sel?.toString() ?? "";
    if (!sel || !raw.trim() || !sel.anchorNode) return null;
    const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode.parentElement;
    const pageEl = node?.closest(".page[data-page-number]") as HTMLElement | null;
    if (!pageEl) return null;

    let file: TFile | null = null;
    app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as { getViewType?: () => string; containerEl?: HTMLElement; file?: TFile };
      if (!file && view.getViewType?.() === "pdf" && view.containerEl?.contains(pageEl)) {
        file = view.file ?? null;
      }
    });
    if (!file) return null;
    return {
      text: cleanPdfText(raw),
      file,
      page: Number(pageEl.dataset.pageNumber) || 0,
      pageLabel: pageEl.dataset.pageLabel || "",
    };
  } catch {
    return null;
  }
}

/** The markdown note that links to this PDF (e.g. "Book- Title"), preferring one with an author. */
export function findCompanionNote(app: App, pdf: TFile): TFile | null {
  const NOTE_TYPES = ["claim", "concept", "quote", "anecdote"];
  const candidates: TFile[] = [];
  for (const [path, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
    if (!targets[pdf.path]) continue;
    const f = app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile) || f.extension !== "md") continue;
    // Thoughts distilled from this PDF also link to it; they're not its notes file.
    const type = String(app.metadataCache.getFileCache(f)?.frontmatter?.type ?? "").toLowerCase();
    if (NOTE_TYPES.includes(type)) continue;
    candidates.push(f);
  }
  const score = (f: TFile) => {
    const cache = app.metadataCache.getFileCache(f);
    const fm = cache?.frontmatter;
    const headings = (cache?.headings ?? []).map((h) => h.heading);
    return (fm?.author || fm?.Author ? 2 : 0) + (headings.includes("Metadata") || headings.includes("Highlights") ? 1 : 0);
  };
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0] ?? null;
}

// ── The Distill window ──────────────────────────────────────

export type NoteType = "claim" | "concept" | "quote" | "anecdote";
export type SaveAs = "thought" | "source";
export type Relation = "Continues" | "Contradicts" | "Refines";

export interface DistillProject {
  id: string;
  name: string;
}

export interface DistillInput {
  quote: string;
  sourceLabel: string; // "Title by Author"
  canSaveToSource: boolean;
  defaultFolder: string;
  defaultSaveAs: SaveAs;
  strikeDefault: boolean;
  projects: DistillProject[];
  prefillIdea?: string;
}

export interface DistillResult {
  idea: string;
  title: string;
  folder: string;
  type: NoteType;
  saveAs: SaveAs;
  connectTo: TFile | null;
  relation: Relation;
  relationLine: string;
  projectIds: string[];
  strike: boolean;
}

export class DistillModal extends Modal {
  constructor(
    app: App,
    private input: DistillInput,
    private pickNote: (onChoose: (file: TFile) => void) => void,
    private onSubmit: (result: DistillResult) => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass("fd-modal");
    contentEl.addClass("fd-content");

    // The passage stays pinned at the top in its own scroll box, so the
    // fields below (and a phone keyboard) can never push it out of view.
    const head = contentEl.createDiv({ cls: "fd-head" });
    head.createDiv({ cls: "fd-source", text: this.input.sourceLabel });
    head.createDiv({ cls: "fd-quote", text: this.input.quote });

    const body = contentEl.createDiv({ cls: "fd-body" });

    const idea = body.createEl("textarea", {
      cls: "fd-idea",
      attr: { rows: Platform.isPhone ? "3" : "4", placeholder: "What does this mean to you? In your words." },
    });
    if (this.input.prefillIdea) idea.value = this.input.prefillIdea;
    idea.addEventListener("input", () => {
      idea.style.height = "auto";
      idea.style.height = Math.min(idea.scrollHeight, window.innerHeight * 0.3) + "px";
    });

    const title = body.createEl("input", {
      type: "text",
      cls: "fd-title",
      attr: { placeholder: "Title: your idea as a full sentence" },
    });
    let titleEdited = false;
    title.addEventListener("input", () => (titleEdited = true));
    idea.addEventListener("input", () => {
      if (titleEdited) return;
      const text = idea.value.trim().split("\n")[0];
      const cut = text.length > 80 ? text.slice(0, 80).replace(/\s+\S*$/, "") : text;
      title.value = cut.replace(/[\s,;:–—-]+$/, "");
    });
    if (this.input.prefillIdea) idea.dispatchEvent(new Event("input"));

    // Row: type + save-as
    const row = body.createDiv({ cls: "fd-row" });
    const type = row.createEl("select", {
      cls: "dropdown fd-type",
      attr: { "aria-label": "Note type: claim = your idea, concept = a term, quote = exact words, anecdote = a story" },
    });
    for (const [value, label] of [
      ["claim", "Claim"],
      ["concept", "Concept"],
      ["quote", "Quote"],
      ["anecdote", "Anecdote"],
    ]) {
      type.createEl("option", { text: label, value });
    }

    const saveAs = row.createEl("select", { cls: "dropdown fd-saveas" });
    saveAs.createEl("option", { text: "As a Thought", value: "thought" });
    if (this.input.canSaveToSource) {
      saveAs.createEl("option", { text: "As a note on the source", value: "source" });
      saveAs.value = this.input.defaultSaveAs;
    }

    // Connects to… (deliberate link, for Thoughts)
    const connect = body.createDiv({ cls: "fd-connect" });
    let connectTo: TFile | null = null;
    const connectBtn = connect.createEl("button", { cls: "fd-connect-btn" });
    const setConnectLabel = () => {
      connectBtn.empty();
      setIcon(connectBtn.createSpan({ cls: "fd-icon" }), "link");
      connectBtn.createSpan({ text: connectTo ? connectTo.basename : "Connects to…" });
    };
    setConnectLabel();
    const relRow = connect.createDiv({ cls: "fd-rel-row" });
    const relation = relRow.createEl("select", { cls: "dropdown fd-relation" });
    for (const r of ["Continues", "Contradicts", "Refines"]) relation.createEl("option", { text: r.toLowerCase(), value: r });
    const relLine = relRow.createEl("input", {
      type: "text",
      cls: "fd-rel-line",
      attr: { placeholder: "how? (one line)" },
    });
    relRow.toggle(false);
    connectBtn.addEventListener("click", (e) => {
      e.preventDefault();
      this.pickNote((file) => {
        connectTo = file;
        setConnectLabel();
        relRow.toggle(true);
        relLine.focus();
      });
    });

    const syncSaveAs = () => connect.toggle(saveAs.value === "thought");
    saveAs.addEventListener("change", syncSaveAs);
    syncSaveAs();

    // More: folder, essays, strike. Collapsed on phones to save height.
    const more = body.createEl("details", { cls: "fd-more" });
    if (!Platform.isPhone) more.open = true;
    more.createEl("summary", { text: "More" });

    const folder = more.createEl("select", { cls: "dropdown fd-folder" });
    folder.createEl("option", { text: "Vault root", value: "" });
    const folders = this.app.vault
      .getAllFolders()
      .map((f) => f.path)
      .filter((p) => p !== "/")
      .sort();
    for (const path of folders) {
      const opt = folder.createEl("option", { text: path, value: path });
      if (path === this.input.defaultFolder) opt.selected = true;
    }

    const projectBoxes = new Map<string, HTMLInputElement>();
    if (this.input.projects.length) {
      more.createDiv({ cls: "fd-label", text: "Add to essays:" });
      for (const p of this.input.projects) {
        const r = more.createEl("label", { cls: "fd-check" });
        const cb = r.createEl("input", { type: "checkbox" });
        r.appendText(" " + p.name);
        projectBoxes.set(p.id, cb);
      }
    }

    const strikeLabel = more.createEl("label", { cls: "fd-check" });
    const strike = strikeLabel.createEl("input", { type: "checkbox" });
    strike.checked = this.input.strikeDefault;
    strikeLabel.appendText(" Then strike it with a lonely note");

    // Buttons
    const buttons = contentEl.createDiv({ cls: "fd-buttons" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const save = buttons.createEl("button", { cls: "mod-cta", text: "Save" });

    const submit = () => {
      const isThought = saveAs.value === "thought";
      if (isThought && !title.value.trim()) {
        new Notice("Give the note a title");
        return;
      }
      if (!idea.value.trim() && !isThought) {
        new Notice("Write a line about it first");
        return;
      }
      const projectIds = [...projectBoxes].filter(([, cb]) => cb.checked).map(([id]) => id);
      this.close();
      this.onSubmit({
        idea: idea.value,
        title: title.value.trim(),
        folder: folder.value,
        type: type.value as NoteType,
        saveAs: saveAs.value as SaveAs,
        connectTo: isThought ? connectTo : null,
        relation: relation.value as Relation,
        relationLine: relLine.value.trim(),
        projectIds,
        strike: isThought && strike.checked,
      });
    };
    save.addEventListener("click", submit);
    title.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });

    window.setTimeout(() => idea.focus(), 50);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ── Writing helpers ─────────────────────────────────────────

export const INVERSE: Record<Relation, string> = {
  Continues: "Continued by",
  Contradicts: "Contradicted by",
  Refines: "Refined by",
};

/** Append a list line under `## heading` (created at the end if missing). */
export function appendUnderHeading(content: string, heading: string, lines: string[]): string {
  const marker = `## ${heading}`;
  const block = lines.join("\n");
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`^## ${escaped}[ \\t]*$`, "m").exec(content);
  if (!found) return content.trimEnd() + `\n\n${marker}\n\n${block}\n`;
  const idx = found.index;
  const next = content.indexOf("\n## ", idx + marker.length);
  const insertAt = next === -1 ? content.length : next;
  const before = content.slice(0, insertAt).trimEnd();
  const after = next === -1 ? "" : "\n" + content.slice(next);
  return `${before}\n${block}\n${after}`;
}

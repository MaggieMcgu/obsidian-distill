import {
  App,
  debounce,
  Editor,
  FuzzySuggestModal,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
} from "obsidian";
import {
  DistillModal,
  DistillResult,
  INVERSE,
  PdfSelection,
  SaveAs,
  appendUnderHeading,
  cleanEditorSelection,
  findCompanionNote,
  findMatchingHighlight,
  noteMetadata,
  readPdfSelection,
} from "./distill";

// ── Data Model ──────────────────────────────────────────────

interface SparkEntry {
  noteA: string;
  noteB: string;
  result: "sparked" | "skipped";
  sparkNote?: string;
  timestamp: number;
}

interface DistillSettings {
  sourceFolder: string;
  outputFolder: string;
  includeOrphans: boolean;
  crossFolder: boolean;
  tagSparks: boolean;
  showEssayProjects: boolean;
  sparkHistory: SparkEntry[];
  // Distill
  distillFolder: string;
  distillSaveAs: SaveAs;
  distillBacklinkToSource: boolean;
  strikeAfterDistill: boolean;
  distillMigrated: boolean;
}

// Rotating provocations — the prompt above the writing area changes with
// each new collision, to nudge a different kind of spark from the same pair.
const PROMPTS: string[] = [
  "What does this collision make you think?",
  "What would one say to the other?",
  "What do they secretly share?",
  "What breaks if both are true?",
  "What's the third thing hiding between them?",
  "What tension sits between these two?",
];

// Cairn project shape (read from Cairn's data.json)
interface CairnProject {
  id: string;
  name: string;
  filePath: string;
  sourceFolder: string;
}

const DEFAULT_SETTINGS: DistillSettings = {
  sourceFolder: "",
  outputFolder: "",
  includeOrphans: true,
  crossFolder: false,
  tagSparks: false,
  showEssayProjects: true,
  distillFolder: "",
  distillSaveAs: "thought",
  distillBacklinkToSource: true,
  strikeAfterDistill: true,
  distillMigrated: false,
  sparkHistory: [],
};

// ── Helpers ─────────────────────────────────────────────────

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "").trim();
}

function getRandomNote(
  exclude: string[],
  app: App,
  settings: DistillSettings,
  differentFolderFrom?: string
): TFile | null {
  let pool = app.vault.getMarkdownFiles();

  // Filter to source folder if set
  if (settings.sourceFolder) {
    const prefix = settings.sourceFolder + "/";
    pool = pool.filter((f) => f.path.startsWith(prefix));
  }

  // Exclude currently shown notes + recently shown (last 10 from history)
  const recentPaths = new Set([
    ...exclude,
    ...settings.sparkHistory
      .slice(-10)
      .flatMap((e) => [e.noteA, e.noteB]),
  ]);
  pool = pool.filter((f) => !recentPaths.has(f.path));

  // Cross-folder collisions: force this card out of the other card's folder.
  // Falls back to the unconstrained pool if that would leave nothing.
  if (settings.crossFolder && differentFolderFrom !== undefined) {
    const crossPool = pool.filter((f) => f.parent?.path !== differentFolderFrom);
    if (crossPool.length > 0) pool = crossPool;
  }

  if (pool.length === 0) return null;

  // If includeOrphans, weight toward notes with fewer backlinks
  if (settings.includeOrphans) {
    // Connections = links out + links in, so a note nobody points to
    // still counts as lonely even if it links out.
    const resolved = app.metadataCache.resolvedLinks;
    const degree = new Map<string, number>();
    for (const [from, targets] of Object.entries(resolved)) {
      const outs = Object.keys(targets);
      degree.set(from, (degree.get(from) || 0) + outs.length);
      for (const to of outs) degree.set(to, (degree.get(to) || 0) + 1);
    }
    pool.sort((a, b) => (degree.get(a.path) || 0) - (degree.get(b.path) || 0));
    const halfPool = pool.slice(0, Math.max(1, Math.ceil(pool.length * 0.5)));
    return halfPool[Math.floor(Math.random() * halfPool.length)];
  }

  return pool[Math.floor(Math.random() * pool.length)];
}

/** Essay projects from Throughline (formerly Cairn), if it's installed. */
async function getCairnProjects(app: App): Promise<CairnProject[]> {
  const dataPath = `${app.vault.configDir}/plugins/note-assembler/data.json`;
  try {
    if (!(await app.vault.adapter.exists(dataPath))) return [];
    const data = JSON.parse(await app.vault.adapter.read(dataPath)) as {
      projects?: (CairnProject & { archived?: boolean })[];
    };
    // Only live essays: not archived, and the essay file still exists.
    return (data.projects ?? []).filter(
      (p) => !p.archived && app.vault.getAbstractFileByPath(p.filePath) instanceof TFile
    );
  } catch {
    return [];
  }
}

// ── Note Picker Modal ───────────────────────────────────────

class NotePickerModal extends FuzzySuggestModal<TFile> {
  sourceFolder: string;
  onChooseFile: (file: TFile) => void;

  constructor(app: App, sourceFolder: string, onChoose: (file: TFile) => void) {
    super(app);
    this.sourceFolder = sourceFolder;
    this.onChooseFile = onChoose;
    this.setPlaceholder("Pick a note…");
  }

  getItems(): TFile[] {
    let files = this.app.vault.getMarkdownFiles();
    if (this.sourceFolder) {
      const prefix = this.sourceFolder + "/";
      files = files.filter((f) => f.path.startsWith(prefix));
    }
    return files.sort((a, b) => a.basename.localeCompare(b.basename));
  }

  getItemText(item: TFile): string {
    return item.basename;
  }

  onChooseItem(item: TFile): void {
    this.onChooseFile(item);
  }
}

// ── Spark Modal ─────────────────────────────────────────────

class SparkModal extends Modal {
  noteA: TFile;
  noteB: TFile;
  contentA: string;
  contentB: string;
  settings: DistillSettings;
  cairnProjects: CairnProject[];
  onSpark: (
    idea: string,
    title: string,
    folder: string,
    fileA: TFile,
    fileB: TFile,
    selectedProjectIds: string[]
  ) => Promise<void>;
  onSkip: (fileA: TFile, fileB: TFile) => void;
  onShuffle: (exclude: string[], differentFolderFrom?: string) => TFile | null;
  onPick: (onChoose: (file: TFile) => void) => void;
  private seenPaths: Set<string> = new Set();
  onSettingsChange: () => void;

  // DOM refs for in-place updates
  private panelTitleA!: HTMLElement;
  private panelContentA!: HTMLElement;
  private panelTitleB!: HTMLElement;
  private panelContentB!: HTMLElement;
  private panelFolderA!: HTMLElement;
  private panelFolderB!: HTMLElement;
  private promptEl!: HTMLElement;
  private lastPromptIdx = -1;

  constructor(
    app: App,
    noteA: TFile,
    noteB: TFile,
    contentA: string,
    contentB: string,
    settings: DistillSettings,
    cairnProjects: CairnProject[],
    onSpark: (
      idea: string,
      title: string,
      folder: string,
      fileA: TFile,
      fileB: TFile,
      selectedProjectIds: string[]
    ) => Promise<void>,
    onSkip: (fileA: TFile, fileB: TFile) => void,
    onShuffle: (exclude: string[]) => TFile | null,
    onPick: (onChoose: (file: TFile) => void) => void,
    onSettingsChange: () => void
  ) {
    super(app);
    this.noteA = noteA;
    this.noteB = noteB;
    this.contentA = contentA;
    this.contentB = contentB;
    this.settings = settings;
    this.cairnProjects = cairnProjects;
    this.onSpark = onSpark;
    this.onSkip = onSkip;
    this.onShuffle = onShuffle;
    this.onPick = onPick;
    this.onSettingsChange = onSettingsChange;
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    contentEl.addClass("fk-spark-modal");
    modalEl.addClass("fk-spark-modal-container");

    // Header
    const header = contentEl.createDiv({ cls: "fk-header" });
    header.createEl("h3", { text: "Strike" });
    header.createSpan({ cls: "fk-header-tagline", text: "Two notes, one new idea" });

    // Folder config row (compact, single line)
    const allFolders: string[] = [];
    this.app.vault.getAllLoadedFiles().forEach((f) => {
      if (f instanceof TFolder && f.path !== "/") {
        allFolders.push(f.path);
      }
    });
    allFolders.sort();

    const configRow = contentEl.createDiv({ cls: "fk-config-row" });

    const sourceGroup = configRow.createDiv({ cls: "fk-config-group" });
    sourceGroup.createSpan({ cls: "fk-config-label", text: "From" });
    const sourceSelect = sourceGroup.createEl("select", { cls: "fk-config-select" });
    sourceSelect.createEl("option", { text: "All folders", value: "" });
    for (const folder of allFolders) {
      const opt = sourceSelect.createEl("option", { text: folder, value: folder });
      if (folder === this.settings.sourceFolder) opt.selected = true;
    }
    sourceSelect.addEventListener("change", () => {
      this.settings.sourceFolder = sourceSelect.value;
      this.onSettingsChange();
      this.shuffleBoth();
    });

    const outputGroup = configRow.createDiv({ cls: "fk-config-group" });
    outputGroup.createSpan({ cls: "fk-config-label", text: "To" });
    const outputSelect = outputGroup.createEl("select", { cls: "fk-config-select" });
    outputSelect.createEl("option", { text: "Vault root", value: "" });
    for (const folder of allFolders) {
      const opt = outputSelect.createEl("option", { text: folder, value: folder });
      if (folder === this.settings.outputFolder) opt.selected = true;
    }
    outputSelect.addEventListener("change", () => {
      this.settings.outputFolder = outputSelect.value;
      this.onSettingsChange();
    });

    // Two-column layout
    const columns = contentEl.createDiv({ cls: "fk-columns" });
    const panelA = this.buildPanel(columns, "A");
    const panelB = this.buildPanel(columns, "B");

    this.panelTitleA = panelA.titleEl;
    this.panelContentA = panelA.contentEl;
    this.panelFolderA = panelA.folderEl;
    this.panelTitleB = panelB.titleEl;
    this.panelContentB = panelB.contentEl;
    this.panelFolderB = panelB.folderEl;

    this.seenPaths.add(this.noteA.path);
    this.seenPaths.add(this.noteB.path);
    this.renderPanel("A");
    this.renderPanel("B");

    // Writing area
    const writing = contentEl.createDiv({ cls: "fk-writing-area" });
    this.promptEl = writing.createEl("label", {
      cls: "fk-writing-prompt",
      text: PROMPTS[0],
    });
    this.rotatePrompt();

    const textarea = writing.createEl("textarea", {
      cls: "fk-idea-textarea",
      placeholder: "The spark goes here…",
    });

    // Title input with auto-suggest
    const titleRow = writing.createDiv({ cls: "fk-title-row" });
    titleRow.createSpan({ cls: "fk-title-label", text: "Title:" });
    const titleInput = titleRow.createEl("input", {
      type: "text",
      cls: "fk-title-input",
      placeholder: "Auto-suggested from your idea",
    });

    let titleManuallyEdited = false;
    titleInput.addEventListener("input", () => {
      titleManuallyEdited = true;
    });

    const updateTitle = debounce(
      () => {
        if (titleManuallyEdited) return;
        const ideaText = textarea.value.trim();
        if (ideaText) {
          titleInput.value = ideaText.split("\n")[0];
        }
      },
      500,
      false
    );

    textarea.addEventListener("input", () => {
      updateTitle();
    });

    // Cairn project checkboxes (if Cairn is installed with projects)
    const projectCheckboxes: Map<string, HTMLInputElement> = new Map();
    if (this.cairnProjects.length > 0) {
      const projectSection = contentEl.createDiv({ cls: "fk-project-section" });
      projectSection.createEl("label", { cls: "fk-project-label", text: "Add to essays:" });
      for (const project of this.cairnProjects) {
        const checkRow = projectSection.createDiv({ cls: "fk-check-row" });
        const cb = checkRow.createEl("input", { type: "checkbox" });
        cb.id = `fk-project-${project.id}`;
        const label = checkRow.createEl("label", { text: project.name });
        label.setAttr("for", cb.id);
        projectCheckboxes.set(project.id, cb);
      }
    }

    // Button row
    const btnRow = contentEl.createDiv({ cls: "fk-btn-row" });

    const pickBtn = btnRow.createEl("button", { text: "Pick specific card" });
    pickBtn.addEventListener("click", () => {
      this.onPick((file: TFile) => {
        this.chooseSlotAndReplace(file);
      });
    });

    const skipBtn = btnRow.createEl("button", { text: "New cards" });
    skipBtn.addEventListener("click", () => {
      this.onSkip(this.noteA, this.noteB);
      this.shuffleBoth(textarea, titleInput);
      titleManuallyEdited = false;
    });

    const saveBtn = btnRow.createEl("button", {
      cls: "mod-cta",
      text: "Save spark",
    });

    const submit = async () => {
      const idea = textarea.value.trim();
      if (!idea) {
        new Notice("Write something first — that's the spark!");
        return;
      }
      const title = titleInput.value.trim();
      if (!title) {
        new Notice("Note title cannot be empty");
        return;
      }
      const folder = outputSelect.value;
      const selectedIds: string[] = [];
      projectCheckboxes.forEach((cb, id) => {
        if (cb.checked) selectedIds.push(id);
      });
      await this.onSpark(idea, title, folder, this.noteA, this.noteB, selectedIds);
      textarea.value = "";
      titleInput.value = "";
      titleManuallyEdited = false;
      // Uncheck all project boxes for next spark
      projectCheckboxes.forEach((cb) => { cb.checked = false; });
    };

    saveBtn.addEventListener("click", () => void submit());

    textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submit();
      }
    });

    // Focus textarea
    window.setTimeout(() => textarea.focus(), 50);
  }

  private buildPanel(
    parent: HTMLElement,
    side: "A" | "B"
  ): { titleEl: HTMLElement; contentEl: HTMLElement; folderEl: HTMLElement } {
    const panel = parent.createDiv({ cls: "fk-panel" });
    panel.addClass(side === "A" ? "fk-panel-a" : "fk-panel-b");

    const titleEl = panel.createDiv({ cls: "fk-panel-title" });
    titleEl.addEventListener("click", () => {
      const file = side === "A" ? this.noteA : this.noteB;
      void this.app.workspace.openLinkText(file.path, "", true);
    });

    const folderEl = panel.createDiv({ cls: "fk-panel-folder" });

    const contentEl = panel.createDiv({ cls: "fk-panel-content" });

    const actions = panel.createDiv({ cls: "fk-panel-actions" });

    const shuffleBtn = actions.createEl("button", {
      cls: "fk-action-btn",
      text: "Shuffle",
    });
    shuffleBtn.addEventListener("click", () => {
      this.shuffleOne(side);
    });

    return { titleEl, contentEl, folderEl };
  }

  // Show a fresh provocation, avoiding an immediate repeat.
  private rotatePrompt() {
    if (!this.promptEl) return;
    let idx = Math.floor(Math.random() * PROMPTS.length);
    if (PROMPTS.length > 1 && idx === this.lastPromptIdx) {
      idx = (idx + 1) % PROMPTS.length;
    }
    this.lastPromptIdx = idx;
    this.promptEl.setText(PROMPTS[idx]);
  }

  private renderPanel(side: "A" | "B") {
    const titleEl = side === "A" ? this.panelTitleA : this.panelTitleB;
    const contentEl = side === "A" ? this.panelContentA : this.panelContentB;
    const folderEl = side === "A" ? this.panelFolderA : this.panelFolderB;
    const note = side === "A" ? this.noteA : this.noteB;
    const content = side === "A" ? this.contentA : this.contentB;

    titleEl.empty();
    titleEl.setText(note.basename);

    const folder = note.parent?.path;
    folderEl.setText(!folder || folder === "/" ? "vault root" : folder);

    contentEl.empty();
    // Show the idea, not its properties block.
    contentEl.setText(content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim());
  }

  private chooseSlotAndReplace(file: TFile) {
    const modal = new Modal(this.app);
    modal.titleEl.setText("Place as which card?");
    const row = modal.contentEl.createDiv({ cls: "fk-slot-choice" });
    const place = (side: "A" | "B") => {
      void this.replaceNote(side, file);
      modal.close();
    };
    const btnA = row.createEl("button", {
      cls: "mod-cta",
      text: `Card A  (${this.noteA.basename})`,
    });
    btnA.addEventListener("click", () => place("A"));
    const btnB = row.createEl("button", {
      cls: "mod-cta",
      text: `Card B  (${this.noteB.basename})`,
    });
    btnB.addEventListener("click", () => place("B"));
    modal.open();
  }

  private async replaceNote(side: "A" | "B", file: TFile) {
    const content = await this.app.vault.read(file);
    if (side === "A") {
      this.noteA = file;
      this.contentA = content;
    } else {
      this.noteB = file;
      this.contentB = content;
    }
    this.renderPanel(side);
  }

  private shuffleOne(side: "A" | "B") {
    // Keep the new card out of the *other* card's folder when cross-folder is on.
    const otherFolder = (side === "A" ? this.noteB : this.noteA).parent?.path;
    const exclude = [...this.seenPaths];
    const newNote = this.onShuffle(exclude, otherFolder);
    if (!newNote) {
      // Reset seen paths (keep only current pair) and try again
      this.seenPaths.clear();
      this.seenPaths.add(this.noteA.path);
      this.seenPaths.add(this.noteB.path);
      const retry = this.onShuffle([...this.seenPaths], otherFolder);
      if (!retry) {
        new Notice("No more notes to shuffle — try broadening your source folder.");
        return;
      }
      this.seenPaths.add(retry.path);
      void this.app.vault.read(retry).then((content) => {
        if (side === "A") { this.noteA = retry; this.contentA = content; }
        else { this.noteB = retry; this.contentB = content; }
        this.renderPanel(side);
        this.rotatePrompt();
      });
      return;
    }
    this.seenPaths.add(newNote.path);
    void this.app.vault.read(newNote).then((content) => {
      if (side === "A") {
        this.noteA = newNote;
        this.contentA = content;
      } else {
        this.noteB = newNote;
        this.contentB = content;
      }
      this.renderPanel(side);
      this.rotatePrompt();
    });
  }

  private shuffleBoth(textarea?: HTMLTextAreaElement, titleInput?: HTMLInputElement) {
    const excludeA: string[] = [];
    const newA = this.onShuffle(excludeA);
    if (!newA) return;
    const newB = this.onShuffle([newA.path], newA.parent?.path);
    if (!newB) return;

    void Promise.all([
      this.app.vault.read(newA),
      this.app.vault.read(newB),
    ]).then(([cA, cB]) => {
      this.noteA = newA;
      this.noteB = newB;
      this.contentA = cA;
      this.contentB = cB;
      this.renderPanel("A");
      this.renderPanel("B");
      this.rotatePrompt();
      if (textarea) textarea.value = "";
      if (titleInput) titleInput.value = "";
      if (textarea) window.setTimeout(() => textarea.focus(), 50);
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ── Plugin ──────────────────────────────────────────────────

export default class DistillPlugin extends Plugin {
  settings!: DistillSettings;
  activeModal?: SparkModal;

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("flame", "Strike two notes together", () => {
      void this.openSpark();
    });

    this.addCommand({
      id: "open-spark",
      name: "Strike two notes",
      callback: () => this.openSpark(),
    });

    this.addSettingTab(new DistillSettingTab(this.app, this));

    // ── Distill ──
    this.addRibbonIcon("sparkles", "Distill selection to a note", () => {
      if (!this.distillFromAnywhere()) new Notice("Select a passage first, then distill it");
    });

    this.addCommand({
      id: "selection-to-note",
      name: "Turn selection into a note",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const hasEditorSel = !!view?.editor.getSelection().trim();
        if (!hasEditorSel && !this.currentPdfSelection()) return false;
        if (!checking) this.distillFromAnywhere();
        return true;
      },
    });

    this.addCommand({
      id: "promote-to-thought",
      name: "Promote source note to its own note",
      editorCheckCallback: (checking, editor, view) => {
        const found = this.sourceNoteAtCursor(editor);
        if (!found || !view.file) return false;
        if (!checking) void this.promoteToThought(editor, view.file, found);
        return true;
      },
    });

    // Remember the last text selected inside a PDF, so Distill still works
    // after a click (ribbon / hotkey) moves focus away from the PDF.
    this.registerDomEvent(document, "selectionchange", () => {
      const pdf = readPdfSelection(this.app);
      if (pdf) this.lastPdfSelection = { ...pdf, at: Date.now() };
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, view) => {
        if (!(view instanceof MarkdownView) || !view.file) return;
        const file = view.file;
        if (editor.getSelection().trim()) {
          menu.addItem((item) =>
            item
              .setTitle("Distill to a note")
              .setIcon("sparkles")
              .onClick(() => void this.distillFromEditor(editor, file))
          );
        }
        const found = this.sourceNoteAtCursor(editor);
        if (found) {
          menu.addItem((item) =>
            item
              .setTitle("Promote to its own note")
              .setIcon("arrow-up-right")
              .onClick(() => void this.promoteToThought(editor, file, found))
          );
        }
      })
    );

    if (!this.settings.distillMigrated) await this.migrateDistillSettings();
  }

  // ── Distill ───────────────────────────────────────────────

  lastPdfSelection: (PdfSelection & { at: number }) | null = null;

  /** Live PDF selection, or one made in the last two minutes. */
  currentPdfSelection(): PdfSelection | null {
    const live = readPdfSelection(this.app);
    if (live) return live;
    const last = this.lastPdfSelection;
    return last && Date.now() - last.at < 2 * 60 * 1000 ? last : null;
  }

  /** Distill whatever is selected: the active editor first, then a PDF. */
  distillFromAnywhere(): boolean {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file && view.editor.getSelection().trim()) {
      void this.distillFromEditor(view.editor, view.file);
      return true;
    }
    const pdf = this.currentPdfSelection();
    if (pdf) {
      void this.openDistill({ quote: pdf.text, source: pdf.file, pdf });
      return true;
    }
    return false;
  }

  async distillFromEditor(editor: Editor, file: TFile) {
    const quote = cleanEditorSelection(editor.getSelection());
    if (quote) await this.openDistill({ quote, source: file });
  }

  /**
   * Open the Distill window for a passage. `source` is the note or PDF it
   * came from; for a PDF, its companion note (the note that links to it)
   * supplies the author and receives source notes and backlinks.
   */
  async openDistill(opts: {
    quote: string;
    source: TFile;
    pdf?: PdfSelection;
    prefillIdea?: string;
    onSaved?: (file: TFile) => void;
    skipSourceBacklink?: boolean;
  }) {
    const { source, pdf } = opts;
    const isPdf = source.extension === "pdf";
    const sourceNote = isPdf ? findCompanionNote(this.app, source) : source;
    const content = sourceNote ? await this.app.vault.read(sourceNote) : "";
    const meta = sourceNote
      ? noteMetadata(this.app, sourceNote, content)
      : { title: "", author: "", url: "" };
    if (!meta.title) meta.title = (sourceNote ?? source).basename;

    let quote = opts.quote;
    let refLink = "";
    if (isPdf) {
      const label = pdf?.pageLabel || (pdf?.page ? String(pdf.page) : "");
      refLink = pdf?.page ? `[[${source.path}#page=${pdf.page}|p.${label}]]` : `[[${source.path}]]`;
    } else {
      const match = findMatchingHighlight(quote, content);
      if (match) {
        quote = match.cleanText;
        refLink = match.linkMarkdown;
      }
    }

    const projects = this.settings.showEssayProjects ? await getCairnProjects(this.app) : [];

    new DistillModal(
      this.app,
      {
        quote,
        sourceLabel: meta.author ? `${meta.title} by ${meta.author}` : meta.title,
        canSaveToSource: !!sourceNote || isPdf,
        defaultFolder: this.settings.distillFolder || this.settings.outputFolder,
        defaultSaveAs: this.settings.distillSaveAs,
        strikeDefault: this.settings.strikeAfterDistill,
        projects: projects.map((p) => ({ id: p.id, name: p.name })),
        prefillIdea: opts.prefillIdea,
      },
      (onChoose) => new NotePickerModal(this.app, this.settings.distillFolder || this.settings.sourceFolder, onChoose).open(),
      (result) => void (async () => {
        this.lastPdfSelection = null; // a used selection must not come back on the next click
        if (result.saveAs === "source") {
          await this.saveSourceNote(result, quote, refLink, source, sourceNote);
        } else {
          const file = await this.saveThought(
            result, quote, refLink, meta.author, source,
            opts.skipSourceBacklink ? null : sourceNote, projects, sourceNote
          );
          if (file) opts.onSaved?.(file);
        }
      })()
    ).open();
  }

  async saveThought(
    r: DistillResult,
    quote: string,
    refLink: string,
    author: string,
    source: TFile,
    backlinkTo: TFile | null,
    projects: CairnProject[],
    sourceNote: TFile | null = backlinkTo
  ): Promise<TFile | null> {
    const name = sanitizeFilename(r.title);
    if (!name) {
      new Notice("Note title cannot be empty");
      return null;
    }
    const path = r.folder ? `${r.folder}/${name}.md` : `${name}.md`;
    if (this.app.vault.getAbstractFileByPath(path)) {
      new Notice(`"${path}" already exists`);
      return null;
    }

    const lines = ["---", `type: ${r.type}`];
    if (author && (r.type === "quote" || r.type === "concept")) {
      lines.push(`author: "${author.replace(/"/g, "'")}"`);
    }
    lines.push("---", "");
    if (r.idea.trim()) lines.push(r.idea.trim(), "");
    if (r.connectTo) {
      const how = r.relationLine ? `: ${r.relationLine}` : "";
      lines.push("## Links", "", `- ${r.relation} [[${r.connectTo.basename}]]${how}`, "");
    }
    lines.push("## Reference", "", `> ${quote}`, "");
    lines.push(sourceNote ? `- Source: [[${sourceNote.basename}]]` : `- Source: [[${source.path}]]`);
    if (author) lines.push(`- Author: ${author}`);
    if (refLink) lines.push(`- ${refLink}`);
    lines.push("");

    const file = await this.app.vault.create(path, lines.join("\n"));

    if (r.connectTo) {
      const how = r.relationLine ? `: ${r.relationLine}` : "";
      await this.app.vault.process(r.connectTo, (c) =>
        appendUnderHeading(c, "Links", [`- ${INVERSE[r.relation]} [[${name}]]${how}`])
      );
    }
    if (this.settings.distillBacklinkToSource && backlinkTo) {
      await this.app.vault.process(backlinkTo, (c) => appendUnderHeading(c, "Notes", [`- [[${name}]]`]));
    }
    for (const id of r.projectIds) {
      const proj = projects.find((p) => p.id === id);
      if (proj) await this.addToEssay(file, proj);
    }

    this.settings.strikeAfterDistill = r.strike;
    await this.saveSettings();
    new Notice(`Created "${name}"`);
    if (r.strike) void this.openSpark(file);
    return file;
  }

  /** The literature-note stage: a short own-words note kept on the source. */
  async saveSourceNote(
    r: DistillResult,
    quote: string,
    refLink: string,
    source: TFile,
    sourceNote: TFile | null
  ) {
    let target = sourceNote;
    if (!target) {
      // A PDF with no notes file yet: make one beside it that links to it.
      const folder = source.parent?.path && source.parent.path !== "/" ? source.parent.path + "/" : "";
      const path = `${folder}${source.basename} - notes.md`;
      const existing = this.app.vault.getAbstractFileByPath(path);
      target =
        existing instanceof TFile
          ? existing
          : await this.app.vault.create(path, `PDF: [[${source.path}]]\n\n## Notes\n`);
    }
    const ref = refLink ? ` — ${refLink}` : "";
    await this.app.vault.process(target, (c) =>
      appendUnderHeading(c, "Notes", [`- ${r.idea.trim().replace(/\n+/g, " ")}${ref}`, `\t> ${quote}`])
    );
    new Notice(`Added to ${target.basename}`);
  }

  /** A `- note` line inside a `## Notes` section, plus its nested `> quote`. */
  sourceNoteAtCursor(editor: Editor): { line: number; idea: string; quote: string } | null {
    const lineNo = editor.getCursor().line;
    const text = editor.getLine(lineNo);
    if (!/^- /.test(text) || text.includes(" → [[")) return null; // already promoted
    // Must sit under a "## Notes" heading
    let underNotes = false;
    for (let i = lineNo - 1; i >= 0; i--) {
      const l = editor.getLine(i);
      if (/^#{1,6} /.test(l)) {
        underNotes = l.trim() === "## Notes";
        break;
      }
    }
    if (!underNotes) return null;
    const idea = text.replace(/^- /, "").replace(/\s+—\s+(\[\[.*\]\]|\[.*\]\(.*\))\s*$/, "").trim();
    if (!idea || /^\[\[[^\]]+\]\]$/.test(idea) || idea.includes("→ [[")) return null;
    const next = lineNo + 1 < editor.lineCount() ? editor.getLine(lineNo + 1) : "";
    const quote = /^\s+>\s?/.test(next) ? next.replace(/^\s+>\s?/, "").trim() : "";
    return { line: lineNo, idea, quote };
  }

  async promoteToThought(editor: Editor, file: TFile, found: { line: number; idea: string; quote: string }) {
    const pdfLink = editor.getLine(found.line).match(/\[\[([^\]|#]+\.pdf)[^\]]*\]\]/);
    const pdf = pdfLink ? this.app.metadataCache.getFirstLinkpathDest(pdfLink[1], file.path) : null;
    const pageMatch = editor.getLine(found.line).match(/#page=(\d+)[^|\]]*\|p\.([^\]]+)\]\]/);
    await this.openDistill({
      quote: found.quote || found.idea,
      source: pdf ?? file,
      pdf: pdf && pageMatch ? { text: found.quote, file: pdf, page: Number(pageMatch[1]), pageLabel: pageMatch[2] } : undefined,
      prefillIdea: found.idea,
      skipSourceBacklink: true,
      onSaved: (thought) => {
        const line = editor.getLine(found.line);
        editor.setLine(found.line, `${line} → [[${thought.basename}]]`);
      },
    });
  }

  /** One-time: carry Distill settings over from Cairn/Throughline. */
  async migrateDistillSettings() {
    const dataPath = `${this.app.vault.configDir}/plugins/note-assembler/data.json`;
    try {
      if (await this.app.vault.adapter.exists(dataPath)) {
        const old =
          (JSON.parse(await this.app.vault.adapter.read(dataPath)) as {
            settings?: { distillDefaultFolder?: string; addBacklinkToSource?: boolean; strikeAfterDistill?: boolean };
          }).settings ?? {};
        if (old.distillDefaultFolder) this.settings.distillFolder = old.distillDefaultFolder;
        if (typeof old.addBacklinkToSource === "boolean") this.settings.distillBacklinkToSource = old.addBacklinkToSource;
        if (typeof old.strikeAfterDistill === "boolean") this.settings.strikeAfterDistill = old.strikeAfterDistill;
      }
    } catch {
      // Nothing to migrate; defaults stand.
    }
    this.settings.distillMigrated = true;
    await this.saveSettings();
  }

  /** Open the Strike window. Pass a note to strike it against a random (lonely) note. */
  async openSpark(preselected?: TFile) {
    const noteA = preselected ?? getRandomNote([], this.app, this.settings);
    const noteB = getRandomNote(
      noteA ? [noteA.path] : [],
      this.app,
      this.settings,
      noteA?.parent?.path
    );

    if (!noteA || !noteB) {
      new Notice(
        "Not enough notes to spark from. Add more notes to your vault."
      );
      return;
    }

    const contentA = await this.app.vault.read(noteA);
    const contentB = await this.app.vault.read(noteB);
    const cairnProjects = this.settings.showEssayProjects
      ? await getCairnProjects(this.app)
      : [];

    const modal = new SparkModal(
      this.app,
      noteA,
      noteB,
      contentA,
      contentB,
      this.settings,
      cairnProjects,
      // onSpark
      async (idea, title, folder, fileA, fileB, selectedProjectIds) => {
        await this.createSparkNote(idea, title, folder, fileA, fileB, selectedProjectIds, cairnProjects);
      },
      // onSkip
      (fileA, fileB) => {
        this.logSpark(fileA.path, fileB.path, "skipped");
      },
      // onShuffle
      (exclude: string[]) => getRandomNote(exclude, this.app, this.settings),
      // onPick
      (onChoose: (file: TFile) => void) => {
        new NotePickerModal(
          this.app,
          this.settings.sourceFolder,
          onChoose
        ).open();
      },
      // onSettingsChange
      () => { void this.saveSettings(); }
    );
    this.activeModal = modal;
    modal.open();
  }

  async createSparkNote(
    idea: string,
    title: string,
    folder: string,
    noteA: TFile,
    noteB: TFile,
    selectedProjectIds: string[],
    cairnProjects: CairnProject[]
  ) {
    const safeName = sanitizeFilename(title);
    if (!safeName) {
      new Notice("Note title cannot be empty");
      return;
    }
    const targetPath = folder ? `${folder}/${safeName}.md` : `${safeName}.md`;

    if (this.app.vault.getAbstractFileByPath(targetPath)) {
      new Notice(`File "${targetPath}" already exists`);
      return;
    }

    // A spark is your own assertion, so it's a `claim` in the 2nd Brain's
    // closed type set; `origin: strike` keeps sparks findable as a group.
    const now = new Date();
    const created = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const lines: string[] = ["---", "type: claim", "origin: strike", `created: ${created}`];
    if (this.settings.tagSparks) lines.push("tags: [strike]");
    lines.push("---", "");
    lines.push(
      idea.trim(),
      "",
      "---",
      "",
      "## Sparked from",
      "",
      `- [[${noteA.basename}]]`,
      `- [[${noteB.basename}]]`,
      ""
    );

    await this.app.vault.create(targetPath, lines.join("\n"));
    this.logSpark(noteA.path, noteB.path, "sparked", targetPath);

    // Add to selected Cairn essay projects
    if (selectedProjectIds.length > 0) {
      const sparkFile = this.app.vault.getAbstractFileByPath(targetPath);
      if (sparkFile instanceof TFile) {
        for (const projId of selectedProjectIds) {
          const proj = cairnProjects.find((p) => p.id === projId);
          if (proj) {
            await this.addToEssay(sparkFile, proj);
          }
        }
      }
    }

    const frag = createFragment();
    frag.append("Sparked ");
    const link = frag.createEl("a", { cls: "fk-notice-link", text: safeName });
    link.addEventListener("click", () => {
      if (this.activeModal) this.activeModal.close();
      const f = this.app.vault.getAbstractFileByPath(targetPath);
      if (f instanceof TFile) void this.app.workspace.getLeaf(false).openFile(f);
    });
    new Notice(frag, 8000);
  }

  async addToEssay(sparkFile: TFile, project: CairnProject) {
    const projectFile = this.app.vault.getAbstractFileByPath(project.filePath);
    if (!(projectFile instanceof TFile)) return;

    let sparkContent = await this.app.vault.read(sparkFile);
    // Strip YAML frontmatter
    sparkContent = sparkContent.replace(/^---\n[\s\S]*?\n---\n?/, "");
    // Strip top-level heading matching filename
    const headingPattern = new RegExp(
      `^#\\s+${sparkFile.basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\n?`
    );
    sparkContent = sparkContent.replace(headingPattern, "").trim();
    // Distilled notes carry their source under "## Reference"; the essay gets the idea.
    sparkContent = sparkContent.replace(/(^|\n)## (Links|Reference)[\s\S]*$/, "").trim();

    const projectContent = await this.app.vault.read(projectFile);
    const quoted = sparkContent.split("\n").map((l: string) => `> ${l}`).join("\n");
    const newSection = `## ${sparkFile.basename}\n\n${quoted}\n\n`;

    // Insert before ## Sources if it exists, else append
    const sourcesMatch = projectContent.match(/^(## Sources)\s*$/m);
    let newContent: string;
    if (sourcesMatch && sourcesMatch.index !== undefined) {
      const before = projectContent.slice(0, sourcesMatch.index);
      const sourcesBlock = projectContent.slice(sourcesMatch.index);
      const updatedSources = sourcesBlock.trimEnd() + `\n- [[${sparkFile.basename}]]`;
      newContent = before.trimEnd() + "\n\n" + newSection + "\n\n" + updatedSources + "\n";
    } else {
      newContent = projectContent.trimEnd() + "\n\n" + newSection + "\n";
    }

    await this.app.vault.modify(projectFile, newContent);
  }

  logSpark(
    noteA: string,
    noteB: string,
    result: "sparked" | "skipped",
    sparkNote?: string
  ) {
    this.settings.sparkHistory.push({
      noteA,
      noteB,
      result,
      sparkNote,
      timestamp: Date.now(),
    });
    // Keep history at reasonable size
    if (this.settings.sparkHistory.length > 200) {
      this.settings.sparkHistory = this.settings.sparkHistory.slice(-200);
    }
    void this.saveSettings();
  }

  async loadSettings() {
    let saved = (await this.loadData()) as Partial<DistillSettings> | null;
    if (!saved) {
      // First run under the "distill" id: carry over settings + spark history from "flint".
      const oldPath = `${this.app.vault.configDir}/plugins/flint/data.json`;
      try {
        if (await this.app.vault.adapter.exists(oldPath)) {
          saved = JSON.parse(await this.app.vault.adapter.read(oldPath)) as Partial<DistillSettings>;
        }
      } catch {
        // No old data; start fresh.
      }
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ── Settings Tab ────────────────────────────────────────────

class DistillSettingTab extends PluginSettingTab {
  plugin: DistillPlugin;

  constructor(app: App, plugin: DistillPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const folders = this.getFolders();

    // Distill (general, no heading)
    new Setting(containerEl)
      .setName("Distilled notes folder")
      .setDesc("Where new distilled notes are saved.")
      .addDropdown((drop) => {
        drop.addOption("", "Vault root");
        for (const f of folders) drop.addOption(f, f);
        drop.setValue(this.plugin.settings.distillFolder);
        drop.onChange(async (val) => {
          this.plugin.settings.distillFolder = val;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Save distilled passages as")
      .setDesc("The default when you distill a passage. You can switch it each time.")
      .addDropdown((drop) => {
        drop.addOption("thought", "Their own note");
        drop.addOption("source", "A note on the source");
        drop.setValue(this.plugin.settings.distillSaveAs);
        drop.onChange(async (val) => {
          this.plugin.settings.distillSaveAs = val === "source" ? "source" : "thought";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Link new notes from their source")
      .setDesc("Add a link to each new note in the note it came from.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.distillBacklinkToSource);
        toggle.onChange(async (val) => {
          this.plugin.settings.distillBacklinkToSource = val;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl).setName("Strike").setHeading();

    new Setting(containerEl)
      .setName("Source folder")
      .setDesc("Which notes to draw from when shuffling. Leave blank for all folders.")
      .addDropdown((drop) => {
        drop.addOption("", "All folders");
        for (const f of folders) {
          drop.addOption(f, f);
        }
        drop.setValue(this.plugin.settings.sourceFolder);
        drop.onChange(async (val) => {
          this.plugin.settings.sourceFolder = val;
          await this.plugin.saveSettings();
        });
      });

    // Output folder
    new Setting(containerEl)
      .setName("Output folder")
      .setDesc("Where new spark notes are saved.")
      .addDropdown((drop) => {
        drop.addOption("", "Vault root");
        for (const f of folders) {
          drop.addOption(f, f);
        }
        drop.setValue(this.plugin.settings.outputFolder);
        drop.onChange(async (val) => {
          this.plugin.settings.outputFolder = val;
          await this.plugin.saveSettings();
        });
      });

    // Orphan preference
    new Setting(containerEl)
      .setName("Prefer orphan notes")
      .setDesc(
        "Weight random selection toward notes with fewer connections. Orphans are dormant potential."
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.includeOrphans);
        toggle.onChange(async (val) => {
          this.plugin.settings.includeOrphans = val;
          await this.plugin.saveSettings();
        });
      });

    // Cross-folder collisions
    new Setting(containerEl)
      .setName("Cross-folder collisions")
      .setDesc(
        "Draw the two cards from different folders. Distance between domains is where the best sparks live. Falls back to same-folder if there's nothing else to pair."
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.crossFolder);
        toggle.onChange(async (val) => {
          this.plugin.settings.crossFolder = val;
          await this.plugin.saveSettings();
        });
      });

    // Tag spark notes
    new Setting(containerEl)
      .setName("Tag spark notes")
      .setDesc(
        "Also add tags: [strike] to each new spark. (Sparks always get type: claim and origin: strike.)"
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.tagSparks);
        toggle.onChange(async (val) => {
          this.plugin.settings.tagSparks = val;
          await this.plugin.saveSettings();
        });
      });

    // Cairn integration
    new Setting(containerEl)
      .setName("Show essay projects")
      .setDesc(
        "Show checkboxes for your essays (from the companion essay plugin) when saving a note. Turn off if you don't use it."
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showEssayProjects);
        toggle.onChange(async (val) => {
          this.plugin.settings.showEssayProjects = val;
          await this.plugin.saveSettings();
        });
      });

    // Stats
    const history = this.plugin.settings.sparkHistory;
    if (history.length > 0) {
      const sparked = history.filter((e) => e.result === "sparked").length;
      const skipped = history.filter((e) => e.result === "skipped").length;
      new Setting(containerEl)
        .setName("Strike history")
        .setDesc(`${sparked} sparked, ${skipped} skipped (${history.length} total)`);
    }

    new Setting(containerEl).setDesc("Free and open source.");
  }

  private getFolders(): string[] {
    const folders: string[] = [];
    this.app.vault.getAllLoadedFiles().forEach((f) => {
      if (f instanceof TFolder && f.path !== "/") {
        folders.push(f.path);
      }
    });
    return folders.sort();
  }
}

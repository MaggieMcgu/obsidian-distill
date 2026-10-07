import {
  App,
  debounce,
  FuzzySuggestModal,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
} from "obsidian";

// ── Data Model ──────────────────────────────────────────────

interface SparkEntry {
  noteA: string;
  noteB: string;
  result: "sparked" | "skipped";
  sparkNote?: string;
  timestamp: number;
}

interface FlintSettings {
  sourceFolder: string;
  outputFolder: string;
  includeOrphans: boolean;
  crossFolder: boolean;
  tagSparks: boolean;
  showEssayProjects: boolean;
  sparkHistory: SparkEntry[];
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

const DEFAULT_SETTINGS: FlintSettings = {
  sourceFolder: "",
  outputFolder: "",
  includeOrphans: true,
  crossFolder: false,
  tagSparks: false,
  showEssayProjects: true,
  sparkHistory: [],
};

// ── Helpers ─────────────────────────────────────────────────

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "").trim();
}

function getRandomNote(
  exclude: string[],
  app: App,
  settings: FlintSettings,
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
    const resolved = (app.metadataCache as any).resolvedLinks as Record<string, Record<string, number>>;
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

async function getCairnProjects(app: App): Promise<CairnProject[]> {
  const dataPath = ".obsidian/plugins/note-assembler/data.json";
  const file = app.vault.getAbstractFileByPath(dataPath);
  if (!file || !(file instanceof TFile)) return [];
  try {
    const raw = await app.vault.read(file);
    const data = JSON.parse(raw);
    return data.projects || [];
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
  settings: FlintSettings;
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
    settings: FlintSettings,
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
    header.createEl("h3", { text: "Flint" });
    header.createEl("span", { cls: "fk-header-tagline", text: "Strike two ideas together" });

    // Folder config row (compact, single line)
    const allFolders: string[] = [];
    this.app.vault.getAllLoadedFiles().forEach((f) => {
      if ((f as TFolder).children !== undefined && f.path !== "/") {
        allFolders.push(f.path);
      }
    });
    allFolders.sort();

    const configRow = contentEl.createDiv({ cls: "fk-config-row" });

    const sourceGroup = configRow.createDiv({ cls: "fk-config-group" });
    sourceGroup.createEl("span", { cls: "fk-config-label", text: "from" });
    const sourceSelect = sourceGroup.createEl("select", { cls: "fk-config-select" });
    sourceSelect.createEl("option", { text: "All folders", value: "" });
    for (const folder of allFolders) {
      const opt = sourceSelect.createEl("option", { text: folder, value: folder });
      if (folder === this.settings.sourceFolder) opt.selected = true;
    }
    sourceSelect.addEventListener("change", async () => {
      this.settings.sourceFolder = sourceSelect.value;
      this.onSettingsChange();
      await this.shuffleBoth();
    });

    const outputGroup = configRow.createDiv({ cls: "fk-config-group" });
    outputGroup.createEl("span", { cls: "fk-config-label", text: "to" });
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
    titleRow.createEl("span", { cls: "fk-title-label", text: "Title:" });
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
      text: "Save Spark",
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

    saveBtn.addEventListener("click", submit);

    textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    });

    // Focus textarea
    setTimeout(() => textarea.focus(), 50);
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
      this.app.workspace.openLinkText(file.path, "", true);
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
    contentEl.setText(content);
  }

  private chooseSlotAndReplace(file: TFile) {
    const modal = new Modal(this.app);
    modal.titleEl.setText("Place as which card?");
    const row = modal.contentEl.createDiv({ cls: "fk-slot-choice" });
    const place = (side: "A" | "B") => {
      this.replaceNote(side, file);
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
      this.app.vault.read(retry).then((content) => {
        if (side === "A") { this.noteA = retry; this.contentA = content; }
        else { this.noteB = retry; this.contentB = content; }
        this.renderPanel(side);
        this.rotatePrompt();
      });
      return;
    }
    this.seenPaths.add(newNote.path);
    this.app.vault.read(newNote).then((content) => {
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

    Promise.all([
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
      if (textarea) setTimeout(() => textarea.focus(), 50);
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ── Plugin ──────────────────────────────────────────────────

export default class FlintPlugin extends Plugin {
  settings!: FlintSettings;
  activeModal?: SparkModal;

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("flame", "Flint — Strike two ideas", () => {
      this.openSpark();
    });

    this.addCommand({
      id: "open-spark",
      name: "Strike two notes",
      callback: () => this.openSpark(),
    });

    this.addSettingTab(new FlintSettingTab(this.app, this));
  }

  /** Open Flint. Pass a note to strike it against a random (lonely) note. */
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
      () => { this.saveSettings(); }
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
    // closed type set; `origin: flint` keeps sparks findable as a group.
    const now = new Date();
    const created = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const lines: string[] = ["---", "type: claim", "origin: flint", `created: ${created}`];
    if (this.settings.tagSparks) lines.push("tags: [flint]");
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

    const frag = document.createDocumentFragment();
    frag.append("Sparked ");
    const link = document.createElement("a");
    link.textContent = safeName;
    link.style.cursor = "pointer";
    link.style.textDecoration = "underline";
    link.addEventListener("click", () => {
      if (this.activeModal) this.activeModal.close();
      const f = this.app.vault.getAbstractFileByPath(targetPath);
      if (f instanceof TFile) this.app.workspace.getLeaf(false).openFile(f);
    });
    frag.append(link);
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
    this.saveSettings();
  }

  async loadSettings() {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ── Settings Tab ────────────────────────────────────────────

class FlintSettingTab extends PluginSettingTab {
  plugin: FlintPlugin;

  constructor(app: App, plugin: FlintPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Source folder
    const folders = this.getFolders();

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
        "Also add tags: [flint] to each new spark. (Sparks always get type: claim and origin: flint.)"
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
        "Show Cairn essay project checkboxes when saving a spark. Disable if you don't use Cairn."
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
      containerEl.createEl("hr");
      const statsDiv = containerEl.createDiv({ cls: "fk-stats" });
      statsDiv.createEl("h4", { text: "Spark history" });
      statsDiv.createEl("p", {
        text: `${sparked} sparked, ${skipped} skipped (${history.length} total)`,
      });
    }

    // About
    containerEl.createEl("hr");
    const about = containerEl.createDiv({ cls: "fk-about" });
    about.createEl("p", {
      text: "Flint is free and open source. Built by Maggie McGuire.",
    });
  }

  private getFolders(): string[] {
    const folders: string[] = [];
    this.app.vault.getAllLoadedFiles().forEach((f) => {
      if ((f as TFolder).children !== undefined && f.path !== "/") {
        folders.push(f.path);
      }
    });
    return folders.sort();
  }
}

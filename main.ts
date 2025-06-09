import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
} from "obsidian";

/**
 * Return SHA-256 of the given UTF-8 text as a 64-char hex string.
 * Works in both the Electron (desktop) and browser (mobile/web) runtimes.
 */
async function sha256(text: string): Promise<string> {
	// 1  Encode to bytes
	const bytes = new TextEncoder().encode(text);

	// 2  Get a digest – crypto.subtle is available in Electron's renderer
	const buffer = await crypto.subtle.digest("SHA-256", bytes);

	// 3  Convert ArrayBuffer → hex string
	return Array.from(new Uint8Array(buffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

const API_ENDPOINT = "https://www.idealite.xyz/api/obsidian/note-upload";

interface IdealiteUploadPluginSettings {
	apiToken: string;
	autoUpload: boolean;
	uploadImages: boolean;
	selectedFolder: string;
	debugMode: boolean;
}

interface UploadMetadata {
	ts: string; // ISO timestamp
	sha: string; // SHA-256 hash
}

interface IdealiteUploadPluginData extends IdealiteUploadPluginSettings {
	/** notes already uploaded at least once – key = full path */
	uploaded?: Record<string, UploadMetadata>;
}

const DEFAULT_SETTINGS: IdealiteUploadPluginSettings = {
	apiToken: "",
	autoUpload: false,
	uploadImages: true,
	selectedFolder: "",
	debugMode: false,
};

export default class IdealiteUploadPlugin extends Plugin {
	settings: IdealiteUploadPluginSettings;

	uploaded: Record<string, UploadMetadata> = {};

	/** UI elements */
	private statusEl!: HTMLElement;
	private ribbonEl!: HTMLElement;

	/** runtime counters */
	private inFlight = 0;
	private failed: { path: string; error: string }[] = [];

	private checkRequiredSettings(): boolean {
		// Check API token
		if (!this.settings.apiToken || this.settings.apiToken.trim() === "") {
			new Notice(
				"Please configure your API token in plugin settings",
				5000
			);
			return false;
		}

		// Check folder selection
		if (!this.isFolderSelected()) {
			new Notice(
				"Please select a folder for sync in plugin settings",
				5000
			);
			return false;
		}

		return true;
	}

	async onload() {
		await this.loadSettings();

		/* ---- UI widgets ---- */
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("idealite-sync-status");

		this.ribbonEl = this.addRibbonIcon(
			"upload-cloud",
			"Idealite Sync",
			async () => {
				// Check settings first
				if (!this.checkRequiredSettings()) {
					return;
				}

				// If there are errors, show error center
				if (this.failed.length) {
					this.showErrorCenter();
					return;
				}

				// If uploads are in progress, show status
				if (this.inFlight > 0) {
					new Notice(`${this.inFlight} uploads in progress...`);
					return;
				}

				// Otherwise, upload the current note (with folder check)
				this.debug("Ribbon icon clicked");
				const activeView =
					this.app.workspace.getActiveViewOfType(MarkdownView);

				if (activeView) {
					this.debug(
						`Active view found: ${
							activeView.file?.path || "no file"
						}`
					);
					await this.uploadCurrentNote(activeView);
				} else {
					// Try to find any markdown file
					const currentFile = this.app.workspace.getActiveFile();
					if (currentFile?.extension === "md") {
						this.debug(
							"Active file is markdown, attempting upload"
						);
						// Check if file is in selected folder before uploading
						if (this.isFileInSelectedFolder(currentFile)) {
							await this.uploadNote(currentFile);
						} else {
							this.showFolderRestrictionNotice(currentFile);
						}
						return;
					}
					new Notice("No active markdown note to upload");
				}
			}
		);

		// wait for the file index; then harvest once
		this.app.workspace.onLayoutReady(() => {
			if (this.isFolderSelected()) this.initialHarvest();
		});

		// Add command to upload current note
		this.addCommand({
			id: "upload-current-note",
			name: "Upload current note to idealite",
			editorCheckCallback: (
				checking: boolean,
				editor: Editor,
				view: MarkdownView
			) => {
				if (checking) {
					return true;
				}

				// Check settings before proceeding
				if (!this.checkRequiredSettings()) {
					return true;
				}

				this.debug(
					`Upload command triggered for: ${
						view.file?.path || "unknown"
					}`
				);
				this.uploadCurrentNote(view);
				return true;
			},
		});

		// Add command to upload selected folder
		this.addCommand({
			id: "upload-selected-folder",
			name: "Upload selected folder to idealite",
			callback: async () => {
				this.debug("Upload selected folder command triggered");

				// Check settings first
				if (!this.checkRequiredSettings()) {
					return;
				}

				// Find the folder in the vault
				this.debug(
					`Looking for folder: ${this.settings.selectedFolder}`
				);
				const folder = this.getFolderFromSettings();
				if (!folder) {
					this.debug(
						`Folder not found: ${this.settings.selectedFolder}`
					);
					new Notice(
						`Cannot find folder: ${this.settings.selectedFolder}`
					);
					return;
				}

				this.debug(`Folder found: ${folder.path}, starting upload`);
				await this.uploadFolder(folder);
			},
		});

		// Listen for new files in the selected folder
		this.registerEvent(
			this.app.vault.on("create", async (file) => {
				if (!this.settings.autoUpload) return;
				if (
					file instanceof TFile &&
					file.extension === "md" &&
					this.isFileInSelectedFolder(file) &&
					!this.uploaded[file.path]
				) {
					await this.uploadNote(file);
				}
			})
		);

		// Listen for renamed files
		this.registerEvent(
			this.app.vault.on("rename", async (file, oldPath) => {
				// Only care about markdown files
				if (!(file instanceof TFile) || file.extension !== "md") return;

				const wasTracked = this.uploaded[oldPath];
				const inWatchedFolder = this.isFileInSelectedFolder(file);

				/* ---------- 1. migrate cache ---------- */
				if (wasTracked) {
					delete this.uploaded[oldPath];
					this.uploaded[file.path] = wasTracked;
					await this.saveAll();
					this.debug(
						`Path changed → migrated cache:\n${oldPath} ➞ ${file.path}`
					);
				}

				/* ---------- 2. decide whether to re-upload ---------- */
				if (inWatchedFolder && this.settings.autoUpload) {
					// If only the name changed, the SHA-256 will match and uploadNote() will skip.
					await this.uploadNote(file);
				}
			})
		);

		// Settings tab
		this.addSettingTab(new IdealiteUploadSettingTab(this.app, this));
	}

	debug(message: string, ...args: any[]) {
		if (this.settings.debugMode) {
			console.log(`[Idealite Upload] ${message}`, ...args);
		}
	}

	async uploadFolder(folder: any) {
		const files = this.getMarkdownFilesInFolder(folder);
		const BATCH_SIZE = 5;

		if (files.length === 0) {
			new Notice(`No markdown files found in ${folder.path}`);
			return;
		}

		// Show initial notice
		new Notice(
			`Starting upload of ${files.length} notes from ${folder.path}`
		);

		let totalSucceeded = 0;
		let totalFailed = 0;
		const failedFiles: { path: string; error: string }[] = [];

		// Calculate total batches for progress display
		const totalBatches = Math.ceil(files.length / BATCH_SIZE);

		// Process files in batches
		for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
			const start = batchIndex * BATCH_SIZE;
			const end = Math.min(start + BATCH_SIZE, files.length);
			const batch = files.slice(start, end);

			// Update status bar with batch progress
			this.statusEl.setText(
				`⟳ Uploading batch ${batchIndex + 1}/${totalBatches} (${
					start + 1
				}-${end} of ${files.length})`
			);

			// Upload all files in this batch concurrently
			const batchResults = await Promise.allSettled(
				batch.map((file) => this.uploadNote(file))
			);

			// Count results for this batch
			batchResults.forEach((result, index) => {
				if (result.status === "fulfilled") {
					totalSucceeded++;
				} else {
					totalFailed++;
					const file = batch[index];
					failedFiles.push({
						path: file.path,
						error: result.reason?.message || "Unknown error",
					});
				}
			});

			// Small delay between batches to avoid overwhelming the server
			if (batchIndex < totalBatches - 1) {
				await this.delay(500); // 500ms delay between batches
			}
		}

		// Update the failed list for error center
		this.failed = failedFiles;

		// Show completion notice
		const message = `Upload complete: ${totalSucceeded} succeeded, ${totalFailed} failed`;
		new Notice(message);

		// Refresh UI to show final state
		this.refreshUi();

		// If there were failures, offer to show error details
		if (totalFailed > 0) {
			this.showErrorCenter();
		}
	}

	// Helper method for delays
	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	getMarkdownFilesInFolder(folder: any): TFile[] {
		this.debug(`Getting markdown files in folder: ${folder.path}`);
		const files: TFile[] = [];

		// Recursively collect all markdown files
		const collectFiles = (folder: any) => {
			if (!folder.children) {
				this.debug(`Folder ${folder.path} has no children property`);
				return;
			}

			for (const child of folder.children) {
				if (child instanceof TFile) {
					if (child.extension === "md") {
						files.push(child);
					}
				} else if (child instanceof TFolder) {
					collectFiles(child);
				}
			}
		};

		collectFiles(folder);
		this.debug(
			`Found ${files.length} markdown files in folder and subfolders`
		);
		return files;
	}

	/**
	 * Check if a folder is currently selected for syncing
	 */
	private isFolderSelected(): boolean {
		return (
			this.settings.selectedFolder !== null &&
			this.settings.selectedFolder !== undefined
		);
	}

	/**
	 * Get the folder object from the current settings
	 */
	private getFolderFromSettings(): TFolder | null {
		if (!this.isFolderSelected()) return null;

		// Handle root folder (empty string)
		if (this.settings.selectedFolder === "") {
			return this.app.vault.getRoot();
		}

		return this.app.vault.getFolderByPath(this.settings.selectedFolder);
	}

	/**
	 * Show a notice when user tries to upload a file outside the selected folder
	 */
	private showFolderRestrictionNotice(file: TFile) {
		const folderName =
			this.settings.selectedFolder === ""
				? "root folder"
				: this.settings.selectedFolder || "selected folder";
		new Notice(
			`Note "${file.name}" is not in the ${folderName}. Only notes in the selected folder can be uploaded.`
		);
	}

	isFileInSelectedFolder(file: TFile): boolean {
		// If no folder is selected, no files should be uploaded
		if (!this.isFolderSelected()) {
			return false;
		}

		// Handle root folder case (empty string means root)
		if (this.settings.selectedFolder === "") {
			return false;
		}

		// Check if the file's path starts with the selected folder path
		// Add a trailing slash to ensure we're checking for the folder and not just a prefix match
		const folderPath = this.settings.selectedFolder.endsWith("/")
			? this.settings.selectedFolder
			: this.settings.selectedFolder + "/";

		return file.path.startsWith(folderPath);
	}

	onunload() {}

	async loadSettings() {
		const data = (await this.loadData()) as IdealiteUploadPluginData | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
		this.uploaded = data?.uploaded ?? {};
	}

	async saveAll() {
		const toSave: IdealiteUploadPluginData = {
			...this.settings,
			uploaded: this.uploaded,
		};
		await this.saveData(toSave);
	}

	async uploadCurrentNote(view: MarkdownView) {
		const file = view.file;
		if (!file) {
			this.debug("No file in the current view");
			new Notice("No file is currently open");
			return;
		}

		// Check settings
		if (!this.checkRequiredSettings()) {
			return;
		}

		// Check if file is in selected folder before uploading
		if (!this.isFileInSelectedFolder(file)) {
			this.showFolderRestrictionNotice(file);
			return;
		}

		this.debug(`Uploading current note: ${file.path}`);
		await this.uploadNote(file);
	}

	async uploadNote(file: TFile) {
		this.inFlight++;
		this.refreshUi();

		try {
			this.debug(`Starting upload for note: ${file.path}`);

			// Get the note content and compute hash
			const content = await this.app.vault.read(file);
			const currentSha = await sha256(content);

			// Check if file is unchanged
			const meta = this.uploaded[file.path];
			if (meta?.sha === currentSha) {
				this.debug("Skip – unchanged", file.path);
				this.inFlight--;
				this.refreshUi();
				return;
			}

			// Extract front matter
			const frontMatter = this.extractFrontMatter(content);
			this.debug("Extracted front matter:", frontMatter);

			// Get embedded images if setting is enabled
			const imageFiles: { file: TFile; data: ArrayBuffer }[] = [];

			if (this.settings.uploadImages) {
				const imageLinks = this.extractImageLinks(content);
				this.debug(`Found ${imageLinks.length} image links in note`);

				for (const link of imageLinks) {
					try {
						// Try to resolve the linked file
						this.debug(`Resolving image link: ${link}`);
						const imageFile = this.getFileFromLink(link);
						if (imageFile && this.isImageFile(imageFile)) {
							this.debug(
								`Loading image data for: ${imageFile.path}`
							);
							const data = await this.app.vault.readBinary(
								imageFile
							);
							imageFiles.push({ file: imageFile, data });
						} else {
							this.debug(
								`Image file not found or not an image: ${link}`
							);
						}
					} catch (error) {
						console.error(`Error processing image ${link}:`, error);
					}
				}
			}

			// Prepare the FormData
			const formData = new FormData();
			formData.append(
				"markdown",
				new Blob([content], { type: "text/markdown" }),
				file.name
			);

			// Add front matter data as JSON
			if (frontMatter) {
				formData.append("frontMatter", JSON.stringify(frontMatter));
			}

			// Add each image to the FormData
			if (imageFiles.length > 0) {
				this.debug(`Adding ${imageFiles.length} images to form data`);
				for (const { file, data } of imageFiles) {
					formData.append(
						"images[]",
						new Blob([data], {
							type: this.getMimeType(file.extension),
						}),
						file.name
					);
				}
			}

			// Send the upload request
			const headers: Record<string, string> = {};
			if (this.settings.apiToken) {
				headers["Authorization"] = `Bearer ${this.settings.apiToken}`;
			}

			this.debug(`Sending POST request to: ${API_ENDPOINT}`);
			const response = await fetch(API_ENDPOINT, {
				method: "POST",
				headers,
				body: formData,
			});

			if (!response.ok) {
				const errorData = await response.json().catch(() => null);
				const errorMessage = `Upload failed with status: ${
					response.status
				}${errorData?.error ? ` - ${errorData.error}` : ""}`;
				this.debug(`API request failed: ${errorMessage}`);
				throw new Error(errorMessage);
			}

			const result = await response.json();
			this.debug(`Upload successful, API response:`, result);

			// Mark as uploaded and clear any prior failure
			this.uploaded[file.path] = {
				ts: new Date().toISOString(),
				sha: currentSha,
			};
			this.failed = this.failed.filter((f) => f.path !== file.path);
			await this.saveAll();

			this.inFlight--;
			this.refreshUi();

			return result;
		} catch (error) {
			this.inFlight--;
			this.failed.push({
				path: file.path,
				error: error instanceof Error ? error.message : String(error),
			});
			this.refreshUi();
			console.error("Error uploading note:", error);
		}
	}

	extractFrontMatter(content: string) {
		// 1. Grab the raw block between the first pair of '---' lines.
		const match = /^---\n([\s\S]*?)\n---/.exec(content);
		if (!match) return null;

		const raw = match[1].split("\n");
		const data: Record<string, any> = {};

		let currentKey: string | null = null;

		for (const lineRaw of raw) {
			const line = lineRaw.replace(/\r$/, ""); // normalise endings
			if (!line.trim()) continue; // skip blanks

			const indent = line.match(/^\s*/)?.[0].length ?? 0;
			const isListItem = line.trimStart().startsWith("-");

			/* -------------------- new key -------------------- */
			if (!indent && !isListItem && line.includes(":")) {
				const [key, ...rest] = line.split(":");
				const valueRaw = rest.join(":").trim();

				currentKey = key.trim();
				if (valueRaw) {
					// scalar on same line → string, number, boolean
					data[currentKey] = coerceScalar(valueRaw);
				} else {
					// list starts on following indented lines
					data[currentKey] = [];
				}
			} else if (isListItem && currentKey) {
				/* -------------- list item for current key -------------- */
				const item = line.trimStart().substring(1).trim();
				(data[currentKey] as any[]).push(coerceScalar(item));
			}
		}

		/* post-process "books" entries into {title, author} objects */
		if (Array.isArray(data.books)) {
			data.books = (data.books as string[]).map(this.parseBookEntry);
		} else if (typeof data.books === "string") {
			data.books = [this.parseBookEntry(data.books)];
		}

		return data;

		/* --- utilities --- */
		function coerceScalar(txt: string): string | number | boolean {
			if (/^(true|false)$/i.test(txt))
				return txt.toLowerCase() === "true";
			if (/^-?\d+(\.\d+)?$/.test(txt)) return Number(txt);
			// strip surrounding quotes if present
			return txt.replace(/^["'](.*)["']$/, "$1");
		}
	}

	// Helper method to parse book entries in "Title by Author" format
	private parseBookEntry(entry: string): { title: string; author: string } {
		const byIndex = entry.toLowerCase().indexOf(" by ");

		if (byIndex > 0) {
			// Split into title and author
			const title = entry.substring(0, byIndex).trim();
			const author = entry.substring(byIndex + 4).trim(); // +4 to skip " by "
			return { title, author };
		} else {
			// Just a title, no author specified
			return { title: entry.trim(), author: "" };
		}
	}

	isImageFile(file: TFile): boolean {
		return (
			file.extension.match(/jpe?g|png|gif|svg|webp|bmp|tiff?/i) !== null
		);
	}

	extractImageLinks(content: string): string[] {
		const imageLinks: string[] = [];

		// Match standard markdown image syntax: ![alt](path/to/image.png)
		const standardRegex = /!\[.*?\]\((.*?)\)/g;
		let match;

		while ((match = standardRegex.exec(content)) !== null) {
			if (match[1]) {
				imageLinks.push(match[1]);
			}
		}

		// Match Obsidian wiki-link image syntax: ![[image.png]]
		const wikiRegex = /!\[\[(.*?)\]\]/g;
		while ((match = wikiRegex.exec(content)) !== null) {
			if (match[1]) {
				imageLinks.push(match[1]);
			}
		}

		// Match HTML image tags: <img src="path/to/image.png" />
		const htmlRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/g;
		while ((match = htmlRegex.exec(content)) !== null) {
			if (match[1]) {
				imageLinks.push(match[1]);
			}
		}

		return imageLinks;
	}

	getFileFromLink(link: string): TFile | null {
		// Remove any anchor or query parameters
		link = link.split("#")[0].split("?")[0];

		// Try to resolve the file from the link
		const file = this.app.metadataCache.getFirstLinkpathDest(link, "");
		return file || null;
	}

	getMimeType(extension: string): string {
		const mimeTypes: Record<string, string> = {
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			png: "image/png",
			gif: "image/gif",
			svg: "image/svg+xml",
			webp: "image/webp",
			bmp: "image/bmp",
			tiff: "image/tiff",
			tif: "image/tiff",
		};

		return mimeTypes[extension.toLowerCase()] || "application/octet-stream";
	}

	/** One-shot scan of the selected folder and upload every unseen note */
	async initialHarvest() {
		// Check settings before proceeding
		if (!this.checkRequiredSettings()) {
			this.debug("Settings incomplete, skipping initial harvest");
			return;
		}

		const folder = this.getFolderFromSettings();
		if (!folder) {
			this.debug("Selected folder not found, skipping initial harvest");
			return;
		}

		const files = this.getMarkdownFilesInFolder(folder);

		let queued = 0;
		for (const f of files) {
			if (this.uploaded[f.path]) continue; // already sent
			queued++;
			await this.uploadNote(f);
		}
		if (queued) new Notice(`Initial sync: uploaded ${queued} new note(s)`);
	}

	private refreshUi() {
		/* status-bar text */
		if (this.inFlight) {
			this.statusEl.setText(`⟳ ${this.inFlight} uploading…`);
		} else if (this.failed.length) {
			this.statusEl.setText(
				`⚠︎ ${this.failed.length} failed – click Idealite`
			);
		} else {
			this.statusEl.setText("✓ Synced");
		}

		/* ribbon tint */
		const cls = this.ribbonEl.classList;
		cls.remove("idealite-sync-error", "idealite-sync-busy");
		if (this.failed.length) cls.add("idealite-sync-error");
		else if (this.inFlight) cls.add("idealite-sync-busy");
	}

	private showErrorCenter() {
		new ErrorCenterModal(this.app, this.failed, async (paths) => {
			// retry callback
			for (const p of paths) {
				const file = this.app.vault.getAbstractFileByPath(p);
				if (file instanceof TFile) await this.uploadNote(file);
			}
		}).open();
	}
}

class ErrorCenterModal extends Modal {
	constructor(
		app: App,
		private errors: { path: string; error: string }[],
		private onRetry: (paths: string[]) => Promise<void>
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Upload errors" });

		const list = contentEl.createEl("ul");
		list.style.maxHeight = "250px";
		list.style.overflow = "auto";

		this.errors.forEach(({ path, error }) => {
			const li = list.createEl("li");
			li.createEl("code", { text: path });
			li.appendText(` — ${error}`);
		});

		const footer = contentEl.createDiv({ cls: "modal-action-buttons" });
		const retryBtn = footer.createEl("button", { text: "Retry failed" });
		footer.createEl("button", { text: "Close" }).onclick = () =>
			this.close();

		retryBtn.onclick = async () => {
			await this.onRetry(this.errors.map((e) => e.path));
			this.close();
		};
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class IdealiteUploadSettingTab extends PluginSettingTab {
	plugin: IdealiteUploadPlugin;

	constructor(app: App, plugin: IdealiteUploadPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		// Use setHeading() instead of createEl("h3")
		new Setting(containerEl).setName("API Connection").setHeading();

		new Setting(containerEl)
			.setName("API Token")
			.setDesc(
				"Authentication token for the API (leave empty if not required)"
			)
			.addText((text) =>
				text
					.setPlaceholder("Enter your API token")
					.setValue(this.plugin.settings.apiToken)
					.onChange(async (value) => {
						this.plugin.settings.apiToken = value;
						await this.plugin.saveAll();
					})
			);

		new Setting(containerEl).setName("Folder Settings").setHeading();

		// Add folder selection
		const folderSetting = new Setting(containerEl)
			.setName("Selected Folder")
			.setDesc(
				"Choose the folder to sync with Idealite. Only notes in this folder will be uploaded."
			)
			.addText((text) => {
				text.setPlaceholder("Example: folder/subfolder")
					.setValue(this.plugin.settings.selectedFolder)
					.onChange(async (value) => {
						this.plugin.settings.selectedFolder = value;
						await this.plugin.saveAll();
						await this.plugin.initialHarvest(); // kick it off immediately
					});

				// Add button to open folder selector
				text.inputEl.style.width = "50%";
				text.inputEl.addClass("selected-folder-input");
			})
			.addButton((button) => {
				button.setButtonText("Browse...").onClick(async () => {
					// Open folder selection modal
					const folderSelectionModal = new FolderSelectionModal(
						this.plugin.app,
						this.plugin,
						async (selectedFolder) => {
							// Update the text field and save settings
							const textField = containerEl.querySelector(
								".selected-folder-input"
							) as HTMLInputElement;
							if (textField) {
								textField.value = selectedFolder;
							}
							this.plugin.settings.selectedFolder =
								selectedFolder;
							await this.plugin.saveAll();
							await this.plugin.initialHarvest(); // kick it off immediately
						}
					);
					folderSelectionModal.open();
				});
			})
			.addButton((button) => {
				button.setButtonText("Verify Selection").onClick(async () => {
					this.verifyFolderSelection();
				});
			});

		new Setting(containerEl).setName("Upload Options").setHeading();

		new Setting(containerEl)
			.setName("Upload images")
			.setDesc("Upload embedded images with the note")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.uploadImages)
					.onChange(async (value) => {
						this.plugin.settings.uploadImages = value;
						await this.plugin.saveAll();
					})
			);

		new Setting(containerEl)
			.setName("Auto upload on save")
			.setDesc(
				"Automatically upload notes when they are saved (only for notes in the selected folder)"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoUpload)
					.onChange(async (value) => {
						this.plugin.settings.autoUpload = value;
						await this.plugin.saveAll();
					})
			);

		new Setting(containerEl).setName("Debugging").setHeading();

		new Setting(containerEl)
			.setName("Debug Mode")
			.setDesc("Enable detailed logging to help troubleshoot issues")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debugMode)
					.onChange(async (value) => {
						this.plugin.settings.debugMode = value;
						await this.plugin.saveAll();
					})
			);

		// Add info about the selected folder with clearer messaging
		if (
			this.plugin.settings.selectedFolder !== null &&
			this.plugin.settings.selectedFolder !== undefined
		) {
			if (this.plugin.settings.selectedFolder === "") {
				containerEl.createEl("div", {
					text: `The root folder is currently selected for Idealite sync. All notes in your vault can be uploaded.`,
					cls: "setting-item-description",
				});
			} else {
				containerEl.createEl("div", {
					text: `The folder "${this.plugin.settings.selectedFolder}" is currently selected for Idealite sync. Only notes in this folder will be uploaded.`,
					cls: "setting-item-description",
				});
			}
		} else {
			containerEl.createEl("div", {
				text: "No folder selected. Please select a folder to enable uploads.",
				cls: "setting-item-description",
			});
		}
	}

	verifyFolderSelection() {
		const folderPath = this.plugin.settings.selectedFolder;

		// Handle case where no folder is selected
		if (folderPath === null || folderPath === undefined) {
			new Notice("No folder selected. Please select a folder first.");
			return;
		}

		// Handle root folder case
		if (folderPath === "") {
			// Count markdown files in the entire vault
			const allFiles = this.plugin.app.vault.getMarkdownFiles();
			new Notice(
				`Root folder selected. Found ${allFiles.length} markdown files in your vault.`
			);
			return;
		}

		// Check if the folder exists
		const folder = this.plugin.app.vault.getFolderByPath(folderPath);

		if (!folder) {
			new Notice(
				`Error: Folder "${folderPath}" not found. Please check the path.`
			);
			return;
		}

		// Count markdown files in the folder
		const files = this.plugin.getMarkdownFilesInFolder(folder);

		// Create detailed notice
		const message = `
Folder verification:
- Folder: ${folderPath}
- Found: ${folder ? "Yes" : "No"}
- Markdown files: ${files.length}
- First few files: ${files
			.slice(0, 3)
			.map((f) => f.name)
			.join(", ")}${files.length > 3 ? "..." : ""}
`;

		new Notice(message.trim());
	}
}

// Modal for folder selection
class FolderSelectionModal extends Modal {
	plugin: IdealiteUploadPlugin;
	onSelect: (folderPath: string) => void;

	constructor(
		app: App,
		plugin: IdealiteUploadPlugin,
		onSelect: (folderPath: string) => void
	) {
		super(app);
		this.plugin = plugin;
		this.onSelect = onSelect;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Select Folder to Sync" });

		// Create a container for the folder list
		const folderListContainer = contentEl.createDiv({
			cls: "folder-list-container",
		});

		// Add some styles to make items clearly clickable
		folderListContainer.style.maxHeight = "400px";
		folderListContainer.style.overflow = "auto";
		folderListContainer.style.border =
			"1px solid var(--background-modifier-border)";
		folderListContainer.style.padding = "10px";
		folderListContainer.style.marginBottom = "20px";

		// Get all folders in the vault
		const folders = this.getFolders();

		if (folders.length === 0) {
			folderListContainer.createEl("div", {
				text: "No folders found in the vault.",
				cls: "setting-item-description",
			});
		}

		// Add root folder option
		const rootFolderEl = folderListContainer.createDiv();
		rootFolderEl.style.padding = "5px 10px";
		rootFolderEl.style.cursor = "pointer";
		rootFolderEl.style.borderRadius = "4px";
		rootFolderEl.style.marginBottom = "5px";
		rootFolderEl.style.backgroundColor = "var(--background-secondary)";

		rootFolderEl.createEl("span", { text: "/ (Root)" });
		rootFolderEl.addEventListener("click", () => {
			console.log("Root folder selected");
			this.onSelect("");
			this.close();
		});

		// Add all folders
		for (const folder of folders) {
			const folderEl = folderListContainer.createDiv();

			// Add styles to make it visibly clickable
			folderEl.style.padding = "5px 10px";
			folderEl.style.cursor = "pointer";
			folderEl.style.borderRadius = "4px";
			folderEl.style.marginBottom = "5px";
			folderEl.style.backgroundColor = "var(--background-primary-alt)";

			// Add hover effect
			folderEl.addEventListener("mouseenter", () => {
				folderEl.style.backgroundColor =
					"var(--background-modifier-hover)";
			});

			folderEl.addEventListener("mouseleave", () => {
				folderEl.style.backgroundColor =
					"var(--background-primary-alt)";
			});

			// Add indentation based on nesting level
			const indentation = folder.path.split("/").length - 1;
			folderEl.style.paddingLeft = `${indentation * 20 + 10}px`;

			folderEl.createEl("span", { text: folder.path });
			folderEl.addEventListener("click", () => {
				console.log(`Selected folder: ${folder.path}`);
				this.onSelect(folder.path);
				this.close();
			});
		}

		// Add a help message
		const helpText = contentEl.createEl("div", {
			text: "Click on a folder to select it. The list is scrollable if you have many folders.",
			cls: "setting-item-description",
		});
		helpText.style.marginTop = "10px";
	}

	getFolders() {
		const folders: { path: string }[] = [];

		try {
			// Get all folders in the vault
			const allFiles = this.plugin.app.vault.getAllLoadedFiles();

			// Filter to just get folders
			for (const file of allFiles) {
				if (file instanceof TFolder && file.path !== "/") {
					folders.push({ path: file.path });
				}
			}
		} catch (error) {
			console.error("Error getting folders:", error);
		}

		return folders;
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

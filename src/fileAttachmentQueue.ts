import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { validateAndEncode, enqueueFile } from './attachmentValidation';

export type { QueuedFile } from './attachmentValidation';

export class FileAttachmentQueue {
    private files: import('./attachmentValidation').QueuedFile[] = [];
    private statusBar: vscode.StatusBarItem;

    constructor() {
        this.statusBar = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100,
        );
        this.statusBar.command = 'synapse.clearAttachments';
        this.statusBar.tooltip = 'Files queued for next Synapse message — click to clear';
    }

    /** Open a file picker and enqueue the selected file. */
    async pickAndEnqueue(): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Attach to Synapse',
            filters: {
                'Supported files': ['md', 'pdf', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'txt', 'csv'],
            },
        });

        if (!uris || uris.length === 0) {
            return;
        }

        const filePath = uris[0].fsPath;
        const filename = path.basename(filePath);
        const ext = path.extname(filePath);

        let stat: fs.Stats;
        try {
            stat = fs.statSync(filePath);
        } catch {
            vscode.window.showErrorMessage(`Synapse: cannot read file "${filePath}"`);
            return;
        }

        let raw: Buffer;
        try {
            raw = fs.readFileSync(filePath);
        } catch {
            vscode.window.showErrorMessage(`Synapse: failed to read "${filePath}"`);
            return;
        }

        const result = validateAndEncode(filename, ext, stat.size, raw);
        if (!result.ok) {
            vscode.window.showErrorMessage(`Synapse: ${result.detail}`);
            return;
        }

        const { queue, replaced } = enqueueFile(this.files, result.entry);
        this.files = queue;
        this.updateStatusBar();

        if (replaced) {
            vscode.window.showInformationMessage(`Synapse: replaced queued file "${filename}"`);
        } else {
            vscode.window.showInformationMessage(
                `Synapse: "${filename}" queued — it will be attached to your next message.`
            );
        }
    }

    /** Return queued files and clear the queue. Called when a message is sent. */
    flush(): import('./attachmentValidation').QueuedFile[] {
        const queued = [...this.files];
        this.files = [];
        this.updateStatusBar();
        return queued;
    }

    /** Remove one file by name. No-op if not found. */
    removeByName(filename: string): void {
        const idx = this.files.findIndex(f => f.filename === filename);
        if (idx >= 0) {
            this.files.splice(idx, 1);
            this.updateStatusBar();
        }
    }

    /** Discard all queued files. */
    clear(): void {
        if (this.files.length === 0) {
            vscode.window.showInformationMessage('Synapse: no files queued.');
            return;
        }
        const names = this.files.map(f => f.filename).join(', ');
        this.files = [];
        this.updateStatusBar();
        vscode.window.showInformationMessage(`Synapse: cleared queued files (${names})`);
    }

    /** Names of currently queued files — for display in the panel bar. */
    queuedNames(): string[] {
        return this.files.map(f => f.filename);
    }

    hasFiles(): boolean {
        return this.files.length > 0;
    }

    private updateStatusBar(): void {
        if (this.files.length === 0) {
            this.statusBar.hide();
            return;
        }
        this.statusBar.text = `$(paperclip) ${this.files.length} file${this.files.length > 1 ? 's' : ''} queued`;
        this.statusBar.show();
    }

    dispose(): void {
        this.statusBar.dispose();
    }
}

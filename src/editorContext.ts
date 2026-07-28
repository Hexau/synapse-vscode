import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Buffer } = require('buffer') as { Buffer: typeof import('buffer').Buffer };

interface Diagnostic {
    line: number;
    message: string;
    severity: 'error' | 'warning' | 'info';
}

interface EditorState {
    file: string;
    language: string;
    cursor_line: number;
    cursor_col: number;
    selection: string;
    diagnostics: Diagnostic[];
    workspace: string;
    context_id: string;
}

type StateCallback = (state: { file: string; cursor_line: number; diagnostics_count: number }) => void;
type ContextIdCallback = (id: string) => void;

export class EditorContextWatcher {
    private contextId = '';
    private lastSent = '';
    private sendTimer: ReturnType<typeof setTimeout> | undefined;
    private disposables: vscode.Disposable[] = [];
    private onContextId?: ContextIdCallback;

    setContextIdCallback(cb: ContextIdCallback) { this.onContextId = cb; }

    constructor(
        private extensionContext: vscode.ExtensionContext,
        private onStateChange?: StateCallback,
    ) {
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
            vscode.window.onDidChangeTextEditorSelection(() => this.schedule()),
            vscode.languages.onDidChangeDiagnostics(() => this.schedule()),
        );
    }

    setContextId(id: string) {
        this.contextId = id;
        this.lastSent = ''; // force re-send with new context id
        this.onContextId?.(id);
        this.schedule();
    }

    getContextId() { return this.contextId; }

    // Force a fresh POST regardless of whether the state looks unchanged.
    // The initial send is fire-and-forget (see send()) and silently drops if
    // the backend isn't reachable yet (e.g. mid-restart) — with no editor
    // activity afterward there's nothing to naturally retrigger it, leaving
    // the session with no editor context for its entire duration. Call this
    // whenever we get a fresh signal the backend is actually up (CLI
    // reconnected) so a dropped initial POST self-heals.
    forceResend() {
        this.lastSent = '';
        this.schedule();
    }

    private schedule() {
        if (this.sendTimer) { clearTimeout(this.sendTimer); }
        this.sendTimer = setTimeout(() => this.send(), 600);
    }

    private buildState(): EditorState | null {
        const cfg = vscode.workspace.getConfiguration('synapse');
        if (!cfg.get('sendEditorContext')) { return null; }

        const editor = vscode.window.activeTextEditor;
        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

        if (!editor) {
            // No file focused (e.g. user is only looking at the chat panel) —
            // still report the workspace so "analyze this project"-style
            // questions work without requiring a specific file to be open.
            if (!workspace) { return null; }
            return {
                file: '', language: '', cursor_line: 0, cursor_col: 0,
                selection: '', diagnostics: [], workspace,
                context_id: this.contextId,
            };
        }

        const doc = editor.document;
        const sel = editor.selection;
        const selectedText = doc.getText(sel).slice(0, 2000);

        let diagnostics: Diagnostic[] = [];
        if (cfg.get('sendDiagnostics')) {
            diagnostics = vscode.languages
                .getDiagnostics(doc.uri)
                .slice(0, 20)
                .map(d => ({
                    line: d.range.start.line + 1,
                    message: d.message,
                    severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error'
                        : d.severity === vscode.DiagnosticSeverity.Warning ? 'warning' : 'info',
                }));
        }

        return {
            file: doc.fileName,
            language: doc.languageId,
            cursor_line: sel.active.line + 1,
            cursor_col: sel.active.character + 1,
            selection: selectedText,
            diagnostics,
            workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
            context_id: this.contextId,
        };
    }

    private send() {
        const state = this.buildState();

        // Update status pill regardless of contextId
        if (state && this.onStateChange) {
            this.onStateChange({
                file: state.file,
                cursor_line: state.cursor_line,
                diagnostics_count: state.diagnostics.length,
            });
        }

        // Only POST to backend if we have a context
        if (!this.contextId || !state) { return; }

        const body = JSON.stringify(state);
        if (body === this.lastSent) { return; }
        this.lastSent = body;

        const synapseCfg = vscode.workspace.getConfiguration('synapse');
        const serverUrl = synapseCfg.get<string>('serverUrl', 'http://localhost:5000');
        const apiToken = synapseCfg.get<string>('apiToken', '');
        const url = new URL('/api/editor_context', serverUrl);
        const lib = url.protocol === 'https:' ? https : http;

        const req = lib.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                ...(apiToken ? { 'X-API-Token': apiToken } : {}),
            },
        }, () => {});

        req.on('error', () => {}); // silent — server may not be running yet
        req.write(body);
        req.end();
    }

    dispose() {
        if (this.sendTimer) { clearTimeout(this.sendTimer); }
        this.disposables.forEach(d => d.dispose());
    }
}

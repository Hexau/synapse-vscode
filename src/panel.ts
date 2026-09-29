import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { generateAllThemesCss } from '@synapse/tokens';
import { SynapseRestClient } from '@synapse/protocol';
import { EditorContextWatcher } from './editorContext';
import { FileAttachmentQueue, QueuedFile } from './fileAttachmentQueue';

// Shared design tokens (see synapse-tokens/src/web.ts) as CSS custom
// properties (--synapse-you, --synapse-accent, etc.), computed once at
// module load. Injected additively at the top of the <style> block below —
// the existing hardcoded hex rules in this file are untouched and keep
// rendering exactly as before; consuming var(--synapse-*) instead of a
// literal hex in those rules is the natural next step, not done here to
// keep this change to "make the tokens present and inspectable", not a
// rewrite of every rule in a file this session hasn't otherwise touched.
const SYNAPSE_TOKENS_CSS = generateAllThemesCss();

export class SynapseSidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'synapse.chatView';
    private view?: vscode.WebviewView;
    private pingTimer?: ReturnType<typeof setInterval>;
    private serverUrl = 'http://localhost:5000';
    // true once the iframe was built WITH a real ?ctxid=. If resolveWebviewView
    // fired before the extension's context id was ready (session restoration
    // can race ahead of activate() — see buildFrameUrl()), this stays false and
    // syncContextId() rebuilds the iframe the moment a real id shows up,
    // instead of leaving the WebUI stuck on the random id it picked for itself.
    private frameHasCtxId = false;
    // Fase 2 - D*HUD (docs/decisions/2026-08-17-vscode-hud-not-walkthrough.md).
    // Uses the shared, typed REST client (Fase 1's usage_summary/token_status
    // + Fase 2's session_goal endpoints) instead of hand-rolling another raw
    // http.get pair like sendMessageWithAttachments below does — that method
    // predates @synapse/protocol having a client worth reusing.
    private readonly restClient: SynapseRestClient;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly watcher: EditorContextWatcher,
        private readonly attachmentQueue?: FileAttachmentQueue,
    ) {
        this.serverUrl = vscode.workspace
            .getConfiguration('synapse')
            .get<string>('serverUrl', 'http://localhost:5000');
        this.restClient = new SynapseRestClient({ serverUrl: this.serverUrl });
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [],
        };

        const frameUrl = this.buildFrameUrl();
        webviewView.webview.html = this.buildHtml(frameUrl);

        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'copy_text' && typeof msg.text === 'string') {
                vscode.env.clipboard.writeText(msg.text);
            }
            // Note: 'context_id' messages bubbled up from the WebUI iframe are
            // intentionally ignored. The extension's context_id is the single
            // source of truth (hostname+workspace hash, injected into the
            // iframe via ?ctxid=); accepting it back would let any incidental
            // chat the WebUI lands on (race conditions, stale sessionStorage,
            // failed chat_ensure calls) silently hijack this window's stable
            // id, cascading into a new random id on every subsequent message.
            if (msg.type === 'ready') {
                this.ping();
            }
            if (msg.type === 'attach_file') {
                vscode.commands.executeCommand('synapse.attachFile');
            }
            if (msg.type === 'remove_attachment' && msg.filename) {
                this.attachmentQueue?.removeByName(msg.filename);
                this.postAttachmentState(this.attachmentQueue?.queuedNames() ?? []);
            }
            if (msg.type === 'clear_attachments') {
                vscode.commands.executeCommand('synapse.clearAttachments');
            }
            if (msg.type === 'send_with_attachments' && msg.text) {
                const text = msg.text as string;
                const files = this.attachmentQueue?.flush() ?? [];
                const contextId = this.watcher.getContextId();
                this.postAttachmentState([]);
                const dedupedFiles = this.deduplicateAgainstEditorContext(files);
                this.sendMessageWithAttachments(text, contextId, dedupedFiles);
            }
        });

        // Start pinging from Node.js (bypasses WebView fetch restrictions)
        this.startPing();

        webviewView.onDidDispose(() => {
            if (this.pingTimer) { clearInterval(this.pingTimer); }
        });
    }

    private buildFrameUrl(): string {
        // Append the extension's context_id so the WebUI creates/attaches its
        // chat to exactly this id (see chat_ensure.py) — without this, the
        // WebUI picks a random unrelated id and editor context posted under
        // this extension's context_id never reaches the chat the user sees.
        const contextId = this.watcher.getContextId();
        if (!contextId) {
            this.frameHasCtxId = false;
            return this.serverUrl;
        }
        try {
            const url = new URL(this.serverUrl);
            url.searchParams.set('ctxid', contextId);
            this.frameHasCtxId = true;
            return url.toString();
        } catch {
            this.frameHasCtxId = false;
            return this.serverUrl;
        }
    }

    // Called from watcher.setContextIdCallback on every context id
    // (re)application (activation's redundant applyActiveContextId() pass,
    // synapse.setContextId, workspace-folder changes). No-ops once the
    // iframe already has a real ctxid — this only exists to self-heal the
    // race where resolveWebviewView ran before the id was ready and the
    // WebUI already latched onto its own random chat id.
    syncContextId(): void {
        if (this.frameHasCtxId || !this.view) { return; }
        if (!this.watcher.getContextId()) { return; }
        const frameUrl = this.buildFrameUrl();
        this.view.webview.html = this.buildHtml(frameUrl);
    }

    private startPing() {
        if (this.pingTimer) { clearInterval(this.pingTimer); }
        this.ping();
        void this.refreshHud();
        this.pingTimer = setInterval(() => { this.ping(); void this.refreshHud(); }, 15000);
    }

    // Fase 2 - D*HUD: no turn-completion event to hook here the way
    // synapse-cli's App.tsx does (ws.onComplete) — this panel is chrome
    // around an iframe of the WebUI; the actual chat session lives inside
    // that iframe, invisible to this class. Piggybacking on the existing
    // 15s ping interval is the only recurring cycle already established,
    // and token_status.py's own docstring notes ctx_window only changes
    // once per LLM turn anyway, so 15s is a reasonable enough cadence
    // without inventing a second polling loop.
    private async refreshHud() {
        const contextId = this.watcher.getContextId();
        if (!contextId) { return; }

        const apiToken = vscode.workspace.getConfiguration('synapse').get<string>('apiToken', '');
        this.restClient.updateApiToken(apiToken);

        try {
            const [tokenStatus, goalStatus] = await Promise.all([
                this.restClient.getTokenStatus(contextId),
                this.restClient.getSessionGoal(contextId),
            ]);
            this.view?.webview.postMessage({
                type: 'hud_update',
                tokenCount: tokenStatus.token_count,
                contextWindow: tokenStatus.context_window,
                goal: goalStatus.goal,
            });
        } catch {
            // Best-effort — the HUD just keeps showing its last known values.
        }
    }

    private ping() {
        const url = new URL('/api/health', this.serverUrl);
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.get(url.toString(), (res) => {
            const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400;
            this.view?.webview.postMessage({ type: 'ping', ok });
        });
        req.on('error', () => {
            this.view?.webview.postMessage({ type: 'ping', ok: false });
        });
        req.setTimeout(4000, () => {
            req.destroy();
            this.view?.webview.postMessage({ type: 'ping', ok: false });
        });
    }

    postEditorState(state: { file: string; cursor_line: number; diagnostics_count: number }) {
        this.view?.webview.postMessage({ type: 'editor_state', ...state });
    }

    postAttachmentState(filenames: string[]) {
        this.view?.webview.postMessage({ type: 'attachment_state', filenames });
    }

    private deduplicateAgainstEditorContext(files: QueuedFile[]): QueuedFile[] {
        const cfg = vscode.workspace.getConfiguration('synapse');
        if (!cfg.get<boolean>('sendEditorContext', true)) {
            return files; // editor context is off — nothing to deduplicate against
        }

        const activeFilePath = vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!activeFilePath) {
            return files;
        }

        const activeName = path.basename(activeFilePath);
        const skipped = files.filter(f => f.filename === activeName);
        if (skipped.length === 0) {
            return files;
        }

        vscode.window.showInformationMessage(
            `Synapse: "${activeName}" is already sent as editor context — skipped from attachments.`
        );
        return files.filter(f => f.filename !== activeName);
    }

    private sendMessageWithAttachments(message: string, contextId: string, files: QueuedFile[]): void {
        const url = new URL('/api/plugins/_a0_connector/v1/message_send', this.serverUrl);
        const body = JSON.stringify({
            message,
            ...(contextId ? { context_id: contextId } : {}),
            attachments: files.map(f => ({ filename: f.filename, base64: f.base64 })),
        });
        const apiToken = vscode.workspace.getConfiguration('synapse').get<string>('apiToken', '');
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request(
            url.toString(),
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    ...(apiToken ? { 'X-API-Token': apiToken } : {}),
                },
            },
            (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        vscode.window.showErrorMessage(
                            `Synapse: message send failed (${res.statusCode}): ${data.slice(0, 200)}`
                        );
                    }
                });
            }
        );
        req.on('error', (e: Error) => {
            vscode.window.showErrorMessage(`Synapse: failed to send message — ${e.message}`);
        });
        req.setTimeout(120000, () => { req.destroy(); });
        req.write(body);
        req.end();
    }

    focus() {
        this.view?.show(true);
    }

    private buildHtml(serverUrl: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; frame-src *; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <style>
    ${SYNAPSE_TOKENS_CSS}

    * { margin:0; padding:0; box-sizing:border-box; }

    #bar {
      display:flex; align-items:center; gap:6px;
      padding:3px 8px; height:24px;
      background:#252526; border-bottom:1px solid #333;
      font:11px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      color:#bbb;
      flex-shrink:0;
    }
    #dot { width:7px;height:7px;border-radius:50%;background:#555;flex-shrink:0;transition:background .3s; }
    #dot.ok  { background:#4caf50; }
    #dot.err { background:#f44336; }
    #bar-txt { flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
    #pill {
      background:#2a2a2a;border:1px solid #3a3a3a;border-radius:8px;
      padding:1px 6px;font-size:10px;color:#888;
      max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
    #pill.warn { border-color:#a07820;color:#c9a227; }
    /* Fase 2 - D*HUD (docs/decisions/2026-08-17-vscode-hud-not-walkthrough.md):
       token/goal strip, refreshed alongside the existing 15s ping. Colors
       reuse @synapse/tokens' shared roles (Fase 1 - F) — same warn/error
       hues the CLI's HUD and the WebUI use, not new one-off values. */
    #hud {
      background:#2a2a2a;border:1px solid #3a3a3a;border-radius:8px;
      padding:1px 6px;font-size:10px;color:#888;
      max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
    #hud.hidden { display:none; }
    #hud.hud-warn { border-color:#a07820; color:var(--synapse-warn, #c9a227); }
    #hud.hud-crit { border-color:#7a2c22; color:var(--synapse-error, #f44336); }
    #hud .goal-active { color:var(--synapse-accent, #4fc1ff); }
    #hud .goal-paused { color:#888; }
    #hud .goal-blocked { color:var(--synapse-error, #f44336); }
    #hud .goal-budget_limited { color:var(--synapse-warn, #c9a227); }
    #attach-btn {
      background:none;border:none;cursor:pointer;
      color:#888;font-size:14px;padding:0 2px;line-height:1;
      flex-shrink:0;display:flex;align-items:center;
    }
    #attach-btn:hover { color:#ccc; }

    #chips-bar {
      display:none;flex-wrap:wrap;gap:4px;align-items:center;
      padding:3px 8px;
      background:#1f1f1f;border-bottom:1px solid #333;
      font:10px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      flex-shrink:0;
    }
    #chips-bar.visible { display:flex; }
    .chip {
      display:inline-flex;align-items:center;gap:3px;
      background:#2d2d2d;border:1px solid #3c3c3c;border-radius:10px;
      padding:1px 6px;color:#bbb;max-width:140px;
    }
    .chip-name { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
    .chip-x {
      background:none;border:none;cursor:pointer;color:#666;
      font-size:11px;padding:0;line-height:1;flex-shrink:0;
    }
    .chip-x:hover { color:#f44336; }

    #send-bar {
      display:none; align-items:center; gap:4px;
      padding:3px 8px 4px;
      background:#1f1f1f; border-bottom:1px solid #333;
      flex-shrink:0;
    }
    #send-bar.visible { display:flex; }
    #send-input {
      flex:1; background:#2a2a2a; border:1px solid #3c3c3c; border-radius:4px;
      color:#ccc; font:11px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      padding:3px 6px; outline:none;
    }
    #send-input:focus { border-color:#007acc; }
    #send-input::placeholder { color:#555; }
    #send-btn {
      background:#0e639c; color:#fff; border:none; border-radius:4px;
      cursor:pointer; font-size:13px; padding:2px 8px; flex-shrink:0; line-height:1.4;
    }
    #send-btn:hover { background:#1177bb; }

    html, body { height:100%;background:#1e1e1e;overflow:hidden;display:flex;flex-direction:column; }
    #frame { width:100%;flex:1;border:none;display:none; }

    #splash {
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      flex:1;gap:12px;
      color:#666;font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      text-align:center;padding:24px;
    }
    #splash .bolt { font-size:36px;margin-bottom:4px; }
    #splash code { background:#2a2a2a;padding:2px 6px;border-radius:3px;font-size:12px;color:#ccc; }
    #splash button {
      margin-top:8px;padding:6px 18px;
      background:#0e639c;color:#fff;border:none;border-radius:4px;
      cursor:pointer;font-size:12px;
    }
    #splash button:hover { background:#1177bb; }
  </style>
</head>
<body>
  <div id="bar">
    <span id="dot"></span>
    <span id="bar-txt">Connecting…</span>
    <span id="pill">no file open</span>
    <span id="hud" class="hidden"></span>
    <button id="attach-btn" title="Attach file to next message (Ctrl+Shift+A)">📎</button>
  </div>
  <div id="chips-bar"></div>
  <div id="send-bar">
    <input id="send-input" type="text" placeholder="Message (files will be attached)…" autocomplete="off">
    <button id="send-btn" title="Send message with attachments">↑</button>
  </div>

  <iframe id="frame" src="${serverUrl}" allow="clipboard-read; clipboard-write"></iframe>

  <div id="splash">
    <div class="bolt">⚡</div>
    <div>Synapse is not running.<br>Start it with <code>python run_ui.py</code></div>
    <button id="retry-btn">Retry</button>
  </div>

  <script>
    const vscode    = acquireVsCodeApi();
    const dot       = document.getElementById('dot');
    const bartxt    = document.getElementById('bar-txt');
    const pill      = document.getElementById('pill');
    const hud       = document.getElementById('hud');
    const frame     = document.getElementById('frame');
    const splash    = document.getElementById('splash');
    const chipsBar  = document.getElementById('chips-bar');
    const attachBtn = document.getElementById('attach-btn');
    const sendBar   = document.getElementById('send-bar');
    const sendInput = document.getElementById('send-input');
    const sendBtn   = document.getElementById('send-btn');

    attachBtn.onclick = () => vscode.postMessage({ type: 'attach_file' });

    function submitMessage() {
      const text = sendInput.value.trim();
      if (!text) return;
      sendInput.value = '';
      vscode.postMessage({ type: 'send_with_attachments', text });
    }

    sendBtn.onclick = submitMessage;
    sendInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitMessage(); }
    });

    document.getElementById('retry-btn').onclick = () => {
      frame.src = '${serverUrl}';
      vscode.postMessage({ type: 'ready' });
    };

    function setOnline(ok) {
      dot.className      = ok ? 'ok' : 'err';
      bartxt.textContent = ok ? 'Synapse connected' : 'Synapse not reachable — is it running?';
      frame.style.display  = ok ? 'block' : 'none';
      splash.style.display = ok ? 'none'  : 'flex';
    }

    function renderChips(filenames) {
      chipsBar.innerHTML = '';
      const hasFiles = filenames && filenames.length > 0;
      chipsBar.classList.toggle('visible', hasFiles);
      sendBar.classList.toggle('visible', hasFiles);
      if (!hasFiles) {
        sendInput.value = '';
        return;
      }
      filenames.forEach(name => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.title = name;

        const label = document.createElement('span');
        label.className = 'chip-name';
        label.textContent = name;

        const x = document.createElement('button');
        x.className = 'chip-x';
        x.textContent = '✕';
        x.title = 'Remove ' + name;
        x.onclick = () => vscode.postMessage({ type: 'remove_attachment', filename: name });

        chip.appendChild(label);
        chip.appendChild(x);
        chipsBar.appendChild(chip);
      });
      sendInput.focus();
    }

    function renderHud(data) {
      const parts = [];

      if (data.tokenCount != null && data.contextWindow > 0) {
        const ratio = data.tokenCount / data.contextWindow;
        const pct = Math.round(ratio * 100);
        parts.push({
          text: data.tokenCount.toLocaleString() + '/' + data.contextWindow.toLocaleString() + ' tok (' + pct + '%)',
          cls: ratio >= 0.9 ? 'hud-crit' : ratio >= 0.7 ? 'hud-warn' : '',
        });
      }

      if (data.goal) {
        const label = data.goal.status === 'active'
          ? 'goal: active (' + data.goal.turns_used + ')'
          : 'goal: ' + data.goal.status;
        parts.push({ text: label, cls: 'goal-' + data.goal.status });
      }

      if (parts.length === 0) {
        hud.classList.add('hidden');
        hud.textContent = '';
        return;
      }

      // Only one badge fits comfortably in the top bar — token pressure wins
      // when both are present, since it's the one that can actually block
      // the next turn; the goal strip is still one /goal away in the chat.
      const shown = parts[0];
      hud.className = shown.cls;
      hud.textContent = shown.text;
      hud.title = parts.map(p => p.text).join(' — ');
    }

    window.addEventListener('message', e => {
      const msg = e.data;
      if (!msg || !msg.type) return;

      if (msg.type === 'ping') { setOnline(msg.ok); return; }
      if (msg.type === 'hud_update') { renderHud(msg); return; }

      if (msg.type === 'editor_state') {
        const name = msg.file ? msg.file.replace(/.*[\\\\/]/, '') : '';
        if (!name) { pill.textContent = 'no file open'; pill.className = ''; return; }
        if (msg.diagnostics_count > 0) {
          pill.textContent = '⚠ ' + name + ':' + msg.cursor_line + ' (' + msg.diagnostics_count + ')';
          pill.className = 'warn';
        } else {
          pill.textContent = name + ':' + msg.cursor_line;
          pill.className = '';
        }
        return;
      }

      if (msg.type === 'attachment_state') {
        renderChips(msg.filenames);
        return;
      }

      // Note: context_id is intentionally NOT bubbled from the iframe anymore
      // — the extension's hash-derived id is the single source of truth.

      // bubble copy requests from Synapse iframe → extension host, since
      // navigator.clipboard / execCommand are blocked inside this webview
      if (msg.type === 'copy_text' && typeof msg.text === 'string') {
        vscode.postMessage({ type: 'copy_text', text: msg.text });
      }
    });

    // Forward messages from the Synapse iframe to this window
    frame.addEventListener('load', () => {
      try {
        frame.contentWindow.addEventListener('message', ev => {
          window.postMessage(ev.data, '*');
        });
      } catch(_) {}
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
    }
}

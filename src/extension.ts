import * as vscode from 'vscode';
import * as os from 'os';
import * as crypto from 'crypto';
import { SynapseSidebarProvider } from './panel';
import { EditorContextWatcher } from './editorContext';
import { CliClient } from './cliClient';
import { FileAttachmentQueue } from './fileAttachmentQueue';
import { HooksProvider, HookItem, CatalogHook, writeProjectHook } from './hooksProvider';
import { DiscoveredHook, slugify, hookTemplate, duplicateTemplate } from './hookFiles';

let watcher: EditorContextWatcher | undefined;
let provider: SynapseSidebarProvider | undefined;
let cli: CliClient | undefined;
let attachmentQueue: FileAttachmentQueue | undefined;
let hooksProvider: HooksProvider | undefined;

const _reindexTimers = new Map<string, ReturnType<typeof setTimeout>>();
const REINDEX_DEBOUNCE_MS = 3000;

// Derives a stable context id from hostname + workspace path so multiple
// VSCode windows (same machine or different machines on a shared server)
// don't collide, without requiring manual setup.
function computeAutoContextId(): string {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'no-workspace';
    const raw = `${os.hostname()}|${workspacePath}`;
    return crypto.createHash('md5').update(raw).digest('hex').slice(0, 8);
}

// Applies whichever context id is active: the user's manual override if set
// in settings, otherwise the auto-derived one. Safe to call repeatedly.
function applyActiveContextId(): void {
    const cfg = vscode.workspace.getConfiguration('synapse');
    const manual = cfg.get<string>('contextId', '').trim();
    const id = manual || computeAutoContextId();
    watcher?.setContextId(id);
    cli?.updateContextId(id);
}

export function activate(context: vscode.ExtensionContext) {
    const serverUrl = vscode.workspace
        .getConfiguration('synapse')
        .get<string>('serverUrl', 'http://localhost:5000');

    cli = new CliClient(serverUrl, (connected) => {
        if (connected) {
            vscode.window.setStatusBarMessage('$(plug) Synapse CLI connected', 3000);
            // The CLI socket only reconnects once the backend is actually
            // reachable — a reliable signal to retry any editor-context POST
            // that silently failed while the backend was down/restarting.
            watcher?.forceResend();
            // Same reasoning for the codebase index: a backend restart wipes
            // its in-memory connector state (including the context_id→workspace
            // binding), and index_project otherwise only fires on activation /
            // workspace change / file save — none of which re-fire for an
            // already-open folder after a restart. Re-announce the open
            // workspace here so the binding + mirror self-heal on every
            // reconnect, without the user having to close/reopen the folder.
            // Debounced (shared per-folder timer) against reconnect storms.
            const folders = vscode.workspace.workspaceFolders;
            if (folders?.length) {
                scheduleReindexForPath(serverUrl, folders[0].uri.fsPath);
            }
            // Re-publicar el catálogo de hooks por la misma razón: si el
            // backend perdió su caché, la WebUI se quedaría sin botones hasta
            // que alguien tocara un archivo de hooks. Un refresh completo, no
            // solo el sync, porque la reconexión también recupera los hooks de
            // fábrica si esta vista estaba en modo offline.
            hooksProvider?.refresh();
        }
    });
    cli.updateApiToken(vscode.workspace.getConfiguration('synapse').get<string>('apiToken', ''));
    cli.start();
    context.subscriptions.push({ dispose: () => cli?.dispose() });

    attachmentQueue = new FileAttachmentQueue();
    context.subscriptions.push({ dispose: () => attachmentQueue?.dispose() });

    watcher = new EditorContextWatcher(context, onEditorStateChange);

    // Apply the context id BEFORE constructing/registering the sidebar
    // provider: VSCode can resolve a restored webview view very early
    // (session restoration can race with the rest of activate()), and
    // panel.ts's buildFrameUrl() reads watcher.getContextId() the moment
    // resolveWebviewView fires. If that races ahead of this call, the
    // iframe loads with no `?ctxid=` for the entire session.
    applyActiveContextId();

    provider = new SynapseSidebarProvider(context.extensionUri, watcher, attachmentQueue);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SynapseSidebarProvider.viewId,
            provider,
            { webviewOptions: { retainContextWhenHidden: true } }
        ),

        vscode.commands.registerCommand('synapse.openPanel', () => {
            vscode.commands.executeCommand('workbench.view.extension.synapse-sidebar');
        }),

        vscode.commands.registerCommand('synapse.setContextId', async () => {
            const cfg = vscode.workspace.getConfiguration('synapse');
            const id = await vscode.window.showInputBox({
                prompt: 'Enter Synapse context ID (leave empty for automatic)',
                value: cfg.get<string>('contextId', ''),
            });
            if (id !== undefined) {
                await cfg.update('contextId', id, vscode.ConfigurationTarget.Workspace);
                applyActiveContextId();
                const active = id.trim() || computeAutoContextId();
                vscode.window.showInformationMessage(
                    `Synapse: context set to ${active}${id.trim() ? '' : ' (auto)'}`
                );
            }
        }),

        vscode.commands.registerCommand('synapse.setApiToken', async () => {
            const cfg = vscode.workspace.getConfiguration('synapse');
            const token = await vscode.window.showInputBox({
                prompt: 'Enter your Synapse API token (from /api/my_account after logging into the WebUI)',
                value: cfg.get<string>('apiToken', ''),
                password: true,
            });
            if (token !== undefined) {
                await cfg.update('apiToken', token, vscode.ConfigurationTarget.Global);
                cli?.updateApiToken(token);
                vscode.window.showInformationMessage('Synapse: API token updated.');
            }
        }),

        vscode.commands.registerCommand('synapse.attachFile', async () => {
            await attachmentQueue?.pickAndEnqueue();
            provider?.postAttachmentState(attachmentQueue?.queuedNames() ?? []);
        }),

        vscode.commands.registerCommand('synapse.clearAttachments', () => {
            attachmentQueue?.clear();
            provider?.postAttachmentState([]);
        }),

        vscode.commands.registerCommand('synapse.refreshHooks', () => {
            hooksProvider?.refresh();
        }),

        // Llega el HookItem cuando viene del botón inline, y el CatalogHook
        // cuando se invoca desde la paleta de comandos.
        vscode.commands.registerCommand(
            'synapse.runHook',
            async (arg?: HookItem | CatalogHook) => {
                const hook = (arg as HookItem)?.hook ?? (arg as CatalogHook);
                if (!hook?.id) { return; }
                await runHook(serverUrl, hook);
            }
        ),

        vscode.commands.registerCommand(
            'synapse.showHookPrompt',
            async (arg?: HookItem | CatalogHook) => {
                const hook = (arg as HookItem)?.hook ?? (arg as CatalogHook);
                if (hook?.id) { await showHookPrompt(hook); }
            }
        ),

        vscode.commands.registerCommand('synapse.createHook', async () => {
            await createHook();
        }),

        vscode.commands.registerCommand('synapse.duplicateHook', async (item?: HookItem) => {
            await duplicateHook(item?.hook);
        }),

        vscode.commands.registerCommand('synapse.openHookFile', async (item?: HookItem) => {
            await openHookFile(item?.hook);
        }),
    );

    // Agent Hooks: los archivos del repo se leen aquí (fs nativo) porque viven
    // en el disco del desarrollador, invisible para el contenedor del backend.
    // El catálogo mostrado se pide al backend, que le suma los de fábrica.
    hooksProvider = new HooksProvider(
        (hooks) => syncHooksToBackend(serverUrl, hooks),
        () => fetchHookCatalog(serverUrl),
        () => !!watcher?.getContextId(),
    );
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('synapse.hooksView', hooksProvider),
    );

    // Un hook nuevo debe aparecer sin reiniciar VSCode. Watcher propio (no el
    // de archivos indexables) porque los .json no están en esa lista.
    const hooksWatcher = vscode.workspace.createFileSystemWatcher(
        '**/{.a0hooks/*.hook.json,.kiro/hooks/*.kiro.hook}'
    );
    const refreshHooks = () => hooksProvider?.refresh();
    context.subscriptions.push(
        hooksWatcher,
        hooksWatcher.onDidCreate(refreshHooks),
        hooksWatcher.onDidChange(refreshHooks),
        hooksWatcher.onDidDelete(refreshHooks),
    );
    hooksProvider.refresh();

    // Wire context_id changes → CLI client
    watcher.setContextIdCallback((id) => cli?.updateContextId(id));

    // Apply context id: manual override from settings if present, otherwise
    // an id auto-derived from hostname + workspace path (no user action needed).
    applyActiveContextId();

    // Trigger codebase-memory-mcp indexing for the current workspace
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length) {
        triggerCodebaseIndex(serverUrl, folders[0].uri.fsPath);
    }
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(e => {
            // Re-derive the auto context id for the new workspace (no-op if a
            // manual override is configured — applyActiveContextId respects it).
            applyActiveContextId();
            if (e.added.length) {
                triggerCodebaseIndex(serverUrl, e.added[0].uri.fsPath);
            }
            // Los hooks son por proyecto: al cambiar de carpeta hay que releer
            // (y re-publicar bajo el context id nuevo, que acaba de cambiar).
            hooksProvider?.refresh();
        }),

    );

    // Re-index on any create/change/delete of an indexable file (debounced
    // per workspace folder). A plain vscode.workspace.onDidSaveTextDocument
    // listener (the previous approach) only fires for saves made through
    // VSCode's own editor — it misses (a) file deletions entirely, and (b)
    // any write synapse's `text_editor_remote` connector tool makes, since
    // that writes with plain fs.writeFileSync and never opens/saves a
    // VSCode TextDocument. A FileSystemWatcher operates at the OS level via
    // the same file-watching VSCode itself uses for its explorer view, so
    // it catches all three regardless of which process made the change.
    // Extension list mirrors helpers/code_knowledge/index_store.py's
    // _CODE_EXTENSIONS — no point re-triggering for asset/binary changes
    // the indexer ignores anyway; also keeps this cheap on large repos.
    const indexableWatcher = vscode.workspace.createFileSystemWatcher(
        '**/*.{py,ts,tsx,js,jsx,java,go,rs,cs,cpp,c,rb,php,swift,kt,md}'
    );
    const scheduleReindex = (uri: vscode.Uri) => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders?.length) { return; }
        // Nunca reindexar por lo que el propio agente acaba de generar. El
        // indexador ya ignora `openwiki/` (SKIP_DIRS), pero el watcher no lo
        // sabía: cada página que la skill escribía disparaba un reindexado
        // completo del repo, y una corrida escribe ~20 páginas. Los trabajos se
        // solapaban hasta saturar CPU (>1000%) y memoria (OOM). El indexado no
        // gana nada releyendo un repo cuyas fuentes no cambiaron.
        if (/[\\/]openwiki[\\/]/.test(uri.fsPath)) { return; }
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        const folderPath = folder?.uri.fsPath ?? workspaceFolders[0].uri.fsPath;
        scheduleReindexForPath(serverUrl, folderPath);
    };
    context.subscriptions.push(
        indexableWatcher,
        indexableWatcher.onDidCreate(scheduleReindex),
        indexableWatcher.onDidChange(scheduleReindex),
        indexableWatcher.onDidDelete(scheduleReindex),
    );
}

export function deactivate() {
    watcher?.dispose();
}

export function getAttachmentQueue(): FileAttachmentQueue | undefined {
    return attachmentQueue;
}

function onEditorStateChange(state: { file: string; cursor_line: number; diagnostics_count: number }) {
    provider?.postEditorState(state);
}

// Debounced wrapper around triggerCodebaseIndex, keyed per workspace folder.
// Shared by the indexable-file watcher and the reconnect handler so a
// reconnect storm (or reconnect coinciding with a burst of saves) coalesces
// into a single index_project call per folder instead of hammering it.
function scheduleReindexForPath(serverUrl: string, folderPath: string): void {
    const existing = _reindexTimers.get(folderPath);
    if (existing) { clearTimeout(existing); }
    _reindexTimers.set(folderPath, setTimeout(() => {
        _reindexTimers.delete(folderPath);
        triggerCodebaseIndex(serverUrl, folderPath);
    }, REINDEX_DEBOUNCE_MS));
}

// Publica el catálogo de hooks al backend. Es lo que permite que la WebUI
// muestre los mismos botones que esta vista: el servidor no puede leer
// `.a0hooks/` por sí mismo (ruta del host), y su mirror solo replica
// extensiones indexables, nunca un `.json`.
async function syncHooksToBackend(serverUrl: string, hooks: DiscoveredHook[]): Promise<void> {
    const contextId = watcher?.getContextId() ?? '';
    if (!contextId) { return; }
    const apiToken = vscode.workspace.getConfiguration('synapse').get<string>('apiToken', '');
    await fetch(`${serverUrl}/api/plugins/_hooks/hooks_sync`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(apiToken ? { 'X-API-Token': apiToken } : {}),
        },
        body: JSON.stringify({
            context_id: contextId,
            workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
            hooks: hooks.map((h) => ({
                ...h.raw,
                id: h.id,
                source_path: h.source_path,
                source_format: h.source_format,
            })),
        }),
    });
}

// Pide el catálogo completo: los hooks del repo (que acabamos de publicar) más
// los de fábrica, que solo el backend conoce. Es lo que mantiene esta vista y
// la WebUI enseñando lo mismo.
async function fetchHookCatalog(serverUrl: string): Promise<CatalogHook[] | null> {
    const contextId = watcher?.getContextId() ?? '';
    const apiToken = vscode.workspace.getConfiguration('synapse').get<string>('apiToken', '');
    const res = await fetch(`${serverUrl}/api/plugins/_hooks/hooks_list`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(apiToken ? { 'X-API-Token': apiToken } : {}),
        },
        body: JSON.stringify({ context_id: contextId }),
    });
    if (!res.ok) { return null; }
    const data = await res.json() as { ok?: boolean; hooks?: CatalogHook[] };
    return data?.ok && Array.isArray(data.hooks) ? data.hooks : null;
}

function requireWorkspaceRoot(): string | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
        vscode.window.showErrorMessage('Abre una carpeta antes de crear un hook.');
    }
    return root;
}

const NEW_HOOK_PLACEHOLDER =
    'Describe aquí lo que quieres que haga el agente.\n\n' +
    'Sé concreto: qué revisar, qué entregar y qué NO tocar.';

async function createHook(): Promise<void> {
    const root = requireWorkspaceRoot();
    if (!root) { return; }

    const name = await vscode.window.showInputBox({
        title: 'Crear hook (1/2)',
        prompt: 'Nombre del hook, como aparecerá en el botón',
        placeHolder: 'Ej: Revisar migraciones antes de desplegar',
        validateInput: (v) => (v.trim() ? undefined : 'El nombre no puede estar vacío'),
    });
    if (!name) { return; }

    const description = await vscode.window.showInputBox({
        title: 'Crear hook (2/2)',
        prompt: 'Descripción corta (opcional) — qué hace y cuándo usarlo',
        placeHolder: 'Ej: Verifica que las migraciones sean reversibles.',
    });
    if (description === undefined) { return; } // cancelado (vacío sí es válido)

    const file = await writeProjectHook(
        root,
        slugify(name),
        hookTemplate(name.trim(), (description || '').trim(), NEW_HOOK_PLACEHOLDER)
    );
    if (file) {
        vscode.window.showInformationMessage(
            `Hook creado. Edita el campo "prompt" y guarda: aparecerá en la lista.`
        );
    }
}

// Partir de un hook que ya funciona es más fiable que escribir uno en blanco:
// el de fábrica trae el prompt afinado y solo hay que ajustarlo al repo.
async function duplicateHook(hook?: CatalogHook): Promise<void> {
    const root = requireWorkspaceRoot();
    if (!root || !hook) { return; }

    const name = await vscode.window.showInputBox({
        title: 'Duplicar como hook del proyecto',
        prompt: 'Nombre para tu copia',
        value: `${hook.name} (copia)`,
        validateInput: (v) => (v.trim() ? undefined : 'El nombre no puede estar vacío'),
    });
    if (!name) { return; }

    const contents = duplicateTemplate(name.trim(), {
        description: hook.description,
        prompt: hook.prompt,
        profile: hook.profile,
        new_chat: hook.new_chat,
    });

    const file = await writeProjectHook(root, slugify(name), contents);
    if (file) {
        vscode.window.showInformationMessage(
            'Copia creada en .a0hooks/ — ajústala a tu proyecto y guarda.'
        );
    }
}

async function openHookFile(hook?: CatalogHook): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root || !hook?.source_path) { return; }
    if (hook.source_format === 'builtin') {
        vscode.window.showInformationMessage(
            'Los hooks de fábrica no se editan. Usa "Duplicar como hook del proyecto".'
        );
        return;
    }
    try {
        const doc = await vscode.workspace.openTextDocument(
            vscode.Uri.file(`${root}/${hook.source_path}`)
        );
        await vscode.window.showTextDocument(doc);
    } catch {
        vscode.window.showErrorMessage(`No se pudo abrir ${hook.source_path}`);
    }
}

/** Un evento del log del agente, tal como lo devuelve log_tail. */
interface LogEvent {
    type?: string;
    heading?: string;
    content?: string;
}

/**
 * Resume un evento del agente en una línea corta para la barra de progreso.
 * Solo se usa para *mostrar* actividad, así que ante cualquier forma inesperada
 * devuelve null y el sondeo simplemente conserva la etiqueta anterior.
 */
function progressLabel(event: LogEvent): string | null {
    const raw = (event.heading || event.content || '').trim();
    if (!raw) { return null; }
    const line = raw.split('\n')[0].replace(/\s+/g, ' ');
    return line.length > 60 ? line.slice(0, 57) + '…' : line;
}

/**
 * Sondea el log del contexto y va reportando lo que el agente hace.
 *
 * Existe porque `hooks_run` solo confirma que el prompt se encoló: sin esto la
 * UI decía "lanzado" y se quedaba muda durante toda la corrida, que en un
 * `openwiki init` son varios minutos. Al no verse nada, la reacción natural es
 * volver a hacer clic y disparar la misma corrida otra vez.
 */
async function followHookRun(
    serverUrl: string,
    apiToken: string,
    contextId: string,
    report: (label: string) => void,
    token: vscode.CancellationToken
): Promise<void> {
    const IDLE_LIMIT = 8;   // ~24 s sin eventos nuevos ⇒ se da por terminada
    const INTERVAL_MS = 3000;
    let after = 0;
    let idle = 0;

    while (!token.isCancellationRequested && idle < IDLE_LIMIT) {
        await new Promise((r) => setTimeout(r, INTERVAL_MS));
        if (token.isCancellationRequested) { return; }
        try {
            const res = await fetch(`${serverUrl}/api/plugins/_a0_connector/v1/log_tail`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(apiToken ? { 'X-API-Token': apiToken } : {}),
                },
                body: JSON.stringify({ context_id: contextId, after, limit: 50 }),
            });
            if (!res.ok) { idle++; continue; }
            const data = (await res.json()) as { events?: LogEvent[]; last_sequence?: number };
            const events = data.events || [];
            if (!events.length) { idle++; continue; }

            idle = 0;
            after = data.last_sequence ?? after;
            for (let i = events.length - 1; i >= 0; i--) {
                const label = progressLabel(events[i]);
                if (label) { report(label); break; }
            }
        } catch {
            // Un fallo de red en el sondeo no debe abortar nada: la corrida
            // sigue viva en el servidor aunque aquí perdamos la señal.
            idle++;
        }
    }
}

async function runHook(serverUrl: string, hook: CatalogHook): Promise<void> {
    const contextId = watcher?.getContextId() ?? '';
    if (!contextId) {
        vscode.window.showWarningMessage(
            `No hay sesión activa de Synapse: sin ella no se puede saber sobre qué proyecto correría "${hook.name}".`
        );
        return;
    }
    if (hooksProvider?.isRunning(hook.id)) {
        vscode.window.showInformationMessage(`"${hook.name}" ya se está ejecutando.`);
        return;
    }

    const apiToken = vscode.workspace.getConfiguration('synapse').get<string>('apiToken', '');
    hooksProvider?.setRunning(hook.id, 'lanzando…');
    try {
        const res = await fetch(`${serverUrl}/api/plugins/_hooks/hooks_run`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(apiToken ? { 'X-API-Token': apiToken } : {}),
            },
            body: JSON.stringify({ context_id: contextId, hook_id: hook.id }),
        });
        if (!res.ok) {
            // El backend resuelve el hook por id contra su propio catálogo, así
            // que un 404 aquí casi siempre significa que aún no le llegó el sync.
            const detail = res.status === 404
                ? 'el servidor todavía no tiene este hook — prueba "Synapse: Refrescar hooks"'
                : `HTTP ${res.status}`;
            vscode.window.showErrorMessage(`No se pudo ejecutar "${hook.name}": ${detail}`);
            hooksProvider?.setRunning(hook.id, undefined);
            return;
        }

        // `newChat` manda la corrida a un chat nuevo, así que el log a seguir es
        // el que devuelve el servidor, no necesariamente el de esta sesión.
        const body = (await res.json()) as { context?: string };
        const runContext = body.context || contextId;

        // El resultado sale en el chat, así que conviene traerlo al frente.
        vscode.commands.executeCommand('workbench.view.extension.synapse-sidebar');

        vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Hook: ${hook.name}`,
                cancellable: true,
            },
            async (progress, token) => {
                progress.report({ message: 'iniciando…' });
                hooksProvider?.setRunning(hook.id, 'iniciando…');
                await followHookRun(serverUrl, apiToken, runContext, (label) => {
                    progress.report({ message: label });
                    hooksProvider?.setRunning(hook.id, label);
                }, token);
                hooksProvider?.setRunning(hook.id, undefined);
                // Cancelar solo deja de mirar; la corrida sigue en el servidor.
                if (!token.isCancellationRequested) {
                    vscode.window.setStatusBarMessage(`$(check) Hook terminado: ${hook.name}`, 5000);
                }
            }
        );
    } catch (err) {
        hooksProvider?.setRunning(hook.id, undefined);
        vscode.window.showErrorMessage(
            `No se pudo ejecutar "${hook.name}": ${err instanceof Error ? err.message : String(err)}`
        );
    }
}

/** Abre el prompt del hook en un documento de solo lectura, para inspeccionarlo. */
async function showHookPrompt(hook: CatalogHook): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content:
            `# ${hook.name}\n\n` +
            (hook.description ? `${hook.description}\n\n` : '') +
            `- Origen: \`${hook.source_path || hook.source_format}\`\n` +
            `- Perfil: \`${hook.profile || 'por defecto'}\`\n` +
            `- Chat nuevo: ${hook.new_chat ? 'sí' : 'no'}\n\n` +
            `## Prompt\n\n${hook.prompt}\n`,
    });
    await vscode.window.showTextDocument(doc, { preview: true });
}

function triggerCodebaseIndex(serverUrl: string, workspacePath: string): void {
    // Fire-and-forget: indexing runs in background on the agent server.
    // context_id lets the server fall back to indexing via this same CLI's
    // /ws connection (list_tree + read file ops) when workspacePath isn't
    // visible on the server's own filesystem (no /mnt/projects bind-mount
    // for it) — see plugins/_a0_connector/api/v1/index_project.py.
    //
    // X-API-Token is required in multi-user mode (helpers/api.py's
    // requires_auth reads it, not a request body field) — without it this
    // request always 302-redirects to /login and the .catch() below
    // swallows it silently, so indexing looked "automatic" in the UI but
    // never actually ran. Read fresh from config rather than threading the
    // token through every call site, since it can change at any time via
    // "Synapse: Set API Token".
    const apiToken = vscode.workspace.getConfiguration('synapse').get<string>('apiToken', '');
    fetch(`${serverUrl}/api/plugins/_a0_connector/v1/index_project`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(apiToken ? { 'X-API-Token': apiToken } : {}),
        },
        body: JSON.stringify({ path: workspacePath, context_id: watcher?.getContextId() ?? '' }),
    }).catch(() => {
        // Silent — server may not be running yet or endpoint not available
    });
}

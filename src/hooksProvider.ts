import * as vscode from 'vscode';
import { discoverHooks, hookFileExists, saveHookFile, DiscoveredHook } from './hookFiles';

/**
 * Agent Hooks: prompts guardados en el repo que se disparan con un clic.
 *
 * Los archivos del proyecto se leen en el cliente (ver `hookFiles.ts`), y no en
 * el servidor, porque el proyecto vive en el disco del desarrollador y el
 * backend corre en un contenedor que no ve esa ruta. El mirror del servidor
 * tampoco sirve de atajo: solo replica extensiones indexables (.ts/.tsx/.md),
 * así que un `.hook.json` nunca llega ahí.
 *
 * Pero el catálogo que se muestra NO es solo el del disco: el backend añade
 * los hooks de fábrica, que están disponibles en cualquier proyecto aunque no
 * tenga `.a0hooks/`. Por eso el flujo es: leer disco → publicar al backend →
 * pedirle el catálogo completo. Así esta vista y la WebUI enseñan lo mismo.
 */

export { DiscoveredHook };

/** Hook tal como lo devuelve el backend (incluye los de fábrica). */
export interface CatalogHook {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    prompt: string;
    profile: string;
    new_chat: boolean;
    source_path: string;
    source_format: 'a0' | 'kiro' | 'builtin';
    warnings: string[];
}

/**
 * Escribe un hook en `.a0hooks/` y lo abre para editar.
 * Devuelve la ruta, o null si el usuario canceló ante un archivo existente.
 */
export async function writeProjectHook(
    root: string,
    id: string,
    contents: string
): Promise<string | null> {
    if (hookFileExists(root, id)) {
        const answer = await vscode.window.showWarningMessage(
            `Ya existe un hook con el id "${id}". ¿Sobrescribirlo?`,
            { modal: true },
            'Sobrescribir'
        );
        if (answer !== 'Sobrescribir') { return null; }
    }

    const file = saveHookFile(root, id, contents);
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    return file;
}

export class HookItem extends vscode.TreeItem {
    constructor(public readonly hook: CatalogHook, status?: string) {
        super(hook.name, vscode.TreeItemCollapsibleState.None);
        const isBuiltin = hook.source_format === 'builtin';
        const running = status !== undefined;
        this.description = running
            ? (status || 'ejecutando…')
            : (!hook.enabled ? 'deshabilitado' : (isBuiltin ? 'de fábrica' : hook.source_format));

        // El tooltip muestra el prompt completo: un hook es texto que viene de
        // un archivo, así que debe poder inspeccionarse antes de correrlo.
        const md = new vscode.MarkdownString();
        if (hook.description) { md.appendMarkdown(`${hook.description}\n\n---\n\n`); }
        if (hook.source_path) { md.appendMarkdown(`_${hook.source_path}_\n\n`); }
        for (const warning of hook.warnings || []) {
            md.appendMarkdown(`⚠️ ${warning}\n\n`);
        }
        md.appendCodeblock(hook.prompt, 'text');
        this.tooltip = md;

        this.iconPath = new vscode.ThemeIcon(
            running ? 'loading~spin'
                : (!hook.enabled ? 'circle-slash' : (isBuiltin ? 'star-full' : 'zap'))
        );

        // El contextValue decide qué botones inline salen al pasar el ratón.
        // Un hook en curso no ofrece ▶: relanzarlo abriría una segunda corrida
        // sobre el mismo proyecto sin que la primera haya terminado.
        const kind = isBuiltin ? 'Builtin' : 'Project';
        this.contextValue = running
            ? `synapseHook${kind}Running`
            : (hook.enabled ? `synapseHook${kind}` : `synapseHook${kind}Disabled`);

        // Ejecutar es un botón explícito (ver package.json), no el clic simple.
        // Un hook es un prompt de un archivo del repo y algunos son corridas
        // largas que escriben documentación: seleccionar para leer el prompt no
        // puede ser lo mismo que dispararlo.
        if (!running) {
            this.command = {
                command: 'synapse.showHookPrompt',
                title: 'Ver prompt',
                arguments: [hook],
            };
        }
    }
}

class MessageItem extends vscode.TreeItem {
    constructor(label: string, icon: string, command?: vscode.Command) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
        if (command) { this.command = command; }
    }
}

export class HooksProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private catalog: CatalogHook[] = [];
    private projectHooks: DiscoveredHook[] = [];
    private offline = false;

    /** hook_id → etiqueta de progreso del hook que está corriendo ahora. */
    private running = new Map<string, string>();

    constructor(
        private readonly syncToBackend: (hooks: DiscoveredHook[]) => Promise<void>,
        private readonly fetchCatalog: () => Promise<CatalogHook[] | null>,
        /** Hay sesión con el backend (context_id asignado por el CLI). */
        private readonly hasSession: () => boolean
    ) {}

    isRunning(hookId: string): boolean {
        return this.running.has(hookId);
    }

    /** Marca el hook como en curso; `undefined` lo devuelve a reposo. */
    setRunning(hookId: string, status: string | undefined): void {
        if (status === undefined) {
            this.running.delete(hookId);
        } else {
            this.running.set(hookId, status);
        }
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): vscode.TreeItem[] {
        if (!vscode.workspace.workspaceFolders?.length) {
            return [new MessageItem('Abre una carpeta para ver sus hooks', 'folder')];
        }
        // Sin sesión no se listan hooks. No es cosmético: el context_id es lo
        // único que ata la corrida a este proyecto, y sin él el backend no
        // puede saber sobre qué repo trabajaría un hook.
        if (!this.hasSession()) {
            return [
                new MessageItem('Conecta Synapse para ver los hooks', 'debug-disconnect'),
            ];
        }
        if (!this.catalog.length) {
            return [
                new MessageItem(
                    this.offline
                        ? 'Sin conexión con Synapse — solo se ven los hooks del repo'
                        : 'Sin hooks — crea uno',
                    this.offline ? 'debug-disconnect' : 'add',
                    this.offline
                        ? undefined
                        : { command: 'synapse.createHook', title: 'Crear hook' }
                ),
            ];
        }
        return this.catalog.map((hook) => new HookItem(hook, this.running.get(hook.id)));
    }

    getCatalog(): CatalogHook[] {
        return this.catalog;
    }

    getProjectHooks(): DiscoveredHook[] {
        return this.projectHooks;
    }

    /**
     * Relee el disco, lo publica al backend y pide el catálogo completo.
     *
     * El orden importa: sin publicar primero, el backend respondería con un
     * catálogo que no incluye los hooks nuevos del repo.
     */
    async refresh(): Promise<void> {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        this.projectHooks = root ? discoverHooks(root) : [];

        if (!this.hasSession()) {
            // Publicar el catálogo sin context_id lo dejaría cacheado bajo una
            // clave vacía, visible desde cualquier otro chat.
            this.catalog = [];
            this._onDidChangeTreeData.fire();
            return;
        }

        try {
            await this.syncToBackend(this.projectHooks);
            const catalog = await this.fetchCatalog();
            if (catalog) {
                this.catalog = catalog;
                this.offline = false;
            } else {
                throw new Error('sin catálogo');
            }
        } catch {
            // Degradación elegante: si el backend no responde, al menos se ven
            // los hooks del repo (sin los de fábrica, que solo él conoce).
            this.offline = true;
            this.catalog = this.projectHooks.map((h) => ({
                id: h.id,
                name: h.name,
                description: h.description,
                enabled: h.enabled,
                prompt: h.prompt,
                profile: '',
                new_chat: false,
                source_path: h.source_path,
                source_format: h.source_format,
                warnings: [],
            }));
        }

        this._onDidChangeTreeData.fire();
    }
}

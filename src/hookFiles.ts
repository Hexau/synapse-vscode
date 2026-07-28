import * as fs from 'fs';
import * as path from 'path';

/**
 * Lectura y escritura de archivos de hooks — sin dependencia de `vscode`,
 * para poder probarlo con node puro (misma convención que
 * `attachmentValidation.ts`).
 *
 * Formato propio: `.a0hooks/*.hook.json`. También se leen los
 * `.kiro/hooks/*.kiro.hook` de AWS Kiro, cuyo esquema es compatible, para que
 * un equipo que ya los tenga escritos no tenga que convertir nada.
 */

export const A0_HOOKS_DIR = '.a0hooks';
export const A0_HOOKS_SUFFIX = '.hook.json';
export const KIRO_HOOKS_DIR = path.join('.kiro', 'hooks');
export const KIRO_HOOKS_SUFFIX = '.kiro.hook';

/** Hook leído del disco del proyecto. */
export interface DiscoveredHook {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    prompt: string;
    source_path: string;
    source_format: 'a0' | 'kiro';
    raw: Record<string, any>;
}

function readHooksFromDir(
    root: string,
    relDir: string,
    suffix: string,
    format: 'a0' | 'kiro'
): DiscoveredHook[] {
    const dir = path.join(root, relDir);
    let entries: string[];
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return []; // La carpeta no existe: es el caso normal, no un error.
    }

    const hooks: DiscoveredHook[] = [];
    for (const entry of entries.sort()) {
        if (!entry.endsWith(suffix)) { continue; }
        const full = path.join(dir, entry);
        try {
            const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
            const then = (raw?.then ?? {}) as Record<string, unknown>;
            const prompt = typeof then.prompt === 'string' ? then.prompt : '';
            if (!prompt.trim()) { continue; }
            hooks.push({
                id: entry.slice(0, -suffix.length),
                name: typeof raw?.name === 'string' && raw.name.trim()
                    ? raw.name
                    : entry.slice(0, -suffix.length),
                description: typeof raw?.description === 'string' ? raw.description : '',
                enabled: raw?.enabled !== false,
                prompt,
                source_path: path.join(relDir, entry).replace(/\\/g, '/'),
                source_format: format,
                raw,
            });
        } catch (err) {
            // Un hook con JSON roto no debe tumbar la vista entera.
            console.warn(`[synapse] hook inválido en ${full}:`, err);
        }
    }
    return hooks;
}

export function discoverHooks(workspaceRoot: string): DiscoveredHook[] {
    // El formato propio se lee después para que gane sobre el de Kiro cuando
    // ambos definen el mismo id (permite migrar un hook sin borrar el original).
    const merged = new Map<string, DiscoveredHook>();
    for (const hook of readHooksFromDir(workspaceRoot, KIRO_HOOKS_DIR, KIRO_HOOKS_SUFFIX, 'kiro')) {
        merged.set(hook.id, hook);
    }
    for (const hook of readHooksFromDir(workspaceRoot, A0_HOOKS_DIR, A0_HOOKS_SUFFIX, 'a0')) {
        merged.set(hook.id, hook);
    }
    return [...merged.values()].sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    );
}

/** `Mi Hook Genial` → `mi-hook-genial`, para nombrar el archivo. */
export function slugify(input: string): string {
    return input
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita acentos
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'hook';
}

export function hookTemplate(name: string, description: string, prompt: string): string {
    return JSON.stringify({
        enabled: true,
        name,
        description,
        version: '1',
        when: { type: 'userTriggered' },
        then: {
            type: 'askAgent',
            profile: 'team-developer',
            newChat: true,
            prompt,
        },
    }, null, 2) + '\n';
}

/** Copia un hook existente como hook del proyecto, con nombre nuevo. */
export function duplicateTemplate(
    name: string,
    source: { description: string; prompt: string; profile?: string; new_chat?: boolean }
): string {
    return JSON.stringify({
        enabled: true,
        name,
        description: source.description,
        version: '1',
        when: { type: 'userTriggered' },
        then: {
            type: 'askAgent',
            profile: source.profile || 'team-developer',
            newChat: source.new_chat !== false,
            prompt: source.prompt,
        },
    }, null, 2) + '\n';
}

export function hookFilePath(root: string, id: string): string {
    return path.join(root, A0_HOOKS_DIR, `${id}${A0_HOOKS_SUFFIX}`);
}

export function hookFileExists(root: string, id: string): boolean {
    return fs.existsSync(hookFilePath(root, id));
}

/** Escribe el hook creando `.a0hooks/` si hace falta. Devuelve la ruta. */
export function saveHookFile(root: string, id: string, contents: string): string {
    const file = hookFilePath(root, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, 'utf8');
    return file;
}

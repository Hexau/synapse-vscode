import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    slugify,
    hookTemplate,
    duplicateTemplate,
    discoverHooks,
    saveHookFile,
    hookFileExists,
    hookFilePath,
} from '../hookFiles';

let tmp: string;

before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hookfiles-'));
});

after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// slugify — el resultado nombra el archivo, así que debe ser seguro en disco
// ---------------------------------------------------------------------------

describe('slugify', () => {
    it('converts a display name into a filename-safe id', () => {
        assert.equal(slugify('Mi Hook Genial'), 'mi-hook-genial');
        assert.equal(slugify('Revisar migraciones antes de desplegar'),
            'revisar-migraciones-antes-de-desplegar');
    });

    it('strips accents so the id stays ASCII', () => {
        assert.equal(slugify('Configuración Rápida'), 'configuracion-rapida');
    });

    it('collapses separators and trims edges', () => {
        assert.equal(slugify('   espacios   raros   '), 'espacios-raros');
        assert.equal(slugify('--a--b--'), 'a-b');
    });

    it('falls back to "hook" when nothing survives', () => {
        assert.equal(slugify('!!!'), 'hook');
        assert.equal(slugify(''), 'hook');
    });

    it('caps the length', () => {
        assert.ok(slugify('a'.repeat(200)).length <= 60);
    });
});

// ---------------------------------------------------------------------------
// Plantillas — deben producir exactamente la forma que el backend parsea
// ---------------------------------------------------------------------------

describe('hookTemplate', () => {
    it('produces valid JSON in the expected shape', () => {
        const parsed = JSON.parse(hookTemplate('Mi Hook', 'Una descripción', 'Haz esto'));
        assert.equal(parsed.enabled, true);
        assert.equal(parsed.name, 'Mi Hook');
        assert.equal(parsed.description, 'Una descripción');
        assert.equal(parsed.when.type, 'userTriggered');
        assert.equal(parsed.then.type, 'askAgent');
        assert.equal(parsed.then.prompt, 'Haz esto');
        assert.equal(parsed.then.profile, 'team-developer');
        assert.equal(parsed.then.newChat, true);
    });

    it('ends with a newline', () => {
        assert.ok(hookTemplate('a', 'b', 'c').endsWith('\n'));
    });
});

describe('duplicateTemplate', () => {
    it('carries the source prompt and profile over', () => {
        const parsed = JSON.parse(duplicateTemplate('Copia', {
            description: 'desc',
            prompt: 'prompt original',
            profile: 'researcher',
            new_chat: false,
        }));
        assert.equal(parsed.name, 'Copia');
        assert.equal(parsed.then.prompt, 'prompt original');
        assert.equal(parsed.then.profile, 'researcher');
        assert.equal(parsed.then.newChat, false);
    });

    it('defaults the profile when the source has none', () => {
        const parsed = JSON.parse(duplicateTemplate('X', { description: '', prompt: 'p' }));
        assert.equal(parsed.then.profile, 'team-developer');
        assert.equal(parsed.then.newChat, true);
    });
});

// ---------------------------------------------------------------------------
// Round-trip: lo que escribimos tiene que volver a descubrirse
// ---------------------------------------------------------------------------

describe('save → discover round-trip', () => {
    it('discovers a hook it just wrote', () => {
        const root = path.join(tmp, 'roundtrip');
        fs.mkdirSync(root, { recursive: true });

        assert.equal(hookFileExists(root, 'mi-hook'), false);
        saveHookFile(root, 'mi-hook', hookTemplate('Mi Hook', 'desc', 'el prompt'));
        assert.equal(hookFileExists(root, 'mi-hook'), true);

        const found = discoverHooks(root);
        assert.equal(found.length, 1);
        assert.equal(found[0].id, 'mi-hook');
        assert.equal(found[0].name, 'Mi Hook');
        assert.equal(found[0].prompt, 'el prompt');
        assert.equal(found[0].source_format, 'a0');
        assert.equal(found[0].source_path, '.a0hooks/mi-hook.hook.json');
    });

    it('creates the .a0hooks directory when missing', () => {
        const root = path.join(tmp, 'nodir');
        fs.mkdirSync(root, { recursive: true });
        const file = saveHookFile(root, 'x', hookTemplate('X', '', 'p'));
        assert.ok(fs.existsSync(file));
        assert.equal(file, hookFilePath(root, 'x'));
    });
});

// ---------------------------------------------------------------------------
// Robustez: un archivo malo no puede tumbar la vista entera
// ---------------------------------------------------------------------------

describe('discoverHooks resilience', () => {
    it('returns empty for a project without hooks', () => {
        const root = path.join(tmp, 'empty');
        fs.mkdirSync(root, { recursive: true });
        assert.deepEqual(discoverHooks(root), []);
    });

    it('skips malformed JSON without dropping valid hooks', () => {
        const root = path.join(tmp, 'malformed');
        fs.mkdirSync(path.join(root, '.a0hooks'), { recursive: true });
        saveHookFile(root, 'good', hookTemplate('Good', '', 'p'));
        fs.writeFileSync(path.join(root, '.a0hooks', 'bad.hook.json'), '{ not json', 'utf8');

        const found = discoverHooks(root);
        assert.equal(found.length, 1);
        assert.equal(found[0].id, 'good');
    });

    it('skips hooks with no prompt — there is nothing to run', () => {
        const root = path.join(tmp, 'noprompt');
        fs.mkdirSync(path.join(root, '.a0hooks'), { recursive: true });
        fs.writeFileSync(
            path.join(root, '.a0hooks', 'empty.hook.json'),
            JSON.stringify({ name: 'x', then: {} }),
            'utf8'
        );
        assert.deepEqual(discoverHooks(root), []);
    });

    it('preserves enabled:false instead of hiding the hook', () => {
        const root = path.join(tmp, 'disabled');
        fs.mkdirSync(path.join(root, '.a0hooks'), { recursive: true });
        fs.writeFileSync(
            path.join(root, '.a0hooks', 'off.hook.json'),
            JSON.stringify({ name: 'Off', enabled: false, then: { prompt: 'p' } }),
            'utf8'
        );
        const found = discoverHooks(root);
        assert.equal(found.length, 1);
        assert.equal(found[0].enabled, false);
    });
});

// ---------------------------------------------------------------------------
// Compatibilidad con AWS Kiro — el motivo por el que existe el formato dual
// ---------------------------------------------------------------------------

describe('Kiro compatibility', () => {
    it('reads .kiro/hooks/*.kiro.hook untouched', () => {
        const root = path.join(tmp, 'kiro');
        fs.mkdirSync(path.join(root, '.kiro', 'hooks'), { recursive: true });
        fs.writeFileSync(
            path.join(root, '.kiro', 'hooks', 'create-doc.kiro.hook'),
            JSON.stringify({
                enabled: true,
                name: 'Generar Documentación',
                description: 'desde cero',
                version: '1',
                when: { type: 'userTriggered' },
                then: { type: 'askAgent', prompt: 'Ejecuta @create-doc-orchestrator.' },
            }),
            'utf8'
        );

        const found = discoverHooks(root);
        assert.equal(found.length, 1);
        assert.equal(found[0].id, 'create-doc');
        assert.equal(found[0].name, 'Generar Documentación');
        assert.equal(found[0].source_format, 'kiro');
        assert.equal(found[0].source_path, '.kiro/hooks/create-doc.kiro.hook');
    });

    it('lets a project hook override a Kiro hook with the same id', () => {
        const root = path.join(tmp, 'override');
        fs.mkdirSync(path.join(root, '.kiro', 'hooks'), { recursive: true });
        fs.writeFileSync(
            path.join(root, '.kiro', 'hooks', 'shared.kiro.hook'),
            JSON.stringify({ name: 'Kiro version', then: { prompt: 'viejo' } }),
            'utf8'
        );
        saveHookFile(root, 'shared', hookTemplate('A0 version', '', 'nuevo'));

        const found = discoverHooks(root);
        assert.equal(found.length, 1, 'el id repetido no debe duplicarse');
        assert.equal(found[0].source_format, 'a0');
        assert.equal(found[0].prompt, 'nuevo');
    });
});

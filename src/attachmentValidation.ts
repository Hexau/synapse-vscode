/** Pure validation helpers — no vscode imports, fully testable in plain Node.js. */

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB

export const ALLOWED_EXTENSIONS = new Set([
    '.md', '.pdf', '.xlsx', '.xls', '.docx', '.doc',
    '.pptx', '.ppt', '.txt', '.csv',
]);

export interface QueuedFile {
    filename: string;
    base64: string;
    sizeBytes: number;
}

export type ValidationError = 'bad_extension' | 'too_large';

export type ValidationResult =
    | { ok: true; entry: QueuedFile }
    | { ok: false; reason: ValidationError; detail: string };

export function validateAndEncode(
    filename: string,
    ext: string,
    sizeBytes: number,
    rawBuffer: Buffer,
): ValidationResult {
    if (!ALLOWED_EXTENSIONS.has(ext.toLowerCase())) {
        return {
            ok: false,
            reason: 'bad_extension',
            detail: `File type "${ext}" is not supported. Allowed: ${[...ALLOWED_EXTENSIONS].join(' ')}`,
        };
    }

    if (sizeBytes > MAX_FILE_BYTES) {
        const mb = (sizeBytes / 1024 / 1024).toFixed(1);
        return {
            ok: false,
            reason: 'too_large',
            detail: `File is too large (${mb} MB). Maximum is 20 MB.`,
        };
    }

    return {
        ok: true,
        entry: {
            filename,
            base64: rawBuffer.toString('base64'),
            sizeBytes,
        },
    };
}

/**
 * Merge a new entry into an existing queue.
 * If a file with the same filename already exists, replace it (dedup by name).
 * Returns the new queue and whether a replacement occurred.
 */
export function enqueueFile(
    queue: QueuedFile[],
    entry: QueuedFile,
): { queue: QueuedFile[]; replaced: boolean } {
    const idx = queue.findIndex(f => f.filename === entry.filename);
    if (idx >= 0) {
        const next = [...queue];
        next[idx] = entry;
        return { queue: next, replaced: true };
    }
    return { queue: [...queue, entry], replaced: false };
}

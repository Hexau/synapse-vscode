import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateAndEncode, enqueueFile, MAX_FILE_BYTES, type QueuedFile } from '../attachmentValidation';

// ---------------------------------------------------------------------------
// validateAndEncode
// ---------------------------------------------------------------------------

describe('validateAndEncode — extension check', () => {
    it('accepts supported extensions', () => {
        const buf = Buffer.from('hello');
        const supported = ['.md', '.pdf', '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.ppt', '.txt', '.csv'];
        for (const ext of supported) {
            const r = validateAndEncode(`file${ext}`, ext, buf.byteLength, buf);
            assert.equal(r.ok, true, `Expected ${ext} to be accepted`);
        }
    });

    it('rejects unsupported extensions', () => {
        const buf = Buffer.from('data');
        const unsupported = ['.exe', '.zip', '.png', '.js', '.json', '.py', ''];
        for (const ext of unsupported) {
            const r = validateAndEncode(`file${ext}`, ext, buf.byteLength, buf);
            assert.equal(r.ok, false, `Expected ${ext} to be rejected`);
            if (!r.ok) {
                assert.equal(r.reason, 'bad_extension');
            }
        }
    });

    it('is case-insensitive for extensions', () => {
        const buf = Buffer.from('doc');
        const r = validateAndEncode('FILE.PDF', '.PDF', buf.byteLength, buf);
        assert.equal(r.ok, true);
    });
});

describe('validateAndEncode — size check', () => {
    it('accepts file exactly at the limit', () => {
        const buf = Buffer.alloc(MAX_FILE_BYTES);
        const r = validateAndEncode('big.pdf', '.pdf', MAX_FILE_BYTES, buf);
        assert.equal(r.ok, true);
    });

    it('rejects file one byte over the limit', () => {
        const overLimit = MAX_FILE_BYTES + 1;
        const buf = Buffer.alloc(1); // buf size doesn't matter — sizeBytes param is used
        const r = validateAndEncode('toobig.pdf', '.pdf', overLimit, buf);
        assert.equal(r.ok, false);
        if (!r.ok) {
            assert.equal(r.reason, 'too_large');
            assert.match(r.detail, /20 MB/);
        }
    });

    it('rejects large file with correct MB label in message', () => {
        const size = 25 * 1024 * 1024; // 25 MB
        const r = validateAndEncode('huge.docx', '.docx', size, Buffer.alloc(1));
        assert.equal(r.ok, false);
        if (!r.ok) {
            assert.match(r.detail, /25\.0 MB/);
        }
    });
});

describe('validateAndEncode — base64 serialization', () => {
    it('round-trips arbitrary binary content through base64', () => {
        const original = Buffer.from([0x00, 0xff, 0x42, 0x80, 0x01, 0xfe]);
        const r = validateAndEncode('data.pdf', '.pdf', original.byteLength, original);
        assert.equal(r.ok, true);
        if (r.ok) {
            const decoded = Buffer.from(r.entry.base64, 'base64');
            assert.deepEqual(decoded, original);
        }
    });

    it('stores correct sizeBytes from the sizeBytes parameter', () => {
        const buf = Buffer.from('hello world');
        const r = validateAndEncode('note.txt', '.txt', buf.byteLength, buf);
        assert.equal(r.ok, true);
        if (r.ok) {
            assert.equal(r.entry.sizeBytes, buf.byteLength);
        }
    });

    it('stores the provided filename as-is', () => {
        const buf = Buffer.from('x');
        const r = validateAndEncode('My Report Q1.xlsx', '.xlsx', buf.byteLength, buf);
        assert.equal(r.ok, true);
        if (r.ok) {
            assert.equal(r.entry.filename, 'My Report Q1.xlsx');
        }
    });
});

// ---------------------------------------------------------------------------
// enqueueFile
// ---------------------------------------------------------------------------

describe('enqueueFile — deduplication', () => {
    const make = (filename: string): QueuedFile => ({
        filename,
        base64: Buffer.from(filename).toString('base64'),
        sizeBytes: filename.length,
    });

    it('appends to empty queue', () => {
        const entry = make('doc.pdf');
        const { queue, replaced } = enqueueFile([], entry);
        assert.equal(queue.length, 1);
        assert.equal(queue[0].filename, 'doc.pdf');
        assert.equal(replaced, false);
    });

    it('appends distinct files', () => {
        const q0 = [make('a.pdf')];
        const { queue, replaced } = enqueueFile(q0, make('b.pdf'));
        assert.equal(queue.length, 2);
        assert.equal(replaced, false);
    });

    it('replaces a file with the same name', () => {
        const old = make('report.xlsx');
        const updated: QueuedFile = { filename: 'report.xlsx', base64: 'bmV3', sizeBytes: 3 };
        const { queue, replaced } = enqueueFile([old], updated);
        assert.equal(queue.length, 1);
        assert.equal(queue[0].base64, 'bmV3', 'Should hold the new base64 content');
        assert.equal(replaced, true);
    });

    it('does not mutate the original queue array', () => {
        const original: QueuedFile[] = [make('x.txt')];
        const snapshot = [...original];
        enqueueFile(original, make('y.txt'));
        assert.deepEqual(original, snapshot);
    });

    it('preserves position of other items when replacing', () => {
        const q = [make('a.pdf'), make('b.pdf'), make('c.pdf')];
        const { queue } = enqueueFile(q, { filename: 'b.pdf', base64: 'updated', sizeBytes: 7 });
        assert.equal(queue[0].filename, 'a.pdf');
        assert.equal(queue[1].filename, 'b.pdf');
        assert.equal(queue[1].base64, 'updated');
        assert.equal(queue[2].filename, 'c.pdf');
    });
});

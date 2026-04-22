import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { buildProgram } from '../cli.js';
import { logger } from '../logger.js';
import type { Interface as RlInterface } from 'node:readline';

vi.mock('../analyzer.js', () => ({
  analyzePdf: vi.fn(),
  AnalyzerError: class AnalyzerError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'AnalyzerError';
    }
  },
  getXfaDatasetsInfo: vi.fn(),
  patchXfaDatasetsXml: vi.fn(),
}));

vi.mock('pdf-lib', () => ({
  PDFDocument: {
    load: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../server.js', () => ({
  startServer: vi.fn(),
}));

vi.mock('open', () => ({ default: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../exporter.js', () => ({
  exportPdf: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock('node:readline', () => ({
  createInterface: vi.fn().mockReturnValue({
    question: vi.fn((_prompt: unknown, cb: (answer: string) => void) => {
      cb('');
    }),
    close: vi.fn(),
  }),
}));

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  // Default: JSON file absent — fill tests that need it to exist override per-test.
  readFile: vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
    ),
}));

/**
 * CLI structure tests — verify the command tree is wired correctly without
 * actually spawning a child process or hitting the filesystem.
 */

describe('CLI program structure', () => {
  it('registers the fill command', () => {
    const program = buildProgram();
    const fill = program.commands.find((c) => c.name() === 'fill');
    expect(fill).toBeDefined();
  });

  it('registers the analyze command', () => {
    const program = buildProgram();
    const analyze = program.commands.find((c) => c.name() === 'analyze');
    expect(analyze).toBeDefined();
  });

  it('registers the export command', () => {
    const program = buildProgram();
    const exp = program.commands.find((c) => c.name() === 'export');
    expect(exp).toBeDefined();
  });

  it('fill command has --open flag defaulting to false', () => {
    const program = buildProgram();
    const fill = program.commands.find((c) => c.name() === 'fill');
    expect(fill).toBeDefined();
    const opt = fill?.options.find((o) => o.long === '--open');
    expect(opt).toBeDefined();
    expect(opt?.defaultValue).toBe(false);
  });

  it('fill command has --json option', () => {
    const program = buildProgram();
    const fill = program.commands.find((c) => c.name() === 'fill');
    const opt = fill?.options.find((o) => o.long === '--json');
    expect(opt).toBeDefined();
  });

  it('fill command has --fresh flag defaulting to false', () => {
    const program = buildProgram();
    const fill = program.commands.find((c) => c.name() === 'fill');
    const opt = fill?.options.find((o) => o.long === '--fresh');
    expect(opt).toBeDefined();
    expect(opt?.defaultValue).toBe(false);
  });

  it('has six top-level commands and no more', () => {
    const program = buildProgram();
    expect(program.commands).toHaveLength(6);
  });

  describe('picker-mode unknown option validation', () => {
    let errorSpy: MockInstance;
    let exitSpy: MockInstance;
    let savedArgv: string[];

    beforeEach(() => {
      vi.clearAllMocks();
      savedArgv = process.argv;
      errorSpy = vi.spyOn(logger, 'error').mockReturnValue(undefined);
      exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((_code?: string | number | null) => undefined as never);
    });

    afterEach(() => {
      process.argv = savedArgv;
      vi.restoreAllMocks();
    });

    it('exits with an error when an unrecognised long option is passed', () => {
      process.argv = ['node', 'fpdf', '--unknown-flag'];
      buildProgram().parse(['node', 'fpdf', '--unknown-flag']);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Unknown option: '--unknown-flag'"),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits with an error when an unrecognised short option is passed', () => {
      process.argv = ['node', 'fpdf', '-v'];
      buildProgram().parse(['node', 'fpdf', '-v']);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown option: '-v'"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('export command action', () => {
    let infoSpy: MockInstance;
    let errorSpy: MockInstance;
    let exitSpy: MockInstance;

    const mockDoc = {
      metadata: {
        version: '1.0',
        originalPdf: '/abs/form.pdf',
        pdfFilename: 'form.pdf',
        pdfHash: 'sha256:abc',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        pageCount: 1,
      },
      pages: [],
    };

    beforeEach(() => {
      vi.clearAllMocks();
      infoSpy = vi.spyOn(logger, 'info').mockReturnValue(undefined);
      errorSpy = vi.spyOn(logger, 'error').mockReturnValue(undefined);
      exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((_code?: string | number | null) => undefined as never);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('reads the json, calls exportPdf, and writes the output', async () => {
      const { exportPdf } = await import('../exporter.js');
      const { readFile, writeFile } = await import('node:fs/promises');
      const filledBytes = new Uint8Array([37, 80, 68, 70]); // %PDF
      vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(mockDoc));
      vi.mocked(exportPdf).mockResolvedValueOnce(filledBytes);

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'export', 'form.fpdf.json']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(readFile).toHaveBeenCalledWith(expect.stringContaining('form.fpdf.json'), 'utf-8');
      expect(exportPdf).toHaveBeenCalledWith('/abs/form.pdf', mockDoc);
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining('form-filled.pdf'),
        filledBytes,
      );
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('form-filled.pdf'));
    });

    it('respects the --output flag', async () => {
      const { exportPdf } = await import('../exporter.js');
      const { readFile, writeFile } = await import('node:fs/promises');
      vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(mockDoc));
      vi.mocked(exportPdf).mockResolvedValueOnce(new Uint8Array());

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'export', 'form.fpdf.json', '--output', '/tmp/out.pdf']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(writeFile).toHaveBeenCalledWith('/tmp/out.pdf', expect.anything());
    });

    it('logs an error and exits when exportPdf rejects', async () => {
      const { exportPdf } = await import('../exporter.js');
      const { readFile } = await import('node:fs/promises');
      vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(mockDoc));
      vi.mocked(exportPdf).mockRejectedValue(new Error('pdf locked'));

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'export', 'form.fpdf.json']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(errorSpy).toHaveBeenCalledWith('pdf locked');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('logs a stringified non-Error value when export rejects with a non-Error', async () => {
      const { exportPdf } = await import('../exporter.js');
      const { readFile } = await import('node:fs/promises');
      vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(mockDoc));
      vi.mocked(exportPdf).mockRejectedValue('disk full');

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'export', 'form.fpdf.json']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(errorSpy).toHaveBeenCalledWith('disk full');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('fill command action', () => {
    let infoSpy: MockInstance;
    let errorSpy: MockInstance;
    let exitSpy: MockInstance;

    beforeEach(() => {
      vi.clearAllMocks(); // reset call counts on vi.fn() mocks between tests
      infoSpy = vi.spyOn(logger, 'info').mockReturnValue(undefined);
      errorSpy = vi.spyOn(logger, 'error').mockReturnValue(undefined);
      exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((_code?: string | number | null) => undefined as never);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('analyzes the PDF, starts the server, and prints the URL', async () => {
      const { analyzePdf } = await import('../analyzer.js');
      const { startServer } = await import('../server.js');
      const mockDoc = {
        metadata: {
          version: '1.0',
          originalPdf: '/abs/form.pdf',
          pdfFilename: 'form.pdf',
          pdfHash: 'sha256:abc',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          pageCount: 1,
        },
        pages: [],
      };
      vi.mocked(analyzePdf).mockResolvedValue(mockDoc);
      vi.mocked(startServer).mockResolvedValue({
        url: 'http://127.0.0.1:12345',
        networkUrls: ['http://127.0.0.1:12345'],
        ownerToken: null,
        close: vi.fn().mockResolvedValue(undefined),
      });

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'fill', 'form.pdf']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(analyzePdf).toHaveBeenCalledWith(expect.stringContaining('form.pdf'));
      expect(startServer).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('form.pdf'));
      expect(stdoutSpy).toHaveBeenCalledWith('http://127.0.0.1:12345\n');

      stdoutSpy.mockRestore();
    });

    it('resumes from an existing .fpdf.json when --json is passed', async () => {
      const { startServer } = await import('../server.js');
      const { readFile } = await import('node:fs/promises');
      const mockDoc = {
        metadata: {
          version: '1.0',
          originalPdf: '/abs/form.pdf',
          pdfFilename: 'form.pdf',
          pdfHash: 'sha256:abc',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          pageCount: 1,
        },
        pages: [],
      };
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(mockDoc));
      vi.mocked(startServer).mockResolvedValue({
        url: 'http://127.0.0.1:12345',
        networkUrls: ['http://127.0.0.1:12345'],
        ownerToken: null,
        close: vi.fn().mockResolvedValue(undefined),
      });

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'fill', 'form.pdf', '--json', 'form.fpdf.json']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(readFile).toHaveBeenCalledWith(expect.stringContaining('form.fpdf.json'), 'utf-8');
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Resumed session'));
      expect(startServer).toHaveBeenCalled();

      stdoutSpy.mockRestore();
    });

    it('auto-resumes from the default .fpdf.json when it exists without --json flag', async () => {
      const { startServer } = await import('../server.js');
      const { analyzePdf } = await import('../analyzer.js');
      const { readFile } = await import('node:fs/promises');
      const mockDoc = {
        metadata: {
          version: '1.0',
          originalPdf: '/abs/form.pdf',
          pdfFilename: 'form.pdf',
          pdfHash: 'sha256:abc',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          pageCount: 1,
        },
        pages: [],
      };
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(mockDoc));
      vi.mocked(startServer).mockResolvedValue({
        url: 'http://127.0.0.1:12345',
        networkUrls: ['http://127.0.0.1:12345'],
        ownerToken: null,
        close: vi.fn().mockResolvedValue(undefined),
      });

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'fill', 'form.pdf']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(analyzePdf).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Resumed session'));
      expect(startServer).toHaveBeenCalled();

      stdoutSpy.mockRestore();
    });

    it('re-analyzes and overwrites the session when --fresh is passed', async () => {
      const { startServer } = await import('../server.js');
      const { analyzePdf } = await import('../analyzer.js');
      const { readFile } = await import('node:fs/promises');
      const freshDoc = {
        metadata: {
          version: '1.0',
          originalPdf: '/abs/form.pdf',
          pdfFilename: 'form.pdf',
          pdfHash: 'sha256:fresh',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          pageCount: 1,
        },
        pages: [],
      };
      // readFile would succeed (existing json) but --fresh should skip it entirely
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(freshDoc));
      vi.mocked(analyzePdf).mockResolvedValue(freshDoc);
      vi.mocked(startServer).mockResolvedValue({
        url: 'http://127.0.0.1:12345',
        networkUrls: ['http://127.0.0.1:12345'],
        ownerToken: null,
        close: vi.fn().mockResolvedValue(undefined),
      });

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'fill', 'form.pdf', '--fresh']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(analyzePdf).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Fresh analysis'));
      expect(startServer).toHaveBeenCalled();

      stdoutSpy.mockRestore();
    });

    it('opens the browser when --open is passed', async () => {
      const { analyzePdf } = await import('../analyzer.js');
      const { startServer } = await import('../server.js');
      const openModule = await import('open');
      vi.mocked(analyzePdf).mockResolvedValue({
        metadata: {
          version: '1.0',
          originalPdf: '/abs/form.pdf',
          pdfFilename: 'form.pdf',
          pdfHash: 'sha256:abc',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          pageCount: 1,
        },
        pages: [],
      });
      vi.mocked(startServer).mockResolvedValue({
        url: 'http://127.0.0.1:12345',
        networkUrls: ['http://127.0.0.1:12345'],
        ownerToken: null,
        close: vi.fn().mockResolvedValue(undefined),
      });

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'fill', 'form.pdf', '--open']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(openModule.default).toHaveBeenCalledWith('http://127.0.0.1:12345');
    });

    it('does not warn when the doc has fillable fields', async () => {
      const { analyzePdf } = await import('../analyzer.js');
      const { startServer } = await import('../server.js');
      const { readFile } = await import('node:fs/promises');
      // Ensure fill triggers fresh analysis (not resume), regardless of prior test state.
      vi.mocked(readFile).mockRejectedValue(
        Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
      );
      const warnSpy = vi.spyOn(logger, 'warn').mockReturnValue(undefined);
      vi.mocked(analyzePdf).mockResolvedValue({
        metadata: {
          version: '1.0',
          originalPdf: '/abs/form.pdf',
          pdfFilename: 'form.pdf',
          pdfHash: 'sha256:abc',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          pageCount: 1,
        },
        pages: [
          {
            pageNumber: 1,
            widthPt: 612,
            heightPt: 792,
            pageType: 'acroform',
            fields: [
              {
                id: 'f1',
                name: 'Name',
                type: 'text',
                label: 'Name',
                displayName: 'Name',
                placement: { x: 50, y: 700, width: 150, height: 14 },
                value: '',
                required: false,
                readOnly: false,
                options: [],
              },
            ],
            candidateFields: [],
            textBlocks: [],
          },
        ],
      });
      vi.mocked(startServer).mockResolvedValue({
        url: 'http://127.0.0.1:12345',
        networkUrls: ['http://127.0.0.1:12345'],
        ownerToken: null,
        close: vi.fn().mockResolvedValue(undefined),
      });

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const program = buildProgram();
      program.parse(['node', 'fpdf', 'fill', 'form.pdf']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('No fillable fields'));
      stdoutSpy.mockRestore();
    });

    it('warns when the doc has no usable fields', async () => {
      const { analyzePdf } = await import('../analyzer.js');
      const { startServer } = await import('../server.js');
      const { readFile } = await import('node:fs/promises');
      vi.mocked(readFile).mockRejectedValue(
        Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
      );
      const warnSpy = vi.spyOn(logger, 'warn').mockReturnValue(undefined);
      vi.mocked(analyzePdf).mockResolvedValue({
        metadata: {
          version: '1.0',
          originalPdf: '/abs/form.pdf',
          pdfFilename: 'form.pdf',
          pdfHash: 'sha256:abc',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          pageCount: 1,
        },
        pages: [
          {
            pageNumber: 1,
            widthPt: 612,
            heightPt: 792,
            pageType: 'hybrid',
            fields: [],
            // Only checkbox candidates at medium/high — should still warn (checkboxes don't count)
            candidateFields: [
              {
                id: 'c1',
                type: 'checkbox',
                label: 'Emergency',
                displayName: 'Emergency',
                placement: { x: 30, y: 650, width: 12, height: 12 },
                value: '',
                confidence: 'high',
                dismissed: false,
              },
            ],
            textBlocks: [],
          },
        ],
      });
      vi.mocked(startServer).mockResolvedValue({
        url: 'http://127.0.0.1:12345',
        networkUrls: ['http://127.0.0.1:12345'],
        ownerToken: null,
        close: vi.fn().mockResolvedValue(undefined),
      });

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const program = buildProgram();
      program.parse(['node', 'fpdf', 'fill', 'form.pdf']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No fillable fields'));
      stdoutSpy.mockRestore();
    });

    it('logs a stringified error when a non-AnalyzerError is thrown', async () => {
      const { analyzePdf } = await import('../analyzer.js');
      const { startServer } = await import('../server.js');
      vi.mocked(analyzePdf).mockResolvedValue({
        metadata: {
          version: '1.0',
          originalPdf: '/abs/form.pdf',
          pdfFilename: 'form.pdf',
          pdfHash: 'sha256:abc',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          pageCount: 1,
        },
        pages: [],
      });
      vi.mocked(startServer).mockRejectedValue('string error');

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'fill', 'form.pdf']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(errorSpy).toHaveBeenCalledWith('string error');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('logs an error and exits when the server fails to start', async () => {
      const { analyzePdf } = await import('../analyzer.js');
      const { startServer } = await import('../server.js');
      vi.mocked(analyzePdf).mockResolvedValue({
        metadata: {
          version: '1.0',
          originalPdf: '/abs/form.pdf',
          pdfFilename: 'form.pdf',
          pdfHash: 'sha256:abc',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          pageCount: 1,
        },
        pages: [],
      });
      vi.mocked(startServer).mockRejectedValue(new Error('port in use'));

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'fill', 'form.pdf']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('port in use'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('migrates and re-analyzes when the loaded JSON has a legacy radio field with boolean value', async () => {
      const { analyzePdf } = await import('../analyzer.js');
      const { startServer } = await import('../server.js');
      const { readFile } = await import('node:fs/promises');

      // Legacy doc:
      //  - radio field without radioValue → triggers needsRadioMigration via !('radioValue' in f)
      //  - radio field WITH radioValue but boolean value → triggers via typeof value === 'boolean'
      //  - text field with a saved value → exercises the migrateDoc value-copy path
      const legacyDoc = {
        metadata: {
          version: '1.0',
          originalPdf: '/abs/form.pdf',
          pdfFilename: 'form.pdf',
          pdfHash: 'sha256:old',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          pageCount: 1,
        },
        pages: [
          {
            pageNumber: 1,
            widthPt: 612,
            heightPt: 792,
            pageType: 'acroform',
            fields: [
              { id: 'r1', name: 'choice', type: 'radio', value: true, radioValue: 'yes' },
              { id: 't1', name: 'firstName', type: 'text', value: 'Alice' },
            ],
            candidateFields: [],
            textBlocks: [],
          },
        ],
      };
      const freshDoc = {
        metadata: {
          version: '1.0',
          originalPdf: '/abs/form.pdf',
          pdfFilename: 'form.pdf',
          pdfHash: 'sha256:fresh',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          pageCount: 1,
        },
        pages: [
          {
            pageNumber: 1,
            widthPt: 612,
            heightPt: 792,
            pageType: 'acroform',
            fields: [
              // firstName is in saved (value 'Alice') → v !== undefined → TRUE branch
              {
                id: 'f1',
                name: 'firstName',
                type: 'text',
                label: 'First Name',
                displayName: 'First Name',
                placement: { x: 50, y: 700, width: 150, height: 14 },
                value: '',
                required: false,
                readOnly: false,
                options: [],
              },
              // lastName is NOT in saved → v === undefined → FALSE branch of v !== undefined
              {
                id: 'f2',
                name: 'lastName',
                type: 'text',
                label: 'Last Name',
                displayName: 'Last Name',
                placement: { x: 50, y: 680, width: 150, height: 14 },
                value: '',
                required: false,
                readOnly: false,
                options: [],
              },
            ],
            candidateFields: [],
            textBlocks: [],
          },
        ],
      };

      vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(legacyDoc));
      vi.mocked(analyzePdf).mockResolvedValue(freshDoc as never);
      vi.mocked(startServer).mockResolvedValue({
        url: 'http://127.0.0.1:12345',
        networkUrls: ['http://127.0.0.1:12345'],
        ownerToken: null,
        close: vi.fn().mockResolvedValue(undefined),
      });

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const program = buildProgram();
      program.parse(['node', 'fpdf', 'fill', 'form.pdf']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(analyzePdf).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Migrating'));
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Migration complete'));
      stdoutSpy.mockRestore();
    });
  });

  describe('analyze command action', () => {
    let infoSpy: MockInstance;
    let errorSpy: MockInstance;
    let exitSpy: MockInstance;

    beforeEach(() => {
      infoSpy = vi.spyOn(logger, 'info').mockReturnValue(undefined);
      errorSpy = vi.spyOn(logger, 'error').mockReturnValue(undefined);
      exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
        throw new Error('process.exit called');
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('calls analyzePdf with the provided file path and writes the json', async () => {
      const { analyzePdf } = await import('../analyzer.js');
      const { writeFile } = await import('node:fs/promises');
      vi.mocked(analyzePdf).mockResolvedValue({
        metadata: {
          version: '1.0',
          originalPdf: '/abs/form.pdf',
          pdfFilename: 'form.pdf',
          pdfHash: 'sha256:abc',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          pageCount: 1,
        },
        pages: [],
      });

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'analyze', 'form.pdf']);

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(analyzePdf).toHaveBeenCalledWith('form.pdf');
      expect(writeFile).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('form.fpdf.json'));
    });

    it('does not warn when the doc has fillable fields', async () => {
      const { analyzePdf } = await import('../analyzer.js');
      const { writeFile } = await import('node:fs/promises');
      const warnSpy = vi.spyOn(logger, 'warn').mockReturnValue(undefined);
      vi.mocked(analyzePdf).mockResolvedValue({
        metadata: {
          version: '1.0',
          originalPdf: '/abs/form.pdf',
          pdfFilename: 'form.pdf',
          pdfHash: 'sha256:abc',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          pageCount: 1,
        },
        pages: [
          {
            pageNumber: 1,
            widthPt: 612,
            heightPt: 792,
            pageType: 'acroform',
            fields: [
              {
                id: 'f1',
                name: 'N',
                type: 'text',
                label: 'N',
                displayName: 'N',
                placement: { x: 0, y: 0, width: 100, height: 14 },
                value: '',
                required: false,
                readOnly: false,
                options: [],
              },
            ],
            candidateFields: [],
            textBlocks: [],
          },
        ],
      });
      const program = buildProgram();
      program.parse(['node', 'fpdf', 'analyze', 'form.pdf']);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('No fillable fields'));
      void writeFile;
    });

    it('warns when the doc has no usable fields', async () => {
      const { analyzePdf } = await import('../analyzer.js');
      const { writeFile } = await import('node:fs/promises');
      const warnSpy = vi.spyOn(logger, 'warn').mockReturnValue(undefined);
      vi.mocked(analyzePdf).mockResolvedValue({
        metadata: {
          version: '1.0',
          originalPdf: '/abs/form.pdf',
          pdfFilename: 'form.pdf',
          pdfHash: 'sha256:abc',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          pageCount: 1,
        },
        pages: [
          {
            pageNumber: 1,
            widthPt: 612,
            heightPt: 792,
            pageType: 'vector',
            fields: [],
            candidateFields: [
              {
                id: 'c1',
                type: 'text',
                label: '',
                displayName: '',
                placement: { x: 50, y: 670, width: 150, height: 1 },
                value: '',
                confidence: 'low',
                dismissed: false,
              },
            ],
            textBlocks: [],
          },
        ],
      });
      const program = buildProgram();
      program.parse(['node', 'fpdf', 'analyze', 'form.pdf']);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No fillable fields'));
      void writeFile;
    });

    it('logs a stringified error when a non-AnalyzerError is thrown', async () => {
      const { analyzePdf } = await import('../analyzer.js');
      vi.mocked(analyzePdf).mockRejectedValue('unexpected string');

      exitSpy.mockImplementation((_code?: string | number | null) => undefined as never);

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'analyze', 'missing.pdf']);

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(errorSpy).toHaveBeenCalledWith('unexpected string');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('logs an error and exits when analyzePdf rejects', async () => {
      const { analyzePdf, AnalyzerError } = await import('../analyzer.js');
      vi.mocked(analyzePdf).mockRejectedValue(new AnalyzerError('file not found'));

      exitSpy.mockImplementation((_code?: string | number | null) => undefined as never);

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'analyze', 'missing.pdf']);

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(errorSpy).toHaveBeenCalledWith('file not found');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('debug-export command action', () => {
    let errorSpy: MockInstance;
    let exitSpy: MockInstance;

    beforeEach(() => {
      vi.clearAllMocks();
      errorSpy = vi.spyOn(logger, 'error').mockReturnValue(undefined);
      exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((_code?: string | number | null) => undefined as never);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('prints radio and checkbox field info and reports no XFA when xfaInfo is null', async () => {
      const { getXfaDatasetsInfo } = await import('../analyzer.js');
      const { readFile } = await import('node:fs/promises');
      const { PDFDocument } = await import('pdf-lib');

      const docWithFields = {
        metadata: {
          version: '1.0',
          originalPdf: '/abs/form.pdf',
          pdfFilename: 'form.pdf',
          pdfHash: 'sha256:abc',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          pageCount: 1,
        },
        pages: [
          {
            pageNumber: 1,
            widthPt: 612,
            heightPt: 792,
            pageType: 'acroform',
            fields: [
              { id: 'r1', name: 'plan', type: 'radio', value: 'hmo', radioValue: 'hmo' },
              { id: 'c1', name: 'agree', type: 'checkbox', value: true },
              { id: 't1', name: 'name', type: 'text', value: 'Alice' },
            ],
            candidateFields: [],
            textBlocks: [],
          },
        ],
      };

      vi.mocked(readFile)
        .mockResolvedValueOnce(JSON.stringify(docWithFields))
        .mockResolvedValueOnce(Buffer.from('%PDF-1.4'));
      (PDFDocument as unknown as { load: ReturnType<typeof vi.fn> }).load.mockResolvedValue({});
      vi.mocked(getXfaDatasetsInfo).mockReturnValue(null);

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const program = buildProgram();
      program.parse(['node', 'fpdf', 'debug-export', 'form.fpdf.json']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('name=plan'));
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('name=agree'));
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('No XFA datasets found'));
      stdoutSpy.mockRestore();
    });

    it('prints XFA datasets XML before and after patching', async () => {
      const { getXfaDatasetsInfo, patchXfaDatasetsXml } = await import('../analyzer.js');
      const { readFile } = await import('node:fs/promises');
      const { PDFDocument } = await import('pdf-lib');

      const simpleDoc = {
        metadata: {
          version: '1.0',
          originalPdf: '/abs/form.pdf',
          pdfFilename: 'form.pdf',
          pdfHash: 'sha256:abc',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          pageCount: 1,
        },
        pages: [
          {
            pageNumber: 1,
            widthPt: 612,
            heightPt: 792,
            pageType: 'acroform',
            fields: [{ id: 't1', name: 'firstName', type: 'text', value: 'Bob' }],
            candidateFields: [],
            textBlocks: [],
          },
        ],
      };

      vi.mocked(readFile)
        .mockResolvedValueOnce(JSON.stringify(simpleDoc))
        .mockResolvedValueOnce(Buffer.from('%PDF-1.4'));
      (PDFDocument as unknown as { load: ReturnType<typeof vi.fn> }).load.mockResolvedValue({});
      vi.mocked(getXfaDatasetsInfo).mockReturnValue({
        ref: {} as never,
        xml: '<datasets><firstName/></datasets>',
      });
      vi.mocked(patchXfaDatasetsXml).mockReturnValue(
        '<datasets><firstName>Bob</firstName></datasets>',
      );

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const program = buildProgram();
      program.parse(['node', 'fpdf', 'debug-export', 'form.fpdf.json']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('XFA datasets XML (initial)'));
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('XFA datasets XML (patched)'));
      stdoutSpy.mockRestore();
    });

    it('logs a stringified error and exits when debug-export fails', async () => {
      const { readFile } = await import('node:fs/promises');
      vi.mocked(readFile).mockRejectedValue('disk error');

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'debug-export', 'missing.fpdf.json']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(errorSpy).toHaveBeenCalledWith('disk error');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('logs an Error message and exits when debug-export throws an Error', async () => {
      const { readFile } = await import('node:fs/promises');
      vi.mocked(readFile).mockRejectedValue(new Error('file not found'));

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'debug-export', 'missing.fpdf.json']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(errorSpy).toHaveBeenCalledWith('file not found');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('save-acroform command action', () => {
    let infoSpy: MockInstance;
    let warnSpy: MockInstance;
    let errorSpy: MockInstance;
    let exitSpy: MockInstance;

    const mockDoc = {
      metadata: {
        version: '1.0',
        originalPdf: '/abs/form.pdf',
        pdfFilename: 'form.pdf',
        pdfHash: 'sha256:abc',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        pageCount: 1,
        pdfKind: 'no-acroform' as const,
      },
      pages: [
        {
          pageNumber: 1,
          widthPt: 612,
          heightPt: 792,
          pageType: 'vector' as const,
          fields: [],
          candidateFields: [
            {
              id: 'c1',
              type: 'text' as const,
              label: 'Name',
              displayName: 'Name',
              placement: { x: 50, y: 700, width: 150, height: 14 },
              value: 'Alice',
              confidence: 'high' as const,
              dismissed: false,
            },
          ],
          textBlocks: [],
        },
      ],
    };

    beforeEach(() => {
      vi.clearAllMocks();
      infoSpy = vi.spyOn(logger, 'info').mockReturnValue(undefined);
      warnSpy = vi.spyOn(logger, 'warn').mockReturnValue(undefined);
      errorSpy = vi.spyOn(logger, 'error').mockReturnValue(undefined);
      exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((_code?: string | number | null) => undefined as never);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('registers the save-acroform command', () => {
      const program = buildProgram();
      const cmd = program.commands.find((c) => c.name() === 'save-acroform');
      expect(cmd).toBeDefined();
    });

    it('save-acroform has --output option', () => {
      const program = buildProgram();
      const cmd = program.commands.find((c) => c.name() === 'save-acroform');
      const opt = cmd?.options.find((o) => o.long === '--output');
      expect(opt).toBeDefined();
    });

    it('analyzes PDF when no .fpdf.json exists and writes acroform PDF', async () => {
      const { existsSync } = await import('node:fs');
      const { analyzePdf } = await import('../analyzer.js');
      const { exportPdf } = await import('../exporter.js');
      const { writeFile } = await import('node:fs/promises');

      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(analyzePdf).mockResolvedValue(mockDoc);
      const outBytes = new Uint8Array([37, 80, 68, 70]);
      vi.mocked(exportPdf).mockResolvedValue(outBytes);

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'save-acroform', 'form.pdf']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(analyzePdf).toHaveBeenCalledWith(expect.stringContaining('form.pdf'));
      expect(exportPdf).toHaveBeenCalledWith(
        expect.stringContaining('form.pdf'),
        expect.anything(),
        { readOnly: false },
      );
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining('form.fpdf.acroform.pdf'),
        outBytes,
      );
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('form.fpdf.acroform.pdf'));
    });

    it('loads .fpdf.json and pre-fills when user accepts (default Y)', async () => {
      const { existsSync } = await import('node:fs');
      const { exportPdf } = await import('../exporter.js');
      const { readFile } = await import('node:fs/promises');
      const readline = await import('node:readline');

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(mockDoc));
      vi.mocked(readline.createInterface).mockReturnValue({
        question: vi.fn((_p: unknown, cb: (a: string) => void) => {
          cb('');
        }), // default Y
        close: vi.fn(),
      } as unknown as RlInterface);
      vi.mocked(exportPdf).mockResolvedValue(new Uint8Array());

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'save-acroform', 'form.pdf']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      // candidate field value 'Alice' should be preserved
      const docArg = vi.mocked(exportPdf).mock.calls[0]?.[1];
      expect(docArg?.pages[0]?.candidateFields[0]?.value).toBe('Alice');
    });

    it('clears field values when user answers n', async () => {
      const { existsSync } = await import('node:fs');
      const { exportPdf } = await import('../exporter.js');
      const { readFile } = await import('node:fs/promises');
      const readline = await import('node:readline');

      const docWithValues = {
        ...mockDoc,
        pages: [
          {
            ...mockDoc.pages[0],
            fields: [
              {
                id: 'f1',
                name: 'FirstName',
                type: 'text' as const,
                label: 'First Name',
                displayName: 'First Name',
                placement: { x: 50, y: 700, width: 150, height: 14 },
                value: 'Bob',
                required: false,
                readOnly: false,
                options: [],
              },
            ],
            candidateFields: [
              {
                id: 'c1',
                type: 'text' as const,
                label: 'Name',
                displayName: 'Name',
                placement: { x: 50, y: 700, width: 150, height: 14 },
                value: 'Alice',
                confidence: 'high' as const,
                dismissed: false,
              },
            ],
          },
        ],
      };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(docWithValues));
      vi.mocked(readline.createInterface).mockReturnValue({
        question: vi.fn((_p: unknown, cb: (a: string) => void) => {
          cb('n');
        }),
        close: vi.fn(),
      } as unknown as RlInterface);
      vi.mocked(exportPdf).mockResolvedValue(new Uint8Array());

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'save-acroform', 'form.pdf']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const docArg = vi.mocked(exportPdf).mock.calls[0]?.[1];
      expect(docArg?.pages[0]?.fields[0]?.value).toBe('');
      expect(docArg?.pages[0]?.candidateFields[0]?.value).toBe('');
    });

    it('warns and skips export when pdfKind is acroform', async () => {
      const { existsSync } = await import('node:fs');
      const { analyzePdf } = await import('../analyzer.js');
      const { exportPdf } = await import('../exporter.js');

      const acroDoc = {
        ...mockDoc,
        metadata: { ...mockDoc.metadata, pdfKind: 'acroform' as const },
      };
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(analyzePdf).mockResolvedValue(acroDoc);

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'save-acroform', 'form.pdf']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already has AcroForm fields'));
      expect(exportPdf).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('respects the --output flag', async () => {
      const { existsSync } = await import('node:fs');
      const { analyzePdf } = await import('../analyzer.js');
      const { exportPdf } = await import('../exporter.js');
      const { writeFile } = await import('node:fs/promises');

      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(analyzePdf).mockResolvedValue(mockDoc);
      vi.mocked(exportPdf).mockResolvedValue(new Uint8Array());

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'save-acroform', 'form.pdf', '--output', '/tmp/out.pdf']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(writeFile).toHaveBeenCalledWith('/tmp/out.pdf', expect.anything());
    });

    it('logs an error and exits when exportPdf rejects', async () => {
      const { existsSync } = await import('node:fs');
      const { analyzePdf } = await import('../analyzer.js');
      const { exportPdf } = await import('../exporter.js');

      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(analyzePdf).mockResolvedValue(mockDoc);
      vi.mocked(exportPdf).mockRejectedValue(new Error('write failed'));

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'save-acroform', 'form.pdf']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(errorSpy).toHaveBeenCalledWith('write failed');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  it('help output includes fill and export options sections', () => {
    const program = buildProgram();
    let helpOutput = '';
    program.configureOutput({
      writeOut: (str) => {
        helpOutput += str;
      },
    });
    program.outputHelp();
    expect(helpOutput).toContain('fill options:');
    expect(helpOutput).toContain('export options:');
  });
});

describe('entry point guard', () => {
  it('does not call buildProgram().parse() when process.argv[1] resolves to a different path than the module', async () => {
    // Covers the common case: running under a test runner where process.argv[1] is
    // the vitest binary — not cli.ts.  parse() must never be invoked automatically.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const savedArgv = [...process.argv];
    process.argv = ['node', '/usr/local/bin/vitest'];
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn(),
      // Identity function — every path stays as-is, so argv[1] ≠ module URL.
      realpathSync: vi.fn().mockImplementation((p: string) => p),
    }));
    try {
      await import('../cli.js');
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      process.argv = savedArgv;
      exitSpy.mockRestore();
      vi.resetModules();
    }
  });

  it('calls buildProgram().parse() when process.argv[1] is a symlink that resolves to the same realpath as the module', async () => {
    // Regression test: before the realpathSync fix, running via `npx @the-hcma/fpdf`
    // produced no output.  npm/npx places a .bin/ symlink as argv[1]; the symlink path
    // never matched import.meta.url (the real path), so buildProgram().parse() was
    // never called.  Now both sides go through realpathSync() first.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const savedArgv = [...process.argv];
    process.argv = ['node', '/home/user/.npm/_npx/12345/node_modules/.bin/fpdf', '--help'];
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn(),
      // Both the .bin/fpdf symlink and import.meta.url resolve to the same real
      // path — exactly what happens when the package is run via npx or a global
      // npm/pnpm install.
      realpathSync: vi.fn().mockReturnValue('/real/path/to/dist/cli.js'),
    }));
    try {
      await expect(import('../cli.js')).rejects.toThrow('process.exit called');
    } finally {
      process.argv = savedArgv;
      exitSpy.mockRestore();
      vi.resetModules();
    }
  });
});

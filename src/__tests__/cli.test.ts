import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { buildProgram } from '../cli.js';
import { logger } from '../logger.js';

vi.mock('../analyzer.js', () => ({
  analyzePdf: vi.fn(),
  AnalyzerError: class AnalyzerError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'AnalyzerError';
    }
  },
}));

vi.mock('../server.js', () => ({
  startServer: vi.fn(),
}));

vi.mock('open', () => ({ default: vi.fn().mockResolvedValue(undefined) }));

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue('{}'),
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

  it('has three top-level commands and no more', () => {
    const program = buildProgram();
    expect(program.commands).toHaveLength(3);
  });

  describe('stub command actions emit an error and exit', () => {
    let errorSpy: MockInstance;
    let exitSpy: MockInstance;

    beforeEach(() => {
      errorSpy = vi.spyOn(logger, 'error').mockReturnValue(undefined);
      exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
        throw new Error('process.exit called');
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('export action logs error and exits', () => {
      const program = buildProgram();
      program.exitOverride();
      expect(() => program.parse(['node', 'fpdf', 'export', 'form.fpdf.json'])).toThrow();
      expect(errorSpy).toHaveBeenCalledWith('export command not yet implemented');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('fill command action', () => {
    let infoSpy: MockInstance;
    let errorSpy: MockInstance;
    let exitSpy: MockInstance;

    beforeEach(() => {
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
        close: vi.fn().mockResolvedValue(undefined),
      });

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'fill', 'form.pdf']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(analyzePdf).toHaveBeenCalledWith(expect.stringContaining('form.pdf'));
      expect(startServer).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('http://127.0.0.1:12345'));
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
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(mockDoc) as never);
      vi.mocked(startServer).mockResolvedValue({
        url: 'http://127.0.0.1:12345',
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
        close: vi.fn().mockResolvedValue(undefined),
      });

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'fill', 'form.pdf', '--open']);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(openModule.default).toHaveBeenCalledWith('http://127.0.0.1:12345');
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
});

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

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
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

    it('fill action logs error and exits', () => {
      const program = buildProgram();
      program.exitOverride();
      expect(() => program.parse(['node', 'fpdf', 'fill', 'form.pdf'])).toThrow();
      expect(errorSpy).toHaveBeenCalledWith('fill command not yet implemented');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('export action logs error and exits', () => {
      const program = buildProgram();
      program.exitOverride();
      expect(() => program.parse(['node', 'fpdf', 'export', 'form.fpdf.json'])).toThrow();
      expect(errorSpy).toHaveBeenCalledWith('export command not yet implemented');
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

      // Give the micro-task queue a chance to settle
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(analyzePdf).toHaveBeenCalledWith('form.pdf');
      expect(writeFile).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('form.fpdf.json'));
    });

    it('logs an error and exits when analyzePdf rejects', async () => {
      const { analyzePdf, AnalyzerError } = await import('../analyzer.js');
      vi.mocked(analyzePdf).mockRejectedValue(new AnalyzerError('file not found'));

      // Use a non-throwing mock so the thrown error doesn't escape the async handler.
      exitSpy.mockImplementation((_code?: string | number | null) => undefined as never);

      const program = buildProgram();
      program.parse(['node', 'fpdf', 'analyze', 'missing.pdf']);

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(errorSpy).toHaveBeenCalledWith('file not found');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});

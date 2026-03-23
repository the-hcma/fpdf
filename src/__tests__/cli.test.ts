import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildProgram } from '../cli.js';
import { logger } from '../logger.js';

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

  describe('command actions emit an error and exit', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;
    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      errorSpy = vi.spyOn(logger, 'error').mockReturnValue(undefined);
      exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
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

    it('analyze action logs error and exits', () => {
      const program = buildProgram();
      program.exitOverride();
      expect(() => program.parse(['node', 'fpdf', 'analyze', 'form.pdf'])).toThrow();
      expect(errorSpy).toHaveBeenCalledWith('analyze command not yet implemented');
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
});

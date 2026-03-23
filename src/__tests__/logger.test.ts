import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../logger.js';

describe('logger', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.FPDF_DEBUG;
  });

  it('writes info messages to stdout with the correct prefix', () => {
    logger.info('hello world');
    expect(stdoutSpy).toHaveBeenCalledWith('[fpdf:info] hello world\n');
  });

  it('writes warn messages to stderr with the correct prefix', () => {
    logger.warn('something odd');
    expect(stderrSpy).toHaveBeenCalledWith('[fpdf:warn] something odd\n');
  });

  it('writes error messages to stderr with the correct prefix', () => {
    logger.error('something broke');
    expect(stderrSpy).toHaveBeenCalledWith('[fpdf:error] something broke\n');
  });

  it('does not write debug messages when FPDF_DEBUG is unset', () => {
    logger.debug('verbose details');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('writes debug messages to stderr when FPDF_DEBUG=1', () => {
    process.env.FPDF_DEBUG = '1';
    logger.debug('verbose details');
    expect(stderrSpy).toHaveBeenCalledWith('[fpdf:debug] verbose details\n');
  });

  it('writes extra args as JSON on a separate line for info', () => {
    logger.info('with args', { key: 'value' });
    expect(stdoutSpy).toHaveBeenNthCalledWith(1, '[fpdf:info] with args\n');
    expect(stdoutSpy).toHaveBeenNthCalledWith(2, '[{"key":"value"}]\n');
  });

  it('writes extra args as JSON on a separate line for warn', () => {
    logger.warn('something odd', { detail: 'x' });
    expect(stderrSpy).toHaveBeenNthCalledWith(1, '[fpdf:warn] something odd\n');
    expect(stderrSpy).toHaveBeenNthCalledWith(2, '[{"detail":"x"}]\n');
  });

  it('writes debug extra args as JSON when FPDF_DEBUG=1', () => {
    process.env.FPDF_DEBUG = '1';
    logger.debug('verbose', { trace: true });
    expect(stderrSpy).toHaveBeenNthCalledWith(1, '[fpdf:debug] verbose\n');
    expect(stderrSpy).toHaveBeenNthCalledWith(2, '[{"trace":true}]\n');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger, installWarnFilter, withSilencedWarn } from '../logger.js';

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
    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[info\] hello world\n$/),
    );
  });

  it('writes warn messages to stderr with the correct prefix', () => {
    logger.warn('something odd');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[warn] something odd\n'));
  });

  it('writes error messages to stderr with the correct prefix', () => {
    logger.error('something broke');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[error] something broke\n'));
  });

  it('does not write debug messages when FPDF_DEBUG is unset', () => {
    logger.debug('verbose details');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('writes debug messages to stderr when FPDF_DEBUG=1', () => {
    process.env.FPDF_DEBUG = '1';
    logger.debug('verbose details');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[debug] verbose details\n'));
  });

  it('writes extra args as JSON on a separate line for info', () => {
    logger.info('with args', { key: 'value' });
    expect(stdoutSpy).toHaveBeenNthCalledWith(1, expect.stringContaining('[info] with args\n'));
    expect(stdoutSpy).toHaveBeenNthCalledWith(2, '[{"key":"value"}]\n');
  });

  it('writes extra args as JSON on a separate line for warn', () => {
    logger.warn('something odd', { detail: 'x' });
    expect(stderrSpy).toHaveBeenNthCalledWith(1, expect.stringContaining('[warn] something odd\n'));
    expect(stderrSpy).toHaveBeenNthCalledWith(2, '[{"detail":"x"}]\n');
  });

  it('writes debug extra args as JSON when FPDF_DEBUG=1', () => {
    process.env.FPDF_DEBUG = '1';
    logger.debug('verbose', { trace: true });
    expect(stderrSpy).toHaveBeenNthCalledWith(1, expect.stringContaining('[debug] verbose\n'));
    expect(stderrSpy).toHaveBeenNthCalledWith(2, '[{"trace":true}]\n');
  });

  it('writes error extra args as JSON on a separate line', () => {
    logger.error('something broke', { code: 42 });
    expect(stderrSpy).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('[error] something broke\n'),
    );
    expect(stderrSpy).toHaveBeenNthCalledWith(2, '[{"code":42}]\n');
  });
});

describe('installWarnFilter', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('suppresses the pdf-lib XFA warning', () => {
    installWarnFilter();
    // eslint-disable-next-line no-console
    console.warn('Removing XFA form data as pdf-lib does not support reading or writing XFA');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('passes through unrelated console.warn messages', () => {
    installWarnFilter();
    // eslint-disable-next-line no-console
    console.warn('some other warning');
    expect(warnSpy).toHaveBeenCalledWith('some other warning');
  });

  it('passes through console.warn called with no arguments', () => {
    installWarnFilter();
    // eslint-disable-next-line no-console
    console.warn();
    expect(warnSpy).toHaveBeenCalledWith();
  });
});

describe('withSilencedWarn', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the provided function and returns its result', async () => {
    const result = await withSilencedWarn(() => Promise.resolve(42));
    expect(result).toBe(42);
  });
});

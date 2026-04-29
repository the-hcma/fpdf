#!/usr/bin/env node
import { writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { exportPdf } from './exporter.js';
import * as path from 'node:path';
import { Command } from 'commander';
import open from 'open';
import { logger, installWarnFilter } from './logger.js';
import { analyzePdf, AnalyzerError, getXfaDatasetsInfo, patchXfaDatasetsXml } from './analyzer.js';
import { startServer } from './server.js';
import type { FpdfDocument } from './types.js';

/**
 * Return true if the document has at least one fillable field or at least one
 * medium/high-confidence candidate field across all pages.  When false the PDF
 * is a print-and-fill form that fpdf cannot help with.
 */
function hasUsableFields(doc: FpdfDocument): boolean {
  return doc.pages.some(
    (p) =>
      p.fields.length > 0 ||
      p.candidateFields.some(
        (c) => (c.confidence === 'high' || c.confidence === 'medium') && c.type !== 'checkbox',
      ),
  );
}

/**
 * Return true if any radio field in the doc is missing `radioValue` (created
 * before the field was added to the schema) or has a legacy boolean value
 * (set by the pre-radioValue browser UI).  Either case means the JSON was
 * written by an older version and needs to be refreshed.
 */
function needsRadioMigration(doc: FpdfDocument): boolean {
  return doc.pages.some((p) =>
    p.fields.some(
      (f) => f.type === 'radio' && (!('radioValue' in f) || typeof f.value === 'boolean'),
    ),
  );
}

/**
 * Re-analyze `pdfPath` and copy any non-empty string field values from `oldDoc`
 * into the fresh document.  Boolean radio values from the old UI are dropped
 * (the user will need to re-select them).
 */
async function migrateDoc(pdfPath: string, oldDoc: FpdfDocument): Promise<FpdfDocument> {
  const freshDoc = await analyzePdf(pdfPath);

  // Build name→value map from oldDoc, keeping only unambiguous string values.
  const saved = new Map<string, string>();
  for (const page of oldDoc.pages) {
    for (const field of page.fields) {
      if (typeof field.value === 'string' && field.value !== '' && !saved.has(field.name)) {
        saved.set(field.name, field.value);
      }
    }
  }

  // Apply saved values to freshDoc fields.
  for (const page of freshDoc.pages) {
    for (const field of page.fields) {
      const v = saved.get(field.name);
      if (v !== undefined) field.value = v;
    }
  }

  return freshDoc;
}

/**
 * Returns true when the process has access to a graphical display.
 * On Linux this checks DISPLAY (X11) and WAYLAND_DISPLAY (Wayland).
 * On macOS and Windows a display is always assumed to be present.
 */
function hasDisplay(): boolean {
  if (process.platform === 'linux') {
    return Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY);
  }
  return true;
}

/**
 * Open `url` in the default browser if a graphical display is available,
 * logging the host name and URL.  When running headless (e.g. on a remote
 * server or in CI), logs a hint so the user can open the URL manually.
 */
async function openBrowser(url: string): Promise<void> {
  const host = hostname();
  if (hasDisplay()) {
    logger.info(`Opening browser on ${host} → ${url}`);
    await open(url);
  } else {
    logger.info(`Headless environment on ${host} — no display detected; open manually: ${url}`);
  }
}

/**
 * Try to find the PID of a process listening on the given TCP port.
 * Attempts `ss` (Linux) then `lsof` (macOS / Linux fallback).
 * Returns null if neither tool is available or no listener is found.
 */
function findPidOnPort(port: number): number | null {
  // ss path (Linux): output has users:(("...",pid=NNN,...)) when a process owns the socket
  const ss = spawnSync('ss', ['-tlnpH', `sport = :${String(port)}`], {
    encoding: 'utf-8',
    timeout: 2000,
  });
  if (ss.status === 0 && ss.stdout) {
    const m = /pid=(\d+)/.exec(ss.stdout);
    if (m?.[1]) return parseInt(m[1], 10);
  }

  // lsof fallback (macOS / Linux)
  const lsof = spawnSync('lsof', ['-ti', `:${String(port)}`, '-sTCP:LISTEN'], {
    encoding: 'utf-8',
    timeout: 2000,
  });
  if (lsof.status === 0 && lsof.stdout) {
    const firstLine = lsof.stdout.trim().split('\n')[0] ?? '';
    const pid = parseInt(firstLine, 10);
    if (!isNaN(pid)) return pid;
  }

  return null;
}

/**
 * Return true when the process with the given PID appears to be an fpdf instance.
 * Checks /proc/<pid>/cmdline (Linux) then falls back to `ps`.
 */
function isFpdfProcess(pid: number): boolean {
  // Linux: null-delimited argv in /proc/<pid>/cmdline
  try {
    const cmdline = readFileSync(`/proc/${String(pid)}/cmdline`, 'latin1');
    return cmdline.includes('fpdf');
  } catch {
    // not Linux or process already gone
  }

  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf-8',
    timeout: 2000,
  });
  return ps.status === 0 && ps.stdout.includes('fpdf');
}

/**
 * Poll until the process with the given PID is gone, or until timeoutMs elapses.
 */
async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0); // throws ESRCH when the process is gone
    } catch {
      return;
    }
    await new Promise<void>((r) => setTimeout(r, 100));
  }
}

/**
 * Start the server; when the port is already in use by a previous fpdf
 * instance, offer to stop that instance and retry.  Any other EADDRINUSE
 * (different process on the port) re-throws the original error.
 */
async function startServerRestarting(
  options: Parameters<typeof startServer>[0],
): Promise<import('./server.js').ServerHandle> {
  try {
    return await startServer(options);
  } catch (err: unknown) {
    if (!(err instanceof Error) || !err.message.includes('already in use')) throw err;

    const port = options.port;
    if (port === undefined) throw err; // OS-allocated port — should not reach here

    const pid = findPidOnPort(port);
    if (pid === null || !isFpdfProcess(pid)) throw err;

    const cyan = process.stderr.isTTY ? '\x1b[36m' : '';
    const reset = process.stderr.isTTY ? '\x1b[0m' : '';
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `${cyan}[fpdf] Another fpdf instance (pid ${String(pid)}) is already on port ${String(port)}. Stop it and restart? [Y/n]${reset} `,
        (a) => {
          rl.close();
          resolve(a);
        },
      );
    });

    if (/^[Nn]/u.test(answer)) throw err;

    process.kill(pid, 'SIGTERM');
    await waitForProcessExit(pid, 3000);
    return await startServer(options);
  }
}

export function buildProgram(): Command {
  installWarnFilter();
  const program = new Command();
  const require = createRequire(import.meta.url);
  const { version } = require('../package.json') as { version: string };
  const buildRevPath = new URL('../dist/.build-rev', import.meta.url);
  let buildRev = '';
  try {
    buildRev = readFileSync(buildRevPath, 'utf8').trim().slice(0, 7);
  } catch {
    // not present when running from source without a build
  }
  const versionString = buildRev ? `${version} (${buildRev})` : version;

  program
    .name('fpdf')
    .description('Fill PDF forms via a local browser overlay')
    .version(versionString);

  program
    .command('fill <file>')
    .description('Analyze a PDF and start a local fill session in the browser')
    .option(
      '--no-open',
      'Do not automatically open the browser (default: auto-open when a display is available)',
    )
    .option('--json <path>', 'Resume from an existing .fpdf.json session file')
    .option('--fresh', 'Ignore any existing .fpdf.json and re-analyze the PDF from scratch', false)
    .option(
      '--listen-all',
      'Bind to 0.0.0.0 instead of 127.0.0.1 (accessible on the local network)',
      false,
    )
    .option('--port <number>', 'TCP port to listen on (default: OS-allocated)')
    .action(
      (
        file: string,
        opts: { open: boolean; json?: string; fresh: boolean; listenAll: boolean; port?: string },
      ) => {
        const run = async (): Promise<void> => {
          const pdfPath = path.resolve(file);
          const defaultJsonPath = path.join(
            path.dirname(pdfPath),
            `${path.basename(pdfPath, path.extname(pdfPath))}.fpdf.json`,
          );
          const jsonPath = opts.json ? path.resolve(opts.json) : defaultJsonPath;

          let doc: FpdfDocument;
          if (opts.json) {
            // Explicit --json: load the specified file; error if it is missing.
            const raw = await readFile(jsonPath, 'utf-8');
            doc = JSON.parse(raw) as FpdfDocument;
            logger.info(`Resumed session from '${jsonPath}'`);
          } else if (opts.fresh) {
            // --fresh: skip any existing session and re-analyze unconditionally.
            doc = await analyzePdf(pdfPath);
            await writeFile(jsonPath, JSON.stringify(doc, null, 2), 'utf-8');
            logger.info(`Fresh analysis of '${pdfPath}' → '${jsonPath}'`);
          } else {
            // Auto-detect: load the default .fpdf.json if it exists, otherwise analyze.
            let raw: string | null = null;
            try {
              raw = await readFile(jsonPath, 'utf-8');
            } catch {
              // File absent — fall through to fresh analysis.
            }
            if (raw !== null) {
              const loaded = JSON.parse(raw) as FpdfDocument;
              if (needsRadioMigration(loaded)) {
                logger.info(`Migrating '${jsonPath}' (radio field schema updated) — re-analyzing…`);
                doc = await migrateDoc(pdfPath, loaded);
                await writeFile(jsonPath, JSON.stringify(doc, null, 2), 'utf-8');
                logger.info(`Migration complete → '${jsonPath}'`);
              } else {
                doc = loaded;
                logger.info(`Resumed session from '${jsonPath}'`);
              }
            } else {
              doc = await analyzePdf(pdfPath);
              await writeFile(jsonPath, JSON.stringify(doc, null, 2), 'utf-8');
              logger.info(`Analyzed '${pdfPath}' → '${jsonPath}'`);
            }
          }

          if (!hasUsableFields(doc)) {
            logger.warn(
              'No fillable fields detected. This PDF appears to be a print-and-fill form that fpdf cannot fill programmatically.',
            );
          }

          const totalFields = doc.pages.reduce((n, p) => n + p.fields.length, 0);
          const totalPages = doc.pages.length;
          const pageWord = totalPages === 1 ? 'page' : 'pages';
          const fieldWord = totalFields === 1 ? 'field' : 'fields';
          const autoListenAll = !hasDisplay();
          if (autoListenAll && !opts.listenAll) {
            logger.info('Headless environment detected — binding to 0.0.0.0 (network-accessible)');
          }
          const host = opts.listenAll || autoListenAll ? '0.0.0.0' : undefined;
          const port = opts.port !== undefined ? parseInt(opts.port, 10) : undefined;
          const handle = await startServerRestarting({
            pdfPath,
            doc,
            jsonPath,
            autoShutdown: true,
            ...(host !== undefined && { host }),
            ...(port !== undefined && { port }),
          });
          logger.info(
            `Ready — ${doc.metadata.pdfFilename} · ${String(totalPages)} ${pageWord} · ${String(totalFields)} ${fieldWord}`,
          );
          for (const u of handle.networkUrls) {
            process.stdout.write(`${u}\n`);
          }

          if (opts.open) {
            const browserUrl = handle.ownerToken
              ? `${handle.url}/?session=${handle.ownerToken}`
              : handle.url;
            await openBrowser(browserUrl);
          }

          // Keep the process alive until SIGINT / SIGTERM
          const shutdown = (): void => {
            void handle
              .close()
              .catch((err: unknown) => {
                logger.error(
                  `Server shutdown error: ${err instanceof Error ? err.message : String(err)}`,
                );
              })
              .finally(() => {
                process.exit(0);
              });
          };
          process.on('SIGINT', shutdown);
          process.on('SIGTERM', shutdown);
        };

        run().catch((err: unknown) => {
          const msg = err instanceof AnalyzerError ? err.message : String(err);
          logger.error(msg);
          process.exit(1);
        });
      },
    );

  program
    .command('analyze <file>')
    .description('Extract fields from a PDF and write a .fpdf.json file (no server)')
    .action((file: string) => {
      const run = async (): Promise<void> => {
        const doc = await analyzePdf(file);
        if (!hasUsableFields(doc)) {
          logger.warn(
            'No fillable fields detected. This PDF appears to be a print-and-fill form that fpdf cannot fill programmatically.',
          );
        }
        const outPath = path.join(
          path.dirname(path.resolve(file)),
          `${path.basename(file, path.extname(file))}.fpdf.json`,
        );
        await writeFile(outPath, JSON.stringify(doc, null, 2), 'utf-8');
        logger.info(`Wrote '${outPath}'`);
      };
      run().catch((err: unknown) => {
        const msg = err instanceof AnalyzerError ? err.message : String(err);
        logger.error(msg);
        process.exit(1);
      });
    });

  program
    .command('debug-export <jsonFile>')
    .description('Show what patchXfaDatasetsXml writes for each field (no PDF written)')
    .action((jsonFile: string) => {
      const run = async (): Promise<void> => {
        const jsonPath = path.resolve(jsonFile);
        const raw = await readFile(jsonPath, 'utf-8');
        const doc = JSON.parse(raw) as FpdfDocument;

        // Show radio fields
        for (const page of doc.pages) {
          for (const field of page.fields) {
            if (field.type === 'radio' || field.type === 'checkbox') {
              process.stdout.write(
                `FIELD  name=${field.name}  type=${field.type}  value=${JSON.stringify(field.value)}  radioValue=${JSON.stringify((field as unknown as Record<string, unknown>).radioValue)}\n`,
              );
            }
          }
        }

        // Show XFA datasets before and after patching
        const pdfBytes = await readFile(doc.metadata.originalPdf);
        const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
        const xfaInfo = getXfaDatasetsInfo(pdfDoc);
        if (!xfaInfo) {
          process.stdout.write('No XFA datasets found in PDF.\n');
          return;
        }
        process.stdout.write(`\n--- XFA datasets XML (initial) ---\n${xfaInfo.xml}\n`);

        const allValues = new Map<string, string | boolean>();
        for (const page of doc.pages) {
          for (const field of page.fields) {
            if (!allValues.has(field.name)) allValues.set(field.name, field.value);
          }
        }
        const patched = patchXfaDatasetsXml(xfaInfo.xml, allValues);
        process.stdout.write(`\n--- XFA datasets XML (patched) ---\n${patched}\n`);
      };
      run().catch((err: unknown) => {
        logger.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      });
    });

  program
    .command('export <jsonFile>')
    .description('Write filled values from a .fpdf.json back into a new PDF')
    .option('-o, --output <path>', 'Output path (default: <name>-filled.pdf alongside the JSON)')
    .action((jsonFile: string, opts: { output?: string }) => {
      const run = async (): Promise<void> => {
        const jsonPath = path.resolve(jsonFile);
        const raw = await readFile(jsonPath, 'utf-8');
        const doc = JSON.parse(raw) as FpdfDocument;
        const outPath = opts.output
          ? path.resolve(opts.output)
          : path.join(
              path.dirname(jsonPath),
              `${path.basename(jsonPath, '.fpdf.json')}-filled.pdf`,
            );
        const filled = await exportPdf(doc.metadata.originalPdf, doc);
        await writeFile(outPath, filled);
        logger.info(`Wrote '${outPath}'`);
      };
      run().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(msg);
        process.exit(1);
      });
    });

  program
    .command('save-acroform <file>')
    .description('Export a PDF as an editable AcroForm PDF (pre-fills from .fpdf.json if present)')
    .option(
      '-o, --output <path>',
      'Output path (default: <name>.fpdf.acroform.pdf alongside the PDF)',
    )
    .action((file: string, opts: { output?: string }) => {
      const run = async (): Promise<void> => {
        const pdfPath = path.resolve(file);
        const stem = path.basename(pdfPath, path.extname(pdfPath));
        const dir = path.dirname(pdfPath);
        const defaultJsonPath = path.join(dir, `${stem}.fpdf.json`);
        const outPath = opts.output
          ? path.resolve(opts.output)
          : path.join(dir, `${stem}.fpdf.acroform.pdf`);

        let doc: FpdfDocument;

        if (existsSync(defaultJsonPath)) {
          const raw = await readFile(defaultJsonPath, 'utf-8');
          const loaded = JSON.parse(raw) as FpdfDocument;

          const cyan = process.stderr.isTTY ? '\x1b[36m' : '';
          const reset = process.stderr.isTTY ? '\x1b[0m' : '';
          const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
          const answer = await new Promise<string>((resolve) => {
            rl.question(
              `${cyan}[fpdf] Pre-fill with saved values from ${defaultJsonPath}? [Y/n]${reset} `,
              (a) => {
                rl.close();
                resolve(a);
              },
            );
          });

          if (/^[Nn]/u.test(answer)) {
            // Clear all field values
            for (const page of loaded.pages) {
              for (const field of page.fields) {
                field.value = field.type === 'checkbox' || field.type === 'radio' ? false : '';
              }
              for (const candidate of page.candidateFields) {
                candidate.value = '';
              }
            }
          }
          doc = loaded;
        } else {
          doc = await analyzePdf(pdfPath);
        }

        if (doc.metadata.pdfKind === 'acroform') {
          logger.warn(
            'This PDF already has AcroForm fields — no conversion needed. Use `fpdf export` to write filled values.',
          );
          return;
        }

        const filled = await exportPdf(pdfPath, doc, { readOnly: false });
        await writeFile(outPath, filled);
        logger.info(`Wrote '${outPath}'`);
      };
      run().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(msg);
        process.exit(1);
      });
    });

  // Note: `scripts/fpdf clean` intercepts this command before Node starts so it
  // works even when node_modules/dist are missing.  This registration keeps
  // `fpdf clean` available when invoking dist/cli.js directly (e.g. in tests).
  program
    .command('clean')
    .description('Remove node_modules/, dist/, and optionally the fnm-managed Node.js')
    .action(() => {
      const run = async (): Promise<void> => {
        const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

        const nodeModulesPath = path.join(rootDir, 'node_modules');
        if (existsSync(nodeModulesPath)) {
          process.stderr.write('[fpdf] Removing node_modules…\n');
          await rm(nodeModulesPath, { recursive: true, force: true });
        }

        const distPath = path.join(rootDir, 'dist');
        if (existsSync(distPath)) {
          process.stderr.write('[fpdf] Removing dist…\n');
          await rm(distPath, { recursive: true, force: true });
        }

        if (process.execPath.includes('fnm')) {
          const nodeVer = process.version;
          const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
          await new Promise<void>((resolve) => {
            rl.question(`[fpdf] Also remove fnm-managed Node.js ${nodeVer}? [Y/n] `, (answer) => {
              rl.close();
              if (!/^[Nn]/u.test(answer)) {
                const result = spawnSync('fnm', ['uninstall', nodeVer], { stdio: 'inherit' });
                if (result.status === 0) {
                  process.stderr.write(`[fpdf] Node.js ${nodeVer} removed.\n`);
                } else {
                  process.stderr.write('[fpdf] fnm uninstall failed — check output above.\n');
                }
              }
              resolve();
            });
          });
        }

        process.stderr.write('[fpdf] Done.\n');
      };
      run().catch((err: unknown) => {
        logger.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      });
    });

  // Default action: bare `fpdf` (no subcommand) starts a picker-mode server.
  // allowUnknownOption prevents Commander from rejecting --open (or any future
  // flag) when no subcommand is given, without consuming the flag before
  // the 'fill' subcommand's own --open option can see it.
  program.allowUnknownOption().allowExcessArguments();
  program.action(() => {
    const argv = process.argv;

    // Validate picker-mode flags manually (allowUnknownOption suppresses
    // Commander's built-in check, so we do it ourselves).
    const pickerKnownFlags = new Set(['--open', '--no-open', '--listen-all', '--port']);
    for (let i = 2; i < argv.length; i++) {
      const arg = argv[i];
      if (!arg?.startsWith('-')) continue;
      if (!pickerKnownFlags.has(arg)) {
        logger.error(`Unknown option: '${arg}'. Run 'fpdf --help' for usage.`);
        process.exit(1);
      }
      if (arg === '--port') i++; // skip the value argument
    }

    const shouldOpen = !argv.includes('--no-open');
    const shouldListenAll = argv.includes('--listen-all');
    const portIdx = argv.indexOf('--port');
    const portArg = portIdx !== -1 ? argv[portIdx + 1] : undefined;
    const run = async (): Promise<void> => {
      const autoListenAll = !hasDisplay();
      if (autoListenAll && !shouldListenAll) {
        logger.info('Headless environment detected — binding to 0.0.0.0 (network-accessible)');
      }
      const host = shouldListenAll || autoListenAll ? '0.0.0.0' : undefined;
      const port = portArg !== undefined ? parseInt(portArg, 10) : undefined;
      const handle = await startServerRestarting({
        // Picker mode (no subcommand) is a persistent service — never auto-exit
        // when the last client disconnects, regardless of --listen-all.
        autoShutdown: false,
        ...(host !== undefined && { host }),
        ...(port !== undefined && { port }),
      });
      logger.info('Picker mode — select a PDF to get started');
      for (const u of handle.networkUrls) {
        process.stdout.write(`${u}\n`);
      }
      if (shouldOpen) {
        await openBrowser(handle.url);
      }
      const shutdown = (): void => {
        void handle
          .close()
          .catch((err: unknown) => {
            logger.error(
              `Server shutdown error: ${err instanceof Error ? err.message : String(err)}`,
            );
          })
          .finally(() => {
            process.exit(0);
          });
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    };
    run().catch((err: unknown) => {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
  });

  // Append per-command option tables to the top-level --help output so users
  // don't need to discover options by running `fpdf <command> --help`.
  program.addHelpText('after', () => {
    const sections: string[] = [];
    for (const cmd of program.commands) {
      const opts = cmd.options.filter((o) => o.long !== '--help');
      if (opts.length === 0) continue;
      const COL = 28;
      const lines = opts.map((o) => `  ${o.flags.padEnd(COL)}${o.description}`);
      sections.push(`\n${cmd.name()} options:\n${lines.join('\n')}`);
    }
    return sections.join('\n');
  });

  return program;
}

// Only parse argv when this file is the entry point.
// Resolve symlinks on both sides so that bin/ symlinks (e.g. from npx or
// npm install -g) match the real dist/cli.js path in import.meta.url.
const entryFile = process.argv[1];
if (entryFile !== undefined) {
  let isMain = false;
  try {
    isMain = realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entryFile);
  } catch {
    // realpathSync can throw if either path does not exist; treat as not main.
  }
  if (isMain) {
    buildProgram().parse(process.argv);
  }
}

#!/usr/bin/env node
import { writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
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

export function buildProgram(): Command {
  installWarnFilter();
  const program = new Command();

  program.name('fpdf').description('Fill PDF forms via a local browser overlay').version('0.1.0');

  program
    .command('fill <file>')
    .description('Analyze a PDF and start a local fill session in the browser')
    .option('--open', 'Automatically open the URL in the default browser', false)
    .option('--json <path>', 'Resume from an existing .fpdf.json session file')
    .option('--fresh', 'Ignore any existing .fpdf.json and re-analyze the PDF from scratch', false)
    .action((file: string, opts: { open: boolean; json?: string; fresh: boolean }) => {
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
          logger.info(`Resumed session from ${jsonPath}`);
        } else if (opts.fresh) {
          // --fresh: skip any existing session and re-analyze unconditionally.
          doc = await analyzePdf(pdfPath);
          await writeFile(jsonPath, JSON.stringify(doc, null, 2), 'utf-8');
          logger.info(`Fresh analysis of ${pdfPath} → ${jsonPath}`);
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
              logger.info(`Migrating ${jsonPath} (radio field schema updated) — re-analyzing…`);
              doc = await migrateDoc(pdfPath, loaded);
              await writeFile(jsonPath, JSON.stringify(doc, null, 2), 'utf-8');
              logger.info(`Migration complete → ${jsonPath}`);
            } else {
              doc = loaded;
              logger.info(`Resumed session from ${jsonPath}`);
            }
          } else {
            doc = await analyzePdf(pdfPath);
            await writeFile(jsonPath, JSON.stringify(doc, null, 2), 'utf-8');
            logger.info(`Analyzed ${pdfPath} → ${jsonPath}`);
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
        const handle = await startServer({ pdfPath, doc, jsonPath });
        logger.info(
          `Ready — ${doc.metadata.pdfFilename} · ${String(totalPages)} ${pageWord} · ${String(totalFields)} ${fieldWord} · ${handle.url}`,
        );
        process.stdout.write(`${handle.url}\n`);

        if (opts.open) {
          await open(handle.url);
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
    });

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
        logger.info(`Wrote ${outPath}`);
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
        logger.info(`Wrote ${outPath}`);
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
        logger.info(`Wrote ${outPath}`);
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
const entryFile = process.argv[1];
if (entryFile !== undefined && import.meta.url === `file://${entryFile}`) {
  buildProgram().parse(process.argv);
}

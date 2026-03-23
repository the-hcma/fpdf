#!/usr/bin/env node
import { writeFile, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Command } from 'commander';
import open from 'open';
import { logger } from './logger.js';
import { analyzePdf, AnalyzerError } from './analyzer.js';
import { startServer } from './server.js';
import type { FpdfDocument } from './types.js';

export function buildProgram(): Command {
  const program = new Command();

  program.name('fpdf').description('Fill PDF forms via a local browser overlay').version('0.1.0');

  program
    .command('fill <file>')
    .description('Analyze a PDF and start a local fill session in the browser')
    .option('--open', 'Automatically open the URL in the default browser', false)
    .option('--json <path>', 'Resume from an existing .fpdf.json session file')
    .action((file: string, opts: { open: boolean; json?: string }) => {
      const run = async (): Promise<void> => {
        const pdfPath = path.resolve(file);
        const defaultJsonPath = path.join(
          path.dirname(pdfPath),
          `${path.basename(pdfPath, path.extname(pdfPath))}.fpdf.json`,
        );
        const jsonPath = opts.json ? path.resolve(opts.json) : defaultJsonPath;

        let doc: FpdfDocument;
        if (opts.json) {
          const raw = await readFile(jsonPath, 'utf-8');
          doc = JSON.parse(raw) as FpdfDocument;
          logger.info(`Resumed session from ${jsonPath}`);
        } else {
          doc = await analyzePdf(pdfPath);
          await writeFile(jsonPath, JSON.stringify(doc, null, 2), 'utf-8');
          logger.info(`Analyzed ${pdfPath} → ${jsonPath}`);
        }

        const handle = await startServer({ pdfPath, doc, jsonPath });
        logger.info(`Listening on ${handle.url}`);
        process.stdout.write(`${handle.url}\n`);

        if (opts.open) {
          await open(handle.url);
        }

        // Keep the process alive until SIGINT / SIGTERM
        const shutdown = (): void => {
          handle.close().catch((err: unknown) => {
            logger.error(
              `Server shutdown error: ${err instanceof Error ? err.message : String(err)}`,
            );
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
    .command('export <jsonFile>')
    .description('Write filled values from a .fpdf.json back into a new PDF')
    .action((...args: unknown[]) => {
      void args;
      logger.error('export command not yet implemented');
      process.exit(1);
    });

  return program;
}

// Only parse argv when this file is the entry point.
const entryFile = process.argv[1];
if (entryFile !== undefined && import.meta.url === `file://${entryFile}`) {
  buildProgram().parse(process.argv);
}

#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Command } from 'commander';
import { logger } from './logger.js';
import { analyzePdf, AnalyzerError } from './analyzer.js';

export function buildProgram(): Command {
  const program = new Command();

  program.name('fpdf').description('Fill PDF forms via a local browser overlay').version('0.1.0');

  program
    .command('fill <file>')
    .description('Analyze a PDF and start a local fill session in the browser')
    .option('--open', 'Automatically open the URL in the default browser', false)
    .option('--json <path>', 'Resume from an existing .fpdf.json session file')
    .action((...args: unknown[]) => {
      void args;
      logger.error('fill command not yet implemented');
      process.exit(1);
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

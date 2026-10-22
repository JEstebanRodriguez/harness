#!/usr/bin/env node
import { main } from '../src/cli.js';
import { NotInitializedError } from '../src/backlog.js';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`❌ ${err.message}`);
    if (process.env.XJERGX_DEBUG && !(err instanceof NotInitializedError)) console.error(err.stack);
    process.exitCode = 1;
  });

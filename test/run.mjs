#!/usr/bin/env node
/** Runs the bundle's unit tests: `node test/run.mjs`. */
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

await import('./setup.mjs')

const result = spawnSync(
  process.execPath,
  ['--test', `${here}host-fold.test.mjs`, `${here}client-recall.test.mjs`],
  { stdio: 'inherit' },
)

rmSync(`${here}.build`, { recursive: true, force: true })
process.exit(result.status ?? 1)

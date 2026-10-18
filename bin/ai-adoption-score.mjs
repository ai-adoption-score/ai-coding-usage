#!/usr/bin/env node
// @ts-check
import { runCli } from '../src/cli.mjs'

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`Something went wrong: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
)

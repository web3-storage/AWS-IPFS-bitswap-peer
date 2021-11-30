'use strict'

const pino = require('pino')
let destination
let level = 'info'

const durationUnits = {
  milliseconds: 1e6,
  seconds: 1e9
}

try {
  if (process.env.NODE_ENV !== 'production') {
    destination = require('pino-pretty')()
  }
} catch (e) {
  // No-op
}

if ((process.env.NODE_DEBUG ?? '').includes('aws-ipfs')) {
  level = 'debug'
} else if ('TAP_CHILD_ID' in process.env) {
  level = 'warn'
}

const logger = pino(
  {
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime
  },
  destination
)

function elapsed(startTime, precision = 3, unit = 'milliseconds') {
  const dividend = durationUnits[unit] ?? durationUnits.milliseconds
  return (Number(process.hrtime.bigint() - startTime) / dividend).toFixed(precision)
}

function serializeError(e) {
  return `[${e.code || e.constructor.name}] ${e.message}`
}

module.exports = {
  logger,
  elapsed,
  serializeError
}

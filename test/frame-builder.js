'use strict'

const p = require('../lib/protocol')

// Builds a well formed 20 byte status frame with a correct checksum.
function buildResponse(fields = {}) {
  const pick = (value, fallback) => (value === undefined ? fallback : value)
  const f = Buffer.alloc(p.FRAME_LENGTH)
  f[0] = p.MAGIC
  f[1] = pick(fields.variant, p.VARIANT_DEFAULT)
  f[2] = pick(fields.echo, p.CMD.PING)
  f[3] = pick(fields.powerStatus, 1)
  f[4] = pick(fields.errorCode, 0)
  f[5] = pick(fields.runningStep, 3)
  f.writeUInt16LE(pick(fields.altitude, 0), 6)
  f[8] = pick(fields.mode, p.MODE.TEMPERATURE)
  f[9] = pick(fields.target, 22)
  f[10] = pick(fields.currentLevelRaw, 4)
  f.writeUInt16LE(Math.round(pick(fields.voltage, 13.4) * 10), 11)
  f.writeInt16LE(pick(fields.chamberTemperature, 150), 13)
  f.writeInt16LE(pick(fields.roomTemperature, 21), 15)
  f[17] = pick(fields.displayError, 0)
  f[18] = 0
  let sum = 0
  for (let i = 3; i <= 18; i++) {
    sum += f[i]
  }
  f[19] = sum % 256
  return f
}

module.exports = { buildResponse }

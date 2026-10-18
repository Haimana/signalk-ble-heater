'use strict'

const test = require('node:test')
const assert = require('node:assert')
const p = require('../lib/protocol')
const { buildResponse } = require('./frame-builder')

const PASSKEY = 1234

test('passkey splits into two decimal digit pairs, not BCD', () => {
  assert.deepStrictEqual(p.encodePasskey(1234), [12, 34])
  assert.deepStrictEqual(p.encodePasskey('1234'), [12, 34])
  assert.deepStrictEqual(p.encodePasskey(9), [0, 9])
  assert.throws(() => p.encodePasskey(12345))
  assert.throws(() => p.encodePasskey('abcd'))
})

// Byte for byte against the hardcoded frames in iotmaestro/vevor-heater-ble.
test('commands match the reference implementation byte for byte', () => {
  assert.deepStrictEqual(
    [...p.buildCommand(p.CMD.PING, 0, PASSKEY)],
    [0xaa, 0x55, 0x0c, 0x22, 0x01, 0x00, 0x00, 0x2f]
  )
  assert.deepStrictEqual(
    [...p.buildCommand(p.CMD.POWER, 1, PASSKEY)],
    [0xaa, 0x55, 0x0c, 0x22, 0x03, 0x01, 0x00, 0x32]
  )
  assert.deepStrictEqual(
    [...p.buildCommand(p.CMD.POWER, 0, PASSKEY)],
    [0xaa, 0x55, 0x0c, 0x22, 0x03, 0x00, 0x00, 0x31]
  )
})

test('command checksum is the sum of bytes 2..6 modulo 256', () => {
  const frame = p.buildCommand(p.CMD.TARGET, 36, PASSKEY)
  assert.strictEqual(frame.length, p.COMMAND_LENGTH)
  assert.strictEqual(frame[7], (12 + 34 + 4 + 36 + 0) % 256)
})

test('command carries the protocol variant the heater reported', () => {
  const frame = p.buildCommand(p.CMD.PING, 0, PASSKEY, p.VARIANT_ALT_ERRORS)
  assert.strictEqual(frame[1], p.VARIANT_ALT_ERRORS)
})

test('malformed frames are rejected with a reason', () => {
  assert.strictEqual(p.parseFrame(Buffer.alloc(8)).ok, false)
  assert.strictEqual(p.parseFrame('not a buffer').ok, false)
  const badMagic = buildResponse()
  badMagic[0] = 0x00
  assert.strictEqual(p.parseFrame(badMagic).ok, false)
})

// Captured live from this boat's heater while it was in standby.
test('accepts the 18-byte idle frames this heater actually sends', () => {
  const raw = Buffer.from('aa5501000000000000000100000000110012', 'hex')
  assert.strictEqual(raw.length, 18)
  const s = p.parseFrame(raw)
  assert.strictEqual(s.ok, true)
  assert.strictEqual(s.checksumOk, true)
  assert.strictEqual(s.state, false)
  assert.strictEqual(s.powerStatus, 'off')
  assert.strictEqual(s.runningState, 'Standby')
  assert.strictEqual(s.standby, true)
  assert.strictEqual(s.roomTemperature, 17)
  assert.strictEqual(s.displayErrorCode, 0)
  assert.strictEqual(s.echo, p.CMD.PING)
})

// The old single byte read turned a 180 C combustion chamber into -76, and
// -5 C in the cabin into 251.
test('temperatures are signed 16 bit little endian', () => {
  const hot = p.parseFrame(buildResponse({ chamberTemperature: 180, roomTemperature: -5 }))
  assert.strictEqual(hot.chamberTemperature, 180)
  assert.strictEqual(hot.roomTemperature, -5)

  const veryHot = p.parseFrame(buildResponse({ chamberTemperature: 265 }))
  assert.strictEqual(veryHot.chamberTemperature, 265)
})

test('voltage and altitude are unsigned 16 bit little endian', () => {
  const s = p.parseFrame(buildResponse({ voltage: 13.7, altitude: 1200 }))
  assert.strictEqual(s.voltage, 13.7)
  assert.strictEqual(s.altitude, 1200)
})

test('byte 9 is a temperature in mode 2 and a power level in mode 1', () => {
  const auto = p.parseFrame(buildResponse({ mode: p.MODE.TEMPERATURE, target: 22, currentLevelRaw: 4 }))
  assert.strictEqual(auto.targetTemperature, 22)
  assert.strictEqual(auto.powerLevel, null)
  assert.strictEqual(auto.currentPowerLevel, 5, 'byte 10 is offset by one')

  const manual = p.parseFrame(buildResponse({ mode: p.MODE.POWER_LEVEL, target: 5 }))
  assert.strictEqual(manual.powerLevel, 5)
  assert.strictEqual(manual.targetTemperature, null)
  assert.strictEqual(manual.currentPowerLevel, null)
})

// A heater that is off stops keeping these bytes meaningful, so an impossible
// setpoint has to read as unknown rather than as a real value.
test('setpoints outside the documented range are reported as unknown', () => {
  const badTemp = p.parseFrame(buildResponse({ mode: p.MODE.TEMPERATURE, target: 99 }))
  assert.strictEqual(badTemp.targetTemperature, null)

  const badLevel = p.parseFrame(buildResponse({ mode: p.MODE.POWER_LEVEL, target: 77 }))
  assert.strictEqual(badLevel.powerLevel, null)

  const badCurrent = p.parseFrame(buildResponse({ mode: p.MODE.TEMPERATURE, currentLevelRaw: 200 }))
  assert.strictEqual(badCurrent.currentPowerLevel, null)

  // Boundaries stay valid.
  assert.strictEqual(p.parseFrame(buildResponse({ mode: 2, target: 8 })).targetTemperature, 8)
  assert.strictEqual(p.parseFrame(buildResponse({ mode: 2, target: 36 })).targetTemperature, 36)
  assert.strictEqual(p.parseFrame(buildResponse({ mode: 1, target: 1 })).powerLevel, 1)
  assert.strictEqual(p.parseFrame(buildResponse({ mode: 1, target: 10 })).powerLevel, 10)
})

test('mode 0 takes its level from byte 10', () => {
  const s = p.parseFrame(buildResponse({ mode: 0, target: 0, currentLevelRaw: 2 }))
  assert.strictEqual(s.powerLevel, 3)
  assert.strictEqual(s.targetTemperature, null)
})

// Byte 3 is tri-state, so a faulted heater must not report itself as on.
test('power status 2 means faulted, not running', () => {
  const faulted = p.parseFrame(buildResponse({ powerStatus: 2, displayError: 8 }))
  assert.strictEqual(faulted.state, false)
  assert.strictEqual(faulted.powerStatus, 'error')

  const running = p.parseFrame(buildResponse({ powerStatus: 1 }))
  assert.strictEqual(running.state, true)

  const off = p.parseFrame(buildResponse({ powerStatus: 0 }))
  assert.strictEqual(off.state, false)
  assert.strictEqual(off.powerStatus, 'off')
})

test('error codes map to the AA55 controller table', () => {
  assert.strictEqual(p.parseFrame(buildResponse({ errorCode: 2 })).errorMessage, 'Lack of fuel')
  assert.strictEqual(p.parseFrame(buildResponse({ errorCode: 2 })).errorLabel, 'E02')
  assert.strictEqual(p.parseFrame(buildResponse({ errorCode: 0 })).errorMessage, null)
  assert.strictEqual(p.parseFrame(buildResponse({ errorCode: 42 })).errorMessage, 'Unknown error 42')
  // Display byte is only a fallback when byte 4 is clear.
  assert.strictEqual(
    p.parseFrame(buildResponse({ errorCode: 0, displayError: 8 })).errorMessage,
    'Ignition unit fault'
  )
})

test('byte 4 is kept separate from the display error code', () => {
  const s = p.parseFrame(buildResponse({ errorCode: 2, displayError: 8 }))
  assert.strictEqual(s.errorCode, 2)
  assert.strictEqual(s.displayErrorCode, 8)
  assert.strictEqual(s.errorMessage, 'Lack of fuel')
})

test('running step 0 is standby', () => {
  const s = p.parseFrame(buildResponse({ runningStep: 0 }))
  assert.strictEqual(s.standby, true)
  assert.strictEqual(s.runningState, 'Standby')
  assert.strictEqual(p.parseFrame(buildResponse({ runningStep: 4 })).runningState, 'Cooldown')
})

test('command availability follows the running step', () => {
  const standby = p.parseFrame(buildResponse({ runningStep: 0 }))
  assert.strictEqual(p.canStart(standby), true)
  assert.strictEqual(p.canStop(standby), false)
  assert.strictEqual(p.canSetTarget(standby), true)

  const running = p.parseFrame(buildResponse({ runningStep: 3 }))
  assert.strictEqual(p.canStart(running), false)
  assert.strictEqual(p.canStop(running), true)

  // The heater refuses commands while it cools down.
  const cooldown = p.parseFrame(buildResponse({ runningStep: 4 }))
  assert.strictEqual(p.canStop(cooldown), false)
  assert.strictEqual(p.canStart(cooldown), false)
  assert.strictEqual(p.canSetTarget(cooldown), false)
})

test('command echo is exposed for matching responses to requests', () => {
  assert.strictEqual(p.parseFrame(buildResponse({ echo: p.CMD.POWER })).echo, p.CMD.POWER)
})

test('checksum mismatch is reported but the frame still parses', () => {
  const good = buildResponse()
  assert.strictEqual(p.parseFrame(good).checksumOk, true)

  const corrupt = buildResponse()
  corrupt[19] = (corrupt[19] + 1) % 256
  const parsed = p.parseFrame(corrupt)
  assert.strictEqual(parsed.ok, true)
  assert.strictEqual(parsed.checksumOk, false)
})

test('trailing bytes from a concatenated notification are ignored', () => {
  const padded = Buffer.concat([buildResponse({ target: 30 }), Buffer.from([0xff, 0xff])])
  const parsed = p.parseFrame(padded)
  assert.strictEqual(parsed.ok, true)
  assert.strictEqual(parsed.targetTemperature, 30)
})

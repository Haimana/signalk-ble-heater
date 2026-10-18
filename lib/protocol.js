/*
 * Copyright 2026 SeB (sebba@end.ro) - S/V Haimana 264900475
 *
 * Wire protocol of the Vevor-style BLE diesel heater. No BLE, no Signal K here,
 * so it can be unit tested without hardware.
 *
 * Reconciled from three independent implementations:
 *   https://github.com/iotmaestro/vevor-heater-ble   (frame layout, display error table)
 *   https://github.com/bderleta/vevor-ble-bridge     (signed temperatures, protocol variants,
 *                                                     command availability rules)
 *   https://github.com/spin877/Bruciatore_BLE        (checksum, value ranges)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict'

const MAGIC = 0xaa
const FRAME_LENGTH = 20
const COMMAND_LENGTH = 8

// Second byte of every frame. The heater echoes its own protocol variant and
// expects it back in requests. 0x66 moves the error code and changes its table,
// 0x88 replaces the passkey with random bytes.
const VARIANT_DEFAULT = 0x55
const VARIANT_ALT_ERRORS = 0x66
const VARIANT_NO_PASSKEY = 0x88

const CMD = {
  PING: 1,
  MODE: 2,
  POWER: 3,
  TARGET: 4,
  SYNC_TIME: 10,
  SET_LANGUAGE: 14,
  SET_TEMP_UNIT: 15,
  SET_TANK_VOLUME: 16,
  SET_PUMP_TYPE: 17,
  SET_AUTO_START_STOP: 18,
  SET_ALTITUDE_UNIT: 19,
  SET_OFFSET: 20,
  SET_BACKLIGHT: 21
}

const LANGUAGE_ENGLISH = 0
const TEMP_UNIT_CELSIUS = 0
const ALTITUDE_UNIT_METERS = 0

const OFFSET_RANGE = { min: -9, max: 9 }
const BACKLIGHT_RANGE = { min: 0, max: 100 }

// Byte 3. Not a boolean: 2 means the heater is faulted, not running.
const POWER_STATUS = {
  0: 'off',
  1: 'running',
  2: 'error'
}

// Byte 5. Value 0 is standby, which is why telemetry is meaningless there.
const RUNNING_STEP = {
  0: 'Standby',
  1: 'Self-test',
  2: 'Ignition',
  3: 'Running',
  4: 'Cooldown'
}

const MODE = {
  POWER_LEVEL: 1,
  TEMPERATURE: 2
}

// Byte 4 on AA55 (and the E0x codes on the LCD / manuals that match it).
// Shared by bderleta, Spettacolo83 and the YAH-A2209 Bluetooth manual.
const CONTROLLER_ERRORS = {
  0: null,
  1: 'Startup failure',
  2: 'Lack of fuel',
  3: 'Supply voltage overrun',
  4: 'Outlet sensor fault',
  5: 'Inlet sensor fault',
  6: 'Pulse pump fault',
  7: 'Fan fault',
  8: 'Ignition unit fault',
  9: 'Overheating',
  10: 'Overheat sensor fault'
}

// Kept as an alias: older code and the diagnostics UI used this name.
const DISPLAY_ERRORS = Object.assign({}, CONTROLLER_ERRORS, { 0: 'No error' })

const POWER_LEVEL_RANGE = { min: 1, max: 10 }
const TEMPERATURE_RANGE = { min: 8, max: 36 }

function encodePasskey(passkey) {
  const n = Number(passkey)
  if (!Number.isInteger(n) || n < 0 || n > 9999) {
    throw new Error(`Invalid passkey ${passkey}: expected 0000-9999`)
  }
  return [Math.floor(n / 100), n % 100]
}

function buildCommand(cmd, value, passkey, variant) {
  const v = Number(value) || 0
  const frame = Buffer.alloc(COMMAND_LENGTH)
  frame[0] = MAGIC
  frame[1] = variant || VARIANT_DEFAULT

  const [high, low] = encodePasskey(passkey)
  frame[2] = high
  frame[3] = low
  frame[4] = cmd & 0xff
  frame[5] = v & 0xff
  frame[6] = (v >> 8) & 0xff
  frame[7] = (frame[2] + frame[3] + frame[4] + frame[5] + frame[6]) % 256
  return frame
}

function inRange(value, range) {
  return Number.isFinite(value) && value >= range.min && value <= range.max
}

function describeError(code) {
  if (!code) {
    return null
  }
  if (Object.prototype.hasOwnProperty.call(CONTROLLER_ERRORS, code)) {
    return CONTROLLER_ERRORS[code]
  }
  return `Unknown error ${code}`
}

// Prefer the controller fault (byte 4). On 20-byte frames byte 17 is the code
// shown on some LCDs; use it only when byte 4 is clear.
function resolveErrorMessage(errorCode, displayErrorCode) {
  return describeError(errorCode) || describeError(displayErrorCode)
}

// The two references disagree: iotmaestro's README says to sum bytes 3..18,
// while their code sums the decoded values, which only covers the low byte of
// each 16 bit field. The results diverge once a temperature passes 255, so the
// result is reported rather than used to drop frames.
function verifyChecksum(frame) {
  // 20-byte layout (iotmaestro): checksum at 19 over bytes 3..18
  // 18-byte layout (this heater when idle): checksum at 17 over bytes 3..16
  const end = frame.length >= 20 ? 18 : 16
  const checkAt = frame.length >= 20 ? 19 : 17
  let sum = 0
  for (let i = 3; i <= end; i++) {
    sum += frame[i]
  }
  return (sum % 256) === frame[checkAt]
}

function parseFrame(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return { ok: false, reason: 'not a buffer' }
  }
  // Real units answer with 18 bytes when idle (no display-error/pad) and 20
  // when the longer layout is used. Anything shorter cannot hold room temp.
  if (buffer.length < 18) {
    return { ok: false, reason: `short frame (${buffer.length} bytes)` }
  }
  if (buffer[0] !== MAGIC) {
    return { ok: false, reason: `bad magic (0x${buffer[0].toString(16)})` }
  }

  const frame = buffer.subarray(0, Math.min(buffer.length, FRAME_LENGTH))
  const powerStatusCode = frame[3]
  const runningStepCode = frame[5]
  const mode = frame[8]
  const target = frame[9]
  // Byte 10 counts from zero while setpoints count from one.
  const levelFromByte10 = frame[10] + 1
  // Display error only exists in the 20-byte layout; on 18-byte frames the
  // last byte is the checksum. The controller fault is always in byte 4.
  const displayError = frame.length >= 20 ? frame[17] : 0
  const errorCode = frame[4]

  // Setpoint bytes are only meaningful in their own mode, and iotmaestro stops
  // validating every field once the heater reports itself off. Anything outside
  // the documented range is reported as unknown instead of as a real setpoint.
  const targetTemperature =
    mode === MODE.TEMPERATURE && inRange(target, TEMPERATURE_RANGE) ? target : null
  let powerLevel = null
  if (mode === MODE.POWER_LEVEL) {
    powerLevel = inRange(target, POWER_LEVEL_RANGE) ? target : null
  } else if (mode === 0) {
    powerLevel = inRange(levelFromByte10, POWER_LEVEL_RANGE) ? levelFromByte10 : null
  }
  const currentPowerLevel =
    (mode === MODE.TEMPERATURE || mode === 0) && inRange(levelFromByte10, POWER_LEVEL_RANGE)
      ? levelFromByte10
      : null

  const errorMessage = resolveErrorMessage(errorCode, displayError)

  return {
    ok: true,
    variant: frame[1],
    echo: frame[2],
    checksumOk: verifyChecksum(frame),
    frameLength: frame.length,

    state: powerStatusCode === 1,
    powerStatusCode,
    powerStatus: POWER_STATUS[powerStatusCode] || `unknown (${powerStatusCode})`,

    runningStepCode,
    runningState: RUNNING_STEP[runningStepCode] || `Unknown (${runningStepCode})`,
    standby: runningStepCode === 0,

    mode,
    targetTemperature,
    powerLevel,
    currentPowerLevel,

    altitude: frame.readUInt16LE(6),
    voltage: frame.readUInt16LE(11) / 10,
    chamberTemperature: frame.readInt16LE(13),
    roomTemperature: frame.readInt16LE(15),

    errorCode,
    displayErrorCode: displayError,
    errorMessage,
    // Convenience for UIs: E02 style label matching the LCD manuals.
    errorLabel: errorCode ? `E${String(errorCode).padStart(2, '0')}` : null
  }
}

// Availability rules taken from bderleta's Home Assistant bridge, which is the
// only implementation known to run in production. Setpoints are the one place
// this is deliberately more permissive: the bridge only offers them while the
// heater runs, but accepting them any time except cooldown lets you set a
// target before starting.
function canStart(status) {
  return !!status && status.runningStepCode === 0
}

function canStop(status) {
  return !!status && status.runningStepCode >= 1 && status.runningStepCode <= 3
}

function canSetTarget(status) {
  return !!status && status.runningStepCode !== 4
}

function encodeClockArgument(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes()
}

module.exports = {
  MAGIC,
  FRAME_LENGTH,
  COMMAND_LENGTH,
  VARIANT_DEFAULT,
  VARIANT_ALT_ERRORS,
  VARIANT_NO_PASSKEY,
  CMD,
  MODE,
  POWER_STATUS,
  RUNNING_STEP,
  DISPLAY_ERRORS,
  CONTROLLER_ERRORS,
  LANGUAGE_ENGLISH,
  TEMP_UNIT_CELSIUS,
  ALTITUDE_UNIT_METERS,
  OFFSET_RANGE,
  BACKLIGHT_RANGE,
  POWER_LEVEL_RANGE,
  TEMPERATURE_RANGE,
  encodePasskey,
  buildCommand,
  parseFrame,
  verifyChecksum,
  describeError,
  resolveErrorMessage,
  encodeClockArgument,
  canStart,
  canStop,
  canSetTarget
}

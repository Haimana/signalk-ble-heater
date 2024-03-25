/*
 * Copyright 2024 SeB (sebba@end.ro) - S/V Haimana 264900475
 * 
 * Plugin page:
 * 
 * https://github.com/haimana/signalk-ble-heater
 * 
 * For making this, I used info and/or parts of code from:
 * https://github.com/htool/jbd-overkill-bms-plugin.git
 *    and
 * https://github.com/spin877/Bruciatore_BLE.git
 * https://github.com/iotmaestro/vevor-heater-ble.git
 * https://github.com/bderleta/vevor-ble-bridge.git
 *
 * Many thanks for developers
 * 
 * ---------------------------------------------------------------------
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * 
*/


const id = "signalk-ble-heater";
const debug = require('debug')(id)

module.exports = function (app, options) {
	"use strict"
	var plugin = {}
	const serviceUUID = '0000ffe0-0000-1000-8000-00805f9b34fb'
	const characteristicUUID = '0000ffe1-0000-1000-8000-00805f9b34fb'
	var RxTx
	var device
	var adapter
	var pollInterval;
	var intervalId;

	let stopped = Promise.resolve()

	plugin.id = id
	plugin.name = "Signalk plugin for BLE Diesel Heater readout"
	plugin.description = "Read Diesel Heater values over bluetooth"

	var unsubscribes = []

	var schema = {
		type: "object",
		title: "Heater settings",
		properties: {
			heaterInstance: {
				type: 'string',
				title: 'Heater instance/name to use',
				default: "heater"
			},
			pollFrequency: {
				title: "Poll frequency in seconds",
				type: "number",
				default: 10
			},
			MAC: {
				title: "Heater BLE MAC address",
				type: "string"
			}
		}
	}

	plugin.schema = function () {
		return schema
	}



	plugin.start = async (options) => {
		// app.debug('Starting plugin');
		stopped.then(() => {
			app.debug('Starting plugin');
			app.debug('Options: %j', JSON.stringify(options));
			unsubscribes.push(pullData);

			const macAddress = options.MAC

			const common = [0xaa, 0x55, 0x0c, 0x22]
			const ping = [...common, 0x01, 0x00, 0x00] // Ping, readonly device status request

			pollInterval = options.pollFrequency * 1000
			const basePath = "environment.inside." + options.heaterInstance

			function addHash(array) {
				let suma = array.slice(2, 7).reduce((acc, curr) => acc + curr, 0);
				let hash = suma % 256;
				let arrayWithHash = [...array, hash];
				return arrayWithHash;
			}

			Buffer.prototype.toArrayInteger = function () {
				if (this.length > 0) {
					const data = new Array(this.length);
					for (let i = 0; i < this.length; i = i + 1)
						data[i] = this[i];
					return data;
				}
				return [];
			}

			async function init() {
				const { createBluetooth } = require('node-ble')
				const { bluetooth, destroy } = createBluetooth()

				adapter = await bluetooth.defaultAdapter()

				app.debug('Waiting for Discovering...')
				if (! await adapter.isDiscovering())
					await adapter.startDiscovery()

				device = await adapter.waitDevice(macAddress);

				app.debug('Connecting...')
				await device.connect()
				const gattServer = await device.gatt()
				app.debug('Got primary service.')

				// serviceUUID
				const service = await gattServer.getPrimaryService(serviceUUID)

				// characteristicUUID 
				RxTx = await service.getCharacteristic(characteristicUUID)

				await RxTx.startNotifications()
				app.debug('Notifications started.')

				// Sending delta
				RxTx.on('valuechanged', buffer => { sendDelta(processData(buffer.toArrayInteger())) })

				intervalId = setInterval(function () { if (RxTx) { pullData(RxTx) } }, pollInterval)

			}

			init()

			async function pullData(arg) {
				app.debug("pullData");

				if (arg && typeof arg.writeValue === 'function') {
					const pingCMD = addHash(ping);
					await arg.writeValue(Buffer.from(pingCMD));
					// } else {
					// 	// Tratează eroarea sau oferă o notificare corespunzătoare în funcție de necesități.
					// 	app.debug("Stopping plugin - pullData don't run!");
				}
			}

			function processData(rawData) {
				// app.debug('processData data:', rawData)
				var obj = {}
				obj.command = Number(toU8(rawData[2]))
				obj.runstatus = byteToOnOff(rawData[3])
				obj.errorcode = Number(toU8(rawData[4]))
				obj.runningstate = byteToStatus(rawData[5])
				obj.altitude = Number(toU16(rawData[6], rawData[7]))
				obj.opertionalmode = Number(toU8(rawData[8]))
				obj.targettemp = Number(celsiusToKelvin(rawData[9]))
				obj.powerlevel = Number(toU8(rawData[10]))
				obj.supplyvoltage = Number(byteToFloat(rawData[11], 0.1)) //deciVolts to Volts
				obj.heatingchambertemp = Number(celsiusToKelvin(rawData[13]))
				// what is in [14]?
				obj.roomtemp = Number(celsiusToKelvin(rawData[15]))
				// what is in [16]?
				obj.errcode2 = Number(toU8(rawData[17]))
				// app.debug('processData obj:', obj)
				return obj
			}

			// Returnează un float cu două zecimale pentru un byte semnat sau nesemnat și un multiplicator
			function byteToFloat(byte, multiplier, signed) {
				multiplier = multiplier || 1;
				if (signed) {
					return parseFloat(toS8(byte) * multiplier).toFixed(2);
				}
				return parseFloat(toU8(byte) * multiplier).toFixed(2);
			}

			//returns a float to two decimal points for a signed/unsigned int and a multiplier
			function bytesToFloat(byte1, byte2, multiplier, signed) {
				multiplier = multiplier === undefined || multiplier === null ? 1 : multiplier;
				if (signed) {
					return parseFloat(toS16(byte1, byte2) * multiplier).toFixed(2);
				}
				return parseFloat(toU16(byte1, byte2) * multiplier).toFixed(2);
			}

			//takes two bytes and returns 16bit signed int (-32768 to +32767)
			function toS16(byte1, byte2) {
				return Buffer.from([byte1, byte2]).readInt16BE();
			}

			//takes two bytes and returns 16 bit unsigned int (0 to 65535)
			function toU16(byte1, byte2) {
				return Buffer.from([byte1, byte2]).readUInt16BE();
			}

			//takes one byte and returns 8 bit int (0 to 255)
			function toU8(byte) {
				return Buffer.from([byte]).readInt8();
			}

			function celsiusToKelvin(byte) {
				return (Buffer.from([byte]).readInt8() + 273).toFixed(0);
			}

			function byteToOnOff(byte) {
				// Verifică valoarea byte-ului și returnează "OFF" sau "ON"
				return byte === 0 ? "OFF" : "ON";
			}

			function byteToStatus(byte) {
				// Obiect care mapează valorile la stringuri
				const statusMap = {
					0: "Warmup",
					1: "Self test",
					2: "Ignition",
					3: "Heating",
					4: "Shutting down"
				};

				// Verifică dacă valoarea byte-ului există în mapare și returnează stringul corespunzător
				return statusMap.hasOwnProperty(byte) ? statusMap[byte] : "Unknown";
			}

			function sendDelta(obj) {
				var updates = []
				// app.debug('sendDelta: %j', obj)
				for (const [key, value] of Object.entries(obj)) {
					// app.debug(value)
					if (typeof value != 'object' && typeof value != 'function') {
						updates.push({ path: basePath + "." + key, value: value })
					} else if (typeof value == 'object') {
						for (const [key2, value2] of Object.entries(value)) {
							// app.debug(value2)
							if (typeof value2 != 'object') {
								updates.push({ path: basePath + "." + key + "." + key2, value: value2 })
							} else if (typeof value2 == 'object') {
								for (const [key3, value3] of Object.entries(value2)) {
									// app.debug(value3)
									if (typeof value3 == 'string') {
										updates.push({ path: basePath + "." + key + "." + key2 + "." + key3, value: value3 })
									}
								}
							}
						}
					}
				}
				// app.debug(updates)
				pushDelta(app, updates)
			}
		})
	}

	function pushDelta(app, values) {
		var update = { updates: [{ values: values }] }
		app.handleMessage(plugin.id, update)
		return
	}

	plugin.stop = async () => {
		app.debug("Stopping...")
		stopped = new Promise(async (resolve) => {
			try {
				// unsubscribes.forEach(f => f());
				await Promise.all(unsubscribes.map(async (f) => await f()));
				unsubscribes = [];
				if (intervalId) {
					clearInterval(intervalId);
					intervalId = null; // Setează intervalId la null după oprirea intervalului
				}

				if (RxTx) { await RxTx.stopNotifications(); }
				if (device) { await device.disconnect(); }

				// Eliberare resurse
				device = null;
				adapter = null;
				RxTx = null;
				await new Promise(resolve => setTimeout(resolve, 10 * 1000))
			} finally {
				app.debug("Plugin stopped and Bluetooth device disconected!")
				resolve()
			}
		})
	}

	return plugin;
};

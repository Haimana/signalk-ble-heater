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

	var stopping = false; // Variabila pentru a urmări dacă funcția stop este în curs de desfășurare

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

	plugin.start = async function (options, restartPlugin) {
		if (stopping) {
			// Așteaptă finalizarea funcției stop înainte de a începe execuția funcției init
			while (stopping) {
				app.debug('Waiting for stop function to complete shutdown...');
				// Așteaptă o mică perioadă de timp înainte de a verifica din nou
				await new Promise(resolve => setTimeout(resolve, 1000));
			}
		}

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
			app.debug('Got RxTx')

			await RxTx.startNotifications()
			app.debug('Notification started.')

			RxTx.on('valuechanged', buffer => { sendDelta(processData(buffer.toArrayInteger())) })

			intervalId = setInterval(function () { if (RxTx) { pullData(RxTx) } }, pollInterval)

		}

		init()

		async function pullData(arg) {
			app.debug("pullData intervalId: ", intervalId);

			if (arg && typeof arg.writeValue === 'function') {
				const pingCMD = addHash(ping);
				await arg.writeValue(Buffer.from(pingCMD));
			} else {
				// Tratează eroarea sau oferă o notificare corespunzătoare în funcție de necesități.
				app.debug("Stopping plugin - pullData don't run!");
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
			obj.supplyvoltage = Number(bytesToFloat(rawData[11], 0.1)) //deciVolts to Volts
			obj.heatingchambertemp = Number(celsiusToKelvin(rawData[13]))
			// what is in [14]?
			obj.roomtemp = Number(celsiusToKelvin(rawData[15]))
			// what is in [16]?
			obj.errcode2 = Number(toU8(rawData[17]))
			// app.debug('processData obj:', obj)
			return obj
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

	}


	function pushDelta(app, values) {
		var update = {
			updates: [
				{
					values: values
				}
			]
		}
		app.handleMessage(plugin.id, update)
		return
	}


	plugin.stop = async function () {
		if (stopping) {
			return; 
		}
		stopping = true; // Setează variabila de stare pentru a indica că funcția stop este în curs de desfășurare
		try {
			app.debug("Stopping...")
			// app.debug("2 - unsubscribes functions: %o", unsubscribes)
			// unsubscribes.forEach(f => f());
			await Promise.all(unsubscribes.map(async (f) => await f()));
			unsubscribes = [];
			// app.debug("3 - unsubscribes ar trebui sa fie gol aici ")
			// app.debug(unsubscribes)
			if (intervalId) {
				clearInterval(intervalId);
				intervalId = null; // Setează intervalId la null după oprirea intervalului
			// 	app.debug("4 - Interval stopped");
			// } else {
			// 	app.debug("4-else - Interval not found or already stopped");
			}

			// Oprește notificările
			if (RxTx) {
				// app.debug("5 - Stopping notifications");
				await RxTx.stopNotifications();
				// app.debug("5.1 - Stopped RxTx notifications");
			// } else {
			// 	app.debug("5-else - No notificationCharacteristic to stop...")
			}


			if (device) {
				// app.debug("6 - Disconnecting device...")
				await device.disconnect(); 
				// app.debug("6.1 - Device Disconnected")
			// } else {
			// 	app.debug("6-else - No Device to disconnect...")
			}


			// Eliberare resurse
			device = null; 
			adapter = null; 
			RxTx = null;
			app.debug("Plugin Stopped!")

		} finally {
			stopping = false;  
		}
	}

	return plugin;
};

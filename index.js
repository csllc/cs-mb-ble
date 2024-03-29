/**
 * Library module for Bluetooth Low Energy interface to CS Bluetooth dongles.
 *
 * This is a client library that handles finding, connecting to, and interacting with
 * Control Solutions BLE dongles that support the proprietary 'Controller' BLE service.
 * 
 * It is designed to be used as the 'device' when instantiating a @csllc/cs-modbus Modbus master.
 * 
 * This handles peripheral discovery and connecting/disconnecting from the 
 * 
 * See README.md for more information, including usage and events emitted by this module.
 * 
 * @ignore
 */
'use strict';

// Native Bluetooth module
// 
// For applications that strictly run on NodeJS (./examples, cs-modbus-cli, etc.) on
// macOS and Linux, this module will fall back onto @abandonware/noble to provide native
// BLE functionality.
// 
// For applications that run in environments that provide a real navigator.bluetooth
// interface (namely, Electron), we can use that instead. This allows apps like Zhivago
// to use a computer's built-in BLE adapter on Windows 10.
// 
// The interface is selected in BleController.constructor() below.
let Bluetooth;
let usingNodeModule;

try {
  Bluetooth = require('webbluetooth').Bluetooth;
  usingNodeModule = true;
} catch(e) {
  Bluetooth = null;
  usingNodeModule = false;
}

// built-in node utility module
const util = require('util');

// Node event emitter module
const EventEmitter = require('events').EventEmitter;

// Library containing implementations of Modbus functions and device-specific
// (CS1814, CS1816, etc.) parameters
const BleDevice = require('./lib/BleDevice');

// UUIDs of services common across all of our BLE peripheral devices if we're not using
// a known device name.
const serviceUuids = [
  '0000180a-0000-1000-8000-00805f9b34fb', // Device Information
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Transparent UART
];
  


//------------------------------------//---------------------------------------

module.exports = class BleController extends EventEmitter {

  constructor(options) {
    super();

    // BLE availability
    this.available = false;

    // BLE ready (peripheral selected and server open)
    this.isReady = false;
    
    // Reference to connected peripheral and server
    this.peripheral = null;
    this.server = null;

    // Reference to the dongle device
    this.device = null;

    // Discovered peripheral list
    this.discoveredPeripherals = [];

    // Save options passed to constructor
    this.options = options || {};

    // Establish peripheral scanning criteria
    if (this.options.bluetooth) {
      this.bluetooth = this.options.bluetooth;
    } else {
      this.bluetooth = new Bluetooth({ deviceFound: this._onDiscover.bind(this),
                                       // See "Web Bluetooth compatibility" section of README
                                       // allowedManufacturerData: [{ companyIdentifier: 0xFFFF }]
                                     });
    }

    // The application should know what kind of dongle it's looking for.
    // A name or service UUID must be provided in the options.
    // A service UUID of 'default' will cause the default CSLLC Private Service
    // UUID to be used, which should be common across all CSLLC BLE devices.
    // Throw an error if one of these options isn't present.
    //
    // See notes in this.startScanning() for why we're not accepting a UUID to
    // search for in lieu of a name.
    if (!this.options.name && !this.options.uuid) {
      // The error message must be composed separately from Error instantiation
      let errorMessage = `A device name and/or private service UUID be provided. Known device names in cs-mb-ble are ${BleDevice.names()}`;
      throw new Error(errorMessage);
    }

    this.scannedName = this.options.name || null;

    if (this.options.uuid == 'default') {
      this.scannedUuid = BleDevice.uuids();
    } else if (this.options.uuid) {
      this.scannedUuid = [ this.options.uuid ];
    }

    // Set up event forwarding from native Bluetooth module
    this.bluetooth.addEventListener('availabilitychanged', this.emit.bind(this, 'availabilitychanged'));

    // Electron doesn't seem to support the workflow of
    // bluetooth.requestDevice() -> emit 'discover' -> user selects via picker yet,
    // so we allow the open() method to be called with a device ID that was previously
    // discovered. Re-scanning is necessary to get a reference to the device.
    //
    // Otherwise, the application must now invoke scanning and peripheral selection.
  }


  /** 
   * Start the bluetooth scanning and find the requested peripheral using the filter parameters
   * supplied to the constructor.
   *
   * @return {Promise}  Resolves when the callback passed in the `discover` event is called 
   *                    with a device ID.
   */
  startScanning() {
    // Start scanning by requesting a peripheral with the criteria established in our constructor
    // This does not connect; just emits a discover event when one is detected 

    // Build filter array
    let filters = [];

    if (this.scannedName) {
      filters.push({ name: this.scannedName });
    }

    if (this.scannedUuid) {
      filters.push({ services: this.scannedUuid });
    }

    // See "Web Bluetooth compatibility" section of README
    // filters.push({ manufacturerData: [{ companyIdentifier: 0xFFFF }] });

    // Build list of services we want
    let services;

    if (this.scannedUuid) {
      services = this.scannedUuid;
    } else if (this.scannedName) {
      services = BleDevice.serviceUuids(this.scannedName);
    } else {
      // Add private CS service UUID
      services = BleDevice.uuids();
    }

    // Add non-private services to service list without adding duplicates
    services = [...new Set(services.concat(serviceUuids))];

    // Emit noble-compatible event
    this.emit('scanStart', filters);

    // Start scanning
    let options = { filters: filters,
                    optionalServices: services,
                    // See "Web Bluetooth compatibility" section of README
                    // optionalManufacturerData: [{ companyIdentifier: 0xFFFF }],
                  };

    return this.bluetooth.requestDevice(options)
    .then((peripheral) => {
      // Peripheral found and selected (either by us or application)
      this.emit('scanStop', peripheral);

      // Save reference to the peripheral
      this.peripheral = peripheral;

      return this.peripheral;
    });

  };


  /**
   * Returns a `Promise` that resolves to a `Boolean` and sets the `available` property 
   * depending on whether BLE is available on the system.
   * 
   */
  getAvailability() {
    return new Promise((resolve, reject) => {

      this.bluetooth.getAvailability()
      .then((isAvailable) => {
        this.available = isAvailable;

        if (this.available) {
          resolve();
        } else {
          reject();
        }
      });
    });
  }


  /**
   * Called by the Bluetooth interface when a peripheral is discovered.
   * 
   * This is only used when we instantiate our own Bluetooth object through NodeJS.
   * If it's provided to us in our constructor (e.g., Electron's
   * navigator.bluetooth object), a 'select-bluetooth-device' event will be
   * fired in the main process instead, and the app will be expected to handle
   * that on its own.
   * 
   * Either way, until the callback function is called, the Promise returned by
   * this.startScanning() will not settle.
   * 
   * @param {BluetoothDevice} newPeripheral  Newly discovered BLE peripheral
   * @param {Function}        callback       Callback function used to select a device
   * @return {None}
   */
  _onDiscover(newPeripheral, callback) {

    let discovered = this.discoveredPeripherals.some(peripheral => {
      return (peripheral.id == newPeripheral.id);
    });

    if (discovered) {
      return;
    }

    let peripheralEntry = {id: newPeripheral.id, name: newPeripheral.name, callback: callback};

    this.discoveredPeripherals.push(peripheralEntry);

    this.emit('discover', peripheralEntry);

    if (this.options.autoConnect) {
      callback();
    } else {
      return;
    }
  }


  /**
   * Open the peripheral that was requested in startScanning()
   *
   */
  open(id) {
    if (id) {
      // If we were provided a device ID, repeat the scanning process, attempt to
      // find the same device that was previously found, and connect to it.
      // We call ourselves recursively to accomplish this.
      if (typeof(id) == 'string') {
        return this.getAvailability()
        .then(() => {
          return this.startScanning()
          .then((device) => {
            if (device.id == id) {
              return this.open();
            } else {
              return Promise.reject("Could not find requested device");
            }
          });
        });
      } else {
        return Promise.reject('Invalid device ID. Expected a string.');
      }
    } else {
      this.emit('connecting');

      if (this.peripheral == null) {
        return Promise.reject("No peripheral selected. startScanning() must be called, and the calling application must use the callback to select a peripheral.");
      }

      return this.peripheral.gatt.connect()
      .then((server) => {
        this.emit('connected');

        // Save a reference to the GATTServer
        this.server = server;
      })
      .then(() => {
        // Set up server disconnect event forwarding
        this.peripheral.addEventListener('gattserverdisconnected', this.emit.bind(this, 'gattserverdisconnected'));
      })
      .then(() => {
        this.device = new BleDevice(this.peripheral, this.server,
                                    { usingNodeModule: usingNodeModule });

        // Set up event forwarding from BleDevice instance
        let eventNames = [ 'inspecting',
                           'inspected',
                           'write',
                           'data',
                           'fault',
                           'writeCharacteristic',
                           'sendCommand',
                           'watch',
                           'superWatch',
                           'unwatch',
                           'unwatchAll',
                           'discoveredService',
                           'discoveredCharacteristic',
                         ];

        eventNames.forEach((name) => {
          this.device.on(name, this.emit.bind(this, name));
        });

        return this.device.inspect();
      })
      .then(() => {
        this.emit('ready');

        this.isReady = true;
      });

    }
  }


  /** 
   * Close the open connection to a peripheral
   */
  close() {
    this.emit('disconnecting');

    if (this.server == null) {
      this.peripheral = null;
      this.server = null;
      this.device = null;
      this.master = null;

      return Promise.reject("Already disconnected");
    }

    this.peripheral.gatt.disconnect();
    this.emit('disconnected');

    this.isReady = false;

    this.device = null;
    this.server = null;
    this.peripheral = null;
    this.master = null;

    return Promise.resolve();
  }
  

  // The following functions are simply passed through to the BleDevice instance


  /**
   * Return an object containing peripheral identity information obtained by this.inspect().
   *
   * @return {Promise} Resolves with object containing device information
   */
  getInfo() {
    if (this.device) {
      return this.device.getInfo();
    } else {
      return Promise.reject("No BLE peripheral");
    }
  }


  /**
   * Sets the peripheral's configuration via Modbus command, if supported
   * Not fully implemented as of time of writing.
   *
   * @param {Object}   configuration  Peripheral configuration (TBD)
   * @return {Promise} Resolves when the command is complete
   */
  configure(configuration) {
    if (this.device) {
      return this.device.configure(configuration);
    } else {
      return Promise.reject("No BLE peripheral");
    }
  }


  /**
   * Set the keyswitch signal of the peripheral via Modbus command, if supported
   *
   * @param {Boolean}  state  New keyswitch state, true = on, false = off
   * @return {Promise} Resolves when the command is complete
   */
  keyswitch(state) {
    if (this.device) {
      return this.device.keyswitch(state);
    } else {
      return Promise.reject("No BLE peripheral");
    }
  }


  /**
   * Sets a watcher on the peripheral via Modbus command, if supported.
   * This associates a 'status' characteristic of the controller service with a
   * memory location on the device connected to the peripheral.
   *
   * @param {Number}    slot     Watcher slot
   * @param {Number}    id       Device ID
   * @param {Number}    address  Device memory address to read
   * @param {Number}    length   Device memory read length
   * @param {Function}  cb       Callback function
   * @return {Promise} Resolves when the command is complete
   */
  watch(slot, id, address, length, cb) {
    if (this.device) {
      return this.device.watch(slot, id, address, length, cb);
    } else {
      return Promise.reject("No BLE peripheral");
    }
  }


  /**
   * Sets the super-watcher on the peripheral via Modbus command, if supported.
   * This associates a 'superWatcher' characteristic of the controller service with
   * one or more single-byte memory locations on the device connected to the peripheral.
   *
   * @param {Number}           id       Device ID
   * @param {Array<Number>}    address  Array of device memory addresses to read
   * @param {Function}         cb       Callback function
   * @return {Promise} Resolves when the command is complete
   */
  superWatch(id, addresses, cb) {
    if (this.device) {
      return this.device.superWatch(id, addresses, cb);
    } else {
      return Promise.reject("No BLE peripheral");
    }
  }


  /**
   * Clears a watcher on the peripheral via Modbus command, if supported.
   *
   * @param {Number}    slot     Watcher slot
   * @return {Promise} Resolves when the command is complete
   */
  unwatch(slot) {
    if (this.device) {
      return this.device.unwatch(slot);
    } else {
      return Promise.reject("No BLE peripheral");
    }
  }


  /**
   * Clears all watchers on the peripheral via Modbus command, if supported.
   * 
   * @return {Promise} Resolves when the command is complete
   */
  unwatchAll() {
    if (this.device) {
      return this.device.unwatchAll();
    } else {
      return Promise.reject("No BLE peripheral");
    }
  }


  /**
   * Gets all watchers currently configured on the peripheral via Modbus command, if supported.
   * Results are compiled into an array of objects.
   * 
   * @return {Promise} Resolves into an array of objects, each member corresponding to an 
   *                   active watcher
   */
  getWatchers() {
    if (this.device) {
      return this.device.getWatchers();
    } else {
      return Promise.reject("No BLE peripheral");
    }
  }

  /**
   * Reads a watcher's value, if supported.
   *
   * @param {Number}   slot   Watcher slot
   * @return {Promise} Resolves when the command is complete with the watcher's
   *                   value (WebBluetooth) or immediately with no value (noble)
   *
   * When this module is used without a provided Bluetooth object, e.g., *not*
   * in an Electron project, the Promise returned by the underlying
   * characteristic.readValue() method doesn't appear to ever resolve with a value;
   * it hangs indefinitely. However, the read does complete and the value is
   * sent asynchronously as a notification (assuming the characteristic is set up
   * for reading and notifications).
   *
   * This is not true for use cases where a Bluetooth object is provided; the
   * "real" WebBluetooth does return a Promise that resolves with the expected
   * value when the read completes.
   */
  readWatcher(slot) {
    if (this.device) {
      if (this.options.bluetooth) {
        // A "real" WebBluetooth instance is used - readWatcher's returned Promise
        // resolves when the read is complete.
        return this.device.readWatcher(slot);
      } else {
        // Here we use our own instance via the 'webbluetooth' Node module - just
        // blindly resolve it because the Promise returned by readWatcher() never
        // seems to resolve.
        //
        // The watcher's value will be sent as a notification in response to this
        // function call.
        this.device.readWatcher(slot)
        .catch((e) => {
          console.error(e);
        });

        return Promise.resolve();
      }
    } else {
      return Promise.reject("No BLE peripheral");
    }
  }

  /**
   * Gets all active members of the peripheral's super-watcher via Modbus command, if supported.
   * Results are compiled into an array of objects.
   *
   * @return {Promise} Resolves into an array of objects, each member corresponding to an active
   *                   super-watcher member.
   */
  getSuperWatcher() {
    if (this.device) {
      return this.device.getSuperWatcher();
    } else {
      return Promise.reject("No BLE peripheral");
    }
  }


  readObject(objectId, options) {
    if (this.device) {
      return this.device.readObject(objectId, options);
    } else {
      return Promise.reject("No BLE peripheral");
    }
  }

  writeObject(objectId, data, options) {
    if (this.device) {
      return this.device.writeObject(objectId, data, options);
    } else {
      return Promise.reject("No BLE peripheral");
    }
  }


  /**
   * Returns whether the connection is open for Modbus use
   *
   * @return {Boolean} True if open, false otherwise
   */
  isOpen() {
    return this.peripheral && this.device && this.isReady;
  }


  /**
   * Write data to the peripheral's transparent UART, i.e., to the Modbus interface. 
   *
   * @param {Buffer}  data  Data to be written
   * @return {promise} Resolves when the write is finished.
   */
  write(data) {
    if (this.device) {
      return this.device.write(data);
    } else {
      return Promise.reject("No BLE peripheral");
    }
  }

}


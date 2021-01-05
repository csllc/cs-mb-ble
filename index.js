/**
 * Library module for Bluetooth Low Energy interface to CS1814 type BLE interfaces
 *
 * This is a client library that handles finding, connecting to, and interacting with
 * Control Solutions CS1814 dongles that support the proprietary 'Controller' BLE service.
 *
 * @ignore
 */
'use strict';

// The noble library throws an exception if there is no compatible bluetooth adapter found.
// this is a workaround as suggested by https://github.com/sandeepmistry/noble/issues/570
var ble;
try { 
  ble = require('@abandonware/noble'); 
} 
catch(err) 
{ 
  ble = { 
    on: (function() {})
  };
}

var Controller = require( './lib/Controller');

// built-in node utility module
var util = require('util');

// Node event emitter module
var EventEmitter = require('events').EventEmitter;

// For the private CSLLC controller service
var uuidControllerService = '6765ed1f4de149e14771a14380c90000';


//------------------------------------//---------------------------------------

function BleControllerFactory() {

  var factory = this;

  // subclass to event emitter
  EventEmitter.call( this );

  // Pass on BLE state change events (noble library events passed
  // through to our event listeners)

  ble.on('stateChange', this.emit.bind(factory, 'stateChange'));
  ble.on('scanStart', this.emit.bind(factory, 'scanStart'));
  ble.on('scanStop', this.emit.bind(factory, 'scanStop'));
  ble.on('discover', this.emit.bind(factory, 'discover'));
  ble.on('warning', this.emit.bind(factory, 'warning'));

  // API to start the bluetooth scanning
  this.startScanning = function() {

    // Scan for devices with the service we care about
    // This does not connect; just emits a discover event
    // when one is detected 
    ble.startScanning([uuidControllerService], false);

  };

  this.stopScanning = function() {
    ble.stopScanning();
  };

  // returns true if there is a bluetooth adapter installed.  Probably
  // a better way is to assume not until the 'stateChange' event is emitted,
  // but this is an easy way to see if the noble library threw an exception
  // on startup.
  this.installed = function() {
    return 'function' === typeof( ble.startScanning );
  };


  // Interface compatible with other MB/CAN modules used in Zhivago

  // We can't seem to pass the Peripheral object through from the port refresh
  // function into the main UI in Zhivago, so this function re-scans and looks
  // for a matching address.
  // This should happen nearly instantly, at least it does in the test environment

  this.peripheral = undefined;
  this.isReady = false;

  this.open = function(address) {
    return new Promise((resolve, reject) => {

      let onDiscover = function(peripheral) {
        if (peripheral.address === address) {
          this.peripheral = peripheral
          
          this.stopScanning();
          console.log("Found peripheral matching address", this.peripheral.address);
          // Connect to device
          this.peripheral.connect( (err) => {
            if (err) {
              reject(err);
            } else {
              this.isReady = true;
              console.log("Connection successful");
            }
          });
          
          // Remove listeners
          this.off('discover', onDiscover);
          // Done
          resolve(); // TODO: Does it make sense to return peripheral here?
        }
      }

      // Temporarily create listener
      this.on('discover', onDiscover);
      
      // TODO: Create timeout for finding device

      // Find peripheral object, again, and make sure it matches
      // the supplied address
      this.startScanning();
      
    });
  }

  this.close = function() {
    return this.peripheral.disconnect()
    .then(() => {
      // Close stream
      this.emit('close'); // TODO: Is this supported/expected for this module?
      resolve();
    })
    .then(() => {
      this.peripheral = undefined;
      me.isReady = false;
      me.push(null);
    })
    .catch((err) => {
      throw err;
    });
  }

  this.write = function(msg) {
    return new Promise((resolve, reject) => {
      console.log("write", msg);
      resolve();

    });
  }

  this.isOpen = function() {
    return this.peripheral && this.isReady;
  }

  // Make constructor available in the exported object
  factory.Controller = Controller;



}

// This object can emit events.  Note, the inherits
// call needs to be before .prototype. additions for some reason
util.inherits( BleControllerFactory, EventEmitter );


//BleControllerFactory.prototype.stateChange = function()

/**
 * Public interface to this module
 *
 * The object constructor is available to our client
 *
 * @ignore
 */
module.exports = BleControllerFactory;

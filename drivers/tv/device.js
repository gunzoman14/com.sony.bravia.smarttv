"use strict";

var async = require('async');
var httpmin = require("http.min");
const Homey = require('homey');
const Commands = require('./commands');

var xmlEnvelope = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>%code%</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>';
var foundDevices = [];
var devices = [];
var net = require("net");

const API_ENDPOINT_DEFAULT = '/IRCC';
const API_ENDPOINT_SONY = '/sony/IRCC';
const POLL_INTERVAL = 1000 * 10 //10 seconds


module.exports = class SonyDevice extends Homey.Device {

  async onInit() {
    super.onInit();
    this.settings = await this.updateSettings();

    this.initDevice(this.settings);

    this.registerFlowCards();
    this.log('Name:', this.getName());
    this.log('Class:', this.getClass());
  }
  async onDeleted () {
    clearInterval(this._pollDeviceInterval);
  }
  async onAdded () {
    Homey.app.log("New device added!");
  }
  async onPairListDevices (socket) {
    socket.on('list_devices', function (data, callback) {
      data = foundDevices;
      foundDevices = [];
      Homey.app.log('list_devices', data);

      async.each(data, function (device, callback) {
        // Call an asynchronous function, often a save() to DB
      }, function () {
        // All tasks are done now
        Homey.app.log('ASYNC:::::callback');
        Homey.app.log(devices);
        // this returns the "devices" to the list_devices view
        callback(null, devices);
        foundDevices = [];
      });
    });
    socket.on('disconnect', function () {
      foundDevices = [];
      Homey.app.log('User aborted pairing, or pairing is finished');
    });
    socket.on('add_device', function (device, callback) {
      Homey.app.log('-------- device added ---------');
      Homey.app.log(device);
      Homey.app.log('-------- device added ---------');
      devices[ device.data.id ] = {
        data: device.data,
        settings: device.settings,
        state: device.state
      }

      Homey.app.log('-------- device added ---------');
      callback(devices, true);
    })
  }

  async getDeviceAvailability(device_data) {
    return new Promise((resolve, reject) => {
      var client = new net.Socket();
      var cancelCheck = setTimeout(function() {
        client.destroy();
        handleOffline();
      }, 3000);

      var handleOnline = function () {
        clearTimeout(cancelCheck);
        client.destroy();
        Homey.app.log("getDeviceAvailability: online");
        resolve();
      };

      var handleOffline = function () {
        clearTimeout(cancelCheck);
        client.destroy();
        Homey.app.log("getDeviceAvailability: offline due to exception");
        reject();
      };

      client.on('error', function (err) {
        if(err && err.errno && err.errno == "ECONNREFUSED") {
          handleOnline();
        }
        else if(err && err.errno && err.errno == "EHOSTUNREACH") {
          handleOffline();
        }
        else if(err && err.errno && err.errno == "ENETUNREACH") {
          console.error("The network that the configured smartphone is on, is not reachable. Are you sure the Homey can reach the configured IP?");
          handleOffline();
        }
        else if(err && err.errno) {
          console.error("ICMP driver can only handle ECONNREFUSED, ENETUNREACH and EHOSTUNREACH, but got "+err.errno);
          handleOffline();
        }
        else {
          console.error("ICMP driver can't handle "+err);
          handleOffline();
        }
      });

      try {
        client.connect(1, device_data["ip"].trim(), function () {
          handleOnline();
        });
      } catch(ex) {
        console.error(ex.message);
        handleOffline();
      }
    });

  }

  async pingEndpoint(ip, endpoint) {
    // Test if endpoint is available with a OPTIONS request.
    Homey.app.log("============ pingEndpoint =============");
    const request = await httpmin.options({ uri: `http://${ip}${endpoint}` });
    return request.response.statusCode === 200;
  }

  async setApiEndpoint(ip) {
    // Check if "/sony/IRCC" endpoint is available
    Homey.app.log("============ setApiEndpoint =============");
    let sonyEndpoint = false;

    try {
      sonyEndpoint = await this.pingEndpoint(ip, API_ENDPOINT_SONY);
    } catch(e) {
      Homey.app.log(e);
    }

    if (sonyEndpoint) {
      this.setSettings({"apiEndpoint": API_ENDPOINT_SONY});
    } else {
      this.setSettings({"apiEndpoint": API_ENDPOINT_DEFAULT});
    }
  }

  async initDevice() {
    Homey.app.log("============ init =============");

    const settings = this.getSettings();
    Homey.app.log(settings);

    // If apiEndpoint not set yet, detect the correct endpoint.
    if (!('apiEndpoint' in settings)) {
      await this.setApiEndpoint(settings.ip);
    }

    // CRON: Create cron task name
    var taskName = 'SBATV_' + this.getSettings()["id"];
    // CRON: unregister task, to force new cron settings
    Homey.app.log('CRON: task "' + taskName + '" registered, every ' + POLL_INTERVAL / 1000 + ' seconds.');
    this._pollDeviceInterval = setInterval(this.pollDevice.bind(this), POLL_INTERVAL);
    this.pollDevice();
  }

  async pollDevice () {
    this.settings = await this.getSettings();
    Homey.app.log(this.settings);
    var alive = false;

    await this.getDeviceAvailability(this.settings)
    .then(function () {
      alive = true;
    })
    .catch(function () {
      alive = false;
    });

    if (alive != this.settings["power"]) {
      if (alive) {
        this.setSettings({"power": true})
        this._powerOn.trigger(this, null, null);
      } else {
        this.setSettings({"power": false});
        this._powerOff.trigger(this, null, null);
      }
    }
  }

  async updateSettings() {
    let merged   = Object.assign({}, this.getData());
    let settings = this.getSettings();
    Object.keys(settings).forEach(key => {
      if (settings[key]) {
        merged[key] = settings[key];
      }
    });
    await this.setSettings(merged);
    return merged;
  }

  async sendCommand(findCode, sendCode) {
    return new Promise((resolve, reject) => {
      if (typeof (this.settings) !== 'undefined') {
        const { apiEndpoint, ip } = this.settings;

        Homey.app.log("   ");
        Homey.app.log("======= send command! ==========");
        Homey.app.log("sendCommand: sendCode:" + sendCode);
        Homey.app.log("sendCommand: to IP:" + ip);
        Homey.app.log("sendCommand: to endpoint:" + apiEndpoint);
        var now = new Date();
        var jsonDate = now.toJSON();
        Homey.app.log("sendCommand: Command time:", jsonDate);
        var random = Math.floor(Math.random() * 1000000000);
        var options = {
          uri: 'http://' + ip + apiEndpoint,
          timeout: 1000,
          headers: {
            "cache-control": "no-cache",
            "random": random
          },
          request: function (req) {
            req.write(xmlEnvelope.replace("%code%", sendCode))
          }
        }

        httpmin.post(options).then(function (data) {

          var statusCode = data.response.statusCode;
          Homey.app.log("statusCode:", statusCode);
          Homey.app.log("response:", data.data);
          if (statusCode == 200) {
            Homey.app.log("sendCommand: command success");
            resolve();

          } else {
            Homey.app.log("sendCommand: unknown statuscode: " + data.response.statusCode);
            reject(new Error('unknown statuscode'))
          }
        }).catch(function (err) {
          Homey.app.log(error);
          reject(new Error('http error'))
        });
      } else {
        Homey.app.log("sendCommand: device settings undefined");
        reject(new Error('device settings undefined'))
      }
    });
  }

  registerFlowCards() {
    Homey.app.log("Settings:", this.settings);

    let actionNetflix = new Homey.FlowCardAction('Netflix');
    actionNetflix.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.Netflix, Commands.Netflix);
    });

    let actionChannelUp = new Homey.FlowCardAction('ChannelUp');
    actionChannelUp.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.ChannelUp, Commands.ChannelUp);
    });

    let actionChannelDown = new Homey.FlowCardAction('ChannelDown');
    actionChannelDown.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.ChannelDown, Commands.ChannelDown);
    });

    let actionVolumeDown = new Homey.FlowCardAction('VolumeDown');
    actionVolumeDown.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.VolumeDown, Commands.VolumeDown);
    });

    let actionVolumeUp = new Homey.FlowCardAction('VolumeUp');
    actionVolumeUp.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.VolumeUp, Commands.VolumeUp);
    });

    let actionToggleMute = new Homey.FlowCardAction('ToggleMute');
    actionToggleMute.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.ToggleMute, Commands.ToggleMute);
    });

    let actionSetInput = new Homey.FlowCardAction('SetInput');
    actionSetInput.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.SetInput, Commands.SetInput);
    });

    let actionEPG = new Homey.FlowCardAction('EPG');
    actionEPG.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.EPG, Commands.EPG);
    });

    let actionEnter = new Homey.FlowCardAction('Enter');
    actionEnter.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.Enter, Commands.Enter);
    });

    let actionNum0 = new Homey.FlowCardAction('Num0');
    actionNum0.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.Num0, Commands.Num0);
    });

    let actionNum1 = new Homey.FlowCardAction('Num1');
    actionNum1.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.Num1, Commands.Num1);
    });

    let actionNum2 = new Homey.FlowCardAction('Num2');
    actionNum2.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.Num2, Commands.Num2);
    });

    let actionNum3 = new Homey.FlowCardAction('Num3');
    actionNum3.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.Num3, Commands.Num3);
    });

    let actionNum4 = new Homey.FlowCardAction('Num4');
    actionNum4.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.Num4, Commands.Num4);
    });

    let actionNum5 = new Homey.FlowCardAction('Num5');
    actionNum5.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.Num5, Commands.Num5);
    });

    let actionNum6 = new Homey.FlowCardAction('Num6');
    actionNum6.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.Num6, Commands.Num6);
    });

    let actionNum7 = new Homey.FlowCardAction('Num7');
    actionNum7.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.Num7, Commands.Num7);
    });

    let actionNum8 = new Homey.FlowCardAction('Num8');
    actionNum8.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.Num8, Commands.Num8);
    });

    let actionNum9 = new Homey.FlowCardAction('Num9');
    actionNum9.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.Num9, Commands.Num9);
    });

    let actionNum10 = new Homey.FlowCardAction('Num10');
    actionNum10.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.Num10, Commands.Num10);
    });

    let actionNum11 = new Homey.FlowCardAction('Num11');
    actionNum11.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.Num11, Commands.Num11);
    });

    let actionNum12 = new Homey.FlowCardAction('Num12');
    actionNum12.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.Num12, Commands.Num12);
    });

    let actionPowerOff = new Homey.FlowCardAction('PowerOff');
    actionPowerOff.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.PowerOff, Commands.PowerOff);
    });

    let actionUp = new Homey.FlowCardAction('Up');
    actionUp.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.Up, Commands.Up);
    });

    let actionDown = new Homey.FlowCardAction('Down');
    actionDown.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.Down, Commands.Down);
    });

    let actionLeft = new Homey.FlowCardAction('Left');
    actionLeft.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.Left, Commands.Left);
    });

    let actionRight = new Homey.FlowCardAction('Right');
    actionRight.register().registerRunListener((args, state) => {
      return this.sendCommand(Commands.Right, Commands.Right);
    });


    /////////////////////////////
    //
    // CONDITION
    //
    /////// Power related ///////

    let conditionPower = new Homey.FlowCardCondition('tv_status');
    conditionPower.register().registerRunListener((args, state) => {
      return Promise.resolve(args["device"]["settings"]["power"]);
    });

    /////////////////////////////
    //
    // TRIGGER
    //
    /////// Power related ///////

    this._powerOn = new Homey.FlowCardTriggerDevice('turned_on').register();
    this._powerOff = new Homey.FlowCardTriggerDevice('turned_off').register();

    /////////////////////////////
    //
    // CAPABILITIES
    //
    /////// STANDARD COMMANDS ///////


    this.registerCapabilityListener('volume_up', async (args) => {
      return this.sendCommand(Commands.VolumeUp, Commands.VolumeUp);
    });

    this.registerCapabilityListener('volume_down', async (args) => {
      return this.sendCommand(Commands.VolumeDown, Commands.VolumeDown);
    });

    this.registerCapabilityListener('volume_mute', async (args) => {
      return this.sendCommand(Commands.ToggleMute, Commands.ToggleMute);
    });

    this.registerCapabilityListener('channel_up', async (args) => {
      return this.sendCommand(Commands.ChannelUp, Commands.ChannelUp);
    });

    this.registerCapabilityListener('channel_down', async (args) => {
      return this.sendCommand(Commands.ChannelDown, Commands.ChannelDown);
    });
  }
}

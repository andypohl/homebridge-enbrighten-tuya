'use strict';

/**
 * homebridge-enbrighten-tuya
 *
 * Local-network control of Enbrighten (Jasco) Wi-Fi string lights, which are
 * Tuya devices under the hood. Talks directly to the light on TCP 6668 using
 * the Tuya LAN protocol via `tuyapi`. No cloud, no internet dependency.
 *
 * Current scope: on/off power. The code is structured so brightness and scene
 * control can be added later by mapping more Tuya datapoints (DPs) to
 * additional HomeKit characteristics/services.
 */

const TuyAPI = require('tuyapi');

const PLATFORM_NAME = 'EnbrightenTuya';
const PLUGIN_NAME = 'homebridge-enbrighten-tuya';

const RECONNECT_MS = 10000;

let hap;

module.exports = (api) => {
  hap = api.hap;
  api.registerPlatform(PLATFORM_NAME, EnbrightenTuyaPlatform);
};

class EnbrightenTuyaPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];
    this.lights = [];

    // Homebridge may load this file to read config before the HAP API is ready.
    if (!api) {
      return;
    }

    this.api.on('didFinishLaunching', () => this.discoverDevices());
    this.api.on('shutdown', () => {
      for (const light of this.lights) {
        light.dispose();
      }
    });
  }

  // Restore cached accessories on startup.
  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  discoverDevices() {
    const devices = Array.isArray(this.config.devices) ? this.config.devices : [];
    const seen = new Set();

    if (devices.length === 0) {
      this.log.warn('No devices configured. Add at least one under "devices" with id, key and ip.');
    }

    for (const device of devices) {
      if (!device || !device.id || !device.key || !device.ip) {
        this.log.warn(
          `Skipping device "${(device && device.name) || '(unnamed)'}": "id", "key" and "ip" are all required.`
        );
        continue;
      }

      const uuid = this.api.hap.uuid.generate(`enbrighten-tuya:${device.id}`);
      if (seen.has(uuid)) {
        this.log.warn(`Duplicate device id "${device.id}" ignored.`);
        continue;
      }
      seen.add(uuid);

      let accessory = this.accessories.find((a) => a.UUID === uuid);
      if (accessory) {
        this.log.info(`Restoring accessory from cache: ${accessory.displayName}`);
        accessory.context.device = device;
      } else {
        const name = device.name || 'Enbrighten Lights';
        this.log.info(`Adding new accessory: ${name}`);
        accessory = new this.api.platformAccessory(name, uuid);
        accessory.context.device = device;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      this.lights.push(new EnbrightenLight(this, accessory, device));
    }

    // Drop accessories that are no longer in the config.
    const stale = this.accessories.filter((a) => !seen.has(a.UUID));
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.log.info(`Removed ${stale.length} accessory(ies) no longer in config.`);
    }
  }
}

class EnbrightenLight {
  constructor(platform, accessory, config) {
    this.platform = platform;
    this.log = platform.log;
    this.api = platform.api;
    this.accessory = accessory;
    this.config = config;
    this.name = config.name || 'Enbrighten Lights';

    this.dpPower = String(config.dpPower != null ? config.dpPower : 20);
    this.version = String(config.version || '3.3');

    this.isOn = false;
    this.connected = false;
    this.loggedDps = false;
    this.reconnectTimer = null;
    this.disposed = false;

    const { Service, Characteristic } = this.api.hap;

    const info =
      accessory.getService(Service.AccessoryInformation) ||
      accessory.addService(Service.AccessoryInformation);
    info
      .setCharacteristic(Characteristic.Manufacturer, 'Enbrighten (Tuya)')
      .setCharacteristic(Characteristic.Model, 'Wi-Fi String Lights')
      .setCharacteristic(Characteristic.SerialNumber, String(config.id));

    this.service =
      accessory.getService(Service.Lightbulb) ||
      accessory.addService(Service.Lightbulb, this.name);
    this.service.setCharacteristic(Characteristic.Name, this.name);

    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(this.handleOnGet.bind(this))
      .onSet(this.handleOnSet.bind(this));

    this.setupDevice();
  }

  setupDevice() {
    this.device = new TuyAPI({
      id: this.config.id,
      key: this.config.key,
      ip: this.config.ip,
      version: this.version,
      issueRefreshOnConnect: true,
    });

    this.device.on('connected', () => {
      this.connected = true;
      this.log.info(`[${this.name}] connected (${this.config.ip}, protocol ${this.version})`);
    });

    this.device.on('disconnected', () => {
      this.connected = false;
      if (!this.disposed) {
        this.log.warn(`[${this.name}] disconnected; will retry.`);
        this.scheduleReconnect();
      }
    });

    this.device.on('error', (err) => {
      this.log.debug(`[${this.name}] error: ${err}`);
    });

    const onData = (data) => this.handleData(data);
    this.device.on('data', onData);
    this.device.on('dp-refresh', onData);

    this.connect();
  }

  handleData(data) {
    if (!data || !data.dps) {
      return;
    }

    // One-time: surface the datapoints so the correct power DP (and, later,
    // brightness/scene DPs) can be identified from the Homebridge log.
    if (!this.loggedDps) {
      this.loggedDps = true;
      this.log.info(`[${this.name}] datapoints seen: ${JSON.stringify(data.dps)}`);
    }

    if (Object.prototype.hasOwnProperty.call(data.dps, this.dpPower)) {
      this.isOn = data.dps[this.dpPower] === true;
      this.service.updateCharacteristic(this.api.hap.Characteristic.On, this.isOn);
    }
  }

  async connect() {
    if (this.disposed) {
      return;
    }
    try {
      // Opportunistic: locate the device by id on the LAN (handles IP changes).
      // Falls back silently to the configured IP if the broadcast is missed.
      await this.device.find({ timeout: 5 });
    } catch (e) {
      this.log.debug(`[${this.name}] find() skipped: ${e}`);
    }
    try {
      await this.device.connect();
    } catch (e) {
      this.log.debug(`[${this.name}] connect() failed: ${e}`);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.disposed) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_MS);
  }

  async handleOnGet() {
    if (!this.connected) {
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE
      );
    }
    return this.isOn;
  }

  async handleOnSet(value) {
    const target = !!value;
    try {
      await this.device.set({ dps: this.dpPower, set: target });
      this.isOn = target;
      this.log.debug(`[${this.name}] set power -> ${target}`);
    } catch (e) {
      this.log.error(`[${this.name}] failed to set power: ${e}`);
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE
      );
    }
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.device.disconnect();
    } catch (e) {
      /* ignore */
    }
  }
}

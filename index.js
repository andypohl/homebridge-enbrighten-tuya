'use strict';

/**
 * homebridge-enbrighten-tuya
 *
 * Local-network control of Enbrighten (Jasco) Wi-Fi string lights, which are
 * Tuya devices under the hood. Talks directly to the light on TCP 6668 using
 * the Tuya LAN protocol via `tuyapi`. No cloud, no internet dependency.
 *
 * Scope: on/off, brightness, and colour (hue/saturation), driven through a single
 * packed Tuya datapoint (DP106 "control_data": brightness 0-1000 plus W,R,G,B).
 * Scene selection is a planned addition (scenes use a different packed form).
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
    // DP106 "control_data": packed brightness + WRGB color (see parseControl).
    this.dpControl = String(config.dpControl != null ? config.dpControl : 106);
    this.version = String(config.version || '3.3');

    this.isOn = false;
    this.connected = false;
    this.loggedDps = false;
    this.reconnectTimer = null;
    this.writeTimer = null;
    this.disposed = false;

    // HomeKit-facing colour state (brightness 1-100, hue 0-360, saturation 0-100).
    this.brightPct = 100;
    this.hue = 0;
    this.sat = 0;

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

    this.service
      .getCharacteristic(Characteristic.Brightness)
      .onGet(() => this.brightPct)
      .onSet(this.handleBrightnessSet.bind(this));

    this.service
      .getCharacteristic(Characteristic.Hue)
      .onGet(() => this.hue)
      .onSet(this.handleHueSet.bind(this));

    this.service
      .getCharacteristic(Characteristic.Saturation)
      .onGet(() => this.sat)
      .onSet(this.handleSaturationSet.bind(this));

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

    // Opt-in verbose logging of every datapoint update (set "debugDatapoints": true
    // in the device config). Used to reverse-engineer packed DPs like control_data
    // (DP106) by watching how they change as settings are adjusted in the app.
    if (this.config.debugDatapoints) {
      this.log.info(`[${this.name}] dp update: ${JSON.stringify(data.dps)}`);
    }

    if (Object.prototype.hasOwnProperty.call(data.dps, this.dpPower)) {
      this.isOn = data.dps[this.dpPower] === true;
      this.service.updateCharacteristic(this.api.hap.Characteristic.On, this.isOn);
    }

    if (Object.prototype.hasOwnProperty.call(data.dps, this.dpControl)) {
      this.parseControl(data.dps[this.dpControl]);
    }
  }

  // DP106 packed control_data. Manual form: "00<AAAA><BBBB>0#<WW><RR><GG><BB>"
  // where BBBB = brightness 0-1000 and the 4 bytes after '#' are White,R,G,B.
  // Scene form (e.g. "4001f403e8") has no '#'; left untouched for now.
  parseControl(val) {
    if (typeof val !== 'string') {
      return;
    }
    const hash = val.indexOf('#');
    if (hash < 0) {
      this.log.debug(`[${this.name}] scene/other control_data: ${val}`);
      return;
    }
    const { Characteristic } = this.api.hap;
    const prefix = val.slice(0, hash);
    const color = val.slice(hash + 1);
    if (prefix.length >= 10) {
      const b1000 = parseInt(prefix.slice(6, 10), 16);
      if (!Number.isNaN(b1000)) {
        this.brightPct = clamp(Math.round(b1000 / 10), 1, 100);
        this.service.updateCharacteristic(Characteristic.Brightness, this.brightPct);
      }
    }
    if (color.length >= 8) {
      const w = parseInt(color.slice(0, 2), 16);
      const r = parseInt(color.slice(2, 4), 16);
      const g = parseInt(color.slice(4, 6), 16);
      const b = parseInt(color.slice(6, 8), 16);
      if (r + g + b <= 8 && w > 0) {
        // White via the W channel -> represent as a desaturated white in HomeKit.
        this.sat = 0;
        this.service.updateCharacteristic(Characteristic.Saturation, 0);
      } else {
        const { h, s } = rgbToHs(r, g, b);
        this.hue = h;
        this.sat = s;
        this.service.updateCharacteristic(Characteristic.Hue, h);
        this.service.updateCharacteristic(Characteristic.Saturation, s);
      }
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

  handleBrightnessSet(value) {
    this.brightPct = clamp(Math.round(value), 1, 100);
    this.scheduleWrite();
  }

  handleHueSet(value) {
    this.hue = ((Number(value) % 360) + 360) % 360;
    this.scheduleWrite();
  }

  handleSaturationSet(value) {
    this.sat = clamp(Number(value), 0, 100);
    this.scheduleWrite();
  }

  // HomeKit sends Hue, Saturation and Brightness as separate rapid calls; coalesce
  // them into a single DP106 write so the light gets one combined command.
  scheduleWrite() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.writeControl();
    }, 80);
  }

  composeControl() {
    const bright1000 = clamp(Math.round(this.brightPct * 10), 1, 1000);
    const { r, g, b } = hsToRgb(this.hue, this.sat);
    // "00" + AAAA(const 03e8) + BBBB(brightness) + "0" + "#" + WW(00) + RR GG BB
    return '0003e8' + hex4(bright1000) + '0#00' + hex2(r) + hex2(g) + hex2(b);
  }

  async writeControl() {
    const payload = this.composeControl();
    try {
      await this.device.set({ dps: this.dpControl, set: payload });
      this.log.debug(`[${this.name}] set control_data -> ${payload}`);
    } catch (e) {
      this.log.error(`[${this.name}] failed to set colour/brightness: ${e}`);
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

// ---- helpers ----------------------------------------------------------------

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function hex2(n) {
  return clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
}

function hex4(n) {
  return clamp(Math.round(n), 0, 65535).toString(16).padStart(4, '0');
}

// HomeKit hue (0-360) + saturation (0-100) -> {r,g,b} 0-255 at full value.
function hsToRgb(h, s) {
  h = ((h % 360) + 360) % 360;
  s = clamp(s, 0, 100) / 100;
  const c = s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = 1 - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

// {r,g,b} 0-255 -> {h:0-360, s:0-100} (value is ignored; brightness is separate).
function rgbToHs(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) {
      h = ((g - b) / d) % 6;
    } else if (max === g) {
      h = (b - r) / d + 2;
    } else {
      h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) {
      h += 360;
    }
  }
  const s = max === 0 ? 0 : (d / max) * 100;
  return { h, s };
}

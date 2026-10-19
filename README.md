# homebridge-enbrighten-tuya

Local-network HomeKit control for **Enbrighten (Jasco) Wi-Fi string lights**.

Enbrighten Wi-Fi lights are Tuya devices internally. This plugin talks to the
light directly on your LAN (TCP 6668, Tuya protocol), so control does not depend
on the Tuya cloud or the internet once it is set up. That suits a segmented
network where the lights live on an IoT VLAN.

**Scope today:** on/off power.
**Designed to grow into:** brightness and scene selection (the Tuya datapoints
for those are noted at the end).

---

## Requirements

- The light on a reachable network. If Homebridge and the light are on different
  VLANs, the Homebridge host must be able to open TCP 6668 to the light, and
  (optionally) receive the light's UDP 6667 broadcast for auto-discovery.
- The light's **device id** and **local key** (one-time lookup, below).

## Install

From the Homebridge host:

```
npm install -g homebridge-enbrighten-tuya
```

Or, to install this local copy during development:

```
cd ~/github/homebridge-enbrighten-tuya
npm install
npm install -g .
```

Then restart Homebridge.

## Getting the device id and local key (one time)

These two secrets live inside the light and are set during pairing. They cannot
be captured from network traffic. The documented way to read them is through a
free Tuya IoT developer account, using the `tinytuya` wizard:

1. Pair the lights in the **Enbrighten** app (or **Smart Life**) if not already.
2. Create a free account at <https://iot.tuya.com>, create a Cloud project
   (data center: the one matching your region), and link your Enbrighten/Smart
   Life app account to it under **Devices → Link App Account**.
3. On any computer with Python:
   ```
   pip install tinytuya
   python -m tinytuya wizard
   ```
   Enter the Tuya project's API key/secret when prompted. The wizard writes
   `devices.json` listing each device's **id**, **key** (local key), **ip**, and
   **version**.

Keep the local key private. You enter it directly into the Homebridge config on
the Homebridge host; it never needs to leave that machine.

## Configuration

Use the Homebridge UI (the plugin ships a config form), or add a platform block
to `config.json`:

```json
{
  "platforms": [
    {
      "platform": "EnbrightenTuya",
      "name": "EnbrightenTuya",
      "devices": [
        {
          "name": "Patio String Lights",
          "id": "PASTE_DEVICE_ID",
          "key": "PASTE_LOCAL_KEY",
          "ip": "192.168.1.182",
          "version": "3.3",
          "dpPower": 20
        }
      ]
    }
  ]
}
```

| Field     | Meaning |
|-----------|---------|
| `id`      | Tuya device id from the wizard. |
| `key`     | Tuya local key from the wizard. Private. |
| `ip`      | The light's LAN address. Pin it with a static DHCP lease so it never moves. |
| `version` | Tuya protocol version the wizard reports (commonly `3.3`). |
| `dpPower` | The datapoint that toggles power. Default `20`. If that does nothing, see below. |

## Finding the right power datapoint

On the first successful connection the plugin logs one line like:

```
[Patio String Lights] datapoints seen: {"20":true,"21":"white","22":1000,...}
```

The boolean that flips with on/off is your power DP. For Tuya lighting devices
it is almost always `20`; some simpler devices use `1`. Set `dpPower` to match.

## Roadmap: brightness and scenes

Tuya lighting devices expose a standard datapoint set. When you want more than
on/off, these are the ones to map:

| DP  | Function        | HomeKit mapping |
|-----|-----------------|-----------------|
| 20  | on/off          | Lightbulb `On` (done) |
| 22  | brightness      | Lightbulb `Brightness` (scale 10–1000) |
| 21  | work mode       | `white` / `colour` / `scene` / `music` |
| 24  | colour (HSV)    | `Hue` + `Saturation` |
| 25  | scene data      | expose scenes as switches or a selector |

The code in `index.js` is organized so each of these becomes an added
characteristic on the existing `Lightbulb` service (or a separate service for
scene switches) without restructuring.

## License

MIT

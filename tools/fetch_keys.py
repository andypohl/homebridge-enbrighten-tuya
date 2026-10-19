#!/usr/bin/env python3
"""
Fetch Tuya device ids and local keys from your Tuya IoT Cloud project, so the
Homebridge plugin can control the lights locally.

Credentials are read from .secrets/tuya-credentials.env (or the environment).
Secrets are written to local files under .secrets/ and are NOT printed to the
terminal, so they never end up in logs or chat. Only non-secret summary info
(names, IPs, protocol version, datapoints) is printed.

Usage:
    ./.venv/bin/python tools/fetch_keys.py [match_ip]

    match_ip defaults to 192.168.1.182 (the Enbrighten string lights).
"""

import json
import os
import sys

import tinytuya

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEC = os.path.join(HERE, ".secrets")
CRED = os.path.join(SEC, "tuya-credentials.env")

# Tuya "code" (cloud) -> local datapoint number, for the standard lighting schema.
CODE_TO_DP = {
    "switch_led": 20,
    "switch_1": 1,
    "bright_value_v2": 22,
    "bright_value": 22,
    "work_mode": 21,
    "colour_data_v2": 24,
    "scene_data_v2": 25,
}


def load_credentials():
    data = {}
    for key in ("TUYA_API_REGION", "TUYA_API_KEY", "TUYA_API_SECRET"):
        if os.environ.get(key):
            data[key] = os.environ[key]
    if os.path.exists(CRED):
        with open(CRED) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                data[k.strip()] = v.strip().strip('"').strip("'")
    missing = [k for k in ("TUYA_API_REGION", "TUYA_API_KEY", "TUYA_API_SECRET") if not data.get(k)]
    if missing:
        print("ERROR: missing credentials: " + ", ".join(missing))
        print("Fill them in: " + CRED)
        sys.exit(2)
    return data


def mask(value):
    if not value:
        return value
    return value[:4] + "..." + value[-4:] if len(value) > 10 else "***"


def guess_power_dp(status_codes):
    if "switch_led" in status_codes:
        return 20
    if "switch_1" in status_codes:
        return 1
    return 20


def main():
    want_ip = sys.argv[1] if len(sys.argv) > 1 else "192.168.1.182"
    cred = load_credentials()

    cloud = tinytuya.Cloud(
        apiRegion=cred["TUYA_API_REGION"],
        apiKey=cred["TUYA_API_KEY"],
        apiSecret=cred["TUYA_API_SECRET"],
    )

    devices = cloud.getdevices(verbose=False)
    if not isinstance(devices, list):
        print("ERROR from Tuya Cloud (check region/keys and that the app account is linked):")
        print(json.dumps(devices)[:500])
        sys.exit(1)

    results = []
    for dev in devices:
        did = dev.get("id")
        local_key = dev.get("key") or dev.get("local_key")
        status_codes = {}
        try:
            st = cloud.getstatus(did)
            if isinstance(st, dict) and st.get("result"):
                status_codes = {s["code"]: s["value"] for s in st["result"] if "code" in s}
        except Exception:
            pass
        results.append(
            {
                "name": dev.get("name"),
                "id": did,
                "key": local_key,
                "ip": dev.get("ip"),
                "version": str(dev.get("version") or "3.3"),
                "status": status_codes,
            }
        )

    os.makedirs(SEC, exist_ok=True)
    devices_path = os.path.join(SEC, "devices.json")
    with open(devices_path, "w") as fh:
        json.dump(results, fh, indent=2)
    os.chmod(devices_path, 0o600)

    matches = [d for d in results if d.get("ip") == want_ip] or results
    block = {"platform": "EnbrightenTuya", "name": "EnbrightenTuya", "devices": []}
    for d in matches:
        if not d.get("key"):
            continue
        block["devices"].append(
            {
                "name": d.get("name") or "Enbrighten Lights",
                "id": d["id"],
                "key": d["key"],
                "ip": d.get("ip") or want_ip,
                "version": d.get("version") or "3.3",
                "dpPower": guess_power_dp(d.get("status") or {}),
            }
        )
    block_path = os.path.join(SEC, "homebridge-block.json")
    with open(block_path, "w") as fh:
        json.dump(block, fh, indent=2)
    os.chmod(block_path, 0o600)

    print("Found %d device(s) in your Tuya project:\n" % len(results))
    for d in results:
        tag = "   <-- matches %s" % want_ip if d.get("ip") == want_ip else ""
        print(
            "  name=%r  ip=%s  version=%s  id=%s  local_key=%s%s"
            % (
                d.get("name"),
                d.get("ip"),
                d.get("version"),
                mask(d.get("id")),
                "present" if d.get("key") else "MISSING",
                tag,
            )
        )
        if d.get("status"):
            print("     datapoint codes: %s" % json.dumps(d["status"]))
            print("     -> guessed power dpPower = %d" % guess_power_dp(d["status"]))
    print()
    print("Secrets written (contents NOT shown here):")
    print("  %s" % devices_path)
    print("  %s   <- paste its \"devices\" into your Homebridge config" % block_path)


if __name__ == "__main__":
    main()

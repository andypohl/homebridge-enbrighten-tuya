#!/usr/bin/env python3
"""Enumerate the light's local datapoints (read-only), to map advanced features.

Run on a host on the light's subnet (e.g. homebridgerton):
    ./.venv/bin/python tools/probe_local.py
"""
import json, os
import tinytuya

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
dev = json.load(open(os.path.join(HERE, ".secrets", "devices.json")))[0]
d = tinytuya.Device(dev["id"], dev.get("ip") or "192.168.1.182", dev["key"],
                    version=float(dev.get("version") or 3.3))
d.set_socketTimeout(5)
st = d.status()
print("status dps:", json.dumps(st.get("dps", {}), indent=2))
print("\ndetecting available DPs (read-only probe)...")
try:
    dps = d.detect_available_dps()
    print("available dps:", json.dumps(dps, indent=2))
except Exception as e:
    print("detect error:", e)

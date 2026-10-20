#!/usr/bin/env python3
"""Log the light's datapoints as they change, to reverse-engineer DP106 (control_data).
Run on the light's subnet (homebridgerton):
    ./.venv/bin/python tools/dp_monitor.py [seconds]
"""
import json, os, sys, time, datetime
import tinytuya

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
dev = json.load(open(os.path.join(HERE, ".secrets", "devices.json")))[0]
dur = int(sys.argv[1]) if len(sys.argv) > 1 else 180
d = tinytuya.Device(dev["id"], dev.get("ip") or "192.168.1.182", dev["key"],
                    version=float(dev.get("version") or 3.3))
d.set_socketPersistent(True); d.set_socketTimeout(5)
last = None
print("monitoring %ds — make changes in the app now" % dur, flush=True)
end = time.time() + dur
while time.time() < end:
    try:
        st = d.status()
        dps = st.get("dps") if isinstance(st, dict) else None
        if dps and dps != last:
            print(datetime.datetime.now().strftime("%H:%M:%S"), json.dumps(dps), flush=True)
            last = dps
    except Exception:
        pass
    time.sleep(1.0)
print("done", flush=True)

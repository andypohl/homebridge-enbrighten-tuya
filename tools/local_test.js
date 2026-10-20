#!/usr/bin/env node
/*
 * Local connectivity check for the Enbrighten (Tuya) lights.
 * Reads .secrets/devices.json, connects to each device on the LAN with TuyAPI,
 * reads its current datapoints, and prints them. Non-destructive by default.
 *
 *   node tools/local_test.js            # read status only
 *   node tools/local_test.js --toggle   # also flip power off->on to prove control
 *
 * Must be run from a host on the SAME subnet as the light (e.g. the Homebridge
 * host), because Tuya devices ignore local control from other subnets.
 */
const fs = require('fs');
const path = require('path');
const TuyAPI = require('tuyapi');

const DO_TOGGLE = process.argv.includes('--toggle');
const sec = path.join(__dirname, '..', '.secrets', 'devices.json');
const devices = JSON.parse(fs.readFileSync(sec, 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(d) {
  const ip = d.ip || '192.168.1.182';
  const version = String(d.version || '3.3');
  const dp = String(d.dpPower || '20');
  console.log(`\n== ${d.name} @ ${ip} (v${version}, dpPower ${dp}) ==`);
  const dev = new TuyAPI({ id: d.id, key: d.key, ip, version, issueRefreshOnConnect: true });
  let gotData = false;
  dev.on('data', (data) => { gotData = true; console.log('  dps:', JSON.stringify(data.dps)); });
  dev.on('error', (e) => console.log('  error:', e && e.message ? e.message : e));
  try {
    await dev.connect();
    console.log('  connected: yes');
    // give it a moment for the refresh-on-connect data
    for (let i = 0; i < 10 && !gotData; i++) await sleep(300);
    const status = await dev.get({ schema: true }).catch(() => null);
    if (status && status.dps) console.log('  get(schema):', JSON.stringify(status.dps));
    const cur = await dev.get({ dps: Number(dp) }).catch(() => null);
    console.log(`  power dp ${dp} currently:`, cur);
    if (DO_TOGGLE && typeof cur === 'boolean') {
      console.log(`  toggling dp ${dp} -> ${!cur} ...`);
      await dev.set({ dps: Number(dp), set: !cur });
      await sleep(1200);
      console.log(`  toggling dp ${dp} back -> ${cur} ...`);
      await dev.set({ dps: Number(dp), set: cur });
      await sleep(600);
      console.log('  toggle done');
    }
  } catch (e) {
    console.log('  FAILED:', e && e.message ? e.message : e);
  } finally {
    try { await dev.disconnect(); } catch (_) {}
  }
}

(async () => {
  for (const d of devices) await check(d);
  process.exit(0);
})();

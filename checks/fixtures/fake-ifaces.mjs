// PLANNER-OWNED. Preload for `node --import`: replaces os.networkInterfaces() with the JSON in env GRILL_FAKE_IFACES.
// syncBuiltinESMExports() makes both `import os from 'node:os'` and `import { networkInterfaces } from 'node:os'` see it.
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';

const fake = JSON.parse(process.env.GRILL_FAKE_IFACES || '{}');
os.networkInterfaces = () => fake;
syncBuiltinESMExports();

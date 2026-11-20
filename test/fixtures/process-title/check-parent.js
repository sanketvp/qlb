// Child of a process.title probe. Inspects the parent the way `qlb token` does.
const { basename } = require('node:path');
const { tokenCallAllowed } = require(process.env.QLB_TOKEN_MODULE);

const snapshot = JSON.parse(process.argv[2]);
const env = {
  QLB_PI_TOKEN_CALL: '1',
  QLB_PI_PACKAGE_ROOT: process.env.QLB_PROBE_PI_ROOT,
};
const nonTty = { isTty: () => false };

const production = tokenCallAllowed(env, nonTty);
// `parentProcess()` stores the executable basename in `ucomm`. `ps -o ucomm=`
// is the overwritten title on Linux and is not the guard field.
const injected = tokenCallAllowed(env, {
  ...nonTty,
  parent: () => ({
    comm: snapshot.comm,
    command: snapshot.command,
    ucomm: basename(snapshot.executable),
  }),
});

process.stdout.write(JSON.stringify({ production, injected }));

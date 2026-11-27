'use strict';

// libsignal (under Baileys) prints whole session objects, private keys
// included, to the console. Keep its message and drop the object.

const isSession = (v) => Boolean(v) && typeof v === 'object'
  && ('currentRatchet' in v || '_chains' in v || 'indexInfo' in v);

function install(target = console) {
  for (const level of ['log', 'info', 'warn', 'error']) {
    const write = target[level].bind(target);
    target[level] = (...args) => write(...args.map((a) => (isSession(a) ? '[session keys hidden]' : a)));
  }
}

module.exports = { install };

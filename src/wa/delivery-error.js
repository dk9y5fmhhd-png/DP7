'use strict';

// The database stores a short code; the wording staff can act on lives here.
const NO_CONFIRMATION = 'no_confirmation';
const STALE_PENDING_MINUTES = 10;

function describeDeliveryError(code) {
  switch (code) {
    case '463':
      return 'WhatsApp refused it: this number cannot start a chat with this contact right now. Ask the contact to message first, or use another number.';
    case '479':
      return 'WhatsApp rejected it (temporary session problem). Try again in a minute.';
    case NO_CONFIRMATION:
      return 'WhatsApp never confirmed it, so it was most likely not delivered.';
    default:
      return code ? `WhatsApp refused it (code ${code}).` : 'WhatsApp reported an error.';
  }
}

module.exports = { NO_CONFIRMATION, STALE_PENDING_MINUTES, describeDeliveryError };

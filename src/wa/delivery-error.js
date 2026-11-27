'use strict';

// The database stores a short code; the wording staff can act on lives here.
const NO_CONFIRMATION = 'no_confirmation';
const STALE_PENDING_MINUTES = 10;

function describeDeliveryError(code) {
  switch (code) {
    case '463':
      return 'WhatsApp refused this message: this number cannot start a chat with this contact right now (the number is restricted, or the contact has never chatted with it). Retrying straight away usually fails again. Ask the contact to message first, or use another number.';
    case '479':
      return 'WhatsApp rejected it (temporary session problem). Try again in a minute.';
    case NO_CONFIRMATION:
      return 'WhatsApp never confirmed it, so it was most likely not delivered.';
    default:
      return code ? `WhatsApp refused it (code ${code}).` : 'WhatsApp reported an error.';
  }
}

// The same reason in a few words, for a table cell.
function describeDeliveryErrorShort(code) {
  switch (code) {
    case '463': return "Refused: can't start this chat";
    case '479': return 'Rejected: session problem';
    case NO_CONFIRMATION: return 'Never confirmed by WhatsApp';
    default: return 'WhatsApp error';
  }
}

module.exports = { NO_CONFIRMATION, STALE_PENDING_MINUTES, describeDeliveryError, describeDeliveryErrorShort };

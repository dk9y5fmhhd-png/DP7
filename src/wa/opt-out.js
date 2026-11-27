'use strict';

// Recognising "stop messaging me" replies (rule taken from Ringline). The WHOLE
// message, lower-cased and stripped of punctuation and emoji, has to be one of
// these phrases: "Stop!" counts, "stop by tomorrow" does not.
const PHRASES = new Set([
  'stop', 'stop it', 'stop all', 'please stop', 'stop message', 'stop messages', 'stop messaging',
  'stop messaging me', 'stop texting', 'stop texting me', 'stop sending', 'stop sending messages',
  'stop sending me messages', 'stop contacting me', 'unsubscribe', 'unsubscribe me', 'opt out',
  'opt me out', 'remove me', 'remove my number', 'remove me from your list', 'do not contact',
  'do not contact me', 'dont contact me', 'don t contact me', 'do not message me', 'dont message me',
  'don t message me', 'leave me alone', 'no more messages', 'no more texts',
  // Hindi, Roman and Devanagari. Worth a native speaker's review.
  'stop karo', 'band karo', 'mat bhejo', 'message mat karo', 'msg mat karo', 'बंद करो', 'मत भेजो',
]);

// Combining marks (\p{M}) are kept: Devanagari vowel signs are marks.
const normalize = (text) => String(text).normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

const isOptOutMessage = (text) => Boolean(text) && PHRASES.has(normalize(text));

module.exports = { isOptOutMessage };

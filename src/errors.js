'use strict';

// Error type for every rejection of the new `despia.<feature>.<action>()` API.
// Native error codes pass through unchanged; the SDK adds the codes below.

const ErrorCodes = Object.freeze({
  NOT_IN_APP: 'not_in_app',     // plain browser: no JSON bridge and no Despia runtime
  UNSUPPORTED: 'unsupported',   // no JSON bridge and the action has no legacy scheme
  INVALID_ARGS: 'invalid_args', // args failed validation or are not JSON-serialisable
  TIMEOUT: 'timeout',           // legacy fallback: the result variable never arrived
  BRIDGE_ERROR: 'bridge_error', // transport failure or malformed reply
  NATIVE_ERROR: 'native_error'  // native rejected without a structured error
});

class DespiaError extends Error {
  constructor(code, message, details) {
    super(message || String(code));
    this.name = 'DespiaError';
    this.code = String(code);
    if (details !== undefined) this.details = details;
  }
}

module.exports = { DespiaError, ErrorCodes };

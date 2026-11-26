'use strict';

// Error type for every rejection of the typed `despia.<feature>.<action>()`
// API. Codes that native sends pass through unchanged; the codes below are
// the ones the SDK itself produces.

const ErrorCodes = Object.freeze({
  NOT_IN_APP: 'not_in_app',                       // plain browser: no Despia runtime at all
  ABORTED: 'aborted',                             // the caller's AbortSignal fired
  TIMEOUT: 'timeout',                             // no reply inside timeoutMs + 5000
  FEATURE_NOT_INSTALLED: 'feature_not_installed', // this app build has no bridge route for it
  BAD_ARGS: 'bad_args',                           // args were not a plain object
  INTERNAL: 'internal'                            // malformed reply or transport fault
});

class DespiaError extends Error {
  constructor(code, message, path) {
    super(message || String(code));
    this.name = 'DespiaError';
    this.code = String(code);
    if (path !== undefined) this.path = path;
  }
}

module.exports = { DespiaError, ErrorCodes };

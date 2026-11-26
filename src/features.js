'use strict';

// Runtime feature map: actions, their parameters and the legacy scheme each
// one falls back to when the JSON bridge is not present. The type-level twin
// of this table is features.d.ts.
//
// Hand-written for now. scripts/generate-features.js emits this exact shape
// from native routes.json files and will replace this file.
//
// action = {
//   params: { name: { type, required?, min?, max? } },  // validated before sending
//   legacy: {                                           // omitted = no fallback
//     scheme: 'scheme://route',
//     query:  { queryKey: 'paramName' },                // appended as ?queryKey=value
//     watch:  ['windowVar' | '{paramName}'],            // variables the app writes back
//     result: 'windowVar' | '{paramName}'               // resolve with one variable;
//   }                                                   // omitted = object of all watched
// }

module.exports = {
  haptics: {
    actions: {
      light: { params: {}, legacy: { scheme: 'lighthaptic://' } },
      heavy: { params: {}, legacy: { scheme: 'heavyhaptic://' } },
      success: { params: {}, legacy: { scheme: 'successhaptic://' } },
      warning: { params: {}, legacy: { scheme: 'warninghaptic://' } },
      error: { params: {}, legacy: { scheme: 'errorhaptic://' } }
    },
    events: []
  },

  vault: {
    actions: {
      set: {
        params: {
          key: { type: 'string', required: true, min: 1 },
          value: { type: 'string', required: true },
          locked: { type: 'boolean' }
        },
        legacy: {
          scheme: 'setvault://',
          query: { key: 'key', value: 'value', locked: 'locked' }
        }
      },
      get: {
        params: {
          key: { type: 'string', required: true, min: 1 }
        },
        legacy: {
          scheme: 'readvault://',
          query: { key: 'key' },
          watch: ['{key}'],
          result: '{key}'
        }
      }
    },
    events: []
  },

  device: {
    actions: {
      appVersion: {
        params: {},
        legacy: { scheme: 'getappversion://', watch: ['versionNumber', 'bundleNumber'] }
      },
      uuid: {
        params: {},
        legacy: { scheme: 'get-uuid://', watch: ['uuid'], result: 'uuid' }
      },
      storeLocation: {
        params: {},
        legacy: { scheme: 'getstorelocation://', watch: ['storeLocation'], result: 'storeLocation' }
      }
    },
    events: []
  },

  revenuecat: {
    actions: {
      purchase: {
        params: {
          externalId: { type: 'string', required: true, min: 1 },
          product: { type: 'string', required: true, min: 1 }
        },
        legacy: {
          scheme: 'revenuecat://purchase',
          query: { external_id: 'externalId', product: 'product' }
        }
      },
      paywall: {
        params: {
          externalId: { type: 'string', required: true, min: 1 },
          offering: { type: 'string', min: 1 }
        },
        legacy: {
          scheme: 'revenuecat://launchPaywall',
          query: { external_id: 'externalId', offering: 'offering' }
        }
      },
      history: {
        params: {},
        legacy: { scheme: 'getpurchasehistory://', watch: ['restoredData'], result: 'restoredData' }
      }
    },
    events: ['purchase']
  },

  gps: {
    actions: {
      start: {
        params: {
          buffer: { type: 'integer', min: 1 },
          movement: { type: 'integer', min: 0 },
          server: { type: 'string', min: 1 }
        },
        legacy: {
          scheme: 'location://',
          query: { buffer: 'buffer', movement: 'movement', server: 'server' }
        }
      },
      stop: {
        params: {},
        legacy: { scheme: 'stoplocation://', watch: ['locationSession'], result: 'locationSession' }
      }
    },
    events: ['change']
  }
};

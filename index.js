// index.js
(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
      define([], factory);
    } else if (typeof module === 'object' && module.exports) {
      module.exports = factory();
    } else {
      root.despia = factory();
    }
  }(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
  
    // Command queue for sequential execution
    const commandQueue = [];
    let processing = false;
  
    // Process command queue with 1ms delay between commands
    function processQueue() {
      if (processing || commandQueue.length === 0) return;
      
      processing = true;
      const { command } = commandQueue.shift();
      
      try {
        // Use the setter pattern: window.despia = command
        window.despia = command;
      } catch (e) {
        console.error('Despia command failed:', e);
      }
      
      setTimeout(() => {
        processing = false;
        processQueue();
      }, 1);
    }
  
    // Add command to queue
    function queueCommand(command) {
      if (typeof window !== 'undefined') {
        commandQueue.push({ command });
        processQueue();
      }
    }

    // Generate a safe signature for change detection
    function safeSig(val) {
        if (val === undefined) return 'u';
        if (val === null) return 'n';
        const t = typeof val;
        if (t !== 'object') return `${t}:${String(val)}`;
        try { return `o:${JSON.stringify(val)}`; } catch { return 'o:[unserializable]'; }
    }
  
    // Simple variable observer with longer timeout, change detection, and guaranteed resolve
    function observeDespiaVariable(variableName, callback, timeout = 30000) {
        const startTime = Date.now();
        const initialRef = window[variableName];
        const initialSig = safeSig(initialRef);

        const ready = (val) => {
            if (val === undefined || val === "n/a") return false;
            return true;
        };

        const changed = (val) => {
            // Special case: if value is null, always consider it changed (immediate signal)
            if (val === null) return true;
            
            if (val !== initialRef) return true;
            return safeSig(val) !== initialSig;
        };

        function checkVariable() {
            const val = window[variableName];

            if (ready(val) && changed(val)) {
                // Fresh response arrived; empty collections and null are valid data.
                callback(val);
                return;
            }

            if (Date.now() - startTime < timeout) {
                setTimeout(checkVariable, 100);
                return;
            }

            // Timeout: still resolve so promises don't hang
            console.error(`Despia timeout: ${variableName} was not set within ${timeout} ms`);
            callback(undefined);
        }

        checkVariable();
    }

    // VariableTracker class for complex multi-variable observation
    class VariableTracker {
        constructor(variables, onReady) {
            this.variables = variables;
            this.onReady = onReady;
            this.triggered = false;
            this.processing = false;
            
            // Create tracker element
            this.tracker = document.createElement('div');
            this.tracker.style.display = 'none';
            document.body.appendChild(this.tracker);
            
            // Setup observer with debounce
            let timeout;
            this.observer = new MutationObserver(() => {
                clearTimeout(timeout);
                timeout = setTimeout(() => this.check(), 100);
            });
            
            // Start observing and checking
            this.observer.observe(this.tracker, { attributes: true });
            this.check();
            this.interval = setInterval(() => this.check(), 1000);
        }

        check() {
            if (this.processing || this.triggered) return;
            this.processing = true;

            try {
                const values = {};
                const allSet = this.variables.every(name => {
                    const val = window[name];
                    // Null signals completed unavailability; only missing values wait.
                    if (val === undefined || val === "n/a") return false;
                    values[name] = val;
                    return true;
                });

                if (allSet && !this.triggered) {
                    this.triggered = true;
                    this.cleanup();
                    this.onReady(values);
                }
            } catch (err) {
                console.error("Error during check:", err);
            }
            
            this.processing = false;
        }

        cleanup() {
            this.observer.disconnect();
            clearInterval(this.interval);
            this.tracker.remove();
        }
    }

    // Observe variables - simple for single variable, tracker for multiple
    function observeVariables(variables, timeout) {
        if (!variables || variables.length === 0) {
            return Promise.resolve({});
        }

        // Pre-clear watched vars to avoid stale immediate resolves
        variables.forEach((name) => {
            try { delete window[name]; } catch (e) { window[name] = undefined; }
        });

        if (variables.length === 1) {
            // Simple single variable observation with 30-second timeout
            return new Promise((resolve) => {
                observeDespiaVariable(variables[0], (value) => {
                    resolve({ [variables[0]]: value });
                }, 30000);
            });
        } else {
            // Multiple variables - use VariableTracker (no timeout, expires after 5 minutes)
            return new Promise((resolve) => {
                const tracker = new VariableTracker(variables, resolve);
                // Auto-cleanup after 5 minutes if not triggered
                setTimeout(() => {
                    if (!tracker.triggered) {
                        tracker.cleanup();
                        resolve({});
                    }
                }, 300000); // 5 minutes
            });
        }
    }
  
    // Main despia function
    function despiaFunction(command, watch = []) {
      // Clear stale responses and start watching before the native setter can reply.
      const response = watch && watch.length > 0 ? observeVariables(watch) : null;
      queueCommand(command);
      return response || Promise.resolve();
    }
  
    // Create proxy for window access
    const despia = new Proxy(despiaFunction, {
      get(target, prop) {
        if (prop in target || prop === 'then' || typeof prop === 'symbol') {
          return target[prop];
        }
        
        if (typeof window !== 'undefined' && prop in window) {
          return window[prop];
        }
        
        return undefined;
      },
      
      apply(target, thisArg, args) {
        return target(...args);
      }
    });
  
    return despia;
  }));
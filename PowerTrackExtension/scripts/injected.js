// PowerTrack Assistant - Injected Script
// Runs in page context to intercept JavaScript API calls

(function() {
  'use strict';

  console.log('PowerTrack Assistant: Injected script loaded');

  // Helper to check if URL is AlsoEnergy domain
  function isAlsoEnergyDomain(url) {
    try {
      const urlObj = new URL(url, window.location.href);
      const hostname = urlObj.hostname.toLowerCase();
      return hostname === 'alsoenergy.com' ||
             hostname.endsWith('.alsoenergy.com') ||
             hostname === 'apps.alsoenergy.com';
    } catch (e) {
      return false;
    }
  }

  // Intercept fetch calls
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const [url, options] = args;

    // Log API calls with detailed info - only for AlsoEnergy domains
    if (typeof url === 'string' && url.includes('/api/') && isAlsoEnergyDomain(url)) {
      const requestData = {
        url: url,
        method: options?.method || 'GET',
        timestamp: new Date().toISOString(),
        requestBody: null,
        headers: {}
      };

      // Capture request body if present
      if (options?.body) {
        try {
          requestData.requestBody = typeof options.body === 'string'
            ? JSON.parse(options.body)
            : options.body;
        } catch (e) {
          requestData.requestBody = options.body;
        }
      }

      // Capture headers
      if (options?.headers) {
        requestData.headers = options.headers;
      }

      // Add referer header (browser automatically adds this)
      requestData.headers['referer'] = window.location.href;

      // Call original fetch and capture response
      const fetchPromise = originalFetch.apply(this, args);

      fetchPromise.then(async (response) => {
        const clonedResponse = response.clone();
        let responseBody = null;

        try {
          const contentType = response.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            responseBody = await clonedResponse.json();
          } else {
            responseBody = await clonedResponse.text();
          }
        } catch (e) {
          responseBody = '[Could not parse response]';
        }

        window.postMessage({
          type: 'POWERTRACK_API_CALL_DETAILED',
          payload: {
            ...requestData,
            statusCode: response.status,
            statusText: response.statusText,
            responseBody: responseBody,
            responseHeaders: Object.fromEntries(response.headers.entries()),
            completedAt: new Date().toISOString()
          }
        }, '*');
      }).catch((error) => {
        window.postMessage({
          type: 'POWERTRACK_API_CALL_DETAILED',
          payload: {
            ...requestData,
            statusCode: 0,
            statusText: 'Network Error',
            error: error.message,
            completedAt: new Date().toISOString()
          }
        }, '*');
      });

      return fetchPromise;
    }

    return originalFetch.apply(this, args);
  };

  // Intercept XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    if (typeof url === 'string' && url.includes('/api/') && isAlsoEnergyDomain(url)) {
      this._ptUrl = url;
      this._ptMethod = method;
      this._ptTimestamp = new Date().toISOString();
    }
    return originalOpen.call(this, method, url, ...rest);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    if (this._ptUrl) {
      const requestBody = args[0];
      const self = this;

      // Capture response
      this.addEventListener('load', function() {
        let responseBody = null;
        try {
          responseBody = JSON.parse(this.responseText);
        } catch (e) {
          responseBody = this.responseText;
        }

        window.postMessage({
          type: 'POWERTRACK_API_CALL_DETAILED',
          payload: {
            url: self._ptUrl,
            method: self._ptMethod,
            timestamp: self._ptTimestamp,
            requestBody: requestBody ? (typeof requestBody === 'string' ? JSON.parse(requestBody) : requestBody) : null,
            headers: { referer: window.location.href },
            statusCode: this.status,
            statusText: this.statusText,
            responseBody: responseBody,
            completedAt: new Date().toISOString()
          }
        }, '*');
      });

      this.addEventListener('error', function() {
        window.postMessage({
          type: 'POWERTRACK_API_CALL_DETAILED',
          payload: {
            url: self._ptUrl,
            method: self._ptMethod,
            timestamp: self._ptTimestamp,
            requestBody: requestBody,
            headers: { referer: window.location.href },
            statusCode: 0,
            statusText: 'Network Error',
            error: 'Request failed',
            completedAt: new Date().toISOString()
          }
        }, '*');
      });
    }
    return originalSend.apply(this, args);
  };

  console.log('PowerTrack API interception active (AlsoEnergy domains only)');
})();

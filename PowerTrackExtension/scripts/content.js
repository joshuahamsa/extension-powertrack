// PowerTrack Assistant - Content Script
// Runs in the context of PowerTrack web pages

console.log('PowerTrack Assistant: Content script loaded');

async function safeSendMessage(message) {
  try {
    if (!chrome?.runtime?.sendMessage) return null;
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    // Happens during extension reload/uninstall: "Extension context invalidated."
    return null;
  }
}


function safeGetRuntimeURL(path) {
  try {
    return chrome?.runtime?.getURL ? chrome.runtime.getURL(path) : null;
  } catch (error) {
    return null;
  }
}

// Inject helper functions into page context
function injectPageScript() {
  const injectedUrl = safeGetRuntimeURL('scripts/injected.js');
  if (!injectedUrl) return;

  const script = document.createElement('script');
  script.src = injectedUrl;
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);
}

// Listen for messages from injected script
window.addEventListener('message', (event) => {
  // Only accept messages from same window
  if (event.source !== window) return;

  if (event.data.type === 'POWERTRACK_API_CALL_DETAILED') {
    // Forward detailed API call data to background script
    safeSendMessage({
      type: 'API_CALL_DETAILED',
      data: event.data.payload
    });
  }

  if (event.data.type === 'POWERTRACK_API_CALL') {
    // Legacy support for basic logging
    safeSendMessage({
      type: 'API_CALL_DETECTED',
      data: event.data.payload
    });
  }
});

// Add helper functions to window for console access
function createPowerTrackHelpers() {
  // Wait for page to load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installHelpers);
  } else {
    installHelpers();
  }
}

function installHelpers() {
  // Create namespace
  window.PowerTrackAPI = {
    version: '1.0.0',

    // Get current site ID from URL
    getCurrentSiteId: function() {
      const match = window.location.pathname.match(/\/site\/([^\/]+)/);
      return match ? match[1] : null;
    },

    // Get current hardware ID from URL
    getCurrentHardwareId: function() {
      const params = new URLSearchParams(window.location.search);
      return params.get('hardwareId') || params.get('key');
    },

    // Extract all site IDs from site selector
    getAllSiteIds: async function() {
      // This would need to be customized based on PowerTrack's actual DOM structure
      const siteElements = document.querySelectorAll('[data-site-id]');
      return Array.from(siteElements).map(el => el.getAttribute('data-site-id'));
    },

    // Make authenticated API call
    fetch: async function(endpoint, options = {}) {
      const auth = await safeSendMessage({ type: 'GET_AUTH' });
      if (!auth) {
        throw new Error('No authentication data available. Please visit PowerTrack to capture auth.');
      }

      const url = endpoint.startsWith('http') ? endpoint : `https://apps.alsoenergy.com${endpoint}`;

      const defaultOptions = {
        method: 'GET',
        headers: {
          'AE-S': auth.ae_s,
          'AE-V': auth.ae_v,
          'Referer': auth.referer,
          'Cookie': auth.cookie,
          'Content-Type': 'application/json'
        }
      };

      const mergedOptions = {
        ...defaultOptions,
        ...options,
        headers: {
          ...defaultOptions.headers,
          ...(options.headers || {})
        }
      };

      try {
        const response = await fetch(url, mergedOptions);
        if (!response.ok) {
          throw new Error(`API call failed: ${response.status} ${response.statusText}`);
        }
        return await response.json();
      } catch (error) {
        console.error('PowerTrack API Error:', error);
        throw error;
      }
    },

    // Quick site data fetch
    getSiteHardware: async function(siteId) {
      if (!siteId) {
        siteId = this.getCurrentSiteId();
      }
      if (!siteId) {
        throw new Error('Site ID required');
      }
      return await this.fetch(`/api/view/sitehardwareproduction/${siteId}`);
    },

    // Get modeling configuration
    getModeling: async function(siteId) {
      if (!siteId) {
        siteId = this.getCurrentSiteId();
      }
      if (!siteId) {
        throw new Error('Site ID required');
      }
      return await this.fetch(`/api/edit/modeling/${siteId}`);
    },

    // Get alert triggers
    getAlerts: async function(siteId) {
      if (!siteId) {
        siteId = this.getCurrentSiteId();
      }
      if (!siteId) {
        throw new Error('Site ID required');
      }
      return await this.fetch(`/api/alerttrigger/site/${siteId}`);
    },

    // Download data as JSON file
    downloadJSON: function(data, filename) {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'powertrack_data.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },

    // Batch export multiple sites
    exportSites: async function(siteIds, delay = 1000) {
      const results = {};
      for (const siteId of siteIds) {
        console.log(`Fetching ${siteId}...`);
        try {
          results[siteId] = {
            hardware: await this.getSiteHardware(siteId),
            modeling: await this.getModeling(siteId),
            alerts: await this.getAlerts(siteId)
          };
        } catch (error) {
          console.error(`Error fetching ${siteId}:`, error);
          results[siteId] = { error: error.message };
        }
        // Rate limiting
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      return results;
    },

    // Helper to get auth status
    getAuthStatus: async function() {
      return await safeSendMessage({ type: 'GET_AUTH' });
    },

    // View API call log
    getAPILog: async function() {
      return await safeSendMessage({ type: 'GET_API_LOG' });
    }
  };

  // Add to console for easy access
  console.log('PowerTrack API helpers installed!');
  console.log('Available commands:');
  console.log('  PowerTrackAPI.getCurrentSiteId()');
  console.log('  PowerTrackAPI.getSiteHardware(siteId)');
  console.log('  PowerTrackAPI.getModeling(siteId)');
  console.log('  PowerTrackAPI.getAlerts(siteId)');
  console.log('  PowerTrackAPI.exportSites([siteIds])');
  console.log('  PowerTrackAPI.downloadJSON(data, filename)');
}

// Inject scripts on load
injectPageScript();
createPowerTrackHelpers();

// Add context menu integration (right-click)
document.addEventListener('contextmenu', (event) => {
  const target = event.target;

  // Check if clicking on site ID or hardware ID
  const siteId = target.getAttribute('data-site-id') ||
                 target.closest('[data-site-id]')?.getAttribute('data-site-id');

  if (siteId) {
    chrome.storage.local.set({ contextSiteId: siteId });
  }
});

// Listen for commands from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_PAGE_INFO':
      sendResponse({
        url: window.location.href,
        siteId: PowerTrackAPI.getCurrentSiteId(),
        hardwareId: PowerTrackAPI.getCurrentHardwareId()
      });
      return true;
  }
});

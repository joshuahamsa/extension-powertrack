// PowerTrack Assistant - Background Service Worker
// Intercepts API calls and manages auth tokens
// JSZip is used only for bulk ZIP export. Keep service worker load resilient.
try {
  const jsZipUrl = (typeof chrome !== 'undefined' && chrome?.runtime?.getURL)
    ? chrome.runtime.getURL('scripts/jszip.min.js')
    : 'jszip.min.js';
  importScripts(jsZipUrl);
} catch (error) {
  console.error('Failed to load JSZip:', error);
}

const API_BASE = 'https://apps.alsoenergy.com';

// Storage safeguards (Chromium-based browsers have strict per-extension quotas)
const MAX_DETAILED_LOG_STORAGE_BYTES = 4 * 1024 * 1024; // Target under typical quotas
const MAX_BODY_CHARS = 100_000;

function truncateLargeValue(value, maxChars) {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    if (value.length <= maxChars) return value;
    return {
      _truncated: true,
      originalType: 'string',
      originalLength: value.length,
      preview: value.slice(0, maxChars)
    };
  }

  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      if (json.length <= maxChars) return value;
      return {
        _truncated: true,
        originalType: Array.isArray(value) ? 'array' : 'object',
        originalLength: json.length,
        preview: json.slice(0, maxChars)
      };
    } catch (error) {
      const str = String(value);
      if (str.length <= maxChars) return str;
      return {
        _truncated: true,
        originalType: 'unstringifiable',
        originalLength: str.length,
        preview: str.slice(0, maxChars)
      };
    }
  }

  return value;
}

function estimateDetailedLogBytes() {
  try {
    return JSON.stringify(detailedApiLog).length;
  } catch (error) {
    return Number.POSITIVE_INFINITY;
  }
}

function pruneDetailedLogsToFitQuota() {
  while (detailedApiLog.length > 0 && estimateDetailedLogBytes() > MAX_DETAILED_LOG_STORAGE_BYTES) {
    detailedApiLog.pop();
  }
}

// Helper functions for filename sanitization
function sanitizeForFilename(str) {
  return String(str).replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function sanitizeTimestamp(ts) {
  return ts.replace(/[:.]/g, '_');
}
const apiCallLog = [];
const detailedApiLog = []; // Detailed logs with request/response bodies
const MAX_LOG_SIZE = 100;
const MAX_DETAILED_LOG_SIZE = 500; // Keep more detailed logs for documentation

// Initialize logs from storage on startup
chrome.storage.local.get(['detailedApiLog'], (result) => {
  if (result.detailedApiLog && Array.isArray(result.detailedApiLog)) {
    detailedApiLog.push(...result.detailedApiLog);
    console.log(`Loaded ${detailedApiLog.length} API logs from storage`);
  }
});

// Helper to check if URL is AlsoEnergy domain
function isAlsoEnergyDomain(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    return hostname === 'alsoenergy.com' ||
           hostname.endsWith('.alsoenergy.com') ||
           hostname === 'apps.alsoenergy.com';
  } catch (e) {
    return false;
  }
}

// Store intercepted API calls
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.url.includes('/api/') && isAlsoEnergyDomain(details.url)) {
      const headers = {};
      details.requestHeaders.forEach(header => {
        headers[header.name] = header.value;
      });

      // Extract auth headers
      const authData = {
        timestamp: new Date().toISOString(),
        url: details.url,
        method: details.method,
        headers: {
          cookie: headers['Cookie'] || headers['cookie'],
          ae_s: headers['AE-S'] || headers['ae-s'],
          ae_v: headers['AE-V'] || headers['ae-v'],
          referer: headers['Referer'] || headers['referer']
        }
      };

      // Save to storage and log
      saveAuthData(authData);
      logApiCall(details, authData);
    }
  },
  { urls: ["https://apps.alsoenergy.com/api/*"] },
  ["requestHeaders"]
);

// Log API responses
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.url.includes('/api/') && isAlsoEnergyDomain(details.url)) {
      updateApiCallLog(details.requestId, {
        statusCode: details.statusCode,
        completedAt: new Date().toISOString()
      });
    }
  },
  { urls: ["https://apps.alsoenergy.com/api/*"] }
);

// Save authentication data
async function saveAuthData(authData) {
  if (!authData.headers.cookie || !authData.headers.ae_s) {
    return; // Incomplete auth data
  }

  const stored = await chrome.storage.local.get(['authData']);
  const existingAuth = stored.authData || {};

  // Only update if we have new/better data
  if (!existingAuth.cookie || authData.headers.cookie !== existingAuth.cookie) {
    const newAuthData = {
      cookie: authData.headers.cookie,
      ae_s: authData.headers.ae_s,
      ae_v: authData.headers.ae_v || '086665',
      referer: authData.headers.referer || API_BASE + '/',
      capturedAt: authData.timestamp,
      expiresWarning: new Date(Date.now() + 20 * 60 * 1000).toISOString() // 20 min warning
    };

    await chrome.storage.local.set({ authData: newAuthData });

    // Notify popup if open
    chrome.runtime.sendMessage({
      type: 'AUTH_UPDATED',
      data: newAuthData
    }).catch(() => {}); // Ignore if popup not open
  }
}

// Log API calls
function logApiCall(details, authData) {
  const apiCall = {
    id: details.requestId,
    timestamp: authData.timestamp,
    method: details.method,
    url: details.url,
    endpoint: details.url.replace(API_BASE, ''),
    statusCode: null, // Will be updated on completion
    completedAt: null
  };

  apiCallLog.unshift(apiCall);

  // Keep log size manageable
  if (apiCallLog.length > MAX_LOG_SIZE) {
    apiCallLog.pop();
  }

  // Save to storage
  chrome.storage.local.set({ apiCallLog: apiCallLog.slice(0, 50) });
}

// Update API call log with response data
function updateApiCallLog(requestId, responseData) {
  const call = apiCallLog.find(c => c.id === requestId);
  if (call) {
    Object.assign(call, responseData);
    chrome.storage.local.set({ apiCallLog: apiCallLog.slice(0, 50) });
  }
}

// Log detailed API call (with request/response bodies)
function logDetailedApiCall(data) {
  const detailedCall = {
    id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    timestamp: data.timestamp,
    completedAt: data.completedAt,
    method: data.method,
    url: data.url,
    endpoint: data.url.replace(API_BASE, ''),
    statusCode: data.statusCode,
    statusText: data.statusText,
    requestBody: truncateLargeValue(data.requestBody, MAX_BODY_CHARS),
    responseBody: truncateLargeValue(data.responseBody, MAX_BODY_CHARS),
    requestHeaders: data.headers,
    responseHeaders: data.responseHeaders,
    error: data.error
  };

  detailedApiLog.unshift(detailedCall);

  // Keep log size manageable
  if (detailedApiLog.length > MAX_DETAILED_LOG_SIZE) {
    detailedApiLog.pop();
  }

  // Save to persistent storage
  saveDetailedLogs();
}

// Save detailed logs to storage
function saveDetailedLogs(attempt = 0) {
  pruneDetailedLogsToFitQuota();

  chrome.storage.local.set({
    detailedApiLog: detailedApiLog,
    lastUpdated: new Date().toISOString()
  }, () => {
    const err = chrome.runtime.lastError;
    if (!err) return;

    const msg = err.message || '';
    console.warn('Failed to save detailed logs:', msg);

    if (attempt >= 5) return;

    if (msg.toLowerCase().includes('quota')) {
      // Drop the oldest 10% and retry.
      const dropCount = Math.max(1, Math.ceil(detailedApiLog.length * 0.1));
      detailedApiLog.splice(-dropCount, dropCount);
      saveDetailedLogs(attempt + 1);
    }
  });
}

// Listen for messages from popup/content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_AUTH':
      chrome.storage.local.get(['authData'], (result) => {
        sendResponse(result.authData || null);
      });
      return true; // Will respond asynchronously

    case 'GET_API_LOG':
      sendResponse(apiCallLog);
      return true;

     case 'GET_DETAILED_API_LOG':
       chrome.storage.local.get(['detailedApiLog'], (result) => {
         sendResponse(result.detailedApiLog || []);
       });
       return true;
 
     case 'API_CALL_DETAILED':
      logDetailedApiCall(message.data);
      sendResponse({ success: true });
      return true;

    case 'CLEAR_API_LOG':
      apiCallLog.length = 0;
      chrome.storage.local.set({ apiCallLog: [] });
      sendResponse({ success: true });
      return true;

    case 'CLEAR_DETAILED_LOG':
      detailedApiLog.length = 0;
      chrome.storage.local.set({ detailedApiLog: [] });
      sendResponse({ success: true });
      return true;

    case 'EXPORT_AUTH_ENV':
      chrome.storage.local.get(['authData'], (result) => {
        if (result.authData) {
          const envContent = generateEnvFile(result.authData);
          sendResponse({ success: true, content: envContent });
        } else {
          sendResponse({ success: false, error: 'No auth data available' });
        }
      });
      return true;

     case 'EXPORT_API_DOCS_JSON': {
       (async () => {
         if (typeof JSZip === 'undefined') {
           throw new Error('JSZip is not available (failed to load)');
         }

         const zip = new JSZip();
         const methodGroups = {};

         detailedApiLog.forEach((entry) => {
           const method = entry.method || 'UNKNOWN';
           if (!methodGroups[method]) methodGroups[method] = [];
           methodGroups[method].push(entry);
         });

         Object.keys(methodGroups).forEach((method) => {
           methodGroups[method].forEach((entry) => {
             const endpoint = sanitizeForFilename(entry.endpoint || 'unknown');
             const timestamp = sanitizeTimestamp(entry.timestamp || new Date().toISOString());
             const filename = `${method}-${endpoint}-${timestamp}.json`;
             const content = JSON.stringify(entry, null, 2);
             zip.file(`${method}/${filename}`, content);
           });
         });

         const arrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });
         const zipname = `powertrack_api_logs_${new Date().toISOString().split('T')[0]}.zip`;
         sendResponse({ success: true, arrayBuffer, filename: zipname });
       })().catch((error) => {
         sendResponse({ success: false, error: error.message });
       });

       return true;
     }

    case 'EXPORT_API_DOCS_MARKDOWN':
      sendResponse({
        success: true,
        content: generateMarkdownDocs(detailedApiLog)
      });
      return true;

    case 'GET_LOG_STATS': {
      const stats = getLogStats();
      sendResponse(stats);
      return true;
    }

    case 'UPDATE_REPO':
      updateRepo(message.config).then(result => sendResponse(result)).catch(error => sendResponse({ success: false, error: error.message }));
      return true;

     case 'FETCH_EXISTING_DOCS':
       fetchExistingDocs(message.config).then(result => sendResponse(result)).catch(error => sendResponse({ success: false, error: error.message }));
       return true;

     case 'EXPORT_SINGLE_LOG': {
       const entry = message.log;
       const method = entry?.method || 'UNKNOWN';
       const endpoint = sanitizeForFilename(entry?.endpoint || 'unknown');
       const timestamp = sanitizeTimestamp(entry?.timestamp || new Date().toISOString());
       const filename = `${method}-${endpoint}-${timestamp}.json`;
       const content = JSON.stringify(entry, null, 2);
       sendResponse({ success: true, content, filename });
       return true;
     }
   }
 });

// Generate .env file content
function generateEnvFile(authData) {
  return `# PowerTrack API Authentication
# Captured: ${authData.capturedAt}
# Expires: ~${authData.expiresWarning}

COOKIE="${authData.cookie}"
AE_S="${authData.ae_s}"
AE_V="${authData.ae_v}"
BASE_URL="${API_BASE}"
REFERER="${authData.referer}"
`;
}

// Generate Python auth dict
function generatePythonAuth(authData) {
  return `# PowerTrack API Authentication (Python)
# Captured: ${authData.capturedAt}

headers = {
    'AE-S': '${authData.ae_s}',
    'AE-V': '${authData.ae_v}',
    'Referer': '${authData.referer}',
    'Cookie': '${authData.cookie}'
}

# Example usage:
# import requests
# response = requests.get('${API_BASE}/api/view/sitehardwareproduction/S60308', headers=headers)
`;
}

// Generate markdown API documentation
function generateMarkdownDocs(logs) {
  if (!logs || logs.length === 0) {
    return '# PowerTrack API Documentation\n\nNo API calls logged yet.';
  }

  // Group by endpoint
  const endpointGroups = {};
  logs.forEach(log => {
    const endpoint = log.endpoint;
    if (!endpointGroups[endpoint]) {
      endpointGroups[endpoint] = [];
    }
    endpointGroups[endpoint].push(log);
  });

  let markdown = `# PowerTrack API Documentation

Generated: ${new Date().toISOString()}
Total API Calls Logged: ${logs.length}
Unique Endpoints: ${Object.keys(endpointGroups).length}

---

## Table of Contents

`;

  // Add TOC
  Object.keys(endpointGroups).sort().forEach((endpoint, idx) => {
    markdown += `${idx + 1}. [${endpoint}](#endpoint-${idx + 1})\n`;
  });

  markdown += '\n---\n\n';

  // Document each endpoint
  Object.entries(endpointGroups).sort().forEach(([endpoint, calls], idx) => {
    const exampleCall = calls[0]; // Use most recent call as example
    const methods = [...new Set(calls.map(c => c.method))];
    const statusCodes = [...new Set(calls.map(c => c.statusCode))];

    markdown += `## Endpoint ${idx + 1}\n\n`;
    markdown += `### \`${endpoint}\`\n\n`;
    markdown += `**Methods:** ${methods.join(', ')}  \n`;
    markdown += `**Status Codes:** ${statusCodes.join(', ')}  \n`;
    markdown += `**Call Count:** ${calls.length}  \n\n`;

    // Example request
    markdown += `#### Example Request\n\n`;
    markdown += `\`\`\`http\n`;
    markdown += `${exampleCall.method} ${endpoint} HTTP/1.1\n`;
    markdown += `Host: apps.alsoenergy.com\n`;
    if (exampleCall.requestHeaders) {
      Object.entries(exampleCall.requestHeaders).forEach(([key, value]) => {
        if (!key.toLowerCase().includes('cookie') && !key.toLowerCase().includes('ae-s')) {
          markdown += `${key}: ${value}\n`;
        }
      });
    }
    markdown += `\`\`\`\n\n`;

    // Request body (if present)
    if (exampleCall.requestBody) {
      markdown += `#### Request Body\n\n`;
      markdown += `\`\`\`json\n`;
      markdown += JSON.stringify(exampleCall.requestBody, null, 2);
      markdown += `\n\`\`\`\n\n`;
    }

    // Example response
    markdown += `#### Example Response\n\n`;
    markdown += `**Status:** ${exampleCall.statusCode} ${exampleCall.statusText}\n\n`;

    if (exampleCall.responseBody) {
      markdown += `\`\`\`json\n`;
      const responsePreview = typeof exampleCall.responseBody === 'string'
        ? exampleCall.responseBody.substring(0, 1000)
        : JSON.stringify(exampleCall.responseBody, null, 2).substring(0, 1000);
      markdown += responsePreview;
      if (JSON.stringify(exampleCall.responseBody).length > 1000) {
        markdown += '\n... (truncated)';
      }
      markdown += `\n\`\`\`\n\n`;
    }

    // Response schema (for arrays, show first item structure)
    if (Array.isArray(exampleCall.responseBody) && exampleCall.responseBody.length > 0) {
      markdown += `#### Response Schema (Array Item)\n\n`;
      markdown += `\`\`\`json\n`;
      markdown += JSON.stringify(exampleCall.responseBody[0], null, 2);
      markdown += `\n\`\`\`\n\n`;
    }

    markdown += `---\n\n`;
  });

  // Add appendix with all timestamps
  markdown += `## Appendix: Call Log\n\n`;
  markdown += `| Timestamp | Method | Endpoint | Status |\n`;
  markdown += `|-----------|--------|----------|--------|\n`;
  logs.slice(0, 50).forEach(log => {
    markdown += `| ${log.timestamp} | ${log.method} | ${log.endpoint} | ${log.statusCode} |\n`;
  });

  return markdown;
}

// Get log statistics
function getLogStats() {
  const stats = {
    totalCalls: detailedApiLog.length,
    uniqueEndpoints: new Set(detailedApiLog.map(l => l.endpoint)).size,
    methodBreakdown: {},
    statusBreakdown: {},
    endpointFrequency: {},
    oldestLog: detailedApiLog[detailedApiLog.length - 1]?.timestamp,
    newestLog: detailedApiLog[0]?.timestamp,
    storageSize: JSON.stringify(detailedApiLog).length
  };

  detailedApiLog.forEach(log => {
    // Method breakdown
    stats.methodBreakdown[log.method] = (stats.methodBreakdown[log.method] || 0) + 1;

    // Status breakdown
    const statusCategory = Math.floor(log.statusCode / 100) * 100;
    stats.statusBreakdown[statusCategory] = (stats.statusBreakdown[statusCategory] || 0) + 1;

    // Endpoint frequency
    stats.endpointFrequency[log.endpoint] = (stats.endpointFrequency[log.endpoint] || 0) + 1;
  });

  // Sort endpoint frequency
  stats.topEndpoints = Object.entries(stats.endpointFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([endpoint, count]) => ({ endpoint, count }));

  return stats;
}

// GitHub API Functions
async function fetchGitHubContents(path, config) {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${path}?ref=${config.branch}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `token ${config.pat}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (!response.ok) {
    if (response.status === 404) return null; // File/folder doesn't exist
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

// Parse existing .md content to extract sections
function parseExistingSections(content) {
  const sections = [];
  const lines = content.split('\n');
  let currentSection = null;
  for (const line of lines) {
    if (line.startsWith('## ') && !line.includes('Table of Contents') && !line.includes('Payload Structure') && !line.includes('Example')) {
      const sectionName = line.substring(3).trim();
      if (!sections.includes(sectionName)) {
        sections.push(sectionName);
      }
    }
  }
  return sections;
}

// Fetch and merge existing sections
async function mergeWithExisting(endpoint, method, newSections, config) {
  const filename = normalizeEndpointFilename(endpoint) + '.md';
  const path = method ? `docs/${method}/${filename}` : `docs/${filename}`;

  try {
    const existingFile = await fetchGitHubContents(path, config);
    if (existingFile && existingFile.content) {
      const existingContent = decodeURIComponent(escape(atob(existingFile.content)));
      const existingSections = parseExistingSections(existingContent);
      // Add existing sections not in newSections
      for (const section of existingSections) {
        if (!newSections.find(s => s.name === section)) {
          // For simplicity, we'll regenerate with all logs, so skip merging old sections without data
          // In future, could store section data
        }
      }
    }
  } catch (e) {
    // File doesn't exist, use newSections as is
  }
  return newSections;
}

async function pushFileToGitHub(path, filename, content, config, sha = null) {
  const url = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${path}`;
  const body = {
    message: `Adding ${filename} to docs`,
    content: btoa(unescape(encodeURIComponent(content))), // Base64 encode UTF-8
    branch: config.branch
  };

  if (!sha) {
    // Check if file exists and get SHA for update
    try {
      const existing = await fetchGitHubContents(path, config);
      if (existing && existing.sha) {
        sha = existing.sha;
      }
    } catch (e) {
      // File doesn't exist, proceed with create
    }
  }

  if (sha) {
    body.sha = sha; // For updates
  }

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${config.pat}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`GitHub API error for ${filename}: ${response.status} ${response.statusText}`, error);
    throw new Error(`Failed to push ${filename}: ${response.status} ${response.statusText} - ${error}`);
  }

  return await response.json();
}

// Normalize endpoint for filename
function normalizeEndpointFilename(endpoint) {
  const base = endpoint.split('?')[0]; // Strip query params
  // Apply ID replacements to normalize
  let normalized = base;
  const replacements = [
    [/\/H\d+/g, '/{hardware_id}'],
    [/\/S\d+/g, '/{site_id}'],
    [/\/C\d+/g, '/{customer_id}'],
    [/\/U\d+/g, '/{user_id}'],
    [/\/x[a-f0-9]+/gi, '/{alert_id}'],
    [/\/(\d{4,})/g, '/{id}']
  ];
  replacements.forEach(([pattern, replacement]) => {
    normalized = normalized.replace(pattern, replacement);
  });
  return normalized.replace('/api/', '').replace(/\//g, '_').replace(/\{/g, '').replace(/\}/g, '').replace(/\/$/, '');
}

// Hardware type map
const hardwareTypeMap = {
  1: "Inverter",
  2: "Production Meter",
  3: "Consumption Meter",
  4: "Site Meter",
  5: "Weather Station",
  6: "DC Combiner",
  9: "Kiosk",
  10: "Gateway",
  11: "Data Capture",
  14: "Camera",
  20: "Extra Meter",
  21: "DNP3 Server",
  24: "Tracker",
  25: "BESS Controller",
  28: "Data Logger",
  31: "Cell Modem",
  34: "Relay",
  37: "BESS Meter"
};

// Analyze schema (simplified)
function analyzeSchema(obj) {
  if (typeof obj === 'object' && obj !== null) {
    if (Array.isArray(obj)) {
      return obj.length > 0 ? analyzeSchema(obj[0]) : { type: 'array', items: { type: 'unknown' } };
    }
    const properties = {};
    for (const [key, value] of Object.entries(obj)) {
      properties[key] = analyzeSchema(value);
    }
    return { type: 'object', properties };
  }
  return { type: typeof obj };
}

// Merge schemas
function mergeSchemas(schemas) {
  if (!schemas || schemas.length === 0) {
    return { type: 'unknown' };
  }
  if (schemas.every(s => s.type === 'object')) {
    const allProps = new Set();
    schemas.forEach(schema => {
      Object.keys(schema.properties || {}).forEach(prop => allProps.add(prop));
    });
    const commonProps = {};
    for (const prop of allProps) {
      const propSchemas = schemas.map(s => s.properties && s.properties[prop]).filter(Boolean);
      if (propSchemas.length === schemas.length) {
        commonProps[prop] = mergeSchemas(propSchemas);
      }
    }
    return { type: 'object', properties: commonProps };
  } else if (schemas.every(s => s.type === 'array')) {
    const itemSchemas = schemas.map(s => s.items || { type: 'unknown' });
    return { type: 'array', items: mergeSchemas(itemSchemas) };
  } else {
    const types = schemas.map(s => s.type || 'unknown');
    const typeCount = {};
    types.forEach(type => typeCount[type] = (typeCount[type] || 0) + 1);
    const mostCommon = Object.entries(typeCount).sort((a, b) => b[1] - a[1])[0][0];
    return { type: mostCommon };
  }
}

// Generate .md content
function generateMDContent(endpoint, method, logs) {
  if (!Array.isArray(logs) || logs.length === 0) {
    console.error('Invalid logs:', logs);
    return `<a id="top"></a>\n# ${endpoint}\n\n[← Back to Index](../logs.md)\n\n**Error:** No valid logs provided.\n\n[Return to top](#top)\n\n`;
  }
  const cleanEndpoint = endpoint.split('?')[0];
  // Normalize endpoint for title
  let normalizedEndpoint = cleanEndpoint;
  const replacements = [
    [/\/H\d+/g, '/{hardware_id}'],
    [/\/S\d+/g, '/{site_id}'],
    [/\/C\d+/g, '/{customer_id}'],
    [/\/U\d+/g, '/{user_id}'],
    [/\/x[a-f0-9]+/gi, '/{alert_id}'],
    [/\/(\d{4,})/g, '/{id}']
  ];
  replacements.forEach(([pattern, replacement]) => {
    normalizedEndpoint = normalizedEndpoint.replace(pattern, replacement);
  });
  let content = `<a id="top"></a>\n# ${normalizedEndpoint}\n\n`;
  content += `[← Back to Index](../logs.md)\n\n`;
  content += `**Methods:** ${method}  \n`;
  content += `**Status Codes:** ${logs.map(l => l.statusCode).join(', ')}  \n\n`;

  // Determine grouping key
  let groupKey = null;
  if (cleanEndpoint.includes('/hardware/') || cleanEndpoint.includes('/edit/hardware')) {
    groupKey = 'functionCode';
  } else if (cleanEndpoint.includes('/alert')) {
    groupKey = 'alertTypeKey';
  }

  // Group logs by type if applicable
  let sections = [];
  if (groupKey) {
    const typeGroups = {};
    logs.forEach(log => {
      if (log.responseBody && log.responseBody[groupKey] !== undefined) {
        const type = log.responseBody[groupKey];
        if (!typeGroups[type]) typeGroups[type] = [];
        typeGroups[type].push(log);
      } else {
        // No type, put in 'General'
        if (!typeGroups['General']) typeGroups['General'] = [];
        typeGroups['General'].push(log);
      }
    });

    for (const [type, groupLogs] of Object.entries(typeGroups)) {
      const responses = groupLogs.map(l => l.responseBody).filter(Boolean);
      const requests = groupLogs.map(l => l.requestBody).filter(Boolean);
      let sectionName = type;
      if (groupKey === 'functionCode' && hardwareTypeMap[type]) {
        sectionName = `${hardwareTypeMap[type]} (functionCode: ${type})`;
      } else if (groupKey === 'alertTypeKey') {
        sectionName = `Alert Type: ${type}`;
      }
      sections.push({ name: sectionName, responses, requests, logs: groupLogs });
    }
  } else {
    // No grouping
    const responses = logs.map(l => l.responseBody).filter(Boolean);
    const requests = logs.map(l => l.requestBody).filter(Boolean);
    sections.push({ name: 'General', responses, requests, logs });
  }

  // Table of Contents
  content += `## Table of Contents\n\n`;
  if (['PUT', 'POST', 'PATCH'].includes(method) && sections.some(s => s.requests.length > 0)) {
    content += `- [Payload Structure](#payload-structure)\n`;
  }
  sections.forEach(section => {
    content += `- [${section.name}](#${section.name.toLowerCase().replace(/ /g, '-').replace(/[^a-z0-9-]/g, '')})\n`;
  });
  content += `- [Example](#example)\n\n`;

  // Payload structure (common)
  if (['PUT', 'POST', 'PATCH'].includes(method) && sections.some(s => s.requests.length > 0)) {
    const allRequests = sections.flatMap(s => s.requests);
    const requestSchemas = allRequests.map(analyzeSchema);
    const mergedRequestSchema = mergeSchemas(requestSchemas);
    content += `## Payload Structure\n\n\`\`\`json\n${JSON.stringify(mergedRequestSchema, null, 2)}\n\`\`\`\n\n`;
    content += `[Return to top](#top)\n\n`;
  }

  // Response sections
  sections.forEach(section => {
    if (section.responses.length > 0) {
      const responseSchemas = section.responses.map(analyzeSchema);
      const mergedResponseSchema = mergeSchemas(responseSchemas);
      content += `## ${section.name}\n\n\`\`\`json\n${JSON.stringify(mergedResponseSchema, null, 2)}\n\`\`\`\n\n`;
      content += `[Return to top](#top)\n\n`;
    }
  });

  // Example (use first log)
  const exampleLog = logs[0];
  content += `## Example\n\n**Request:**\n\n\`\`\`http\n${method} ${exampleLog.url}\n`;
  if (exampleLog.requestHeaders) {
    Object.entries(exampleLog.requestHeaders).forEach(([k, v]) => {
      if (!k.toLowerCase().includes('cookie') && !k.toLowerCase().includes('authorization')) {
        content += `${k}: ${v}\n`;
      }
    });
  }
  content += `\`\`\`\n\n`;

  if (exampleLog.requestBody) {
    content += `**Payload:**\n\n\`\`\`json\n${JSON.stringify(exampleLog.requestBody, null, 2)}\n\`\`\`\n\n`;
  }

  if (exampleLog.responseBody) {
    content += `**Response:**\n\n\`\`\`json\n${JSON.stringify(exampleLog.responseBody, null, 2)}\n\`\`\`\n\n`;
  }

  content += `[Return to top](#top)\n\n`;

  return content;
}

// Push with retry for rate limit handling
async function pushWithRetry(path, filename, content, config, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await pushFileToGitHub(path, filename, content, config);
    } catch (error) {
      if (i === retries || !isRetryable(error)) {
        throw error;
      }
      const delay = Math.pow(2, i) * 1000; // Exponential backoff: 1s, 2s, 4s
      console.log(`Retrying ${filename} in ${delay}ms due to ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

function isRetryable(error) {
  const msg = error.message.toLowerCase();
  return msg.includes('403') || msg.includes('422') || msg.includes('rate limit') || msg.includes('too many requests');
}

// Fetch existing docs
async function fetchExistingDocs(config) {
  try {
    const methods = ['GET', 'PUT', 'POST', 'PATCH', 'DELETE'];
    const docs = [];
    for (const method of methods) {
      try {
        const contents = await fetchGitHubContents(`docs/${method}`, config);
        if (contents && Array.isArray(contents)) {
          contents.forEach(item => {
            if (item.type === 'file' && item.name.endsWith('.md')) {
              // Parse filename back to endpoint
              const filename = item.name.replace('.md', '');
              // Reverse normalization (approximate)
              let endpoint = filename.replace(/_/g, '/');
              endpoint = endpoint.replace(/hardwareid/g, '{hardware_id}').replace(/siteid/g, '{site_id}').replace(/customerid/g, '{customer_id}').replace(/userid/g, '{user_id}').replace(/alertid/g, '{alert_id}');
              // Add /api/ prefix
              endpoint = `/api/${endpoint}`;
              docs.push({ method, endpoint, filename: item.name });
            }
          });
        }
      } catch (e) {
        // Folder may not exist
      }
    }
    return { success: true, docs };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Update repo function
async function updateRepo(config) {
  console.log('updateRepo called with config:', config);
  try {
    // Load logs
    const logs = [...detailedApiLog];
    console.log(`Loaded ${logs.length} logs from storage`);
    if (logs.length === 0) {
      return { success: false, error: 'No API logs available' };
    }

    // Group by endpoint+method
    const groups = {};
    logs.forEach(log => {
      const key = `${log.endpoint}|${log.method}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(log);
    });
    console.log('Groups keys:', Object.keys(groups));

    // Generate and push files with retry and delay
    for (const [key, groupLogs] of Object.entries(groups)) {
      console.log(`Processing ${key}, logs count: ${groupLogs.length}`);
      const [endpoint, method] = key.split('|');
      const filename = normalizeEndpointFilename(endpoint) + '.md';

      // Check if endpoint needs special handling
      const isHardware = endpoint.includes('/hardware/') || endpoint.includes('/edit/hardware');
      const isAlert = endpoint.includes('/alert');

      if (isHardware || isAlert) {
        // Create separate files by type
        const typeKey = isHardware ? 'functionCode' : 'alertTypeKey';
        const typeMap = isHardware ? hardwareTypeMap : {};

        const typeGroups = {};
        groupLogs.forEach(log => {
          if (log.responseBody && log.responseBody[typeKey] !== undefined) {
            const type = log.responseBody[typeKey];
            if (!typeGroups[type]) typeGroups[type] = [];
            typeGroups[type].push(log);
          } else {
            if (!typeGroups['Unknown']) typeGroups['Unknown'] = [];
            typeGroups['Unknown'].push(log);
          }
        });

        for (const [type, typeLogs] of Object.entries(typeGroups)) {
          let typeName;
          if (isHardware) {
            typeName = typeMap[type] || `Unknown_${type}`;
          } else {
            // For alerts, append the name from the response
            const alertName = typeLogs[0]?.responseBody?.name || 'Unknown';
            typeName = `${type} ${alertName}`;
          }
          const folder = isHardware ? 'Hardware' : 'Alerts';
          const methodFilename = `${method}_${filename.replace('.md', '')}.md`;
          const path = `docs/${folder}/${typeName}/${methodFilename}`;

          console.log(`Pushing to ${path}`);
          const content = generateMDContent(endpoint, method, typeLogs);
          await pushWithRetry(path, methodFilename, content, config);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } else {
        // Skip if exists
        const path = `${method}/${filename}`;
        try {
          await fetchGitHubContents(`docs/${path}`, config);
          console.log(`Skipping existing docs/${path}`);
        } catch (e) {
          const path = `docs/${method}/${filename}`;
          console.log(`Pushing to ${path}`);
          const content = generateMDContent(endpoint, method, groupLogs);
          await pushWithRetry(path, filename, content, config);
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }

    return { success: true, message: `Updated ${Object.keys(groups).length} endpoints` };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function updateReadmeTOC(config, newCount) {
  // Simple TOC update - fetch current logs.md, append new entries
  let logsContent = '';
  try {
    const logs = await fetchGitHubContents('docs/logs.md', config);
    if (logs && logs.content) {
      logsContent = decodeURIComponent(escape(atob(logs.content)));
    }
  } catch (e) {
    // No logs.md, create basic one
  }

  if (!logsContent.includes('Adding')) {
    logsContent += `\n\nLast updated: ${new Date().toISOString()} - Added ${newCount} new endpoints\n`;
  }

  console.log('Pushing to docs/logs.md');
  await pushWithRetry('docs/logs.md', 'logs.md', logsContent, config);
}

// Install/update handler
chrome.runtime.onInstalled.addListener(() => {
  console.log('PowerTrack Assistant installed');
});

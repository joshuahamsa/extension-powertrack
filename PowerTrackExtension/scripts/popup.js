const siteConfig = typeof SITE_CONFIG !== 'undefined' ? SITE_CONFIG : {};
const appName = siteConfig.siteName || 'PowerTrack Assistant';
document.title = appName;

async function loadAPILog() {
  const log = await chrome.runtime.sendMessage({ type: 'GET_DETAILED_API_LOG' });
  const container = document.getElementById('api-log');

  if (!log || log.length === 0) {
    container.innerHTML = '<div class="empty-state">No API calls logged yet. Browse to capture API calls.</div>';
    return;
  }

  const logData = log.slice(0, 50);
  container.innerHTML = logData.map((call, index) => `
    <div class="log-entry">
      <div class="log-header">
        <span class="method ${call.method}">${call.method}</span>
        <span class="endpoint" title="${call.url}">${call.endpoint}</span>
        <span class="status ${call.statusCode < 400 ? 'success' : 'error'}">${call.statusCode || '...'}</span>
        <button class="btn export-single" data-index="${index}">Export</button>
      </div>
      <div class="log-time">${formatTimestamp(call.timestamp)}</div>
      ${call.requestBody ? '<div class="log-detail">Has request body</div>' : ''}
      ${call.responseBody ? '<div class="log-detail">Has response data</div>' : ''}
    </div>
  `).join('');

  document.querySelectorAll('.export-single').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const index = parseInt(e.target.dataset.index, 10);
      const selectedLog = logData[index];
      try {
        const result = await chrome.runtime.sendMessage({ type: 'EXPORT_SINGLE_LOG', log: selectedLog });
        if (result.success) {
          downloadFile(result.content, result.filename, 'application/json');
          showStatus('Single log exported', 'success');
        } else {
          showStatus('Export failed', 'error');
        }
      } catch (error) {
        console.error('Export error:', error);
        showStatus('Export error', 'error');
      }
    });
  });

  if (log.length > 50) {
    container.innerHTML += `<div class="info-message">Showing 50 of ${log.length} calls</div>`;
  }
}

async function loadGithubConfig() {
  try {
    const stored = await chrome.storage.local.get('githubConfig');
    if (!stored.githubConfig) return;
    const { pat, owner, repo, branch } = stored.githubConfig;
    if (pat) document.getElementById('github-pat').value = pat;
    if (owner) document.getElementById('github-owner').value = owner;
    if (repo) document.getElementById('github-repo').value = repo;
    if (branch) document.getElementById('github-branch').value = branch;
  } catch (error) {
    console.warn('Failed to load GitHub config:', error);
  }
}

async function loadLogStats() {
  const stats = await chrome.runtime.sendMessage({ type: 'GET_LOG_STATS' });
  const statsBox = document.getElementById('log-stats');

  if (!stats || stats.totalCalls === 0) {
    statsBox.style.display = 'none';
    return;
  }

  document.getElementById('stat-total').textContent = stats.totalCalls;
  document.getElementById('stat-endpoints').textContent = stats.uniqueEndpoints;
  document.getElementById('stat-size').textContent = Math.round(stats.storageSize / 1024) + ' KB';

  if (stats.oldestLog && stats.newestLog) {
    const oldest = new Date(stats.oldestLog);
    const newest = new Date(stats.newestLog);
    document.getElementById('stat-range').textContent =
      `${oldest.toLocaleDateString()} - ${newest.toLocaleDateString()}`;
  }

  statsBox.style.display = 'block';
}

document.getElementById('view-stats').addEventListener('click', async () => {
  await loadLogStats();
  showStatus('Statistics loaded', 'success');
});

document.getElementById('clear-log').addEventListener('click', async () => {
  if (confirm('Clear all API logs? This cannot be undone.')) {
    await chrome.runtime.sendMessage({ type: 'CLEAR_DETAILED_LOG' });
    await chrome.runtime.sendMessage({ type: 'CLEAR_API_LOG' });
    loadAPILog();
    document.getElementById('log-stats').style.display = 'none';
    showStatus('All logs cleared', 'success');
  }
});

document.getElementById('export-json').addEventListener('click', async () => {
  showStatus('Generating ZIP archive...', 'info');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'EXPORT_API_DOCS_JSON' });
    if (result && result.success) {
      const blob = new Blob([result.arrayBuffer], { type: 'application/zip' });
      downloadFile(blob, result.filename, 'application/zip');
      showStatus('API logs exported as ZIP', 'success');
    } else {
      showStatus(result?.error || 'ZIP export failed', 'error');
    }
  } catch (error) {
    console.error('ZIP export error:', error);
    showStatus('ZIP export error', 'error');
  }
});

document.getElementById('export-markdown').addEventListener('click', async () => {
  showStatus('Generating documentation...', 'info');
  const result = await chrome.runtime.sendMessage({ type: 'EXPORT_API_DOCS_MARKDOWN' });
  if (result.success) {
    const timestamp = new Date().toISOString().split('T')[0];
    const prefix = (siteConfig.shortName || siteConfig.siteName || 'api').toLowerCase().replace(/\s+/g, '_');
    downloadFile(result.content, `${prefix}_api_docs_${timestamp}.md`, 'text/markdown');
    showStatus('API documentation exported', 'success');
  }
});

document.getElementById('show-github-config').addEventListener('click', () => {
  const config = document.getElementById('github-config');
  config.style.display = config.style.display === 'none' ? 'block' : 'none';
});

document.getElementById('save-github-config').addEventListener('click', async () => {
  const pat = document.getElementById('github-pat').value.trim();
  const owner = document.getElementById('github-owner').value.trim();
  const repo = document.getElementById('github-repo').value.trim();
  const branch = document.getElementById('github-branch').value.trim();

  if (!pat || !owner || !repo) {
    showStatus('Fill in all GitHub config fields', 'error');
    return;
  }

  await chrome.storage.local.set({
    githubConfig: { pat, owner, repo, branch }
  });

  showStatus('GitHub config saved', 'success');
  document.getElementById('github-config').style.display = 'none';
});

document.getElementById('update-repo').addEventListener('click', async () => {
  try {
    const config = await chrome.storage.local.get('githubConfig');
    if (!config.githubConfig) {
      showStatus('Configure GitHub settings first', 'error');
      document.getElementById('github-config').style.display = 'block';
      return;
    }

    showStatus('Updating repo...', 'info');
    const result = await chrome.runtime.sendMessage({
      type: 'UPDATE_REPO',
      config: config.githubConfig
    });

    if (result.success) {
      showStatus(`Repo updated: ${result.message}`, 'success');
    } else {
      showStatus(`Update failed: ${result.error}`, 'error');
    }
  } catch (error) {
    console.error('Error in update-repo click:', error);
    showStatus(`Error: ${error.message}`, 'error');
  }
});

document.getElementById('fetch-existing-docs').addEventListener('click', async () => {
  try {
    const config = await chrome.storage.local.get('githubConfig');
    if (!config.githubConfig) {
      showStatus('Configure GitHub settings first', 'error');
      document.getElementById('github-config').style.display = 'block';
      return;
    }

    showStatus('Fetching existing docs...', 'info');
    const result = await chrome.runtime.sendMessage({
      type: 'FETCH_EXISTING_DOCS',
      config: config.githubConfig
    });

    if (result.success) {
      displayExistingDocs(result.docs);
      showStatus('Existing docs fetched', 'success');
    } else {
      showStatus(`Fetch failed: ${result.error}`, 'error');
    }
  } catch (error) {
    console.error('Error in fetch-existing-docs click:', error);
    showStatus(`Error: ${error.message}`, 'error');
  }
});

function displayExistingDocs(docs) {
  const container = document.getElementById('api-log');
  let html = '<div class="info-message">Existing Documented Endpoints:</div>';
  html += '<ul>';
  docs.forEach(doc => {
    html += `<li>${doc.method}: ${doc.endpoint}</li>`;
  });
  html += '</ul>';
  container.innerHTML = html;
}

function formatTimestamp(iso) {
  if (!iso) return 'N/A';
  const date = new Date(iso);
  return date.toLocaleString();
}

function showStatus(message, type = 'info') {
  const statusEl = document.getElementById('status-message');
  statusEl.textContent = message;
  statusEl.className = `status-${type}`;
  setTimeout(() => {
    statusEl.textContent = '';
    statusEl.className = '';
  }, 3000);
}

function downloadFile(content, filename, mimeType) {
  let blob;
  if (content instanceof Blob) {
    blob = content;
  } else {
    blob = new Blob([content], { type: mimeType });
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

loadAPILog();
loadGithubConfig();

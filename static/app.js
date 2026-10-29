/**
 * Bookstore Operations & Inventory Hub Frontend Controller.
 * Powers Single & Bulk Book Entry (Workflows A & B), Intelligent Search,
 * POS Selling, Unassigned Books Management, and Google Sheets Live Sync.
 */

// Global State
let currentTab = 'tabSearch';
let batchBooksA = [];
let batchCandidatesB = [];
let batchImageHashes = [];
let activeSaleCopy = null;
let searchDebounceTimer = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  const safeInit = (fnName, fn) => {
    try { fn(); } catch (err) { console.error(`Initialization notice in ${fnName}:`, err); }
  };

  safeInit('initTabs', initTabs);
  safeInit('initExportDropdown', initExportDropdown);
  safeInit('initStats', initStats);
  safeInit('initSearch', initSearch);
  safeInit('initCart', initCart);
  safeInit('initGenreTab', initGenreTab);
  safeInit('initAdvisorTab', initAdvisorTab);
  safeInit('initSingleAdd', initSingleAdd);
  safeInit('initBatchA', initBatchA);
  safeInit('initBatchB', initBatchB);
  safeInit('initPOS', initPOS);
  safeInit('initUnassigned', initUnassigned);
  safeInit('initHistoryAndSync', initHistoryAndSync);
  safeInit('initCancelSaleReturnModal', initCancelSaleReturnModal);
  safeInit('initEditSalePaymentModal', initEditSalePaymentModal);
  safeInit('initLiveCamera', initLiveCamera);

  // Initial load
  fetchStats();
  fetchUnassigned();
  fetchSalesAndAudit();
});

/* =========================================================================
   1. TABS & STATS CONTROLLER
   ========================================================================= */

function initTabs() {
  const tabButtons = document.querySelectorAll('.main-tabs .tab-btn');
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const tabId = btn.getAttribute('data-tab');
      document.getElementById(tabId).classList.add('active');
      currentTab = tabId;

      if (tabId === 'tabCart') renderCartTab();
      if (tabId === 'tabGenre') loadGenreTab();
      if (tabId === 'tabAdvisor') {
        const inp = document.getElementById('advisorQuestionInput');
        if (inp) inp.focus();
      }
      if (tabId === 'tabUnassigned') fetchUnassigned();
      if (tabId === 'tabHistory') fetchSalesAndAudit();
      if (tabId === 'tabSearch') {
        const sinp = document.getElementById('searchInput');
        if (sinp) sinp.focus();
      }
    });
  });

  // Clicking unassigned stats card switches directly to unassigned tab
  const cardUnassigned = document.getElementById('cardUnassigned');
  if (cardUnassigned) {
    cardUnassigned.addEventListener('click', () => {
      const tab = document.querySelector('.tab-btn[data-tab="tabUnassigned"]');
      if (tab) tab.click();
    });
  }
}

function safeSet(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

async function fetchStats() {
  clearSearchCache();
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    if (data.stats) {
      safeSet('statTotalCopies', data.stats.total_copies.toLocaleString());
      safeSet('statUniqueTitles', data.stats.unique_titles.toLocaleString());
      safeSet('statAvailable', data.stats.available_copies.toLocaleString());
      safeSet('statSold', data.stats.sold_copies.toLocaleString());
      safeSet('statUnassigned', data.stats.unassigned_count.toLocaleString());
      safeSet('tabUnassignedBadge', data.stats.unassigned_count);
      safeSet('unassignedCountLabel', data.stats.unassigned_count);
      safeSet('statSalesCount', data.stats.total_sales_count);
      safeSet('statRevenue', `₹${data.stats.total_revenue.toFixed(2)}`);
    }
    if (data.sync) {
      safeSet('pendingSyncCount', data.sync.pending_count);
      safeSet('syncPendingCount', data.sync.pending_count);
      safeSet('syncCompletedCount', data.sync.synced_count);
      safeSet('syncLastTime', data.sync.last_synced_at ? new Date(data.sync.last_synced_at).toLocaleTimeString() : 'Just now');
    }
  } catch (err) {
    console.error('Failed to fetch stats:', err);
  }
}

function initExportDropdown() {
  const btn = document.getElementById('btnExportMenu');
  const menu = document.getElementById('exportDropdownMenu');
  if (!btn || !menu) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = menu.style.display !== 'none';
    menu.style.display = isOpen ? 'none' : 'flex';
    btn.setAttribute('aria-expanded', !isOpen);
  });

  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && e.target !== btn) {
      menu.style.display = 'none';
      btn.setAttribute('aria-expanded', 'false');
    }
  });
}

function initStats() {
  // Poll stats every 15 seconds
  setInterval(fetchStats, 15000);
}

/* =========================================================================
   2. INTELLIGENT SEARCH CONTROLLER (Req 2)
   ========================================================================= */

let currentSearchType = 'all';

/**
 * Downscales an image to a maximum dimension to ensure fast mobile processing,
 * minimal network payload, and high local/cloud OCR performance.
 */
async function downscaleImage(fileOrDataUrl, maxDim = 1200, quality = 0.85) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let width = img.width;
      let height = img.height;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => {
      if (typeof fileOrDataUrl === 'string') resolve(fileOrDataUrl);
      else {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(fileOrDataUrl);
      }
    };
    if (typeof fileOrDataUrl === 'string') {
      img.src = fileOrDataUrl;
    } else {
      const reader = new FileReader();
      reader.onload = () => { img.src = reader.result; };
      reader.readAsDataURL(fileOrDataUrl);
    }
  });
}

function initSearch() {
  const input = document.getElementById('searchInput');
  const clearBtn = document.getElementById('btnClearSearch');
  const modePills = document.querySelectorAll('.search-mode-pill');

  // Search mode pill selection (All, Title, Author)
  modePills.forEach(pill => {
    pill.addEventListener('click', () => {
      modePills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentSearchType = pill.getAttribute('data-type') || 'all';

      if (currentSearchType === 'author') {
        input.placeholder = "Type or speak author's name (e.g. Tony Robbins, Scott Young)...";
      } else if (currentSearchType === 'title') {
        input.placeholder = "Type or speak book title (e.g. Awaken the Giant Within)...";
      } else {
        input.placeholder = "Search or speak title, author, or Book ID (e.g. BK-10151)...";
      }

      if (input.value.trim()) {
        performSearch(input.value);
      }
      input.focus();
    });
  });

  input.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    clearBtn.style.display = input.value ? 'inline-block' : 'none';
    searchDebounceTimer = setTimeout(() => {
      performSearch(input.value);
    }, 100);
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.style.display = 'none';
    performSearch('');
  });

  // Photo search via camera snap
  const cameraSearchSnapInput = document.getElementById('cameraSearchSnapInput');
  if (cameraSearchSnapInput) {
    cameraSearchSnapInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await processCoverSearchImage(file, file.name);
      cameraSearchSnapInput.value = '';
    });
  }

  // Photo search via image file upload
  const cameraSearchFileInput = document.getElementById('cameraSearchFileInput');
  if (cameraSearchFileInput) {
    cameraSearchFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await processCoverSearchImage(file, file.name);
      cameraSearchFileInput.value = '';
    });
  }

  // Voice Search / Microphone integration (Web Speech API)
  setupVoiceSearch();
}

function setupVoiceSearch() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btnVoice = document.getElementById('btnVoiceSearch');
  const btnVoiceAction = document.getElementById('btnVoiceSearchAction');
  const input = document.getElementById('searchInput');
  const clearBtn = document.getElementById('btnClearSearch');
  const statusNotice = document.getElementById('voiceSearchStatusNotice');
  const statusText = document.getElementById('voiceSearchStatusText');

  if (!SpeechRecognition) {
    const handleUnsupported = () => {
      alert("🎙️ Voice search is not supported by this browser. For voice input, please open this app in Google Chrome or Apple Safari.");
    };
    if (btnVoice) btnVoice.addEventListener('click', handleUnsupported);
    if (btnVoiceAction) btnVoiceAction.addEventListener('click', handleUnsupported);
    return;
  }

  let recognition = null;
  let isListening = false;

  try {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
  } catch (err) {
    console.warn('SpeechRecognition init notice:', err);
  }

  function setListeningState(listening) {
    isListening = listening;
    if (btnVoice) {
      if (listening) btnVoice.classList.add('listening');
      else btnVoice.classList.remove('listening');
    }
    if (btnVoiceAction) {
      if (listening) {
        btnVoiceAction.classList.add('btn-danger');
        btnVoiceAction.classList.remove('btn-secondary');
        btnVoiceAction.innerHTML = '🛑 Stop Listening';
      } else {
        btnVoiceAction.classList.remove('btn-danger');
        btnVoiceAction.classList.add('btn-secondary');
        btnVoiceAction.innerHTML = '🎙️ Speak to Search';
      }
    }
    if (statusNotice) {
      statusNotice.style.display = listening ? 'inline-flex' : 'none';
    }
  }

  if (!recognition) return;

  recognition.onstart = () => {
    setListeningState(true);
    if (statusText) statusText.textContent = 'Listening... Speak book title or author now';
  };

  recognition.onresult = (event) => {
    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }

    const spokenText = (finalTranscript || interimTranscript).trim();
    if (spokenText) {
      input.value = spokenText;
      if (clearBtn) clearBtn.style.display = 'inline-block';
      if (statusText) statusText.textContent = `Heard: "${spokenText}"`;
      performSearch(spokenText);
    }
  };

  recognition.onerror = (event) => {
    console.warn('Speech recognition notice:', event.error);
    setListeningState(false);
    if (event.error === 'not-allowed') {
      alert('Microphone access was blocked. Please enable microphone permissions in your browser or device settings to speak and search.');
    }
  };

  recognition.onend = () => {
    setListeningState(false);
  };

  const toggleVoiceSearch = () => {
    if (isListening) {
      try { recognition.stop(); } catch (e) {}
      setListeningState(false);
    } else {
      try {
        recognition.start();
      } catch (e) {
        console.warn('Could not start recognition:', e);
      }
    }
  };

  if (btnVoice) btnVoice.addEventListener('click', toggleVoiceSearch);
  if (btnVoiceAction) btnVoiceAction.addEventListener('click', toggleVoiceSearch);
}

async function processCoverSearchImage(fileOrB64, fallbackName = 'cover.jpg') {
  const input = document.getElementById('searchInput');
  const clearBtn = document.getElementById('btnClearSearch');

  input.value = '📸 Optimizing photo...';
  try {
    let base64Data = fileOrB64;
    if (typeof fileOrB64 !== 'string') {
      base64Data = await downscaleImage(fileOrB64, 1200, 0.85);
    }

    let clientOcrText = '';
    if (window.Tesseract) {
      input.value = '🔍 Reading cover / spine...';
      try {
        const tRes = await Tesseract.recognize(base64Data, 'eng');
        clientOcrText = (tRes.data?.text || '').trim();
      } catch (tErr) {
        console.warn('Local OCR warning:', tErr);
      }
    }

    input.value = '📚 Matching inventory...';
    const ocrRes = await fetch('/api/books/ocr-extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw_text: clientOcrText || fallbackName.replace(/\.[^/.]+$/, "").replace(/[_\-]/g, " "),
        image_data: base64Data
      })
    });

    const cand = await ocrRes.json();
    if (cand && cand.title && cand.title.trim()) {
      input.value = cand.title.trim();
      if (clearBtn) clearBtn.style.display = 'inline-block';
      performSearch(input.value);
    } else if (clientOcrText) {
      const lines = clientOcrText.split('\n')
        .map(l => l.replace(/[^a-zA-Z0-9\s\-\':]/g, '').trim())
        .filter(l => l.length >= 3 && !/^(bestseller|edition|novel|published|isbn|\d+$)/i.test(l));
      const bestGuess = lines.length ? lines.sort((a, b) => b.length - a.length)[0] : clientOcrText.slice(0, 40);
      input.value = bestGuess;
      if (clearBtn) clearBtn.style.display = 'inline-block';
      performSearch(bestGuess);
    } else {
      input.value = '';
      alert('Could not detect clear text on this cover or spine. Please hold camera closer or enter the title manually.');
    }
  } catch (err) {
    input.value = '';
    alert('Photo analysis note: ' + err.message);
  }
}

function setSearch(query, searchType = 'all') {
  const input = document.getElementById('searchInput');
  input.value = query;
  currentSearchType = searchType;

  // Sync mode pill UI
  const modePills = document.querySelectorAll('.search-mode-pill');
  modePills.forEach(p => {
    if (p.getAttribute('data-type') === searchType) {
      p.classList.add('active');
    } else {
      p.classList.remove('active');
    }
  });

  document.getElementById('btnClearSearch').style.display = 'inline-block';
  document.querySelector('.tab-btn[data-tab="tabSearch"]').click();
  performSearch(query);
}

let searchSeqCounter = 0;
let searchAbortController = null;
const clientSearchCache = new Map();

function clearSearchCache() {
  clientSearchCache.clear();
}

async function performSearch(query) {
  const container = document.getElementById('searchResultsContainer');
  const cleanQ = (query || '').trim();
  if (!cleanQ) {
    if (searchAbortController) {
      searchAbortController.abort();
      searchAbortController = null;
    }
    const hint = currentSearchType === 'author' 
      ? "Enter an author's name above to see all their books." 
      : (currentSearchType === 'title' 
          ? "Enter a book title above." 
          : "Enter a book title, author, niche genre, or Inventory ID above.");
    container.innerHTML = `<div class="empty-state-card">${hint}</div>`;
    return;
  }

  const cacheKey = `${currentSearchType}:${cleanQ.toLowerCase()}`;
  if (clientSearchCache.has(cacheKey)) {
    renderSearchResults(clientSearchCache.get(cacheKey));
    return;
  }

  // Cancel any existing in-flight search request to eliminate race conditions
  if (searchAbortController) {
    searchAbortController.abort();
  }
  searchAbortController = new AbortController();
  const currentSeq = ++searchSeqCounter;

  // Only display full loading state if results aren't currently shown
  if (!container.querySelector('.book-card')) {
    container.innerHTML = '<div class="photo-meta">⚡ Searching live inventory records...</div>';
  }

  try {
    const res = await fetch(
      `/api/search?q=${encodeURIComponent(cleanQ)}&type=${encodeURIComponent(currentSearchType)}`,
      { signal: searchAbortController.signal }
    );
    const data = await res.json();
    if (currentSeq !== searchSeqCounter) return;

    // Cache the result for immediate lookup if user types/backspaces
    clientSearchCache.set(cacheKey, data);
    if (clientSearchCache.size > 100) {
      const firstKey = clientSearchCache.keys().next().value;
      clientSearchCache.delete(firstKey);
    }

    renderSearchResults(data);
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (currentSeq !== searchSeqCounter) return;
    container.innerHTML = `<div class="alert alert-danger">Error searching inventory: ${err.message}</div>`;
  }
}

function renderSearchResults(data) {
  window.currentSearchResultsData = data;
  const container = document.getElementById('searchResultsContainer');
  container.innerHTML = '';

  const { exact_matches, query, search_type } = data;

  if (!exact_matches || exact_matches.length === 0) {
    const typeLabel = search_type === 'author' ? 'author' : (search_type === 'title' ? 'title' : 'books');
    container.innerHTML = `
      <div class="empty-prompt">
        <div class="prompt-icon">🔍</div>
        <h3>No ${typeLabel} found matching "${escapeHtml(query)}"</h3>
        <p>Check spelling or add this book to inventory.</p>
        <button class="btn btn-primary" style="margin-top:0.75rem;" onclick="switchToAddWithTitle('${escapeHtml(query)}')">➕ Add to Inventory</button>
      </div>
    `;
    return;
  }

  // Count total physical copies across all matching titles
  let totalCopiesCount = 0;
  exact_matches.forEach(m => {
    totalCopiesCount += (m.copies && m.copies.length > 0) ? m.copies.length : 1;
  });

  let badgeText = 'EXACT MATCH';
  const shownText = (data.total_exact_count && data.total_exact_count > exact_matches.length)
    ? `${totalCopiesCount} shown of ${data.total_exact_count} total`
    : `${totalCopiesCount}`;
  let categoryTitle = `Matching Books (${shownText})`;
  if (search_type === 'author') {
    badgeText = 'AUTHOR MATCH';
    categoryTitle = `✍️ Books by Author "${escapeHtml(query)}" (${shownText})`;
  } else if (search_type === 'title') {
    badgeText = 'TITLE MATCH';
    categoryTitle = `📖 Books Matching Title "${escapeHtml(query)}" (${shownText})`;
  }

  // Exact Matches Only - each physical copy rendered as an independent tile via DocumentFragment for batch DOM injection
  const block = document.createElement('div');
  block.className = 'results-category-block';
  block.innerHTML = `
    <div class="category-header exact-header">
      <span class="badge badge-success">${badgeText}</span>
      <h3 class="category-title">${categoryTitle}</h3>
    </div>
  `;
  const fragment = document.createDocumentFragment();
  exact_matches.forEach(item => {
    fragment.appendChild(createBookCard(item, 'exact'));
  });
  block.appendChild(fragment);
  container.appendChild(block);
  resolveLazyCovers();
}

function getGenreGradient(genre) {
  const g = (genre || '').toLowerCase();
  if (g.includes('fic') || g.includes('novel') || g.includes('lit') || g.includes('stor')) return 'linear-gradient(135deg, #7c3aed, #4f46e5)';
  if (g.includes('sci') || g.includes('tech') || g.includes('comp') || g.includes('math')) return 'linear-gradient(135deg, #0d9488, #0891b2)';
  if (g.includes('hist') || g.includes('bio') || g.includes('memoir') || g.includes('polit')) return 'linear-gradient(135deg, #d97706, #b45309)';
  if (g.includes('mys') || g.includes('thrill') || g.includes('crime') || g.includes('dark')) return 'linear-gradient(135deg, #334155, #1e293b)';
  if (g.includes('child') || g.includes('ya') || g.includes('comic') || g.includes('manga')) return 'linear-gradient(135deg, #db2777, #e11d48)';
  if (g.includes('self') || g.includes('spirit') || g.includes('phil') || g.includes('health') || g.includes('yoga')) return 'linear-gradient(135deg, #059669, #047857)';
  return 'linear-gradient(135deg, #2563eb, #1d4ed8)';
}

const coverCache = new Map();
let lazyCoverObserver = null;

function getBookCoverHtml(title, author, genre, imageUrl) {
  const safeTitle = escapeHtml(title || 'Book');
  const safeAuthor = escapeHtml(author || '');
  const safeGenre = escapeHtml(genre || '');
  const bg = getGenreGradient(genre);

  const effectiveUrl = imageUrl || coverCache.get(safeTitle.toLowerCase());

  if (effectiveUrl) {
    return `
      <div class="book-cover-container" title="${safeTitle} by ${safeAuthor}">
        <img src="${escapeHtml(effectiveUrl)}" alt="${safeTitle}" class="book-cover-img" loading="lazy"
             onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';" />
        <div class="book-cover-placeholder" style="display:none; background:${bg};">
          <span class="placeholder-icon">📖</span>
          <span class="placeholder-genre">${safeGenre || 'Book'}</span>
        </div>
      </div>
    `;
  }

  return `
    <div class="book-cover-container" data-lazy-title="${safeTitle}" data-lazy-author="${safeAuthor}" title="${safeTitle} by ${safeAuthor}">
      <div class="book-cover-placeholder" style="background:${bg};">
        <span class="placeholder-icon">📖</span>
        <span class="placeholder-genre">${safeGenre || 'Book'}</span>
      </div>
    </div>
  `;
}

function resolveLazyCovers() {
  if (!('IntersectionObserver' in window)) return;
  if (!lazyCoverObserver) {
    lazyCoverObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const container = entry.target;
        lazyCoverObserver.unobserve(container);

        if (container.getAttribute('data-resolving') || container.getAttribute('data-resolved')) return;
        const title = container.getAttribute('data-lazy-title');
        const author = container.getAttribute('data-lazy-author') || '';
        if (!title) return;

        if (coverCache.has(title.toLowerCase())) {
          applyCoverToContainer(container, coverCache.get(title.toLowerCase()), title);
          return;
        }

        container.setAttribute('data-resolving', 'true');
        fetch(`/api/books/cover?title=${encodeURIComponent(title)}&author=${encodeURIComponent(author)}`)
          .then(res => res.json())
          .then(data => {
            if (data && data.cover_url) {
              coverCache.set(title.toLowerCase(), data.cover_url);
              applyCoverToContainer(container, data.cover_url, title);
            } else {
              container.removeAttribute('data-resolving');
              container.setAttribute('data-resolved', 'true');
            }
          })
          .catch(() => {
            container.removeAttribute('data-resolving');
          });
      });
    }, { rootMargin: '100px 0px' });
  }

  document.querySelectorAll('.book-cover-container[data-lazy-title]:not([data-resolved]):not([data-resolving])').forEach(el => {
    lazyCoverObserver.observe(el);
  });
}

function applyCoverToContainer(container, coverUrl, title) {
  container.removeAttribute('data-resolving');
  container.setAttribute('data-resolved', 'true');
  if (coverUrl) {
    const existingImg = container.querySelector('.book-cover-img');
    if (existingImg) existingImg.remove();

    const img = document.createElement('img');
    img.src = coverUrl;
    img.alt = title;
    img.className = 'book-cover-img';
    img.loading = 'lazy';
    img.onerror = () => {
      img.remove();
      const ph = container.querySelector('.book-cover-placeholder');
      if (ph) ph.style.display = 'flex';
    };
    const placeholder = container.querySelector('.book-cover-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    container.insertBefore(img, container.firstChild);
  }
}

function cleanBookTitle(title) {
  if (!title) return '';
  let t = title;
  t = t.replace(/,\s*copy\s*\d+(\s*of\s*\d+)?\s*(?=\))/gi, '');
  t = t.replace(/\s*\(\s*copy\s*\d+(\s*of\s*\d+)?\s*\)/gi, '');
  t = t.replace(/\s*[-–—]\s*copy\s*\d+(\s*of\s*\d+)?\s*$/gi, '');
  t = t.replace(/\s+copy\s+\d+(\s*of\s*\d+)?\s*$/gi, '');
  return t.trim();
}

function getBookState(book, copy) {
  const status = ((copy && copy.status) || (book && book.status) || '').toUpperCase();
  if (status === 'SOLD' || status === 'SOLD OUT') {
    return 'SOLD';
  }
  const rackRaw = (copy && copy.rack !== undefined && copy.rack !== null) ? copy.rack : ((book && book.rack !== undefined && book.rack !== null) ? book.rack : '');
  const rack = String(rackRaw).trim();
  const loc = String((copy && copy.location_english) || (book && book.location_english) || '').toLowerCase();
  if (!rack || rack === '' || rack.toLowerCase().includes('unassigned') || loc.includes('unassigned') || loc === '') {
    return 'UNASSIGNED';
  }
  return 'ASSIGNED';
}

/**
 * Formats a user-friendly location string preview from rack, col, and pos.
 */
function formatLocationPreviewText(rack, col, pos) {
  const r = (rack !== null && rack !== undefined) ? rack.toString().trim() : '';
  const c = (col !== null && col !== undefined) ? col.toString().trim() : '';
  const p = (pos !== null && pos !== undefined) ? pos.toString().trim() : '';
  if (!r || !c || !p) {
    return 'Location Unassigned';
  }
  let posText = p;
  if (p === '1') posText = 'On top of the rack';
  else if (p === '2') posText = '2nd book from top';
  else if (p === '3') posText = '3rd book from top';
  else if (!isNaN(p)) {
    const n = parseInt(p, 10);
    let sfx = 'th';
    if (n % 100 < 11 || n % 100 > 13) {
      if (n % 10 === 1) sfx = 'st';
      else if (n % 10 === 2) sfx = 'nd';
      else if (n % 10 === 3) sfx = 'rd';
    }
    posText = `${n}${sfx} book from top`;
  }
  return `Rack ${r} → Column ${c} → ${posText}`;
}

function formatLocationPill(state, locationText, sellingPrice, copy = null) {
  let locStr = (copy && copy.location_english) ? copy.location_english : (locationText || '');
  if (!locStr && copy && (copy.rack || copy.column_num)) {
    locStr = formatLocationString(copy.rack, copy.column_num, copy.position);
  }

  if (state === 'SOLD') {
    const priceText = (sellingPrice !== null && sellingPrice !== undefined && sellingPrice !== '') 
      ? ` &bull; Paid: ₹${sellingPrice}` 
      : '';
    return `
      <div class="wayfinder-hud hud-sold" title="This copy has been sold and removed from inventory">
        <span class="hud-status-icon">❌</span>
        <div class="hud-marker">
          <span class="hud-label">STATUS</span>
          <span class="hud-val">SOLD OUT${priceText} &bull; Off Shelf</span>
        </div>
        ${locStr ? `<span class="hud-subval">(Was ${escapeHtml(locStr.replace(/->/g, '→'))})</span>` : ''}
      </div>
    `;
  }

  if (!locStr || state === 'UNASSIGNED' || locStr.toLowerCase() === 'unassigned') {
    return `
      <div class="wayfinder-hud hud-unassigned" title="Needs shelf assignment">
        <span class="hud-status-icon">📍</span>
        <div class="hud-marker">
          <span class="hud-label">SHELF STATUS</span>
          <span class="hud-val">Location Unassigned</span>
        </div>
      </div>
    `;
  }

  const formattedLoc = locStr.replace(/->/g, '→');
  return `
    <div class="wayfinder-hud" title="Physical shelf location">
      <span class="hud-status-icon">📍</span>
      <span class="hud-val" style="font-size:0.95rem; font-weight:700; color:#064e3b; letter-spacing:-0.01em;">${escapeHtml(formattedLoc)}</span>
    </div>
  `;
}

/**
 * Creates a single, independent tile for one physical book copy.
 * Each copy gets its own separate card with editable fields and Sell button.
 * When in edit mode, the Sell button is completely hidden.
 */
function createBookTile(book, copy, matchType) {
  const card = document.createElement('div');
  card.className = 'book-card-item';

  function renderView() {
    const state = getBookState(book, copy);
    let cardClass = 'book-card-item';
    if (state === 'SOLD') cardClass += ' card-is-sold';
    else if (state === 'UNASSIGNED') cardClass += ' card-is-unassigned';
    else cardClass += ' card-is-assigned';
    card.className = cardClass;

    const cleanTitle = cleanBookTitle(copy.title || book.title || '');
    const cleanAuthor = escapeHtml(copy.author || book.author || 'Author');
    const genre = copy.simple_genre || book.simple_genre || copy.genre || book.genre || '';
    const coverHtml = getBookCoverHtml(cleanTitle, copy.author || book.author, genre, copy.image_url || book.image_url);
    const locationText = copy.location_english || book.location_english || (copy.shelf_location ? `Shelf ${copy.shelf_location}` : '');
    const bookId = copy.book_id || book.book_id || '';
    const language = copy.language || book.language || 'English';
    const sellingPrice = (copy.selling_price !== null && copy.selling_price !== undefined && copy.selling_price !== '') ? copy.selling_price : (book.selling_price || '');

    card.innerHTML = `
      <div class="book-card-main">
        <div class="book-card-header-left">
          <div class="book-cover-3d-wrap">
            ${coverHtml}
          </div>
          <div class="book-info">
            <h3 class="book-title">${escapeHtml(cleanTitle)}</h3>
            <div class="book-author">
              <span class="author-prefix">by</span>
              <b>${cleanAuthor}</b>
            </div>
            <div class="book-location-hero">
              ${formatLocationPill(state, locationText, sellingPrice, copy)}
            </div>
            <div class="book-meta-line">
              ${state === 'UNASSIGNED' ? '<span class="state-chip state-unassigned"><span class="chip-dot"></span> UNASSIGNED</span>' : ''}
              <span class="chip book-lang-chip">🌐 ${escapeHtml(language)}</span>
              ${genre ? `<span class="chip simple-genre-chip">${escapeHtml(genre)}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="book-card-actions">
          ${state === 'SOLD' ? `
            <button class="btn btn-sm btn-undo-purchase" data-bid="${escapeHtml(bookId)}" style="background:#fef2f2; color:#dc2626; border:1px solid #fecaca; font-weight:700; border-radius:10px; padding:0.4rem 0.75rem; display:inline-flex; align-items:center; gap:0.35rem; cursor:pointer; height:32px; transition:all 0.15s ease;" title="Undo purchase and return this book to shelf">
              <span>↩️</span> Undo Purchase
            </button>
            <button class="btn btn-sm btn-edit-payment-copy" data-bid="${escapeHtml(bookId)}" style="background:#eff6ff; color:#2563eb; border:1px solid #bfdbfe; font-weight:700; border-radius:10px; padding:0.4rem 0.75rem; display:inline-flex; align-items:center; gap:0.35rem; cursor:pointer; height:32px; transition:all 0.15s ease;" title="Change payment received for this sale (e.g. correct ₹200 to ₹300)">
              <span>💳</span> Edit Payment
            </button>
          ` : `
            <button class="btn btn-sm btn-toggle-cart ${isBookInCart(bookId) ? 'active' : ''}" data-bid="${escapeHtml(bookId)}" style="background:${isBookInCart(bookId) ? '#059669' : '#ffffff'}; color:${isBookInCart(bookId) ? '#ffffff' : '#047857'}; border:1px solid ${isBookInCart(bookId) ? '#059669' : '#10b981'}; font-weight:700; border-radius:10px; padding:0.4rem 0.85rem; display:inline-flex; align-items:center; gap:0.4rem; cursor:pointer; height:32px; box-shadow:0 1px 2px rgba(0,0,0,0.05); transition:all 0.15s ease;" title="${isBookInCart(bookId) ? 'Remove from cart' : 'Add to cart'}">
              <span>${isBookInCart(bookId) ? '✓ In Cart' : '🛒 Add to Cart'}</span>
            </button>
          `}
          <button class="btn btn-sm btn-edit-tile" title="Edit book details">
            ✏️ Edit
          </button>
          <div class="delete-trigger-container">
            <button class="btn-subtle-delete" title="Permanently delete this copy">
              🗑️ Delete
            </button>
          </div>
        </div>
      </div>
      <div class="book-card-expanded-area">
        <div class="expanded-meta-grid">
          <div class="expanded-meta-item">
            <span class="meta-label">Language</span>
            <span class="meta-value">🌐 ${escapeHtml(language)}</span>
          </div>
          <div class="expanded-meta-item">
            <span class="meta-label">Genre</span>
            <span class="meta-value">${escapeHtml(genre || 'General')}</span>
          </div>
          <div class="expanded-meta-item">
            <span class="meta-label">Availability</span>
            <span class="meta-value">${state === 'ASSIGNED' ? '✅ Ready on Shelf' : (state === 'SOLD' ? `❌ Sold${sellingPrice ? ` (₹${sellingPrice})` : ''}` : '⚠️ Unassigned')}</span>
          </div>
        </div>
        <div class="expanded-summary-placeholder">
          <span style="font-size:1.15rem;">📖</span>
          <span>Book overview & synopsis slot &bull; <i style="opacity:0.8;">(Summary held for future update)</i></span>
        </div>
      </div>
    `;

    // Hook up Edit button
    const btnEdit = card.querySelector('.btn-edit-tile');
    if (btnEdit) {
      btnEdit.addEventListener('click', (e) => {
        e.stopPropagation();
        renderEdit();
      });
    }

    // Hook up Undo Purchase button (visible on SOLD books)
    const btnUndo = card.querySelector('.btn-undo-purchase');
    if (btnUndo) {
      btnUndo.addEventListener('click', async (e) => {
        e.stopPropagation();
        const confirmMsg = `Are you sure you want to undo the purchase for "${cleanTitle}"?\n\nThis will restore the book to its shelf position (${locationText || 'its recorded location'}) and make it available in inventory again.`;
        if (!confirm(confirmMsg)) return;

        btnUndo.disabled = true;
        btnUndo.innerHTML = `<span>⏳</span> Undoing...`;

        try {
          const res = await fetch('/api/books/revert-sale', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              book_id: bookId,
              position_mode: 'previous',
              user: 'Staff',
              notes: 'Undo purchase from UI'
            })
          });

          const data = await res.json();
          if (res.ok && data.success) {
            // Update in-memory copy & group
            copy.status = 'Available';
            copy.selling_price = null;
            if (book && book.copies) {
              const matched = book.copies.find(c => c.book_id === bookId);
              if (matched) {
                matched.status = 'Available';
                matched.selling_price = null;
              }
            } else if (book && (book.book_id === bookId)) {
              book.status = 'Available';
              book.selling_price = null;
            }

            clearSearchCache();
            fetchStats();

            // If search results data is currently cached in window, update it
            if (window.currentSearchResultsData && Array.isArray(window.currentSearchResultsData.exact_matches)) {
              window.currentSearchResultsData.exact_matches.forEach(g => {
                if (g.book_id === bookId) {
                  g.status = 'Available';
                  g.selling_price = null;
                }
                if (g.copies && Array.isArray(g.copies)) {
                  g.copies.forEach(c => {
                    if (c.book_id === bookId) {
                      c.status = 'Available';
                      c.selling_price = null;
                    }
                  });
                }
              });
            }

            // Also refresh genre view if active
            if (typeof loadGenreBooks === 'function') {
              loadGenreBooks();
            }

            renderView();

            const locNotice = (data.book && data.book.location_english) ? `\nLocation: ${data.book.location_english}` : '';
            alert(`✅ Purchase Undone!\n\n"${cleanTitle}" is now back in inventory as Available.${locNotice}`);
          } else {
            alert('Cannot undo purchase: ' + (data.error || 'Server error'));
            btnUndo.disabled = false;
            btnUndo.innerHTML = `<span>↩️</span> Undo Purchase`;
          }
        } catch (err) {
          alert('Network error while undoing purchase: ' + err.message);
          btnUndo.disabled = false;
          btnUndo.innerHTML = `<span>↩️</span> Undo Purchase`;
        }
      });
    }

    // Hook up Edit Payment button & Clickable Paid badge (for SOLD books)
    const btnEditPay = card.querySelector('.btn-edit-payment-copy');
    if (btnEditPay) {
      btnEditPay.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditSalePaymentModal(copy, book, renderView);
      });
    }
    const chipPaid = card.querySelector('.btn-edit-paid-chip');
    if (chipPaid) {
      chipPaid.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditSalePaymentModal(copy, book, renderView);
      });
    }

    // Hook up Add/Remove from Cart button
    const btnToggleCart = card.querySelector('.btn-toggle-cart');
    if (btnToggleCart) {
      btnToggleCart.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCartBook({
          book_id: bookId,
          title: cleanTitle,
          author: copy.author || book.author || '',
          location_english: locationText || 'Location Unassigned',
          genre: genre,
          image_url: copy.image_url || book.image_url || ''
        });
      });
    }

    // Hook up safe two-step Delete button (guarded against accidental clicks)
    function wireDeleteTrigger() {
      const delContainer = card.querySelector('.delete-trigger-container');
      if (!delContainer) return;
      const btnDel = delContainer.querySelector('.btn-subtle-delete');
      if (!btnDel) return;

      btnDel.addEventListener('click', (e) => {
        e.stopPropagation();
        delContainer.innerHTML = `
          <div class="delete-confirm-wrap">
            <button class="btn-really-delete" title="Click to confirm deletion">⚠️ Really Delete?</button>
            <button class="btn-abort-delete" title="Cancel">✖</button>
          </div>
        `;

        const autoRevertTimer = setTimeout(() => {
          delContainer.innerHTML = `<button class="btn-subtle-delete" title="Permanently delete this copy">🗑️ Delete</button>`;
          wireDeleteTrigger();
        }, 6000);

        delContainer.querySelector('.btn-abort-delete').addEventListener('click', (ev) => {
          ev.stopPropagation();
          clearTimeout(autoRevertTimer);
          delContainer.innerHTML = `<button class="btn-subtle-delete" title="Permanently delete this copy">🗑️ Delete</button>`;
          wireDeleteTrigger();
        });

        delContainer.querySelector('.btn-really-delete').addEventListener('click', async (ev) => {
          ev.stopPropagation();
          clearTimeout(autoRevertTimer);
          const confirmed = confirm(`⚠️ PERMANENT DELETION\n\nAre you sure you want to permanently delete "${cleanTitle}" (${bookId}) from inventory?\n\nThis will remove it completely from the database.`);
          if (!confirmed) {
            delContainer.innerHTML = `<button class="btn-subtle-delete" title="Permanently delete this copy">🗑️ Delete</button>`;
            wireDeleteTrigger();
            return;
          }

          try {
            const res = await fetch('/api/books/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ book_id: bookId })
            });
            const data = await res.json();
            if (data.success || !data.error) {
              card.style.transition = 'all 0.3s ease';
              card.style.opacity = '0';
              card.style.transform = 'scale(0.95)';
              setTimeout(() => {
                card.remove();
                fetchStats();
              }, 300);
            } else {
              alert('Failed to delete book: ' + (data.error || 'Unknown error'));
              delContainer.innerHTML = `<button class="btn-subtle-delete" title="Permanently delete this copy">🗑️ Delete</button>`;
              wireDeleteTrigger();
            }
          } catch (err) {
            alert('Network error while deleting: ' + err.message);
            delContainer.innerHTML = `<button class="btn-subtle-delete" title="Permanently delete this copy">🗑️ Delete</button>`;
            wireDeleteTrigger();
          }
        });
      });
    }

    wireDeleteTrigger();
  }

  function renderEdit() {
    const bookId = copy.book_id || book.book_id || '';
    const curTitle = copy.title || book.title || '';
    const curAuthor = copy.author || book.author || '';
    const curLang = copy.language || book.language || 'English';
    const curRack = copy.rack !== null && copy.rack !== undefined ? copy.rack : '';
    const curCol = copy.column_num !== null && copy.column_num !== undefined ? copy.column_num : '';
    const curPos = copy.position !== null && copy.position !== undefined ? copy.position : '';
    const curPrice = copy.selling_price !== null && copy.selling_price !== undefined ? copy.selling_price : (book.selling_price || '');
    const initialPreview = formatLocationPreviewText(curRack, curCol, curPos);

    card.innerHTML = `
      <div class="book-card-main edit-active-card">
        <div class="book-card-header-left" style="width:100%;">
          <div class="book-edit-form-wrap" style="width:100%; display:flex; flex-direction:column; gap:0.5rem;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.15rem;">
              <span class="copy-id-box" style="font-weight:700;">✏️ Edit Book Details</span>
              ${state === 'SOLD' ? `
                <span class="state-chip state-sold" style="padding:0.18rem 0.6rem; font-size:0.72rem;">SOLD COPY</span>
              ` : `
                <span style="font-size:0.75rem; color:var(--text-muted); font-style:italic;">(Sell option hidden during edit)</span>
              `}
            </div>

            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:0.5rem;">
              <div>
                <label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem; color:var(--text-muted);">Book's Title</label>
                <input type="text" class="form-control form-control-sm inp-edit-title" value="${escapeHtml(curTitle)}" placeholder="Book title..." style="width:100%; padding:0.4rem 0.6rem; font-size:0.88rem; font-weight:600;">
              </div>
              <div>
                <label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem; color:var(--text-muted);">Author's Name</label>
                <input type="text" class="form-control form-control-sm inp-edit-author" value="${escapeHtml(curAuthor)}" placeholder="Author name..." style="width:100%; padding:0.4rem 0.6rem; font-size:0.88rem;">
              </div>
            </div>

            <div style="display:flex; gap:0.5rem; flex-wrap:wrap; align-items:flex-end;">
              <div style="flex:1; min-width:110px;">
                <label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem; color:var(--text-muted);">Language</label>
                <input type="text" class="form-control form-control-sm inp-edit-lang" value="${escapeHtml(curLang)}" placeholder="Language" style="width:100%; padding:0.4rem 0.6rem; font-size:0.85rem;">
              </div>
              <div style="width:100px;">
                <label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem; color:var(--text-muted);">Rack</label>
                <input type="text" class="form-control form-control-sm inp-edit-rack" value="${escapeHtml(curRack.toString())}" placeholder="e.g. 36" style="width:100%; padding:0.4rem 0.6rem; font-size:0.85rem;">
              </div>
              <div style="width:75px;">
                <label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem; color:var(--text-muted);">Column</label>
                <input type="text" class="form-control form-control-sm inp-edit-col" value="${escapeHtml(curCol.toString())}" placeholder="e.g. 4" style="width:100%; padding:0.4rem 0.6rem; font-size:0.85rem;">
              </div>
              <div style="width:75px;">
                <label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem; color:var(--text-muted);">Position</label>
                <input type="text" class="form-control form-control-sm inp-edit-pos" value="${escapeHtml(curPos.toString())}" placeholder="e.g. 8" style="width:100%; padding:0.4rem 0.6rem; font-size:0.85rem;">
              </div>
            </div>

            <div class="edit-loc-preview-badge" style="margin-top:0.15rem;">
              <span>📍</span> <span class="lbl-loc-preview" style="font-weight:600;">${escapeHtml(initialPreview)}</span>
            </div>

            <!-- Payment & Repayment Section -->
            <div class="edit-payment-container" style="margin-top:0.35rem; padding:0.75rem 0.95rem; background:${state === 'SOLD' ? '#fff1f2' : '#f8fafc'}; border:1.5px solid ${state === 'SOLD' ? '#fecdd3' : '#e2e8f0'}; border-radius:12px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.4rem;">
                <span style="font-size:0.82rem; font-weight:700; color:${state === 'SOLD' ? '#be123c' : '#334155'}; display:inline-flex; align-items:center; gap:0.35rem;">
                  <span>💳</span> ${state === 'SOLD' ? 'Sale Payment Recorded' : 'Price Setting'}
                </span>
                ${state === 'SOLD' ? `
                  <span style="font-size:0.74rem; font-weight:700; color:#9f1239;">Recorded Sale Amount</span>
                ` : `
                  <span style="font-size:0.72rem; color:var(--text-muted);">(Optional price tag)</span>
                `}
              </div>

              <div style="display:flex; gap:0.75rem; align-items:flex-end; flex-wrap:wrap;">
                <div style="width:140px;">
                  <label style="display:block; font-size:0.72rem; font-weight:700; color:${state === 'SOLD' ? '#9f1239' : '#64748b'}; margin-bottom:0.2rem;">
                    ${state === 'SOLD' ? 'Amount Paid (₹)' : 'Price (₹)'}
                  </label>
                  <div style="position:relative; display:flex; align-items:center;">
                    <span style="position:absolute; left:0.55rem; font-weight:700; color:${state === 'SOLD' ? '#be123c' : '#64748b'}; font-size:0.9rem;">₹</span>
                    <input type="number" step="any" min="0" class="form-control form-control-sm inp-edit-price" value="${escapeHtml(curPrice.toString())}" placeholder="${state === 'SOLD' ? '0.00' : 'Price...'}" style="width:100%; padding-left:1.45rem; font-weight:700; font-size:0.92rem; ${state === 'SOLD' ? 'color:#881337; border-color:#fca5a5; background:#ffffff;' : ''}">
                  </div>
                </div>

                ${state === 'SOLD' ? `
                  <button type="button" class="btn btn-sm btn-save-payment-only" style="background:#2563eb; color:#ffffff; font-weight:700; border:none; border-radius:10px; padding:0.48rem 0.95rem; display:inline-flex; align-items:center; gap:0.35rem; cursor:pointer; height:34px; box-shadow:0 2px 8px rgba(37,99,235,0.3); transition:all 0.15s ease;" title="Update recorded payment">
                    <span>💾</span> Update Payment
                  </button>
                ` : ''}
              </div>

              ${state === 'SOLD' ? `
                <div style="font-size:0.72rem; color:#9f1239; margin-top:0.45rem; line-height:1.35;">
                  💡 <b>Correct Payment Received</b>: Enter the actual amount paid above (e.g. 300) and click <b>Update Payment</b>.
                </div>
              ` : ''}
            </div>
          </div>
        </div>

        <div class="book-card-actions" style="justify-content:flex-start; min-width:90px;">
          <button class="btn btn-sm btn-primary btn-save-edit" style="width:100%; white-space:nowrap; margin-bottom:0.35rem;">
            💾 Save
          </button>
          <button class="btn btn-sm btn-outline btn-cancel-edit" style="width:100%; white-space:nowrap;">
            ✖ Cancel
          </button>
        </div>
      </div>
    `;

    const inpRack = card.querySelector('.inp-edit-rack');
    const inpCol = card.querySelector('.inp-edit-col');
    const inpPos = card.querySelector('.inp-edit-pos');
    const lblPreview = card.querySelector('.lbl-loc-preview');

    function syncLocPreview() {
      if (lblPreview) {
        lblPreview.textContent = formatLocationPreviewText(inpRack.value, inpCol.value, inpPos.value);
      }
    }

    inpRack.addEventListener('input', syncLocPreview);
    inpCol.addEventListener('input', syncLocPreview);
    inpPos.addEventListener('input', syncLocPreview);

    // Cancel action
    card.querySelector('.btn-cancel-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      renderView();
    });

    // Update Payment Only action (for sold books)
    const btnSavePaymentOnly = card.querySelector('.btn-save-payment-only');
    if (btnSavePaymentOnly) {
      btnSavePaymentOnly.addEventListener('click', async (e) => {
        e.stopPropagation();
        const priceVal = card.querySelector('.inp-edit-price') ? card.querySelector('.inp-edit-price').value.trim() : '';
        if (priceVal === '') {
          alert('Please enter a valid payment amount.');
          return;
        }
        btnSavePaymentOnly.disabled = true;
        btnSavePaymentOnly.innerHTML = `<span>⏳</span> Updating...`;
        try {
          const res = await fetch('/api/books/update-payment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ book_id: bookId, selling_price: priceVal })
          });
          const data = await res.json();
          if (data.success && data.book) {
            copy.selling_price = data.book.selling_price;
            if (book.copies) {
              const bCopy = book.copies.find(c => c.book_id === bookId);
              if (bCopy) bCopy.selling_price = data.book.selling_price;
            }
            if (book.book_id === bookId) book.selling_price = data.book.selling_price;
            fetchStats();
            renderView();
            alert(`✅ Payment updated to ₹${data.new_price}! (Difference: ${data.adjustment >= 0 ? '+' : ''}₹${data.adjustment})`);
          } else {
            alert('Failed to update payment: ' + (data.error || 'Unknown error'));
            btnSavePaymentOnly.disabled = false;
            btnSavePaymentOnly.innerHTML = `<span>💾</span> Update Payment`;
          }
        } catch (err) {
          alert('Network error while updating payment: ' + err.message);
          btnSavePaymentOnly.disabled = false;
          btnSavePaymentOnly.innerHTML = `<span>💾</span> Update Payment`;
        }
      });
    }

    // Save action
    const btnSave = card.querySelector('.btn-save-edit');
    btnSave.addEventListener('click', async (e) => {
      e.stopPropagation();
      const newTitle = card.querySelector('.inp-edit-title').value.trim();
      const newAuthor = card.querySelector('.inp-edit-author').value.trim();
      const newLang = card.querySelector('.inp-edit-lang').value.trim() || 'English';
      const newRack = inpRack.value.trim();
      const newCol = inpCol.value.trim();
      const newPos = inpPos.value.trim();
      const newPrice = card.querySelector('.inp-edit-price') ? card.querySelector('.inp-edit-price').value.trim() : '';

      if (!newTitle) {
        alert('Book Title cannot be empty.');
        return;
      }

      btnSave.disabled = true;
      btnSave.textContent = 'Saving...';

      try {
        const res = await fetch('/api/books/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            book_id: bookId,
            title: newTitle,
            author: newAuthor,
            language: newLang,
            rack: newRack,
            column_num: newCol,
            position: newPos,
            selling_price: newPrice
          })
        });
        const data = await res.json();
        if (data.success && data.book) {
          // Update in-memory copy & book
          copy.title = data.book.title;
          book.title = data.book.title;
          copy.author = data.book.author;
          book.author = data.book.author;
          copy.language = data.book.language;
          book.language = data.book.language;
          copy.rack = data.book.rack;
          copy.column_num = data.book.column_num;
          copy.position = data.book.position;
          copy.location_english = data.book.location_english;
          book.location_english = data.book.location_english;
          copy.selling_price = data.book.selling_price;
          copy.status = data.book.status;
          renderView();
          fetchStats();
        } else {
          alert('Failed to update book: ' + (data.error || 'Unknown error'));
          btnSave.disabled = false;
          btnSave.textContent = '💾 Save';
        }
      } catch (err) {
        alert('Network error while saving: ' + err.message);
        btnSave.disabled = false;
        btnSave.textContent = '💾 Save';
      }
    });
  }

  // Card click to expand / select (tile gets bigger with extra details)
  card.addEventListener('click', (e) => {
    // If the click is on an interactive button, input, or inside edit mode, don't toggle selection
    if (e.target.closest('button, input, select, textarea, .book-card-actions, .edit-active-card, .delete-trigger-container')) {
      return;
    }
    const wasSelected = card.classList.contains('is-selected');
    document.querySelectorAll('.book-card-item.is-selected').forEach(c => {
      if (c !== card) c.classList.remove('is-selected');
    });
    if (wasSelected) {
      card.classList.remove('is-selected');
    } else {
      card.classList.add('is-selected');
    }
  });

  // Initial render in View mode
  renderView();
  return card;
}

/**
 * Renders each copy in a book group as an independent separate tile.
 */
function createBookCard(bookGroup, matchType) {
  const fragment = document.createDocumentFragment();
  const copies = (bookGroup.copies && bookGroup.copies.length > 0) ? bookGroup.copies : [bookGroup];
  copies.forEach(copy => {
    fragment.appendChild(createBookTile(bookGroup, copy, matchType));
  });
  return fragment;
}

/* =========================================================================
   GENRE TAB CONTROLLER
   ========================================================================= */

let allLoadedGenreBooks = [];
let genreDataLoaded = false;

async function loadGenreTab() {
  if (genreDataLoaded) return;
  try {
    const res = await fetch('/api/genres');
    const data = await res.json();
    const select = document.getElementById('genreSelect');
    const pillsWrap = document.getElementById('quickGenrePills');
    if (!select || !data.genres) return;

    select.innerHTML = '<option value="">-- Choose a Genre --</option>';
    if (pillsWrap) pillsWrap.innerHTML = '';

    data.genres.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.simple_genre;
      opt.textContent = `${g.simple_genre} (${g.total_copies.toLocaleString()} copies)`;
      select.appendChild(opt);

      // Add quick pill
      if (pillsWrap) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'quick-genre-pill';
        pill.textContent = `${g.simple_genre}`;
        pill.setAttribute('data-genre', g.simple_genre);
        pill.addEventListener('click', () => {
          document.querySelectorAll('.quick-genre-pill').forEach(p => p.classList.remove('active'));
          pill.classList.add('active');
          select.value = g.simple_genre;
          fetchBooksForGenre(g.simple_genre);
        });
        pillsWrap.appendChild(pill);
      }
    });

    genreDataLoaded = true;
  } catch (err) {
    console.error('Failed to load genres list:', err);
  }
}

async function fetchBooksForGenre(genreName) {
  if (!genreName) {
    document.getElementById('genreBooksContainer').innerHTML = `
      <div class="empty-prompt">
        <div class="prompt-icon">🏷️</div>
        <h3>Select a Genre Above</h3>
        <p>Pick any canonical category from the dropdown to see all matching books and their shelf locations.</p>
      </div>
    `;
    safeSet('genreBooksCountBadge', '0 Books');
    return;
  }

  const container = document.getElementById('genreBooksContainer');
  container.innerHTML = '<div class="empty-prompt"><p>Loading books in ' + escapeHtml(genreName) + '...</p></div>';

  try {
    const res = await fetch(`/api/books/by-genre?genre=${encodeURIComponent(genreName)}&available_only=true`);
    const data = await res.json();
    allLoadedGenreBooks = data.books || [];
    renderFilteredGenreBooks();
  } catch (err) {
    console.error('Failed to load books by genre:', err);
    container.innerHTML = '<div class="empty-prompt"><p style="color:var(--danger)">Failed to load books for this genre.</p></div>';
  }
}

function renderFilteredGenreBooks() {
  const container = document.getElementById('genreBooksContainer');
  const filterVal = (document.getElementById('genreFilterInput')?.value || '').toLowerCase().trim();

  let filtered = allLoadedGenreBooks;
  if (filterVal) {
    filtered = allLoadedGenreBooks.filter(b => 
      (b.title && b.title.toLowerCase().includes(filterVal)) || 
      (b.author && b.author.toLowerCase().includes(filterVal)) ||
      (b.genre && b.genre.toLowerCase().includes(filterVal))
    );
  }

  let totalCopies = 0;
  filtered.forEach(b => {
    totalCopies += (b.copies && b.copies.length > 0) ? b.copies.length : 1;
  });
  safeSet('genreBooksCountBadge', `${totalCopies} Book${totalCopies === 1 ? '' : 's'}`);

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-prompt">
        <div class="prompt-icon">📖</div>
        <h3>No Matching Books Found</h3>
        <p>No books in this genre match your filter.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  filtered.forEach(bookGroup => {
    container.appendChild(createBookCard(bookGroup, 'genre'));
  });
  resolveLazyCovers();
}

function initGenreTab() {
  const select = document.getElementById('genreSelect');
  if (select) {
    select.addEventListener('change', (e) => {
      const g = e.target.value;
      document.querySelectorAll('.quick-genre-pill').forEach(p => {
        if (p.getAttribute('data-genre') === g) p.classList.add('active');
        else p.classList.remove('active');
      });
      fetchBooksForGenre(g);
    });
  }

  const filterInp = document.getElementById('genreFilterInput');
  if (filterInp) {
    filterInp.addEventListener('input', () => {
      renderFilteredGenreBooks();
    });
  }
}

/* =========================================================================
   BOOK ADVISOR (ASK QUESTIONS & RECOMMENDATIONS) CONTROLLER
   ========================================================================= */

function initAdvisorTab() {
  const btnAsk = document.getElementById('btnAskAdvisor');
  const inputQ = document.getElementById('advisorQuestionInput');

  async function submitQuestion(questionText) {
    const q = (questionText || inputQ?.value || '').trim();
    if (!q) return;

    if (inputQ) inputQ.value = q;

    const container = document.getElementById('advisorResultsContainer');
    const summaryBanner = document.getElementById('advisorSummaryBanner');
    const summaryText = document.getElementById('advisorSummaryText');

    container.innerHTML = `
      <div class="empty-prompt">
        <div style="font-size:2rem;">✨</div>
        <h3>Finding Recommendations...</h3>
        <p>Analyzing reading intent and finding relevant inventory matches for you.</p>
      </div>
    `;
    if (summaryBanner) summaryBanner.style.display = 'none';

    try {
      const res = await fetch('/api/ask-recommendations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q })
      });
      const data = await res.json();

      if (summaryBanner && summaryText) {
        summaryText.innerHTML = escapeHtml(data.answer).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
        summaryBanner.style.display = 'block';
      }

      if (!data.books || data.books.length === 0) {
        container.innerHTML = `
          <div class="empty-prompt">
            <div class="prompt-icon">🔍</div>
            <h3>No Direct Recommendations Found</h3>
            <p>Try rephrasing your question or browse our <b>Genre</b> tab to explore categories.</p>
          </div>
        `;
        return;
      }

      container.innerHTML = '';
      data.books.forEach(item => {
        container.appendChild(createBookCard(item, 'recommendation'));
      });
      resolveLazyCovers();
    } catch (err) {
      console.error('Error fetching recommendations:', err);
      container.innerHTML = `
        <div class="empty-prompt">
          <p style="color:var(--danger)">Failed to process recommendation request.</p>
        </div>
      `;
    }
  }

  if (btnAsk) {
    btnAsk.addEventListener('click', () => submitQuestion());
  }

  if (inputQ) {
    inputQ.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitQuestion();
      }
    });
  }

  // Example question pills
  document.querySelectorAll('.example-question-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const q = pill.getAttribute('data-q');
      submitQuestion(q);
    });
  });
}

/* =========================================================================
   3. SINGLE BOOK ADDITION (Req 1.1)
   ========================================================================= */

async function suggestGenreForSingleBook(force = false) {
  const titleInput = document.getElementById('manualTitle') || document.getElementById('pictureTitle') || document.getElementById('singleTitle');
  const authorInput = document.getElementById('manualAuthor') || document.getElementById('pictureAuthor') || document.getElementById('singleAuthor');
  const genreInput = document.getElementById('manualGenre') || document.getElementById('pictureGenre') || document.getElementById('singleGenre');
  if (!titleInput || !genreInput) return;

  const title = titleInput.value.trim();
  const author = authorInput ? authorInput.value.trim() : '';
  if (!title) return;

  if (genreInput.value.trim() && !force) return;

  const btnAuto = document.getElementById('btnAutoGenre');
  if (btnAuto) btnAuto.textContent = '⏳ AI Detecting...';

  try {
    const res = await fetch(`/api/books/suggest-genre?title=${encodeURIComponent(title)}&author=${encodeURIComponent(author)}`);
    const data = await res.json();
    if (data.genre) {
      genreInput.value = data.genre;
      if (btnAuto) btnAuto.textContent = `✨ AI: ${data.genre}`;
      setTimeout(() => {
        if (btnAuto) btnAuto.textContent = '✨ Auto-Detect Genre';
      }, 3000);
    } else {
      if (btnAuto) btnAuto.textContent = '✨ Auto-Detect Genre';
    }
  } catch (e) {
    if (btnAuto) btnAuto.textContent = '✨ Auto-Detect Genre';
  }
}

function initManualAdd() {
  const form = document.getElementById('formManualBook') || document.getElementById('formSingleBook');
  if (!form) return;

  const titleInp = document.getElementById('manualTitle') || document.getElementById('singleTitle');
  const authorInp = document.getElementById('manualAuthor') || document.getElementById('singleAuthor');
  const genreInp = document.getElementById('manualGenre') || document.getElementById('singleGenre');
  const langInp = document.getElementById('manualLanguage') || document.getElementById('singleLanguage');
  const rackInp = document.getElementById('manualRack') || document.getElementById('singleRack');
  const colInp = document.getElementById('manualColumn') || document.getElementById('singleColumn');
  const posInp = document.getElementById('manualPosition') || document.getElementById('singlePosition');
  const notesInp = document.getElementById('manualNotes') || document.getElementById('singleNotes');
  const locPreview = document.getElementById('manualLocationPreview') || document.getElementById('singleLocationEnglishPreview');
  const alertBox = document.getElementById('manualDupAlert') || document.getElementById('singleDupAlert');

  function updateLocPreview() {
    if (!rackInp || !colInp || !posInp || !locPreview) return;
    const rack = rackInp.value.trim();
    const col = colInp.value.trim();
    const pos = posInp.value.trim();
    if (!rack || !col || !pos) {
      locPreview.innerHTML = 'Location: <span class="highlight">Unassigned</span>';
    } else {
      let posText = pos;
      if (pos === '1') posText = 'On top of the rack';
      else if (pos === '2') posText = '2nd book from top';
      else if (pos === '3') posText = '3rd book from top';
      else if (!isNaN(pos)) {
        const n = parseInt(pos, 10);
        let sfx = 'th';
        if (n % 100 < 11 || n % 100 > 13) {
          if (n % 10 === 1) sfx = 'st';
          else if (n % 10 === 2) sfx = 'nd';
          else if (n % 10 === 3) sfx = 'rd';
        }
        posText = `${n}${sfx} book from top`;
      }
      locPreview.innerHTML = `Location: <span class="highlight">Rack ${escapeHtml(rack)} → Column ${escapeHtml(col)} → ${escapeHtml(posText)}</span>`;
    }
  }

  if (rackInp) rackInp.addEventListener('input', updateLocPreview);
  if (colInp) colInp.addEventListener('input', updateLocPreview);
  if (posInp) posInp.addEventListener('input', updateLocPreview);

  // Auto-suggest genre button
  const btnAutoGenre = document.getElementById('btnManualAutoGenre') || document.getElementById('btnAutoGenre');
  if (btnAutoGenre && titleInp) {
    btnAutoGenre.addEventListener('click', async () => {
      const t = titleInp.value.trim();
      const a = authorInp ? authorInp.value.trim() : '';
      if (!t) {
        alert('Please enter a book title first to suggest genre.');
        return;
      }
      btnAutoGenre.textContent = '⏳ Thinking...';
      try {
        const res = await fetch(`/api/books/suggest-genre?title=${encodeURIComponent(t)}&author=${encodeURIComponent(a)}`);
        const data = await res.json();
        if (data && data.genre && genreInp) {
          genreInp.value = data.genre;
        }
      } catch (e) {}
      btnAutoGenre.textContent = '✨ Auto-Suggest Genre';
    });
  }

  // Automatically query LLM for genre on blur if genre is still empty
  const autoFetchManualGenre = async () => {
    if (!genreInp || genreInp.value.trim()) return;
    const t = titleInp ? titleInp.value.trim() : '';
    const a = authorInp ? authorInp.value.trim() : '';
    if (!t || t.length < 2) return;
    if (btnAutoGenre) btnAutoGenre.textContent = '⏳ Thinking...';
    try {
      const res = await fetch(`/api/books/suggest-genre?title=${encodeURIComponent(t)}&author=${encodeURIComponent(a)}`);
      const data = await res.json();
      if (data && data.genre && genreInp && !genreInp.value.trim()) {
        genreInp.value = data.genre;
      }
    } catch (e) {}
    if (btnAutoGenre) btnAutoGenre.textContent = '✨ Auto-Suggest Genre';
  };

  if (titleInp) titleInp.addEventListener('blur', autoFetchManualGenre);
  if (authorInp) authorInp.addEventListener('blur', autoFetchManualGenre);

  // Duplicate title check
  if (titleInp) {
    titleInp.addEventListener('blur', async () => {
      const t = titleInp.value.trim();
      if (!alertBox || !t || t.length < 3) {
        if (alertBox) alertBox.style.display = 'none';
        return;
      }
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(t)}`);
        const data = await res.json();
        if (data.exact_matches && data.exact_matches.length > 0) {
          const match = data.exact_matches[0];
          alertBox.style.display = 'block';
          alertBox.innerHTML = `
            <strong>ℹ️ Title Exists in Inventory:</strong> "${escapeHtml(match.title)}" already has <b>${match.total_copies}</b> physical copy recorded (Location: ${match.copies[0]?.location_english || 'Unassigned'}).
            <br>Saving this will add an additional physical copy to inventory.
          `;
        } else {
          alertBox.style.display = 'none';
        }
      } catch (e) {}
    });
  }

  // Form Submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const saveBtn = document.getElementById('btnSaveManualBook') || document.getElementById('btnSaveSingleBook');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving to Inventory...';
    }

    const payload = {
      title: cleanBookTitle(titleInp.value.trim()),
      author: authorInp ? authorInp.value.trim() : '',
      genre: genreInp ? genreInp.value.trim() : '',
      language: langInp ? langInp.value.trim() : 'English',
      rack: rackInp ? rackInp.value.trim() : '',
      column_num: colInp ? colInp.value.trim() : '',
      position: posInp ? posInp.value.trim() : '',
      notes: notesInp ? notesInp.value.trim() : '',
      idempotency_key: Date.now().toString()
    };

    try {
      const res = await fetch('/api/books/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (data.success) {
        alert(`🎉 Book Successfully Added!\n\nTitle: ${data.book.title}\nAuthor: ${data.book.author}\nLocation: ${data.book.location_english}`);
        form.reset();
        if (alertBox) alertBox.style.display = 'none';
        updateLocPreview();
        fetchStats();
      } else {
        alert('Error adding book: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Network or server error: ' + err.message);
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Save Book to Inventory';
      }
    }
  });
}

function initPictureAdd() {
  const cameraInput = document.getElementById('pictureCameraInput') || document.getElementById('singleBookCamera');
  const fileInput = document.getElementById('pictureFileInput') || document.getElementById('singleBookFile');
  const btnCamera = document.getElementById('btnPictureCamera');
  const btnFile = document.getElementById('btnPictureFile');
  const liveCameraBtn = document.getElementById('btnPictureLiveCamera');
  const previewWrap = document.getElementById('picturePhotoPreviewWrap') || document.getElementById('singlePhotoPreview');
  const previewImg = document.getElementById('picturePhotoImg') || document.getElementById('singlePhotoImg');
  const ocrStatus = document.getElementById('pictureOcrStatus') || document.getElementById('singleOcrStatus');
  const matchBadge = document.getElementById('pictureMatchBadge') || document.getElementById('singleMatchBadge');
  const formWrap = document.getElementById('pictureFormWrap');
  const form = document.getElementById('formPictureBook');

  if (btnCamera && cameraInput) {
    btnCamera.addEventListener('click', (e) => {
      e.preventDefault();
      cameraInput.click();
    });
  }

  if (btnFile && fileInput) {
    btnFile.addEventListener('click', (e) => {
      e.preventDefault();
      fileInput.click();
    });
  }

  if (liveCameraBtn) {
    liveCameraBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (typeof window.openLiveCamera === 'function') {
        window.openLiveCamera('picture');
      }
    });
  }

  const rackInp = document.getElementById('pictureRack');
  const colInp = document.getElementById('pictureColumn');
  const posInp = document.getElementById('picturePosition');
  const locPreview = document.getElementById('pictureLocationPreview');

  function updateLocPreview() {
    if (!rackInp || !colInp || !posInp || !locPreview) return;
    const rack = rackInp.value.trim();
    const col = colInp.value.trim();
    const pos = posInp.value.trim();
    if (!rack || !col || !pos) {
      locPreview.innerHTML = 'Location: <span class="highlight">Unassigned</span>';
    } else {
      let posText = pos;
      if (pos === '1') posText = 'On top of the rack';
      else if (pos === '2') posText = '2nd book from top';
      else if (pos === '3') posText = '3rd book from top';
      else if (!isNaN(pos)) {
        const n = parseInt(pos, 10);
        let sfx = 'th';
        if (n % 100 < 11 || n % 100 > 13) {
          if (n % 10 === 1) sfx = 'st';
          else if (n % 10 === 2) sfx = 'nd';
          else if (n % 10 === 3) sfx = 'rd';
        }
        posText = `${n}${sfx} book from top`;
      }
      locPreview.innerHTML = `Location: <span class="highlight">Rack ${escapeHtml(rack)} → Column ${escapeHtml(col)} → ${escapeHtml(posText)}</span>`;
    }
  }

  if (rackInp) rackInp.addEventListener('input', updateLocPreview);
  if (colInp) colInp.addEventListener('input', updateLocPreview);
  if (posInp) posInp.addEventListener('input', updateLocPreview);

  const handlePictureFile = async (file) => {
    if (!file) return;
    if (previewWrap) previewWrap.style.display = 'block';
    if (ocrStatus) ocrStatus.textContent = 'Reading photo...';
    if (matchBadge) matchBadge.innerHTML = '';
    if (formWrap) formWrap.style.display = 'none';

    try {
      const downscaledB64 = await downscaleImage(file, 1200, 0.85);
      if (previewImg) previewImg.src = downscaledB64;
      if (ocrStatus) ocrStatus.textContent = '🌟 Analyzing book cover with AI...';

      const res = await fetch('/api/books/ocr-extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_data: downscaledB64,
          raw_text: file.name.replace(/\.[^/.]+$/, "").replace(/[_\-]/g, " ")
        })
      });
      const cand = await res.json();

      if (cand && cand.title && cand.title.length > 2) {
        const cleanTitle = cleanBookTitle(cand.title);
        const titleInp = document.getElementById('pictureTitle');
        const authorInp = document.getElementById('pictureAuthor');
        const genreInp = document.getElementById('pictureGenre');
        const langInp = document.getElementById('pictureLanguage');

        if (titleInp) titleInp.value = cleanTitle;
        if (authorInp) authorInp.value = cand.author || 'Author';
        if (genreInp) genreInp.value = cand.genre || 'General Non-Fiction';
        if (langInp) langInp.value = cand.language || 'English';

        if (ocrStatus) ocrStatus.textContent = '✅ Book Recognized via AI!';
        if (matchBadge) {
          matchBadge.innerHTML = `📖 <b>"${escapeHtml(cleanTitle)}"</b> by <b>${escapeHtml(cand.author || 'Author')}</b>`;
        }
        if (formWrap) formWrap.style.display = 'block';
        updateLocPreview();
      } else {
        if (ocrStatus) ocrStatus.textContent = '⚠️ Could not read title clearly. Please type details below:';
        if (formWrap) formWrap.style.display = 'block';
      }
    } catch (err) {
      if (ocrStatus) ocrStatus.textContent = 'Error processing photo: ' + err.message;
    } finally {
      if (cameraInput) cameraInput.value = '';
      if (fileInput) fileInput.value = '';
    }
  };

  const btnPicAutoGenre = document.getElementById('btnPictureAutoGenre');
  if (btnPicAutoGenre) {
    btnPicAutoGenre.addEventListener('click', async () => {
      const t = document.getElementById('pictureTitle')?.value.trim() || '';
      const a = document.getElementById('pictureAuthor')?.value.trim() || '';
      const genreInp = document.getElementById('pictureGenre');
      if (!t) {
        alert('Please enter or scan a title first.');
        return;
      }
      btnPicAutoGenre.textContent = '⏳ Thinking...';
      try {
        const res = await fetch(`/api/books/suggest-genre?title=${encodeURIComponent(t)}&author=${encodeURIComponent(a)}`);
        const data = await res.json();
        if (data && data.genre && genreInp) {
          genreInp.value = data.genre;
        }
      } catch (e) {}
      btnPicAutoGenre.textContent = '✨ Auto-Suggest';
    });
  }

  if (cameraInput) cameraInput.addEventListener('change', (e) => handlePictureFile(e.target.files[0]));
  if (fileInput) fileInput.addEventListener('change', (e) => handlePictureFile(e.target.files[0]));

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const saveBtn = document.getElementById('btnSavePictureBook');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving to Inventory...';
      }

      const payload = {
        title: cleanBookTitle(document.getElementById('pictureTitle')?.value || ''),
        author: document.getElementById('pictureAuthor')?.value || '',
        genre: document.getElementById('pictureGenre')?.value || '',
        language: document.getElementById('pictureLanguage')?.value || 'English',
        rack: document.getElementById('pictureRack')?.value || '',
        column_num: document.getElementById('pictureColumn')?.value || '',
        position: document.getElementById('picturePosition')?.value || '',
        notes: document.getElementById('pictureNotes')?.value || '',
        idempotency_key: Date.now().toString()
      };

      try {
        const res = await fetch('/api/books/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (data.success) {
          alert(`🎉 Book Successfully Added!\n\nTitle: ${data.book.title}\nAuthor: ${data.book.author}\nLocation: ${data.book.location_english}`);
          form.reset();
          if (previewWrap) previewWrap.style.display = 'none';
          if (formWrap) formWrap.style.display = 'none';
          fetchStats();
        } else {
          alert('Error adding book: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Network error: ' + err.message);
      } finally {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = '💾 Confirm & Save Book to Inventory';
        }
      }
    });
  }
}

function initAddModeSwitcher() {
  const addModeBtns = document.querySelectorAll('[data-add-mode]');
  addModeBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      addModeBtns.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.add-mode-content').forEach(c => c.style.display = 'none');

      btn.classList.add('active');
      const mode = btn.getAttribute('data-add-mode');
      if (mode === 'manualAdd' || mode === 'singleAdd') {
        const el = document.getElementById('sectionManualAdd') || document.getElementById('sectionSingleAdd');
        if (el) el.style.display = 'block';
        const tInp = document.getElementById('manualTitle');
        if (tInp) tInp.focus();
      } else if (mode === 'pictureAdd' || mode === 'fewBooksAdd') {
        const el = document.getElementById('sectionPictureAdd') || document.getElementById('sectionBulkA');
        if (el) el.style.display = 'block';
        const cam = document.getElementById('pictureCameraInput');
        if (cam) cam.click();
      } else if (mode === 'stackAdd') {
        const el = document.getElementById('sectionStackAdd') || document.getElementById('sectionBulkB');
        if (el) el.style.display = 'block';
        const cam = document.getElementById('multiBookCameraInput');
        if (cam) cam.click();
      }
    });
  });
}

function initSingleAdd() {
  initAddModeSwitcher();
  initManualAdd();
  initPictureAdd();
}

window.switchToAddWithTitle = function(title) {
  const addTabBtn = document.querySelector('.tab-btn[data-tab="tabAdd"]');
  if (addTabBtn) addTabBtn.click();

  const manualBtn = document.querySelector('[data-add-mode="manualAdd"]');
  if (manualBtn) manualBtn.click();

  const titleInp = document.getElementById('manualTitle') || document.getElementById('singleTitle');
  if (titleInp) {
    titleInp.value = cleanBookTitle(title);
    titleInp.focus();
  }
};

async function checkDuplicateTitle(title) {
  const alertBox = document.getElementById('singleDupAlert');
  if (!title || title.trim().length < 3) {
    alertBox.style.display = 'none';
    return;
  }

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(title)}`);
    const data = await res.json();
    if (data.exact_matches && data.exact_matches.length > 0) {
      const match = data.exact_matches[0];
      alertBox.style.display = 'block';
      alertBox.innerHTML = `
        <strong>ℹ️ Title Exists in Inventory:</strong> "${escapeHtml(match.title)}" already has <b>${match.total_copies}</b> physical copy recorded (Location: ${match.copies[0]?.location_english || 'Unassigned'}).
        <br>Adding this will generate a new unique Inventory ID for this additional physical copy (Req 1.4 & 1.5).
      `;
    } else {
      alertBox.style.display = 'none';
    }
  } catch (err) {
    alertBox.style.display = 'none';
  }
}

/* Live Camera Viewfinder & Real OCR Processor (Req 1.1 Option A) */
let cameraStream = null;
let currentCameraFacing = 'environment';

let videoScanTimer = null;
let latestDetectedBook = null;

function initLiveCamera() {
  const openBtn = document.getElementById('btnOpenLiveCamera');
  const modal = document.getElementById('modalLiveCamera');
  if (!modal) return;
  const closeBtn = document.getElementById('btnCloseLiveCamera');
  const snapBtn = document.getElementById('btnSnapLivePhoto');
  const switchBtn = document.getElementById('btnSwitchCamera');
  const video = document.getElementById('liveCameraVideo');
  const canvas = document.getElementById('liveCameraCanvas');
  const autoScanChk = document.getElementById('chkAutoScanVideo');
  const hudBanner = document.getElementById('liveDetectionBanner');
  const hudTitle = document.getElementById('liveDetectedTitle');
  const btnUseDetected = document.getElementById('btnLiveUseDetected');
  const guideStatus = document.getElementById('guideStatusLabel');

  // Security: Cleanse any previously stored API key from user's browser storage
  try {
    localStorage.removeItem('google_vision_api_key');
  } catch (e) {}

  let serverAiAvailable = false;
  fetch('/api/config/google-key')
    .then(r => r.json())
    .then(data => {
      serverAiAvailable = !!data.has_key;
    })
    .catch(() => {});

  let currentLiveCameraMode = 'single';
  const modalTitle = document.getElementById('liveCameraModalTitle');
  const doneBatchABtn = document.getElementById('btnDoneLiveBatchA');
  const countDoneSpan = document.getElementById('countDoneBatchA');
  const doneBatchBBtn = document.getElementById('btnDoneLiveBatchB');
  const countDoneSpanB = document.getElementById('countDoneBatchB');
  const wrapAutoScan = document.getElementById('wrapAutoScan');

  function updateBatchADoneCount() {
    if (countDoneSpan) countDoneSpan.textContent = batchBooksA.length;
  }

  function updateBatchBDoneCount() {
    if (countDoneSpanB && typeof stackPhotosQueue !== 'undefined') {
      countDoneSpanB.textContent = stackPhotosQueue.length;
    }
  }

  window.openLiveCamera = async function(mode = 'single') {
    currentLiveCameraMode = mode;
    modal.style.display = 'flex';
    hudBanner.style.display = 'none';

    if (doneBatchABtn) doneBatchABtn.style.display = (mode === 'batchA') ? 'inline-flex' : 'none';
    if (doneBatchBBtn) doneBatchBBtn.style.display = (mode === 'batchB' || mode === 'stack') && (typeof stackPhotosQueue !== 'undefined' && stackPhotosQueue.length > 0) ? 'inline-flex' : 'none';
    if (wrapAutoScan) wrapAutoScan.style.display = (mode === 'single' || mode === 'picture') ? 'inline-flex' : 'none';

    if (mode === 'batchA') {
      if (modalTitle) modalTitle.textContent = '📸 Workflow A: Rapid Batch Photos';
      guideStatus.textContent = 'Hold book in frame & tap Snap. Snaps one after another!';
      snapBtn.textContent = `📸 Snap Book #${batchBooksA.length + 1}`;
      updateBatchADoneCount();
    } else if (mode === 'batchB' || mode === 'stack') {
      if (modalTitle) modalTitle.textContent = '📸 Stack Close-up Viewfinder (Multiple Shots)';
      guideStatus.textContent = 'Hold camera close to stack section & tap Snap. Take multiple shots of tall stacks!';
      const currentQueueLen = (typeof stackPhotosQueue !== 'undefined') ? stackPhotosQueue.length : 0;
      snapBtn.textContent = `📸 Snap Close-Up #${currentQueueLen + 1}`;
      updateBatchBDoneCount();
    } else if (mode === 'picture' || mode === 'single') {
      if (modalTitle) modalTitle.textContent = '📸 Camera Viewfinder (Single Book)';
      guideStatus.textContent = 'Align Book Cover or Spine Here';
      snapBtn.textContent = '📸 Snap Photo';
    } else if (mode === 'posBatchA') {
      if (modalTitle) modalTitle.textContent = '📸 Sell Workflow A: Rapid Multi-Scan';
      guideStatus.textContent = 'Hold book to sell in frame & tap Snap. Snaps one after another to cart!';
      snapBtn.textContent = `📸 Snap & Add to Cart`;
    } else if (mode === 'posBatchB') {
      if (modalTitle) modalTitle.textContent = '📸 Sell Workflow B: Stack Photo Sell';
      guideStatus.textContent = 'Align entire stack of books to sell (spines stacked) in frame';
      snapBtn.textContent = '📸 Snap Stack to Sell';
    } else if (mode === 'pos') {
      if (modalTitle) modalTitle.textContent = '📸 Quick Sell: Cover / Spine Scanner';
      guideStatus.textContent = 'Align book cover or spine to sell and tap Snap';
      snapBtn.textContent = '📸 Scan to Sell';
    } else if (mode === 'search') {
      if (modalTitle) modalTitle.textContent = '📸 Search: Cover / Spine Scanner';
      guideStatus.textContent = 'Align book cover or spine to search';
      snapBtn.textContent = '📸 Scan Book';
    } else {
      if (modalTitle) modalTitle.textContent = '📸 Camera Viewfinder (Single Book)';
      guideStatus.textContent = 'Align Book Cover or Spine Here';
      snapBtn.textContent = '📸 Snap Photo';
    }

    await startCameraStream();
  };

  if (openBtn) {
    openBtn.addEventListener('click', () => window.openLiveCamera('single'));
  }

  if (doneBatchABtn) {
    doneBatchABtn.addEventListener('click', () => {
      stopCameraStream();
      modal.style.display = 'none';
      const bulkToggle = document.querySelector('.bulk-toggle-section');
      if (bulkToggle) bulkToggle.open = true;
      const btnBulkA = document.querySelector('[data-mode="bulkA"]');
      if (btnBulkA) btnBulkA.click();
    });
  }

  if (doneBatchBBtn) {
    doneBatchBBtn.addEventListener('click', () => {
      stopCameraStream();
      modal.style.display = 'none';
      if (typeof processAllStackPhotos === 'function') {
        processAllStackPhotos();
      }
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      stopCameraStream();
      modal.style.display = 'none';
      if (typeof renderStackPhotosQueue === 'function') {
        renderStackPhotosQueue();
      }
    });
  }

  if (switchBtn) {
    switchBtn.addEventListener('click', async () => {
      currentCameraFacing = currentCameraFacing === 'environment' ? 'user' : 'environment';
      stopCameraStream();
      await startCameraStream();
    });
  }

  // Continuous Video Detection Toggle
  if (autoScanChk) {
    autoScanChk.addEventListener('change', () => {
      if (autoScanChk.checked) {
        guideStatus.textContent = '🎥 Live Video Detection Scanning...';
        startContinuousVideoScan();
      } else {
        stopContinuousVideoScan();
        hudBanner.style.display = 'none';
        guideStatus.textContent = 'Align Book Cover or Spine Here';
      }
    });
  }

  if (btnUseDetected) {
    btnUseDetected.addEventListener('click', () => {
      if (!latestDetectedBook) return;
      stopCameraStream();
      modal.style.display = 'none';
      applyDetectedBookToForm(latestDetectedBook);
    });
  }

  if (snapBtn) {
    snapBtn.addEventListener('click', async () => {
      if (!video || !video.videoWidth) {
        alert('Camera is loading, please wait a moment.');
        return;
      }

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.90);

      if (currentLiveCameraMode === 'batchA') {
        // Rapid sequential batch mode: "one pic after another"
        await addPhotoToBatchA(dataUrl, `book_${batchBooksA.length + 1}.jpg`);
        snapBtn.textContent = `📸 Snap Book #${batchBooksA.length + 1}`;
        updateBatchADoneCount();
        guideStatus.textContent = `✅ Book #${batchBooksA.length} captured! Hold next book & tap Snap.`;
        video.style.filter = 'brightness(1.5)';
        setTimeout(() => { video.style.filter = 'none'; }, 200);
        // Stays open for next photo
      } else if (currentLiveCameraMode === 'batchB' || currentLiveCameraMode === 'stack') {
        addPhotoToStackQueue(dataUrl, `stack_shot_${stackPhotosQueue.length + 1}.jpg`);
        video.style.filter = 'brightness(1.5)';
        setTimeout(() => { video.style.filter = 'none'; }, 200);
        if (doneBatchBBtn) {
          doneBatchBBtn.style.display = 'inline-flex';
          const cnt = document.getElementById('countDoneBatchB');
          if (cnt) cnt.textContent = stackPhotosQueue.length;
        }
        snapBtn.textContent = `📸 Snap Next Section #${stackPhotosQueue.length + 1}`;
        guideStatus.textContent = `✅ Shot #${stackPhotosQueue.length} captured! Move camera down to next section and Snap, or tap Done & Process.`;
      } else if (currentLiveCameraMode === 'posBatchA') {
        await processPosBatchAFile(dataUrl, `pos_snap_${posCart.length + 1}.jpg`);
        video.style.filter = 'brightness(1.5)';
        setTimeout(() => { video.style.filter = 'none'; }, 200);
        guideStatus.textContent = `✅ Book added! Cart has ${posCart.length} books. Hold next book & tap Snap.`;
      } else if (currentLiveCameraMode === 'posBatchB') {
        stopCameraStream();
        modal.style.display = 'none';
        processPosStackPhoto(dataUrl, 'pos_stack.jpg');
      } else if (currentLiveCameraMode === 'pos') {
        stopCameraStream();
        modal.style.display = 'none';
        processPosSearchImage(dataUrl, 'pos_capture.jpg');
      } else if (currentLiveCameraMode === 'search') {
        stopCameraStream();
        modal.style.display = 'none';
        processCoverSearchImage(dataUrl, 'search_capture.jpg');
      } else {
        // Single book
        stopCameraStream();
        modal.style.display = 'none';
        processBookImageOCR(dataUrl, 'camera_capture.jpg');
      }
    });
  }

  function fallbackToNativeCamera(mode) {
    if (mode === 'single' || mode === 'picture') {
      const cam = document.getElementById('pictureCameraInput') || document.getElementById('singleBookCamera');
      if (cam) cam.click();
    } else if (mode === 'batchA') {
      const cam = document.getElementById('batchCameraInput');
      if (cam) cam.click();
    } else if (mode === 'batchB' || mode === 'stack') {
      const cam = document.getElementById('multiBookCameraInput');
      if (cam) cam.click();
    } else if (mode === 'posBatchA') {
      const cam = document.getElementById('posBatchACameraInput');
      if (cam) cam.click();
    } else if (mode === 'posBatchB') {
      const cam = document.getElementById('posBatchBCameraInput');
      if (cam) cam.click();
    } else if (mode === 'pos') {
      const cam = document.getElementById('posCameraInput');
      if (cam) cam.click();
    } else if (mode === 'search') {
      const cam = document.getElementById('cameraSearchInput') || document.getElementById('cameraSearchFileInput');
      if (cam) cam.click();
    }
  }

  async function startCameraStream() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const isSecure = window.isSecureContext || location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
      let msg = '';
      if (!isSecure) {
        msg = '🔒 Video Camera Requires HTTPS\n\n' +
          'Web browsers strictly restrict live video streaming to Secure Contexts (HTTPS).\n\n' +
          '👉 Please use the official HTTPS link: https://book-store-advanced.vercel.app\n' +
          'Or use "Take Photo with Camera", which works directly on any connection!';
      } else {
        msg = 'Unable to access camera: Camera permissions are denied or no camera device is connected.';
      }
      alert(msg);
      modal.style.display = 'none';
      fallbackToNativeCamera(currentLiveCameraMode);
      return;
    }

    // Tiered constraints: start with flexible mobile rear camera, fallback to any camera
    const constraintsAttempts = [
      {
        video: {
          facingMode: { ideal: currentCameraFacing || 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      },
      {
        video: {
          facingMode: { ideal: currentCameraFacing || 'environment' }
        },
        audio: false
      },
      {
        video: true,
        audio: false
      }
    ];

    let stream = null;
    let lastError = null;

    for (const constraint of constraintsAttempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraint);
        if (stream) break;
      } catch (err) {
        lastError = err;
        console.warn('getUserMedia constraint fallback notice:', err);
      }
    }

    if (!stream) {
      alert('Unable to start live camera: ' + (lastError ? lastError.message : 'Permission denied') + '\n\nPlease check browser camera permissions or use "Take Photo with Camera".');
      modal.style.display = 'none';
      fallbackToNativeCamera(currentLiveCameraMode);
      return;
    }

    try {
      cameraStream = stream;
      video.srcObject = cameraStream;
      video.setAttribute('playsinline', 'true');
      video.setAttribute('webkit-playsinline', 'true');
      video.muted = true;

      // Ensure playback starts on mobile Safari
      await new Promise((resolve) => {
        let resolved = false;
        const tryPlay = () => {
          if (resolved) return;
          resolved = true;
          video.play().then(resolve).catch(resolve);
        };
        video.onloadedmetadata = tryPlay;
        setTimeout(tryPlay, 350);
      });

      if (autoScanChk && autoScanChk.checked) {
        startContinuousVideoScan();
      }
    } catch (err) {
      alert('Video player initialization notice: ' + err.message);
    }
  }

  function stopCameraStream() {
    stopContinuousVideoScan();
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      cameraStream = null;
    }
  }

  function startContinuousVideoScan() {
    if (videoScanTimer) clearInterval(videoScanTimer);
    videoScanTimer = setInterval(async () => {
      if (!video.videoWidth || !cameraStream) return;
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, 640, 360);
      const frameDataUrl = canvas.toDataURL('image/jpeg', 0.7);

      // Fast video OCR frame check
      let frameText = '';
      if (window.Tesseract) {
        try {
          const ret = await Tesseract.recognize(frameDataUrl, 'eng');
          frameText = (ret.data.text || '').trim();
        } catch (e) {}
      }

      if (frameText && frameText.length >= 8 && frameText.split(/\s+/).length >= 2) {
        try {
          const res = await fetch('/api/books/ocr-extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw_text: frameText, image_data: frameDataUrl })
          });
          const cand = await res.json();
          if (cand.title && cand.title.length > 2) {
            latestDetectedBook = cand;
            hudBanner.style.display = 'flex';
            hudTitle.textContent = `${cand.title} — ${cand.author || 'Author detected'}`;
            guideStatus.textContent = `🎯 Locked: ${cand.title}`;
          }
        } catch (e) {}
      }
    }, 900);
  }

  function stopContinuousVideoScan() {
    if (videoScanTimer) {
      clearInterval(videoScanTimer);
      videoScanTimer = null;
    }
  }
}

function applyDetectedBookToForm(cand) {
  const matchBadge = document.getElementById('pictureMatchBadge') || document.getElementById('singleMatchBadge');
  const ocrStatus = document.getElementById('pictureOcrStatus') || document.getElementById('singleOcrStatus');
  const previewBox = document.getElementById('picturePhotoPreviewWrap') || document.getElementById('singlePhotoPreview');
  const formWrap = document.getElementById('pictureFormWrap');

  if (previewBox) previewBox.style.display = 'block';
  if (formWrap) formWrap.style.display = 'block';

  const cleanTitle = cleanBookTitle(cand.title || '');
  const titleInp = document.getElementById('pictureTitle') || document.getElementById('singleTitle') || document.getElementById('manualTitle');
  const authorInp = document.getElementById('pictureAuthor') || document.getElementById('singleAuthor') || document.getElementById('manualAuthor');
  const genreInp = document.getElementById('pictureGenre') || document.getElementById('singleGenre') || document.getElementById('manualGenre');
  const langInp = document.getElementById('pictureLanguage') || document.getElementById('singleLanguage') || document.getElementById('manualLanguage');

  if (titleInp) titleInp.value = cleanTitle;
  if (authorInp) authorInp.value = cand.author || 'Author';
  if (genreInp) genreInp.value = cand.genre || 'General Non-Fiction';
  if (langInp) langInp.value = cand.language || 'English';

  if (matchBadge) {
    matchBadge.style.display = 'block';
    matchBadge.innerHTML = `✅ <b>Detected via AI:</b> "${escapeHtml(cleanTitle)}" by <b>${escapeHtml(cand.author || 'Author')}</b>`;
  }
  if (ocrStatus) ocrStatus.textContent = '✅ Book detected and details filled below!';
  checkDuplicateTitle(cleanTitle);
}

function preprocessImageForOCR(imageDataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let w = img.width;
      let h = img.height;
      const maxDim = 1600;
      if (w > maxDim || h > maxDim) {
        if (w > h) {
          h = Math.round((h * maxDim) / w);
          w = maxDim;
        } else {
          w = Math.round((w * maxDim) / h);
          h = maxDim;
        }
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.95));
    };
    img.onerror = () => resolve(imageDataUrl);
    img.src = imageDataUrl;
  });
}

async function searchGlobalBookCatalog(queryText) {
  if (!queryText) return null;
  const cleanQ = queryText.replace(/[^\w\s]/g, ' ').trim();
  if (cleanQ.length < 3) return null;

  try {
    const res = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(cleanQ)}&limit=1`);
    if (res.ok) {
      const data = await res.json();
      if (data.docs && data.docs.length > 0) {
        const doc = data.docs[0];
        return {
          title: doc.title,
          author: (doc.author_name && doc.author_name.length > 0) ? doc.author_name[0] : '',
          genre: (doc.subject && doc.subject.length > 0) ? doc.subject.slice(0, 2).join(', ') : '',
          language: 'English'
        };
      }
    }
  } catch (err) {
    console.warn('Global catalog lookup notice:', err);
  }
  return null;
}

async function processBookImageOCR(imageDataUrl, filenameHint = '') {
  const previewBox = document.getElementById('picturePhotoPreviewWrap') || document.getElementById('singlePhotoPreview');
  const previewImg = document.getElementById('picturePhotoImg') || document.getElementById('singlePhotoImg');
  const ocrStatus = document.getElementById('pictureOcrStatus') || document.getElementById('singleOcrStatus');
  const progressWrap = document.getElementById('ocrProgressWrap');
  const progressFill = document.getElementById('ocrProgressFill');
  const rawTextWrap = document.getElementById('singleOcrRawTextWrap');
  const rawTextElem = document.getElementById('singleOcrRawText');
  const matchBadge = document.getElementById('pictureMatchBadge') || document.getElementById('singleMatchBadge');
  const formWrap = document.getElementById('pictureFormWrap');

  if (previewBox) previewBox.style.display = 'block';
  if (previewImg) previewImg.src = imageDataUrl;
  if (progressWrap) progressWrap.style.display = 'block';
  if (progressFill) progressFill.style.width = '20%';
  if (ocrStatus) ocrStatus.textContent = 'Processing image...';
  if (rawTextWrap) rawTextWrap.style.display = 'none';
  if (matchBadge) matchBadge.style.display = 'none';

  // 1. Client-side Optical Text Scanning (if available)
  let extractedText = '';
  if (window.Tesseract && imageDataUrl) {
    try {
      if (ocrStatus) ocrStatus.textContent = 'Reading text from book cover...';
      if (progressFill) progressFill.style.width = '35%';
      const processedImage = await preprocessImageForOCR(imageDataUrl);

      const result = await Tesseract.recognize(
        processedImage,
        'eng',
        {
          logger: m => {
            if (m.status === 'recognizing text' && progressFill && ocrStatus) {
              const pct = Math.min(80, Math.round(30 + (m.progress || 0) * 50));
              progressFill.style.width = `${pct}%`;
              ocrStatus.textContent = `Reading text from book cover... ${pct}%`;
            }
          }
        }
      );
      extractedText = (result.data ? result.data.text : '').trim();
    } catch (err) {
      console.warn('In-browser OCR encountered warning:', err);
    }
  }

  // 2. Fallback to filename hints if OCR empty
  let payloadText = extractedText;
  if (!payloadText && filenameHint) {
    payloadText = filenameHint.replace(/\.[^/.]+$/, "").replace(/[_\-]/g, " ");
  }

  if (progressFill) progressFill.style.width = '85%';
  if (ocrStatus) ocrStatus.textContent = '🌟 Analyzing book cover with AI...';

  // 3. Server-side Multimodal AI Recognition (API key remains completely protected on server)
  try {
    const res = await fetch('/api/books/ocr-extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw_text: payloadText,
        image_data: imageDataUrl
      })
    });
    const cand = await res.json();

    if (progressWrap) progressWrap.style.display = 'none';

    if (payloadText && rawTextWrap && rawTextElem) {
      rawTextWrap.style.display = 'block';
      rawTextElem.textContent = payloadText;
    }

    if (cand && cand.title && cand.title.length > 2) {
      const cleanTitle = cleanBookTitle(cand.title);
      cand.title = cleanTitle;

      // Cross-reference with Global Book Catalog if needed
      if (!cand.matched_existing) {
        const globalLookup = await searchGlobalBookCatalog(cleanTitle + ' ' + (cand.author || '')) || await searchGlobalBookCatalog(cleanTitle);
        if (globalLookup && globalLookup.title) {
          cand.title = globalLookup.title;
          if (globalLookup.author) cand.author = globalLookup.author;
          if (globalLookup.genre && !cand.genre) cand.genre = globalLookup.genre;
          cand.engine = 'Global Book Catalog (Open Library)';
        }
      }

      applyDetectedBookToForm(cand);

      if (cand.engine === 'Google Gemini Vision AI') {
        if (matchBadge) {
          matchBadge.style.display = 'block';
          matchBadge.innerHTML = `🌟 <b>Identified via AI:</b> "${escapeHtml(cand.title)}" by <b>${escapeHtml(cand.author || 'Author')}</b>`;
        }
        if (ocrStatus) ocrStatus.textContent = '✅ Book identified via AI! Details filled below.';
      } else if (cand.matched_existing) {
        if (matchBadge) {
          matchBadge.style.display = 'block';
          matchBadge.innerHTML = `✅ <b>Verified Catalog Match:</b> "${escapeHtml(cand.title)}" by <b>${escapeHtml(cand.author)}</b>`;
        }
        if (ocrStatus) ocrStatus.textContent = '✅ Book identified from bookstore inventory!';
      } else {
        if (matchBadge) {
          matchBadge.style.display = 'block';
          matchBadge.innerHTML = `📘 <b>Identified Book:</b> "${escapeHtml(cand.title)}" by <b>${escapeHtml(cand.author || 'Author')}</b>`;
        }
        if (ocrStatus) ocrStatus.textContent = '✅ Book cover identified! Details filled below.';
      }

      if (formWrap) formWrap.style.display = 'block';
      checkDuplicateTitle(cand.title);
    } else {
      if (ocrStatus) ocrStatus.textContent = '⚠️ Could not clearly extract title from image. Please enter manually.';
      if (formWrap) formWrap.style.display = 'block';
    }
  } catch (err) {
    if (progressWrap) progressWrap.style.display = 'none';
    if (ocrStatus) ocrStatus.textContent = 'Error processing book: ' + err.message;
    if (formWrap) formWrap.style.display = 'block';
  }
}

// Generate realistic synthetic book spine on canvas to test photo OCR
function testSampleBookPhoto(title, author, genre) {
  const canvas = document.createElement('canvas');
  canvas.width = 450;
  canvas.height = 650;
  const ctx = canvas.getContext('2d');

  // Background
  const gradient = ctx.createLinearGradient(0, 0, 450, 650);
  gradient.addColorStop(0, '#1e293b');
  gradient.addColorStop(1, '#0f172a');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 450, 650);

  // Gold decorative border
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 6;
  ctx.strokeRect(20, 20, 410, 610);

  // Title
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 36px Georgia, serif';
  ctx.textAlign = 'center';
  
  // Word wrap title
  const words = title.split(' ');
  let line = '';
  let y = 180;
  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    const metrics = ctx.measureText(testLine);
    if (metrics.width > 360 && n > 0) {
      ctx.fillText(line.trim(), 225, y);
      line = words[n] + ' ';
      y += 45;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line.trim(), 225, y);

  // Author
  ctx.fillStyle = '#f59e0b';
  ctx.font = 'italic 28px Georgia, serif';
  ctx.fillText(`by ${author}`, 225, y + 80);

  // Genre tag
  ctx.fillStyle = '#94a3b8';
  ctx.font = '600 18px sans-serif';
  ctx.fillText(genre.toUpperCase(), 225, y + 140);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
  processBookImageOCR(dataUrl, `${title}.jpg`);
}

/* =========================================================================
   4. WORKFLOW A: BATCH INDIVIDUAL PHOTOS (Req 1.2) - "ONE PIC AFTER ANOTHER"
   ========================================================================= */

async function addPhotoToBatchA(base64Data, filename = 'book.jpg') {
  const itemId = Date.now() + Math.floor(Math.random() * 1000);
  const tempItem = {
    id: itemId,
    photo: base64Data,
    title: 'Analyzing photo...',
    author: 'Reading cover / spine...',
    genre: '',
    rack: '',
    column_num: '',
    position: '',
    confidence: 'processing',
    flag_uncertain: false,
    warning: null
  };
  batchBooksA.push(tempItem);
  renderBatchTableA();

  // Run OCR asynchronously
  (async () => {
    let extractedText = '';
    if (window.Tesseract) {
      try {
        const ocrRes = await Tesseract.recognize(base64Data, 'eng');
        extractedText = (ocrRes.data?.text || '').trim();
      } catch (err) {
        console.warn('Batch OCR warning:', err);
      }
    }

    const payloadText = extractedText || filename.replace(/\.[^/.]+$/, "").replace(/[_\-]/g, " ");

    try {
      const res = await fetch('/api/books/ocr-extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          raw_text: payloadText,
          image_data: base64Data,
          batch_hashes: batchImageHashes
        })
      });
      const cand = await res.json();

      if (cand.image_hash) {
        if (batchImageHashes.includes(cand.image_hash)) {
          const ok = confirm("⚠️ Duplicate Image Warning: You photographed the same book/image twice in this batch. Do you want to keep both physical copies?");
          if (!ok) {
            batchBooksA = batchBooksA.filter(b => b.id !== itemId);
            renderBatchTableA();
            return;
          }
        }
        batchImageHashes.push(cand.image_hash);
      }

      const target = batchBooksA.find(b => b.id === itemId);
      if (target) {
        target.title = cand.title || 'Untitled Book';
        target.author = cand.author || 'Unknown Author';
        target.genre = cand.genre || '';
        target.confidence = cand.confidence || 'high';
        target.flag_uncertain = cand.flag_uncertain || false;
        target.warning = cand.warning || null;
        renderBatchTableA();
      }
    } catch (err) {
      const target = batchBooksA.find(b => b.id === itemId);
      if (target) {
        target.title = filename.replace(/\.[^/.]+$/, "").replace(/[_\-]/g, " ");
        target.author = 'Unknown Author';
        target.confidence = 'uncertain';
        target.flag_uncertain = true;
        target.warning = 'Could not analyze automatically; please enter details.';
        renderBatchTableA();
      }
    }
  })();
}

function initBatchA() {
  const cameraInput = document.getElementById('batchCameraInput');
  const fileInput = document.getElementById('batchFileInput');
  const liveCameraBtn = document.getElementById('btnBatchALiveCamera');
  const saveBatchBtn = document.getElementById('btnSaveBatchA');

  if (liveCameraBtn) {
    liveCameraBtn.addEventListener('click', () => {
      if (typeof window.openLiveCamera === 'function') {
        window.openLiveCamera('batchA');
      }
    });
  }

  const handleBatchAFile = async (file) => {
    if (!file) return;
    try {
      const downscaledB64 = await downscaleImage(file, 1200, 0.85);
      await addPhotoToBatchA(downscaledB64, file.name);
      if (cameraInput) cameraInput.value = '';
      if (fileInput) fileInput.value = '';

      const notice = document.getElementById('batchAStatusNotice');
      if (notice) {
        notice.style.display = 'block';
        notice.textContent = `✅ Book #${batchBooksA.length} added! Tap "Snap Next Book" to capture the next one.`;
        setTimeout(() => { notice.style.display = 'none'; }, 4000);
      }
    } catch (err) {
      alert('Error reading photo: ' + err.message);
    }
  };

  if (cameraInput) cameraInput.addEventListener('change', (e) => handleBatchAFile(e.target.files[0]));
  if (fileInput) fileInput.addEventListener('change', (e) => handleBatchAFile(e.target.files[0]));

  // Manual Book Name Entry for Add Books One-by-One
  const btnManualBatchAdd = document.getElementById('btnManualBatchAdd');
  const inputManualTitle = document.getElementById('manualBatchTitle');
  const inputManualAuthor = document.getElementById('manualBatchAuthor');

  const addManualBookToBatchA = () => {
    if (!inputManualTitle) return;
    const titleVal = cleanBookTitle(inputManualTitle.value.trim());
    const authorVal = inputManualAuthor ? inputManualAuthor.value.trim() : '';
    if (!titleVal) {
      inputManualTitle.focus();
      return;
    }

    const newItem = {
      id: 'item_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      photo: '',
      title: titleVal,
      author: authorVal || 'Unknown Author',
      genre: 'General Non-Fiction',
      language: 'English',
      confidence: 'high',
      flag_uncertain: false,
      warning: null
    };

    batchBooksA.push(newItem);
    renderBatchTableA();

    // Fetch genre suggestion in background
    fetch(`/api/books/suggest-genre?title=${encodeURIComponent(titleVal)}&author=${encodeURIComponent(authorVal)}`)
      .then(r => r.json())
      .then(data => {
        if (data && data.genre) {
          newItem.genre = data.genre;
          renderBatchTableA();
        }
      })
      .catch(() => {});

    inputManualTitle.value = '';
    if (inputManualAuthor) inputManualAuthor.value = '';
    inputManualTitle.focus();

    const notice = document.getElementById('batchAStatusNotice');
    if (notice) {
      notice.style.display = 'block';
      notice.textContent = `✅ Added "${titleVal}" to batch!`;
      setTimeout(() => { notice.style.display = 'none'; }, 3000);
    }
  };

  if (btnManualBatchAdd) btnManualBatchAdd.addEventListener('click', addManualBookToBatchA);
  if (inputManualTitle) {
    inputManualTitle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addManualBookToBatchA();
      }
    });
  }
  if (inputManualAuthor) {
    inputManualAuthor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addManualBookToBatchA();
      }
    });
  }

  if (saveBatchBtn) {
    saveBatchBtn.addEventListener('click', async () => {
      if (batchBooksA.length === 0) return;
      saveBatchBtn.disabled = true;
      saveBatchBtn.textContent = 'Saving Batch to Inventory...';

      const booksToSave = batchBooksA.map(b => {
        const r = (b.rack || '').trim();
        const c = (b.column_num || '').trim();
        return {
          ...b,
          rack: r,
          column_num: c,
          position: (r || c) ? (b.position || '').trim() : ''
        };
      });

      try {
        const res = await fetch('/api/books/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ books: booksToSave })
        });
        const data = await res.json();
        if (data.success) {
          alert(`🎉 Batch Successfully Saved!\n\n${data.count} physical books added with unique Inventory IDs to inventory.`);
          batchBooksA = [];
          batchImageHashes = [];
          renderBatchTableA();
          fetchStats();
        } else {
          alert('Failed to save batch: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Network error saving batch: ' + err.message);
      } finally {
        saveBatchBtn.disabled = false;
        saveBatchBtn.textContent = '💾 Save All to Inventory';
      }
    });
  }
}

function renderBatchTableA() {
  const container = document.getElementById('containerBatchA') || document.getElementById('tbodyBatchA');
  const countSpan = document.getElementById('batchCount');
  const saveCountSpan = document.getElementById('batchCountSave');
  const saveBtn = document.getElementById('btnSaveBatchA');

  if (countSpan) countSpan.textContent = batchBooksA.length;
  if (saveCountSpan) saveCountSpan.textContent = batchBooksA.length;
  if (saveBtn) saveBtn.disabled = batchBooksA.length === 0;

  if (!container) return;

  if (batchBooksA.length === 0) {
    container.innerHTML = `
      <div class="candidate-empty-state">
        <div class="empty-icon">📚</div>
        <b>No books in batch yet</b>
        <p>Snap book covers or spines sequentially using <b>"📸 Webcam"</b> or <b>"📱 Snap Next Book"</b>.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = batchBooksA.map((item, idx) => `
    <div class="candidate-card" id="batchCardA_${idx}">
      <div class="candidate-card-header">
        <div class="candidate-spine-badge">
          ${item.photo ? `<img src="${item.photo}" class="candidate-thumb" alt="Book photo">` : ''}
          <span class="spine-num">#${idx + 1}</span>
          <span class="spine-pos-text">${item.confidence === 'processing' ? '⏳ Analyzing spine...' : `Book #${idx + 1}`}</span>
        </div>
        <div class="candidate-header-actions">
          ${item.confidence === 'processing'
            ? `<span class="badge" style="background:#e0f2fe; color:#0369a1;">⏳ Analyzing...</span>`
            : item.flag_uncertain
              ? `<span class="badge badge-warning" title="${escapeHtml(item.warning || '')}">⚠️ Verify</span>`
              : `<span class="badge badge-success">✓ Ready</span>`}
          <button type="button" class="btn btn-sm btn-outline" style="color:var(--danger); border-color:#fca5a5;" onclick="removeBatchItemA(${idx})" title="Remove from batch">
            🗑️ Remove
          </button>
        </div>
      </div>

      <div class="candidate-card-body">
        <div class="candidate-field-group">
          <label class="candidate-field-label">Book Title</label>
          <input type="text" class="candidate-input cand-title-input" value="${escapeHtml(item.title || '')}" oninput="updateBatchItemA(${idx}, 'title', this.value)" placeholder="Enter book title...">
        </div>

        <div class="candidate-field-row">
          <div class="candidate-field-group" style="flex: 1.2;">
            <label class="candidate-field-label">Author</label>
            <input type="text" class="candidate-input" value="${escapeHtml(item.author || '')}" oninput="updateBatchItemA(${idx}, 'author', this.value)" placeholder="Author name">
          </div>
          <div class="candidate-field-group" style="flex: 1;">
            <label class="candidate-field-label">Genre</label>
            <input type="text" class="candidate-input" value="${escapeHtml(item.genre || '')}" oninput="updateBatchItemA(${idx}, 'genre', this.value)" placeholder="Genre (e.g. Fiction)">
          </div>
        </div>

        <div class="candidate-field-row">
          <div class="candidate-field-group" style="flex: 1;">
            <label class="candidate-field-label">Rack (Optional)</label>
            <input type="text" class="candidate-input" value="${escapeHtml(item.rack || '')}" oninput="updateBatchItemA(${idx}, 'rack', this.value)" placeholder="Leave blank if unassigned">
          </div>
          <div class="candidate-field-group" style="flex: 1;">
            <label class="candidate-field-label">Column (Optional)</label>
            <input type="text" class="candidate-input" value="${escapeHtml(item.column_num || '')}" oninput="updateBatchItemA(${idx}, 'column_num', this.value)" placeholder="Leave blank if unassigned">
          </div>
          <div class="candidate-field-group" style="flex: 1;">
            <label class="candidate-field-label">Position (Optional)</label>
            <input type="text" class="candidate-input" value="${escapeHtml(item.position || '')}" oninput="updateBatchItemA(${idx}, 'position', this.value)" placeholder="Optional pos">
          </div>
        </div>
        ${item.warning ? `<div style="font-size:0.78rem; color:#b45309; background:#fef3c7; padding:0.35rem 0.6rem; border-radius:6px; border:1px solid #fde68a;">⚠️ ${escapeHtml(item.warning)}</div>` : ''}
      </div>
    </div>
  `).join('');
}

function updateBatchItemA(index, field, value) {
  if (batchBooksA[index]) {
    batchBooksA[index][field] = value;
  }
}

function removeBatchItemA(index) {
  batchBooksA.splice(index, 1);
  renderBatchTableA();
}

/* =========================================================================
   5. WORKFLOW B: MULTI-BOOK SHELF / STACK PHOTOGRAPHY (Req 1.2)
   ========================================================================= */

let stackCountB = 0;
let stackPhotosQueue = [];

function addPhotoToStackQueue(dataUrl, name = 'shot.jpg') {
  const shotNum = stackPhotosQueue.length + 1;
  stackPhotosQueue.push({
    id: 'shot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    dataUrl: dataUrl,
    name: name,
    label: `Shot #${shotNum}`
  });
  renderStackPhotosQueue();
}

function removePhotoFromStackQueue(id) {
  stackPhotosQueue = stackPhotosQueue.filter(p => p.id !== id);
  stackPhotosQueue.forEach((p, i) => { p.label = `Shot #${i + 1}`; });
  renderStackPhotosQueue();
}
window.removePhotoFromStackQueue = removePhotoFromStackQueue;

function clearStackPhotosQueue() {
  stackPhotosQueue = [];
  renderStackPhotosQueue();
}

function renderStackPhotosQueue() {
  const wrap = document.getElementById('stackPhotosQueueWrap');
  const countSpan = document.getElementById('stackQueueCount');
  const btnProcessCount = document.getElementById('btnProcessStackCount');
  const thumbsList = document.getElementById('stackThumbsList');
  if (!wrap || !thumbsList) return;

  if (countSpan) countSpan.textContent = stackPhotosQueue.length;
  if (btnProcessCount) btnProcessCount.textContent = stackPhotosQueue.length;

  if (stackPhotosQueue.length === 0) {
    wrap.style.display = 'none';
    thumbsList.innerHTML = '';
    return;
  }

  wrap.style.display = 'block';
  thumbsList.innerHTML = stackPhotosQueue.map((item) => `
    <div style="position: relative; display: inline-flex; flex-direction: column; align-items: center; min-width: 90px; max-width: 110px; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 0.4rem; box-shadow: 0 1px 3px rgba(0,0,0,0.06);">
      <button type="button" onclick="window.removePhotoFromStackQueue('${item.id}')" style="position: absolute; top: -6px; right: -6px; width: 20px; height: 20px; border-radius: 50%; background: #ef4444; color: #fff; border: none; font-size: 11px; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 4px rgba(0,0,0,0.2);" title="Remove this shot">✕</button>
      <img src="${item.dataUrl}" alt="${item.label}" style="width: 80px; height: 80px; object-fit: cover; border-radius: 6px; border: 1px solid #e2e8f0;">
      <span style="font-size: 0.75rem; font-weight: 600; color: #334155; margin-top: 0.3rem;">${item.label}</span>
    </div>
  `).join('');
}

async function processAllStackPhotos() {
  if (stackPhotosQueue.length === 0) return;
  const statusLbl = document.getElementById('multiPhotoStatus');
  const processBtn = document.getElementById('btnProcessAllStackPhotos');
  if (processBtn) {
    processBtn.disabled = true;
    processBtn.textContent = '⏳ Processing Stack Photos with AI...';
  }

  const totalShots = stackPhotosQueue.length;
  let accumulatedFromShots = [];
  const seenTitlesInBatch = new Set();

  // Helper to deduplicate books found in overlapping close-up photos of the same stack
  function deduplicateCandidate(cand) {
    const key = (cand.title || '').trim().toLowerCase().replace(/[^\w]/g, '');
    if (!key) return false;
    if (seenTitlesInBatch.has(key)) return false;
    seenTitlesInBatch.add(key);
    return true;
  }

  try {
    for (let i = 0; i < totalShots; i++) {
      const shot = stackPhotosQueue[i];
      if (statusLbl) statusLbl.textContent = `🔍 Reading Shot #${i + 1} of ${totalShots} with AI Vision...`;
      stackCountB++;

      let shotCandidates = [];
      try {
        const res = await fetch('/api/books/ocr-extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            multiple: true,
            spine_mode: true,
            image_data: shot.dataUrl
          })
        });
        const data = await res.json();
        if (data.candidates && data.candidates.length > 0) {
          shotCandidates = data.candidates;
        }
      } catch (e) {
        console.warn(`Error scanning shot #${i + 1}:`, e);
      }

      // If direct AI vision didn't catch anything, run local Tesseract OCR fallback
      if (shotCandidates.length === 0 && window.Tesseract) {
        try {
          if (statusLbl) statusLbl.textContent = `🔍 Reading Shot #${i + 1} with local OCR fallback...`;
          const ocrRes = await Tesseract.recognize(shot.dataUrl, 'eng');
          const text = ocrRes.data?.text || '';
          const ocrLines = text.split('\n').map(l => l.trim()).filter(l => l.length >= 2);
          const fbRes = await fetch('/api/books/ocr-extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              raw_text: ocrLines.join('\n---\n'),
              multiple: true,
              spine_mode: true,
              image_data: shot.dataUrl
            })
          });
          const fbData = await fbRes.json();
          if (fbData.candidates && fbData.candidates.length > 0) {
            shotCandidates = fbData.candidates;
          }
        } catch (tErr) {
          console.warn('Fallback OCR notice:', tErr);
        }
      }

      // Filter duplicates and tag items
      const uniqueFromShot = shotCandidates.filter(deduplicateCandidate);
      const tagged = uniqueFromShot.map((cand, idx) => ({
        ...cand,
        stack_num: stackCountB,
        stack_index: idx,
        stack_total: uniqueFromShot.length,
        rack: '',
        column_num: '',
        position: '',
        skipped: false
      }));
      accumulatedFromShots = accumulatedFromShots.concat(tagged);
    }

    batchCandidatesB = batchCandidatesB.concat(accumulatedFromShots);
    renderBatchTableB();

    if (statusLbl) {
      statusLbl.textContent = `🎉 Detected ${accumulatedFromShots.length} books across ${totalShots} close-up shot(s)! (Total candidates: ${batchCandidatesB.length})`;
    }
    stackPhotosQueue = [];
    renderStackPhotosQueue();
  } catch (err) {
    if (statusLbl) statusLbl.textContent = 'Error processing stack photos: ' + err.message;
  } finally {
    if (processBtn) {
      processBtn.disabled = false;
      processBtn.innerHTML = `⚡ Get All Information at Once from <span id="btnProcessStackCount">0</span> Photos with AI`;
    }
  }
}

async function processStackPhoto(base64Data, filename = 'stack.jpg') {
  addPhotoToStackQueue(base64Data, filename);
  await processAllStackPhotos();
}

function initBatchB() {
  const cameraInput = document.getElementById('multiBookCameraInput');
  const fileInput = document.getElementById('multiBookFileInput');
  const liveCameraBtn = document.getElementById('btnBatchBLiveCamera');
  const saveBtn = document.getElementById('btnSaveBatchB');
  const clearBtn = document.getElementById('btnClearBatchB');
  const btnAddAnother = document.getElementById('btnAddAnotherStackPhoto');
  const btnClearQueue = document.getElementById('btnClearStackQueue');
  const btnProcessStack = document.getElementById('btnProcessAllStackPhotos');

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (confirm('Clear all accumulated stacks?')) {
        batchCandidatesB = [];
        stackCountB = 0;
        renderBatchTableB();
      }
    });
  }

  const btnCameraB = document.getElementById('btnMultiBookCamera');
  const btnFileB = document.getElementById('btnMultiBookFile');

  if (btnCameraB && cameraInput) {
    btnCameraB.addEventListener('click', (e) => {
      e.preventDefault();
      cameraInput.click();
    });
  }

  if (btnAddAnother && cameraInput) {
    btnAddAnother.addEventListener('click', (e) => {
      e.preventDefault();
      cameraInput.click();
    });
  }

  if (btnFileB && fileInput) {
    btnFileB.addEventListener('click', (e) => {
      e.preventDefault();
      fileInput.click();
    });
  }

  if (btnClearQueue) {
    btnClearQueue.addEventListener('click', () => {
      if (confirm('Clear all queued close-up shots?')) {
        clearStackPhotosQueue();
      }
    });
  }

  if (btnProcessStack) {
    btnProcessStack.addEventListener('click', () => {
      processAllStackPhotos();
    });
  }

  if (liveCameraBtn) {
    liveCameraBtn.addEventListener('click', () => {
      if (typeof window.openLiveCamera === 'function') {
        window.openLiveCamera('batchB');
      }
    });
  }

  const handleBatchBFiles = async (files) => {
    if (!files || files.length === 0) return;
    const statusLbl = document.getElementById('multiPhotoStatus');
    if (statusLbl) statusLbl.textContent = `Optimizing ${files.length} close-up photo(s)...`;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const downscaledB64 = await downscaleImage(file, 1600, 0.88);
        addPhotoToStackQueue(downscaledB64, file.name || `shot_${stackPhotosQueue.length + 1}.jpg`);
      } catch (err) {
        console.warn('Error reading photo:', err);
      }
    }
    if (cameraInput) cameraInput.value = '';
    if (fileInput) fileInput.value = '';

    if (statusLbl) {
      statusLbl.textContent = `📸 ${stackPhotosQueue.length} close-up shot(s) ready! Tap "+ Add Another Shot" for more sections, or tap "Get All Information at Once" below.`;
    }
  };

  if (cameraInput) cameraInput.addEventListener('change', (e) => handleBatchBFiles(e.target.files));
  if (fileInput) fileInput.addEventListener('change', (e) => handleBatchBFiles(e.target.files));

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
    const validBooks = batchCandidatesB
      .filter(b => b.title && b.title.trim() && !b.skipped)
      .map(b => {
        const r = (b.rack || '').trim();
        const c = (b.column_num || '').trim();
        return {
          ...b,
          rack: r,
          column_num: c,
          position: (r || c) ? (b.position || '').trim() : ''
        };
      });
    if (validBooks.length === 0) {
      alert('No valid books to save.');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving Confirmed Books...';

    try {
      const res = await fetch('/api/books/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ books: validBooks })
      });
      const data = await res.json();
      if (data.success) {
        alert(`🎉 Successfully confirmed and saved ${data.count} books from all stacks to inventory!`);
        batchCandidatesB = [];
        stackCountB = 0;
        renderBatchTableB();
        fetchStats();
      } else {
        alert('Failed to save: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Error: ' + err.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '💾 Confirm & Save Valid Books';
    }
  });
  }
}

function getSpinePositionLabel(index, total, stackNumber, stackTotal, stackIndex) {
  if (stackNumber && stackTotal) {
    let pos = 'Middle';
    if (stackIndex === 0) pos = 'Top of stack';
    else if (stackIndex === stackTotal - 1 && stackTotal > 1) pos = 'Bottom of stack';
    else {
      const ordinals = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];
      pos = `${ordinals[stackIndex] || `#${stackIndex + 1}`} from top`;
    }
    return `Stack #${stackNumber} • ${pos} (Book #${index + 1})`;
  }
  if (index === 0) return 'Top of stack (#1)';
  if (index === total - 1 && total > 1) return `Bottom of stack (#${index + 1})`;
  const ordinals = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];
  const ord = ordinals[index] || `#${index + 1}`;
  return `${ord} from top (#${index + 1})`;
}

function renderBatchTableB() {
  const container = document.getElementById('containerBatchB') || document.getElementById('tbodyBatchB');
  const countSpan = document.getElementById('multiCandidateCount');
  const saveBtn = document.getElementById('btnSaveBatchB');
  const labelSnap = document.getElementById('labelSnapStackB');
  const clearBtn = document.getElementById('btnClearBatchB');

  const validCount = batchCandidatesB.filter(b => !b.skipped).length;
  if (countSpan) countSpan.textContent = validCount;
  if (saveBtn) saveBtn.disabled = validCount === 0;

  if (labelSnap) {
    labelSnap.textContent = batchCandidatesB.length > 0 
      ? `📸 + Snap Another Stack (${stackCountB} added)` 
      : '📸 Take Stack Photo';
  }
  if (clearBtn) {
    clearBtn.style.display = batchCandidatesB.length > 0 ? 'inline-block' : 'none';
  }

  if (!container) return;

  if (batchCandidatesB.length === 0) {
    container.innerHTML = `
      <div class="candidate-empty-state">
        <div class="empty-icon">📖</div>
        <b>Stack photography mode</b>
        <p>Take a photo of a stack of books (stacked one on top of each other) to automatically detect all spines. You can photograph multiple stacks one after another to combine them!</p>
      </div>
    `;
    return;
  }

  container.innerHTML = batchCandidatesB.map((cand, idx) => {
    const posLabel = getSpinePositionLabel(idx, batchCandidatesB.length, cand.stack_num, cand.stack_total, cand.stack_index);
    return `
      <div class="candidate-card ${cand.skipped ? 'is-skipped' : ''}" id="batchCardB_${idx}">
        <div class="candidate-card-header">
          <div class="candidate-spine-badge">
            <span class="spine-num">#${idx + 1}</span>
            <span class="spine-pos-text">${posLabel}</span>
          </div>
          <div class="candidate-header-actions">
            ${cand.flag_uncertain
              ? `<span class="badge badge-warning" title="${escapeHtml(cand.warning || 'Uncertain spine text')}">⚠️ Check</span>`
              : `<span class="badge badge-success">✓ Spine Detected</span>`}
            <button type="button" class="btn btn-sm ${cand.skipped ? 'btn-primary' : 'btn-outline'}" onclick="toggleSkipCandidateB(${idx})">
              ${cand.skipped ? '↩ Restore' : '✕ Skip'}
            </button>
            <button type="button" class="btn btn-sm btn-outline" style="color:var(--danger); border-color:#fca5a5;" onclick="removeBatchCandidateB(${idx})" title="Remove from list">
              🗑️
            </button>
          </div>
        </div>

        <div class="candidate-card-body">
          <div class="candidate-field-group">
            <label class="candidate-field-label">Book Title</label>
            <input type="text" class="candidate-input cand-title-input" value="${escapeHtml(cand.title || '')}" oninput="updateBatchItemB(${idx}, 'title', this.value)" placeholder="Book Title">
          </div>

          <div class="candidate-field-row">
            <div class="candidate-field-group" style="flex: 1.2;">
              <label class="candidate-field-label">Author</label>
              <input type="text" class="candidate-input" value="${escapeHtml(cand.author || '')}" oninput="updateBatchItemB(${idx}, 'author', this.value)" placeholder="Author">
            </div>
            <div class="candidate-field-group" style="flex: 1;">
              <label class="candidate-field-label">Genre</label>
              <input type="text" class="candidate-input" value="${escapeHtml(cand.genre || '')}" oninput="updateBatchItemB(${idx}, 'genre', this.value)" placeholder="Genre (e.g. Business, Fiction)">
            </div>
          </div>

          <div class="candidate-field-row">
            <div class="candidate-field-group" style="flex: 1;">
              <label class="candidate-field-label">Rack (Optional)</label>
              <input type="text" class="candidate-input" value="${escapeHtml(cand.rack || '')}" oninput="updateBatchItemB(${idx}, 'rack', this.value)" placeholder="Leave blank if unassigned">
            </div>
            <div class="candidate-field-group" style="flex: 1;">
              <label class="candidate-field-label">Column (Optional)</label>
              <input type="text" class="candidate-input" value="${escapeHtml(cand.column_num || '')}" oninput="updateBatchItemB(${idx}, 'column_num', this.value)" placeholder="Leave blank if unassigned">
            </div>
          </div>

          ${cand.existing_in_inventory ? `<div class="candidate-existing-tag">ℹ️ Matches existing title in catalog (will add as an additional copy)</div>` : ''}
          ${cand.skipped ? `<div style="font-size:0.78rem; color:#64748b; font-style:italic;">This spine is skipped and will not be saved. Click "Restore" above if you want to include it.</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function removeBatchCandidateB(index) {
  if (batchCandidatesB[index]) {
    batchCandidatesB.splice(index, 1);
    renderBatchTableB();
  }
}

function updateBatchItemB(index, field, value) {
  if (batchCandidatesB[index]) {
    batchCandidatesB[index][field] = value;
  }
}

function toggleSkipCandidateB(index) {
  if (batchCandidatesB[index]) {
    batchCandidatesB[index].skipped = !batchCandidatesB[index].skipped;
    renderBatchTableB();
  }
}

/* =========================================================================
   6. SELLING WORKFLOW (POS) (Req 3, Multi-Book Sale & Workflows A & B)
   ========================================================================= */

let posCart = [];
let posBatchCandidatesB = [];

function addToPosCart(item) {
  if (!item || !item.book_id) return;
  const existing = posCart.find(x => x.book_id === item.book_id);
  if (existing) {
    alert(`"${item.title || item.book_id}" is already in your Sale Cart.`);
    return;
  }
  posCart.push({
    book_id: item.book_id,
    title: item.title || 'Unknown Title',
    author: item.author || '',
    location_english: item.location_english || 'Unassigned',
    price: item.price !== undefined && item.price !== null ? item.price : null
  });
  renderPosCart();

  // Scroll to cart smoothly if it's the first item
  if (posCart.length === 1) {
    const cartSec = document.getElementById('posCartSection');
    if (cartSec) cartSec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function removeFromPosCart(index) {
  if (posCart[index]) {
    posCart.splice(index, 1);
    renderPosCart();
  }
}

function clearPosCart() {
  posCart = [];
  renderPosCart();
}

function updatePosCartItemPrice(index, val) {
  if (posCart[index]) {
    const num = parseFloat(val);
    posCart[index].price = (!isNaN(num) && num >= 0) ? num : null;
    recalculatePosCartTotal();
  }
}

function recalculatePosCartTotal() {
  let total = 0;
  let hasPrices = false;
  posCart.forEach(item => {
    if (item.price !== null && !isNaN(item.price)) {
      total += item.price;
      hasPrices = true;
    }
  });
  const totalSpan = document.getElementById('posCartTotalPrice');
  if (totalSpan) {
    totalSpan.textContent = hasPrices ? `₹${total.toFixed(2)}` : '₹0.00';
  }
}

function renderPosCart() {
  const cartSection = document.getElementById('posCartSection');
  const countSpan = document.getElementById('posCartCount');
  const totalItemsSpan = document.getElementById('posCartTotalItems');
  const btnCountSpan = document.getElementById('posCartBtnCount');
  const itemsContainer = document.getElementById('posCartItemsList');

  if (!cartSection) return;

  const count = posCart.length;
  if (countSpan) countSpan.textContent = count;
  if (totalItemsSpan) totalItemsSpan.textContent = count;
  if (btnCountSpan) btnCountSpan.textContent = count;

  if (count === 0) {
    cartSection.style.display = 'none';
    if (itemsContainer) itemsContainer.innerHTML = '';
    return;
  }

  cartSection.style.display = 'block';

  if (itemsContainer) {
    itemsContainer.innerHTML = posCart.map((item, idx) => `
      <div class="pos-cart-item">
        <div class="pos-cart-item-details">
          <div class="pos-cart-item-title">${escapeHtml(item.title)}</div>
          <div class="pos-cart-item-meta">
            ${item.author ? `<span>by ${escapeHtml(item.author)}</span>` : ''}
            <span>📍 ${escapeHtml(item.location_english || 'Unassigned')}</span>
          </div>
        </div>
        <div class="pos-cart-item-price-wrap">
          <input type="number" step="any" min="0" placeholder="Price (₹)" 
                 class="pos-cart-item-price-input" 
                 value="${item.price !== null && item.price !== undefined ? item.price : ''}" 
                 oninput="updatePosCartItemPrice(${idx}, this.value)">
          <button type="button" class="btn btn-sm btn-outline" style="color:var(--danger); border-color:#fca5a5; padding:0.25rem 0.5rem;" onclick="removeFromPosCart(${idx})" title="Remove from cart">
            ✕
          </button>
        </div>
      </div>
    `).join('');
  }

  recalculatePosCartTotal();
}

async function processPosSearchImage(fileOrB64, fallbackName = 'cover.jpg') {
  const searchInput = document.getElementById('posSearchInput');
  searchInput.value = '📸 Optimizing photo...';
  try {
    let base64Data = fileOrB64;
    if (typeof fileOrB64 !== 'string') {
      base64Data = await downscaleImage(fileOrB64, 1200, 0.85);
    }

    let clientOcrText = '';
    if (window.Tesseract) {
      searchInput.value = '🔍 Reading cover / spine...';
      try {
        const tRes = await Tesseract.recognize(base64Data, 'eng');
        clientOcrText = (tRes.data?.text || '').trim();
      } catch (tErr) {
        console.warn('Local OCR warning:', tErr);
      }
    }

    searchInput.value = '📚 Matching inventory...';
    const ocrRes = await fetch('/api/books/ocr-extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw_text: clientOcrText || fallbackName.replace(/\.[^/.]+$/, "").replace(/[_\-]/g, " "),
        image_data: base64Data
      })
    });
    const cand = await ocrRes.json();
    if (cand && cand.title && cand.title.trim()) {
      searchInput.value = cand.title.trim();
      searchPOS(cand.title.trim());
    } else if (clientOcrText) {
      const lines = clientOcrText.split('\n')
        .map(l => l.replace(/[^a-zA-Z0-9\s\-\':]/g, '').trim())
        .filter(l => l.length >= 3 && !/^(bestseller|edition|novel|published|isbn|\d+$)/i.test(l));
      const bestGuess = lines.length ? lines.sort((a, b) => b.length - a.length)[0] : clientOcrText.slice(0, 40);
      searchInput.value = bestGuess;
      searchPOS(bestGuess);
    } else {
      searchInput.value = '';
      alert('Could not identify book from photo. Please enter Book ID or title.');
    }
  } catch (err) {
    searchInput.value = '';
    alert('Photo analysis note: ' + err.message);
  }
}

/* Workflow A for Selling: Rapid Multi-Scan directly into Sale Cart */
async function processPosBatchAFile(fileOrBase64, filename = 'scan.jpg') {
  const notice = document.getElementById('posBatchAStatusNotice');
  if (notice) {
    notice.style.display = 'block';
    notice.textContent = '🔍 Reading book cover/spine with AI Vision...';
  }

  try {
    let base64Data = fileOrBase64;
    if (typeof fileOrBase64 !== 'string') {
      base64Data = await fileToBase64(fileOrBase64);
    }

    const ocrRes = await fetch('/api/books/ocr-extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_data: base64Data,
        raw_text: filename.replace(/\.[^/.]+$/, "").replace(/[_\-]/g, " ")
      })
    });
    const cand = await ocrRes.json();
    const queryTitle = (cand.title || '').trim();

    if (!queryTitle) {
      if (notice) notice.textContent = '⚠️ Could not read title from photo. Please try again.';
      return;
    }

    // Match against inventory
    const searchRes = await fetch(`/api/search?q=${encodeURIComponent(queryTitle)}`);
    const searchData = await searchRes.json();
    const allMatches = [...(searchData.exact_matches || []), ...(searchData.possible_matches || [])];

    let availableCopy = null;
    let matchedGroup = null;

    for (const g of allMatches) {
      const copy = (g.copies || []).find(c => c.status === 'Available');
      if (copy) {
        availableCopy = copy;
        matchedGroup = g;
        break;
      }
    }

    if (availableCopy && matchedGroup) {
      addToPosCart({
        book_id: availableCopy.book_id,
        title: matchedGroup.title,
        author: matchedGroup.author,
        location_english: availableCopy.location_english
      });
      if (notice) {
        notice.style.display = 'block';
        notice.textContent = `✅ Added "${matchedGroup.title}" (${availableCopy.book_id}) to Sale Cart! Snap next book.`;
      }
    } else {
      if (notice) {
        notice.style.display = 'block';
        notice.textContent = `⚠️ Detected "${queryTitle}", but no available copies were found in store.`;
      }
    }
  } catch (err) {
    if (notice) notice.textContent = 'Error: ' + err.message;
  }
}

/* Workflow B for Selling: Stack Photo Sell */
let posStackCountB = 0;

async function processPosStackPhoto(fileOrBase64, filename = 'stack.jpg') {
  const previewWrap = document.getElementById('posMultiPhotoPreviewWrap');
  const previewImg = document.getElementById('posMultiPhotoImg');
  const statusLbl = document.getElementById('posMultiPhotoStatus');

  let base64Data = fileOrBase64;
  if (typeof fileOrBase64 !== 'string') {
    base64Data = await fileToBase64(fileOrBase64);
  }

  if (previewWrap) previewWrap.style.display = 'block';
  if (previewImg) previewImg.src = base64Data;
  posStackCountB++;
  if (statusLbl) statusLbl.textContent = `🔍 Reading Stack #${posStackCountB} to sell with AI Vision (spines top to bottom)...`;

  try {
    const res = await fetch('/api/books/ocr-extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        multiple: true,
        spine_mode: true,
        image_data: base64Data
      })
    });
    const data = await res.json();
    const rawCandidates = data.candidates || [];

    const newCandidates = [];
    for (let idx = 0; idx < rawCandidates.length; idx++) {
      const cand = rawCandidates[idx];
      let copyId = cand.available_book_id || null;
      let locEng = cand.location_english || '';

      if (!copyId && cand.title) {
        try {
          const sRes = await fetch(`/api/search?q=${encodeURIComponent(cand.title)}`);
          const sData = await sRes.json();
          const matches = [...(sData.exact_matches || []), ...(sData.possible_matches || [])];
          for (const m of matches) {
            const avail = (m.copies || []).find(c => c.status === 'Available');
            if (avail) {
              copyId = avail.book_id;
              locEng = avail.location_english;
              break;
            }
          }
        } catch (e) {
          console.warn('Matching candidate notice:', e);
        }
      }

      newCandidates.push({
        candidate_index: posBatchCandidatesB.length + idx + 1,
        stack_num: posStackCountB,
        stack_index: idx,
        stack_total: rawCandidates.length,
        title: cand.title || 'Unknown Title',
        author: cand.author || '',
        available_book_id: copyId,
        location_english: locEng,
        is_available: !!copyId,
        price: null,
        skipped: !copyId
      });
    }

    posBatchCandidatesB = posBatchCandidatesB.concat(newCandidates);

    const availableCount = posBatchCandidatesB.filter(b => b.is_available).length;
    if (statusLbl) {
      statusLbl.textContent = `✅ Stack #${posStackCountB}: Detected ${newCandidates.length} books. Total books in stack list: ${posBatchCandidatesB.length} (${availableCount} available to sell). You can photograph another stack or click "Add Valid Books to Cart".`;
    }
    renderPosBatchB();
  } catch (err) {
    if (statusLbl) statusLbl.textContent = 'Error processing stack: ' + err.message;
  }
}

function renderPosBatchB() {
  const container = document.getElementById('containerPosBatchB');
  const validCountSpan = document.getElementById('posStackValidCount');
  const btnAddAll = document.getElementById('btnAddAllStackToCart');
  const labelSnap = document.getElementById('labelPosSnapStackB');
  const clearBtn = document.getElementById('btnClearPosBatchB');

  const validAvailable = posBatchCandidatesB.filter(b => b.is_available && !b.skipped);
  if (validCountSpan) validCountSpan.textContent = validAvailable.length;
  if (btnAddAll) btnAddAll.disabled = validAvailable.length === 0;

  if (labelSnap) {
    labelSnap.textContent = posBatchCandidatesB.length > 0
      ? `📸 + Snap Another Stack (${posStackCountB} added)`
      : '📸 Take Stack Photo';
  }
  if (clearBtn) {
    clearBtn.style.display = posBatchCandidatesB.length > 0 ? 'inline-block' : 'none';
  }

  if (!container) return;

  if (posBatchCandidatesB.length === 0) {
    container.innerHTML = `
      <div class="candidate-empty-state">
        <div class="empty-icon">📚</div>
        <b>Photograph a stack of books to sell</b>
        <p>Place books in a stack on the counter and take a photo. AI vision will detect each book spine from top to bottom and match it with available inventory copies. You can photograph multiple stacks to combine them!</p>
      </div>
    `;
    return;
  }

  container.innerHTML = posBatchCandidatesB.map((cand, idx) => {
    const posLabel = getSpinePositionLabel(idx, posBatchCandidatesB.length, cand.stack_num, cand.stack_total, cand.stack_index);
    const inCart = cand.available_book_id && posCart.some(c => c.book_id === cand.available_book_id);

    return `
      <div class="candidate-card ${cand.skipped ? 'is-skipped' : ''}" id="posBatchCardB_${idx}">
        <div class="candidate-card-header">
          <div class="candidate-spine-badge">
            <span class="spine-num">#${idx + 1}</span>
            <span class="spine-pos-text">${posLabel}</span>
          </div>
          <div class="candidate-header-actions">
            ${cand.is_available 
              ? `<span class="badge badge-success">✓ Available in Store</span>`
              : `<span class="badge badge-warning">⚠️ Not in Stock</span>`}
            ${cand.is_available ? `
              <button type="button" class="btn btn-sm ${inCart ? 'btn-success' : 'btn-primary'}" onclick="addStackCandidateToCart(${idx})">
                ${inCart ? '✓ In Cart' : '+ Add to Cart'}
              </button>
            ` : ''}
            <button type="button" class="btn btn-sm btn-outline" onclick="toggleSkipPosCandidateB(${idx})">
              ${cand.skipped ? '↩ Include' : '✕ Exclude'}
            </button>
            <button type="button" class="btn btn-sm btn-outline" style="color:var(--danger); border-color:#fca5a5;" onclick="removePosBatchCandidateB(${idx})" title="Remove from list">
              🗑️
            </button>
          </div>
        </div>

        <div class="candidate-card-body">
          <div class="candidate-field-group">
            <label class="candidate-field-label">Book Title</label>
            <input type="text" class="candidate-input cand-title-input" value="${escapeHtml(cand.title || '')}" oninput="updatePosCandidateB(${idx}, 'title', this.value)">
          </div>

          <div class="candidate-field-row">
            <div class="candidate-field-group" style="flex: 1.2;">
              <label class="candidate-field-label">Author</label>
              <input type="text" class="candidate-input" value="${escapeHtml(cand.author || '')}" oninput="updatePosCandidateB(${idx}, 'author', this.value)">
            </div>
            <div class="candidate-field-group" style="flex: 1;">
              <label class="candidate-field-label">Selling Price (₹)</label>
              <input type="number" step="any" min="0" placeholder="Optional price (₹)" class="candidate-input" value="${cand.price !== null ? cand.price : ''}" oninput="updatePosCandidateB(${idx}, 'price', this.value)">
            </div>
          </div>

          ${cand.is_available ? `
            <div class="candidate-existing-tag" style="background:#ecfdf5; border-color:#a7f3d0; color:#065f46;">
              ✓ Matched physical copy: <b>${escapeHtml(cand.available_book_id)}</b> (📍 ${escapeHtml(cand.location_english || 'Unassigned')})
            </div>
          ` : `
            <div class="candidate-existing-tag" style="background:#fffbeb; border-color:#fde68a; color:#b45309;">
              ⚠️ No available copies found in inventory. Cannot sell this title.
            </div>
          `}
        </div>
      </div>
    `;
  }).join('');
}

function removePosBatchCandidateB(index) {
  if (posBatchCandidatesB[index]) {
    posBatchCandidatesB.splice(index, 1);
    renderPosBatchB();
  }
}

function updatePosCandidateB(index, field, value) {
  if (posBatchCandidatesB[index]) {
    if (field === 'price') {
      const num = parseFloat(value);
      posBatchCandidatesB[index].price = (!isNaN(num) && num >= 0) ? num : null;
    } else {
      posBatchCandidatesB[index][field] = value;
    }
  }
}

function toggleSkipPosCandidateB(index) {
  if (posBatchCandidatesB[index]) {
    posBatchCandidatesB[index].skipped = !posBatchCandidatesB[index].skipped;
    renderPosBatchB();
  }
}

function addStackCandidateToCart(index) {
  const cand = posBatchCandidatesB[index];
  if (!cand || !cand.available_book_id) return;
  addToPosCart({
    book_id: cand.available_book_id,
    title: cand.title,
    author: cand.author,
    location_english: cand.location_english,
    price: cand.price
  });
  renderPosBatchB();
}

function initPOS() {
  const searchInput = document.getElementById('posSearchInput');
  const drawer = document.getElementById('saleDrawer');
  const closeBtn = document.getElementById('btnCloseSaleDrawer');
  const confirmBtn = document.getElementById('btnConfirmSale');
  const cameraInput = document.getElementById('posCameraInput');
  const fileInput = document.getElementById('posFileInput');
  const liveCameraBtn = document.getElementById('btnPosLiveCamera');

  // Mode switcher tabs in POS
  const posModeBtns = document.querySelectorAll('[data-pos-mode]');
  posModeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      posModeBtns.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.pos-mode-content').forEach(c => c.style.display = 'none');

      btn.classList.add('active');
      const mode = btn.getAttribute('data-pos-mode');
      if (mode === 'posSingle') document.getElementById('sectionPosSingle').style.display = 'block';
      if (mode === 'posBatchA') document.getElementById('sectionPosBatchA').style.display = 'block';
      if (mode === 'posBatchB') document.getElementById('sectionPosBatchB').style.display = 'block';
    });
  });

  // Workflow A inputs
  const posBatchACamInput = document.getElementById('posBatchACameraInput');
  const posBatchAFlInput = document.getElementById('posBatchAFileInput');
  const btnPosBatchALive = document.getElementById('btnPosBatchALiveCamera');

  if (btnPosBatchALive) {
    btnPosBatchALive.addEventListener('click', () => {
      if (typeof window.openLiveCamera === 'function') {
        window.openLiveCamera('posBatchA');
      }
    });
  }

  const handlePosBatchA = async (file) => {
    if (!file) return;
    try {
      const downscaled = await downscaleImage(file, 1200, 0.85);
      await processPosBatchAFile(downscaled, file.name);
      if (posBatchACamInput) posBatchACamInput.value = '';
      if (posBatchAFlInput) posBatchAFlInput.value = '';
    } catch (e) {
      alert('Error reading photo: ' + e.message);
    }
  };

  if (posBatchACamInput) posBatchACamInput.addEventListener('change', (e) => handlePosBatchA(e.target.files[0]));
  if (posBatchAFlInput) posBatchAFlInput.addEventListener('change', (e) => handlePosBatchA(e.target.files[0]));

  // Workflow B inputs
  const posBatchBCamInput = document.getElementById('posBatchBCameraInput');
  const posBatchBFlInput = document.getElementById('posBatchBFileInput');
  const btnPosBatchBLive = document.getElementById('btnPosBatchBLiveCamera');
  const btnAddAllStack = document.getElementById('btnAddAllStackToCart');

  if (btnPosBatchBLive) {
    btnPosBatchBLive.addEventListener('click', () => {
      if (typeof window.openLiveCamera === 'function') {
        window.openLiveCamera('posBatchB');
      }
    });
  }

  const handlePosBatchB = async (file) => {
    if (!file) return;
    try {
      const downscaled = await downscaleImage(file, 1600, 0.88);
      await processPosStackPhoto(downscaled, file.name);
      if (posBatchBCamInput) posBatchBCamInput.value = '';
      if (posBatchBFlInput) posBatchBFlInput.value = '';
    } catch (e) {
      alert('Error reading stack photo: ' + e.message);
    }
  };

  if (posBatchBCamInput) posBatchBCamInput.addEventListener('change', (e) => handlePosBatchB(e.target.files[0]));
  if (posBatchBFlInput) posBatchBFlInput.addEventListener('change', (e) => handlePosBatchB(e.target.files[0]));

  if (btnAddAllStack) {
    btnAddAllStack.addEventListener('click', () => {
      const available = posBatchCandidatesB.filter(b => b.is_available && !b.skipped);
      if (available.length === 0) return;
      available.forEach(cand => {
        addToPosCart({
          book_id: cand.available_book_id,
          title: cand.title,
          author: cand.author,
          location_english: cand.location_english,
          price: cand.price
        });
      });
      alert(`🎉 Added ${available.length} books from all stacks into your Sale Cart!`);
      renderPosBatchB();
    });
  }

  const clearPosStackBtn = document.getElementById('btnClearPosBatchB');
  if (clearPosStackBtn) {
    clearPosStackBtn.addEventListener('click', () => {
      if (confirm('Clear all accumulated stacks to sell?')) {
        posBatchCandidatesB = [];
        posStackCountB = 0;
        renderPosBatchB();
      }
    });
  }

  // Cart actions
  const btnClearCart = document.getElementById('btnClearPosCart');
  if (btnClearCart) {
    btnClearCart.addEventListener('click', () => {
      if (confirm('Are you sure you want to clear all books from the Sale Cart?')) {
        clearPosCart();
      }
    });
  }

  const btnCheckoutCart = document.getElementById('btnCheckoutPosCart');
  if (btnCheckoutCart) {
    btnCheckoutCart.addEventListener('click', async () => {
      if (posCart.length === 0) return;
      btnCheckoutCart.disabled = true;
      btnCheckoutCart.textContent = `Processing Sale of ${posCart.length} Books...`;

      const sharedNotes = (document.getElementById('posCartNotes')?.value || '').trim();

      const payload = {
        books: posCart.map(c => ({
          book_id: c.book_id,
          selling_price: c.price,
          notes: sharedNotes
        })),
        notes: sharedNotes
      };

      try {
        const res = await fetch('/api/books/sell', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (data.success) {
          const count = data.count || posCart.length;
          posCart = [];
          posBatchCandidatesB = [];
          renderPosCart();
          renderPosBatchB();

          const posInput = document.getElementById('posSearchInput');
          if (posInput && posInput.value.trim()) {
            searchPOS(posInput.value.trim());
          }

          fetchStats();
          renderDigitalReceipt(data);
          alert(`🎉 Sale Confirmed!\n\n${count} books marked SOLD OUT.`);
        } else {
          alert('Cannot complete sale: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Network error completing sale: ' + err.message);
      } finally {
        btnCheckoutCart.disabled = false;
        btnCheckoutCart.textContent = `✅ Complete Sale & Mark SOLD OUT`;
      }
    });
  }

  // Mode 1: Single search / scan
  if (liveCameraBtn) {
    liveCameraBtn.addEventListener('click', () => {
      if (typeof window.openLiveCamera === 'function') {
        window.openLiveCamera('pos');
      }
    });
  }

  let posDebounce = null;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      clearTimeout(posDebounce);
      posDebounce = setTimeout(() => {
        searchPOS(searchInput.value);
      }, 250);
    });
  }

  const handlePosFile = async (file) => {
    if (!file) return;
    await processPosSearchImage(file, file.name);
    if (cameraInput) cameraInput.value = '';
    if (fileInput) fileInput.value = '';
  };

  if (cameraInput) cameraInput.addEventListener('change', (e) => handlePosFile(e.target.files[0]));
  if (fileInput) fileInput.addEventListener('change', (e) => handlePosFile(e.target.files[0]));

  const hideSaleDrawer = () => {
    if (drawer) drawer.style.display = 'none';
    activeSaleCopy = null;
  };

  if (closeBtn) closeBtn.addEventListener('click', hideSaleDrawer);
  const btnCancelSaleDrawer = document.getElementById('btnCancelSaleDrawer');
  if (btnCancelSaleDrawer) {
    btnCancelSaleDrawer.addEventListener('click', hideSaleDrawer);
  }

  // Also close when clicking outside modal card on backdrop
  if (drawer) {
    drawer.addEventListener('click', (e) => {
      if (e.target === drawer) {
        hideSaleDrawer();
      }
    });
  }

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      if (!activeSaleCopy) return;

      confirmBtn.disabled = true;
    confirmBtn.textContent = 'Processing Sale...';

    const priceInput = document.getElementById('salePrice').value;
    const notesInput = document.getElementById('saleNotes').value;

    const payload = {
      book_id: activeSaleCopy.book_id,
      selling_price: priceInput ? parseFloat(priceInput) : null,
      notes: notesInput
    };

    try {
      const res = await fetch('/api/books/sell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (data.success) {
        drawer.style.display = 'none';

        const soldTitle = activeSaleCopy.title || (data.book && data.book.title) || 'Book';
        const soldBid = activeSaleCopy.book_id;
        activeSaleCopy = null;

        // Refresh search results if user was in Search tab
        const mainSearchInput = document.getElementById('searchInput');
        if (mainSearchInput && mainSearchInput.value.trim()) {
          performSearch(mainSearchInput.value.trim());
        }

        // Refresh POS candidates if in POS tab
        const posInput = document.getElementById('posSearchInput');
        if (posInput && posInput.value.trim()) {
          searchPOS(posInput.value.trim());
        }

        fetchStats();
        renderDigitalReceipt(data);
        alert(`✅ Sale Confirmed!\n\n"${soldTitle}" (${soldBid})\nMarked SOLD OUT.\nTransaction Ref: ${data.transaction_ref}`);
      } else {
        alert('Cannot complete sale: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Network error completing sale: ' + err.message);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = '✅ Complete Sale & Mark SOLD OUT';
    }
  });
  }
}

async function searchPOS(query) {
  const container = document.getElementById('posCandidatesContainer');
  if (!query || !query.trim()) {
    container.innerHTML = '<div class="empty-state-card">Type an Inventory ID (e.g. <b>BK-10151</b>) or book title above.</div>';
    return;
  }

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();

    const allMatches = [...(data.exact_matches || []), ...(data.possible_matches || [])];

    if (allMatches.length === 0) {
      container.innerHTML = '<div class="empty-state-card">No matching books found in inventory.</div>';
      return;
    }

    const allCopies = [];
    allMatches.forEach(group => {
      const copies = (group.copies && group.copies.length > 0) ? group.copies : [group];
      copies.forEach(copy => {
        allCopies.push({ group, copy });
      });
    });

    if (allCopies.length === 0) {
      container.innerHTML = '<div class="empty-state-card">No matching books found in inventory.</div>';
      return;
    }

    container.innerHTML = allCopies.map(({ group, copy }) => {
      const cleanTitle = cleanBookTitle(group.title);
      const coverHtml = getBookCoverHtml(cleanTitle, group.author, group.simple_genre || group.genre, group.image_url);
      const state = getBookState(group, copy);
      const bid = copy.book_id || '';
      const inCart = posCart.some(c => c.book_id === bid);
      const locText = copy.location_english || (copy.shelf_location ? `Shelf ${copy.shelf_location}` : '');
      const language = copy.language || group.language || 'English';

      return `
      <div class="book-card-item">
        <div class="book-card-main">
          <div class="book-card-header-left">
            ${coverHtml}
            <div class="book-info">
              <div class="book-title">${escapeHtml(cleanTitle)}</div>
              <div class="book-author">by <b>${escapeHtml(group.author)}</b></div>
              <div class="book-meta-line">
                <span class="state-chip state-${state.toLowerCase()}">${state}</span>
                <span class="chip book-lang-chip">🌐 ${escapeHtml(language)}</span>
                ${state === 'ASSIGNED' && locText ? `<span class="book-loc-chip">📍 ${escapeHtml(locText)}</span>` : ''}
                ${state === 'UNASSIGNED' ? `<span class="book-loc-chip unassigned-loc-chip">📍 Location Unassigned</span>` : ''}
              </div>
            </div>
          </div>
          <div class="book-card-actions">
            ${state !== 'SOLD' ? `
              <div style="display:flex; gap:0.4rem; align-items:center;">
                <button class="btn btn-sm ${inCart ? 'btn-outline' : 'btn-pos-add-cart'}" data-cart-bid="${escapeHtml(bid)}">
                  ${inCart ? '✓ In Cart' : '🛒 Add to Cart'}
                </button>
              </div>
            ` : `
              <button class="btn btn-sm btn-outline" disabled style="opacity:0.6; font-weight:700;">SOLD</button>
            `}
          </div>
        </div>
      </div>
    `;
    }).join('');

    resolveLazyCovers();

    // Hook up Add to Cart buttons
    container.querySelectorAll('[data-cart-bid]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bid = btn.getAttribute('data-cart-bid');
        const item = allCopies.find(x => (x.copy.book_id || x.group.book_id) === bid);
        if (item) {
          addToPosCart({
            book_id: bid,
            title: item.group.title,
            author: item.group.author,
            location_english: item.copy.location_english
          });
          btn.textContent = '✓ In Cart';
          btn.classList.remove('btn-pos-add-cart');
          btn.classList.add('btn-outline');
        }
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="alert alert-danger">Error: ${err.message}</div>`;
  }
}

let activeReturnContext = null;

function initCancelSaleReturnModal() {
  const modal = document.getElementById('modalCancelSaleReturn');
  if (!modal) return;

  const btnClose = document.getElementById('btnCloseCancelSaleModal');
  const btnCancel = document.getElementById('btnCancelReturnModal');
  const btnZero = document.getElementById('btnReturnSetZeroRefund');
  const btnConfirm = document.getElementById('btnConfirmReturnToShelf');

  const radioPrev = document.getElementById('radioReturnPrev');
  const radioNew = document.getElementById('radioReturnNew');
  const lblPrev = document.getElementById('lblReturnPrev');
  const lblNew = document.getElementById('lblReturnNew');
  const secNew = document.getElementById('returnNewPosSection');

  const inpRack = document.getElementById('returnInpRack');
  const inpCol = document.getElementById('returnInpCol');
  const inpPos = document.getElementById('returnInpPos');
  const previewNew = document.getElementById('returnNewPosPreview');

  function updatePosModeUI() {
    if (radioNew && radioNew.checked) {
      if (lblPrev) {
        lblPrev.classList.remove('selected');
        lblPrev.style.borderColor = '#e2e8f0';
        lblPrev.style.background = '#ffffff';
      }
      if (lblNew) {
        lblNew.classList.add('selected');
        lblNew.style.borderColor = '#2563eb';
        lblNew.style.background = '#eff6ff';
      }
      if (secNew) secNew.style.display = 'block';
    } else {
      if (lblPrev) {
        lblPrev.classList.add('selected');
        lblPrev.style.borderColor = '#2563eb';
        lblPrev.style.background = '#eff6ff';
      }
      if (lblNew) {
        lblNew.classList.remove('selected');
        lblNew.style.borderColor = '#e2e8f0';
        lblNew.style.background = '#ffffff';
      }
      if (secNew) secNew.style.display = 'none';
    }
  }

  function updateNewPosPreview() {
    if (previewNew && inpRack && inpCol && inpPos) {
      previewNew.textContent = formatLocationPreviewText(inpRack.value, inpCol.value, inpPos.value);
    }
  }

  if (radioPrev) radioPrev.addEventListener('change', updatePosModeUI);
  if (radioNew) radioNew.addEventListener('change', updatePosModeUI);
  if (lblPrev) lblPrev.addEventListener('click', () => { if (radioPrev) { radioPrev.checked = true; updatePosModeUI(); } });
  if (lblNew) lblNew.addEventListener('click', () => { if (radioNew) { radioNew.checked = true; updatePosModeUI(); } });

  [inpRack, inpCol, inpPos].forEach(inp => {
    if (inp) {
      inp.addEventListener('input', updateNewPosPreview);
      inp.addEventListener('change', updateNewPosPreview);
    }
  });

  if (btnZero) {
    btnZero.addEventListener('click', () => {
      const inpRefund = document.getElementById('returnRefundAmount');
      if (inpRefund) inpRefund.value = '0';
    });
  }

  const hideModal = () => {
    modal.style.display = 'none';
    activeReturnContext = null;
  };

  if (btnClose) btnClose.addEventListener('click', hideModal);
  if (btnCancel) btnCancel.addEventListener('click', hideModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) hideModal();
  });

  const btnSwitchToEditPay = document.getElementById('btnSwitchToEditPayFromReturn');
  if (btnSwitchToEditPay) {
    btnSwitchToEditPay.addEventListener('click', () => {
      if (!activeReturnContext) return;
      const { copy, book, onRestored } = activeReturnContext;
      hideModal();
      openEditSalePaymentModal(copy, book, onRestored);
    });
  }

  if (btnConfirm) {
    btnConfirm.addEventListener('click', async () => {
      if (!activeReturnContext) return;
      const { copy, book, onRestored } = activeReturnContext;
      const bookId = copy.book_id || book.book_id;
      const posMode = radioNew && radioNew.checked ? 'new' : 'previous';
      const newRack = inpRack ? inpRack.value.trim() : '';
      const newCol = inpCol ? inpCol.value.trim() : '';
      const newPos = inpPos ? inpPos.value.trim() : '';
      const refundVal = document.getElementById('returnRefundAmount') ? document.getElementById('returnRefundAmount').value.trim() : '';
      const notesVal = document.getElementById('returnNotes') ? document.getElementById('returnNotes').value.trim() : '';

      if (posMode === 'new' && (!newRack || !newCol || !newPos)) {
        alert('Please specify Rack, Column, and Position for the new position, or select "Previous Position".');
        return;
      }

      btnConfirm.disabled = true;
      btnConfirm.innerHTML = `<span>⏳</span> Restoring...`;

      try {
        const payload = {
          book_id: bookId,
          position_mode: posMode,
          rack: posMode === 'new' ? newRack : undefined,
          column_num: posMode === 'new' ? newCol : undefined,
          position: posMode === 'new' ? newPos : undefined,
          refund_amount: refundVal !== '' ? refundVal : undefined,
          notes: notesVal
        };

        const res = await fetch('/api/books/return', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (data.success || !data.error) {
          const updatedBook = data.book || {};
          copy.status = 'Available';
          copy.selling_price = null;
          copy.rack = updatedBook.rack !== undefined ? updatedBook.rack : copy.rack;
          copy.column_num = updatedBook.column_num !== undefined ? updatedBook.column_num : copy.column_num;
          copy.position = updatedBook.position !== undefined ? updatedBook.position : copy.position;
          copy.location_english = updatedBook.location_english || copy.location_english;

          if (book.copies) {
            const bCopy = book.copies.find(c => c.book_id === bookId);
            if (bCopy) {
              bCopy.status = 'Available';
              bCopy.selling_price = null;
              bCopy.rack = copy.rack;
              bCopy.column_num = copy.column_num;
              bCopy.position = copy.position;
              bCopy.location_english = copy.location_english;
            }
          }
          if (book.book_id === bookId) {
            book.status = 'Available';
            book.selling_price = null;
            book.rack = copy.rack;
            book.column_num = copy.column_num;
            book.position = copy.position;
            book.location_english = copy.location_english;
          }

          hideModal();
          fetchStats();
          if (typeof onRestored === 'function') {
            onRestored();
          }

          const targetLoc = updatedBook.location_english || 'its shelf';
          const refundText = data.refunded_amount > 0 ? ` Refunded ₹${data.refunded_amount}.` : '';
          alert(`✅ Returned to Shelf!\n\n"${book.title || copy.title}" is now back in stock at:\n📍 ${targetLoc}.${refundText}`);
        } else {
          alert('Failed to return book: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Network error while returning book: ' + err.message);
      } finally {
        btnConfirm.disabled = false;
        btnConfirm.innerHTML = `↩️ Confirm Return to Shelf`;
      }
    });
  }
}

function openCancelSaleReturnModal(copy, book, onRestored, options = {}) {
  const modal = document.getElementById('modalCancelSaleReturn');
  if (!modal) return;

  activeReturnContext = { copy, book, onRestored };

  const bookId = copy.book_id || book.book_id || '';
  const title = copy.title || book.title || 'Untitled Book';
  const author = copy.author || book.author || '';
  const sellingPrice = (copy.selling_price !== null && copy.selling_price !== undefined && copy.selling_price !== '') 
    ? copy.selling_price 
    : (book.selling_price || 0);

  const prevLoc = copy.location_english || book.location_english || (copy.shelf_location ? `Shelf ${copy.shelf_location}` : 'Unassigned Shelf');

  document.getElementById('returnModalBookTitle').textContent = title;
  document.getElementById('returnModalBookAuthor').textContent = author ? `by ${author}` : '';
  document.getElementById('returnModalBookId').textContent = bookId;
  document.getElementById('returnModalPaidBadge').textContent = `💳 Paid: ₹${sellingPrice || '0'}`;
  document.getElementById('returnModalCurrentLoc').textContent = `📍 Previous: ${prevLoc}`;
  document.getElementById('returnPrevLocationDesc').textContent = `📍 ${prevLoc}`;

  const radioPrev = document.getElementById('radioReturnPrev');
  const radioNew = document.getElementById('radioReturnNew');
  const lblPrev = document.getElementById('lblReturnPrev');
  const lblNew = document.getElementById('lblReturnNew');
  const secNew = document.getElementById('returnNewPosSection');
  const inpRefund = document.getElementById('returnRefundAmount');
  const inpNotes = document.getElementById('returnNotes');
  const inpRack = document.getElementById('returnInpRack');
  const inpCol = document.getElementById('returnInpCol');
  const inpPos = document.getElementById('returnInpPos');

  if (inpRefund) inpRefund.value = (sellingPrice || '0').toString();
  if (inpNotes) inpNotes.value = '';

  if (options.defaultNewRack || options.defaultNewCol || options.defaultNewPos) {
    if (radioNew) radioNew.checked = true;
    if (inpRack) inpRack.value = options.defaultNewRack || '';
    if (inpCol) inpCol.value = options.defaultNewCol || '';
    if (inpPos) inpPos.value = options.defaultNewPos || '';
  } else {
    if (radioPrev) radioPrev.checked = true;
    if (inpRack) inpRack.value = (copy.rack !== null && copy.rack !== undefined) ? copy.rack.toString() : '';
    if (inpCol) inpCol.value = (copy.column_num !== null && copy.column_num !== undefined) ? copy.column_num.toString() : '';
    if (inpPos) inpPos.value = (copy.position !== null && copy.position !== undefined) ? copy.position.toString() : '';
  }

  // Trigger UI state
  if (radioNew && radioNew.checked) {
    if (lblPrev) { lblPrev.classList.remove('selected'); lblPrev.style.borderColor = '#e2e8f0'; lblPrev.style.background = '#ffffff'; }
    if (lblNew) { lblNew.classList.add('selected'); lblNew.style.borderColor = '#2563eb'; lblNew.style.background = '#eff6ff'; }
    if (secNew) secNew.style.display = 'block';
  } else {
    if (lblPrev) { lblPrev.classList.add('selected'); lblPrev.style.borderColor = '#2563eb'; lblPrev.style.background = '#eff6ff'; }
    if (lblNew) { lblNew.classList.remove('selected'); lblNew.style.borderColor = '#e2e8f0'; lblNew.style.background = '#ffffff'; }
    if (secNew) secNew.style.display = 'none';
  }

  const previewNew = document.getElementById('returnNewPosPreview');
  if (previewNew && inpRack && inpCol && inpPos) {
    previewNew.textContent = formatLocationPreviewText(inpRack.value, inpCol.value, inpPos.value);
  }

  modal.style.display = 'flex';
}

let activeEditPayContext = null;

function initEditSalePaymentModal() {
  const modal = document.getElementById('modalEditSalePayment');
  if (!modal) return;

  const btnClose = document.getElementById('btnCloseEditPaymentModal');
  const btnCancel = document.getElementById('btnCancelEditPaymentModal');
  const btnConfirm = document.getElementById('btnConfirmEditPayment');
  const inpPrice = document.getElementById('inpEditPayNewPrice');
  const inpNotes = document.getElementById('inpEditPayNotes');
  const adjustmentText = document.getElementById('editPayAdjustmentText');
  const adjustmentBanner = document.getElementById('editPayAdjustmentBanner');

  function updateAdjustmentBanner() {
    if (!activeEditPayContext) return;
    const oldPrice = parseFloat(activeEditPayContext.oldPrice) || 0;
    const valStr = inpPrice ? inpPrice.value.trim() : '';
    if (valStr === '' || isNaN(valStr)) {
      if (adjustmentText) adjustmentText.textContent = 'Enter new amount to calculate store revenue adjustment';
      if (adjustmentBanner) {
        adjustmentBanner.style.background = '#ffffff';
        adjustmentBanner.style.borderColor = '#dbeafe';
        adjustmentBanner.style.color = '#1d4ed8';
      }
      if (btnConfirm) btnConfirm.textContent = '💾 Save Corrected Payment';
      return;
    }
    const newPrice = parseFloat(valStr) || 0;
    const diff = newPrice - oldPrice;
    if (diff > 0) {
      if (adjustmentText) adjustmentText.innerHTML = `🟢 <b>Revenue increase: +₹${diff.toFixed(2)}</b> (Total store revenue will increase by ₹${diff.toFixed(2)})`;
      if (adjustmentBanner) {
        adjustmentBanner.style.background = '#ecfdf5';
        adjustmentBanner.style.borderColor = '#a7f3d0';
        adjustmentBanner.style.color = '#065f46';
      }
    } else if (diff < 0) {
      if (adjustmentText) adjustmentText.innerHTML = `🔻 <b>Revenue decrease: -₹${Math.abs(diff).toFixed(2)}</b> (Total store revenue will decrease by ₹${Math.abs(diff).toFixed(2)})`;
      if (adjustmentBanner) {
        adjustmentBanner.style.background = '#fff1f2';
        adjustmentBanner.style.borderColor = '#fecdd3';
        adjustmentBanner.style.color = '#9f1239';
      }
    } else {
      if (adjustmentText) adjustmentText.innerHTML = `<b>No change: ₹${oldPrice.toFixed(2)}</b> (Same as currently recorded payment)`;
      if (adjustmentBanner) {
        adjustmentBanner.style.background = '#f8fafc';
        adjustmentBanner.style.borderColor = '#e2e8f0';
        adjustmentBanner.style.color = '#475569';
      }
    }
    if (btnConfirm) btnConfirm.textContent = `💾 Save Payment as ₹${newPrice}`;
  }

  if (inpPrice) {
    inpPrice.addEventListener('input', updateAdjustmentBanner);
    inpPrice.addEventListener('change', updateAdjustmentBanner);
  }

  const hideModal = () => {
    modal.style.display = 'none';
    activeEditPayContext = null;
  };

  if (btnClose) btnClose.addEventListener('click', hideModal);
  if (btnCancel) btnCancel.addEventListener('click', hideModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) hideModal();
  });

  if (btnConfirm) {
    btnConfirm.addEventListener('click', async () => {
      if (!activeEditPayContext) return;
      const { copy, book, onUpdated } = activeEditPayContext;
      const bookId = copy.book_id || book.book_id;
      const valStr = inpPrice ? inpPrice.value.trim() : '';

      if (valStr === '' || isNaN(valStr) || parseFloat(valStr) < 0) {
        alert('Please enter a valid, non-negative payment amount (e.g. 300).');
        if (inpPrice) inpPrice.focus();
        return;
      }

      const notesVal = inpNotes ? inpNotes.value.trim() : '';

      btnConfirm.disabled = true;
      btnConfirm.innerHTML = `<span>⏳</span> Saving...`;

      try {
        const res = await fetch('/api/books/update-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            book_id: bookId,
            selling_price: valStr,
            notes: notesVal
          })
        });
        const data = await res.json();

        if (data.success && data.book) {
          copy.selling_price = data.book.selling_price;
          if (book.copies) {
            const bCopy = book.copies.find(c => c.book_id === bookId);
            if (bCopy) bCopy.selling_price = data.book.selling_price;
          }
          if (book.book_id === bookId) {
            book.selling_price = data.book.selling_price;
          }

          hideModal();
          fetchStats();
          if (typeof onUpdated === 'function') {
            onUpdated();
          }

          const diffMsg = data.adjustment !== 0 ? ` (Store revenue adjusted by ${data.adjustment >= 0 ? '+' : ''}₹${data.adjustment})` : '';
          alert(`✅ Payment corrected successfully!\n\n"${book.title || copy.title}" is now recorded as sold for ₹${data.new_price}.${diffMsg}`);
        } else {
          alert('Failed to update payment: ' + (data.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Network error while updating payment: ' + err.message);
      } finally {
        btnConfirm.disabled = false;
        btnConfirm.innerHTML = `💾 Save Corrected Payment`;
      }
    });
  }
}

function openEditSalePaymentModal(copy, book, onUpdated) {
  const modal = document.getElementById('modalEditSalePayment');
  if (!modal) return;

  const bookId = copy.book_id || book.book_id || '';
  const title = copy.title || book.title || 'Untitled Book';
  const author = copy.author || book.author || '';
  const currentPaid = (copy.selling_price !== null && copy.selling_price !== undefined && copy.selling_price !== '') 
    ? copy.selling_price 
    : (book.selling_price || 0);

  activeEditPayContext = { copy, book, onUpdated, oldPrice: currentPaid };

  document.getElementById('editPayBookTitle').textContent = title;
  document.getElementById('editPayBookAuthor').textContent = author ? `by ${author}` : '';
  document.getElementById('editPayBookId').textContent = bookId;
  document.getElementById('editPayCurrentPaidBadge').textContent = `₹${parseFloat(currentPaid || 0).toFixed(2)}`;

  const inpPrice = document.getElementById('inpEditPayNewPrice');
  const inpNotes = document.getElementById('inpEditPayNotes');
  const btnConfirm = document.getElementById('btnConfirmEditPayment');
  const adjustmentText = document.getElementById('editPayAdjustmentText');
  const adjustmentBanner = document.getElementById('editPayAdjustmentBanner');

  if (inpPrice) {
    inpPrice.value = (currentPaid || '').toString();
  }
  if (inpNotes) {
    inpNotes.value = '';
  }

  if (adjustmentText) adjustmentText.textContent = `Current payment recorded: ₹${parseFloat(currentPaid || 0).toFixed(2)}. Type new amount above.`;
  if (adjustmentBanner) {
    adjustmentBanner.style.background = '#ffffff';
    adjustmentBanner.style.borderColor = '#dbeafe';
    adjustmentBanner.style.color = '#1d4ed8';
  }
  if (btnConfirm) {
    btnConfirm.textContent = `💾 Save Corrected Payment`;
  }

  modal.style.display = 'flex';
  setTimeout(() => {
    if (inpPrice) {
      inpPrice.focus();
      inpPrice.select();
    }
  }, 100);
}

function openSaleModalForCopy(bookId, title, author, locationEnglish) {
  activeSaleCopy = { book_id: bookId, title: title, author: author, location_english: locationEnglish };

  document.getElementById('saleBookTitle').textContent = title || '-';
  document.getElementById('saleBookAuthor').textContent = author ? `by ${author}` : '';
  document.getElementById('saleBookId').textContent = bookId;
  document.getElementById('saleBookLocation').textContent = locationEnglish ? `📍 ${locationEnglish}` : '📍 Location Unassigned';
  document.getElementById('salePrice').value = '';
  document.getElementById('saleNotes').value = '';

  const drawer = document.getElementById('saleDrawer');
  drawer.style.display = 'flex';
  drawer.onclick = (e) => {
    if (e.target === drawer) {
      drawer.style.display = 'none';
    }
  };
}

function renderDigitalReceipt(saleData) {
  const container = document.getElementById('saleReceiptContainer');
  if (!container) return;
  container.style.display = 'block';

  // Multi-book sale receipt
  if (saleData.sold_books && saleData.sold_books.length > 0) {
    const totalAmount = saleData.total_amount ? `₹${parseFloat(saleData.total_amount).toFixed(2)}` : '₹0.00';
    container.innerHTML = `
      <div class="receipt-title">✅ Sale Confirmed — ${saleData.count} Books Marked SOLD OUT</div>
      <div class="receipt-meta">Time: ${new Date().toLocaleString()}</div>
      <div style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:1rem; max-width:540px; margin:0.75rem auto 1rem auto; text-align:left;">
        <div style="display:flex; justify-content:space-between; margin-bottom:0.75rem; border-bottom:1px solid #e2e8f0; padding-bottom:0.5rem;">
          <b>Total Books Sold: ${saleData.count}</b>
          <b style="color:#059669; font-size:1.1rem;">Total: ${totalAmount}</b>
        </div>
        <div style="display:flex; flex-direction:column; gap:0.5rem; max-height:260px; overflow-y:auto;">
          ${saleData.sold_books.map(b => `
            <div style="font-size:0.85rem; border-bottom:1px dashed #e2e8f0; padding-bottom:0.4rem; display:flex; justify-content:space-between; align-items:flex-start;">
              <div>
                <div style="font-weight:600; color:#1e293b;">${escapeHtml(b.title)}</div>
                <div style="font-size:0.75rem; color:#64748b;">📍 ${escapeHtml(b.location_english || 'Unassigned')}</div>
                <div style="font-size:0.75rem; color:#2563eb;">Ref: ${escapeHtml(b.transaction_ref)}</div>
              </div>
              <div style="font-weight:600; color:#0f172a;">
                ${b.selling_price ? `₹${parseFloat(b.selling_price).toFixed(2)}` : '-'}
              </div>
            </div>
          `).join('')}
        </div>
        <div style="margin-top:0.75rem; font-size:0.8rem; color:#059669; font-weight:600; text-align:center;">
          ✓ All copies updated to SOLD OUT in inventory
        </div>
      </div>
      <div style="display:flex; justify-content:center; gap:0.5rem;">
        <button class="btn btn-primary btn-sm" onclick="window.print()">🖨️ Print Receipt</button>
        <button class="btn btn-outline btn-sm" onclick="document.getElementById('saleReceiptContainer').style.display='none'">Dismiss</button>
      </div>
    `;
    return;
  }

  // Single book sale receipt
  const priceText = saleData.selling_price !== null && saleData.selling_price !== undefined ? `₹${parseFloat(saleData.selling_price).toFixed(2)}` : 'Not recorded (Price omitted)';
  const bookTitle = saleData.book ? saleData.book.title : 'Book';
  const bookAuthor = saleData.book ? saleData.book.author : '';
  const bookId = saleData.book ? saleData.book.book_id : (saleData.transaction_ref || '');

  container.innerHTML = `
    <div class="receipt-title">✅ Sale Confirmed & Marked SOLD OUT</div>
    <div class="receipt-meta">Transaction Ref: <b>${escapeHtml(saleData.transaction_ref)}</b> | Time: ${new Date(saleData.sold_at || Date.now()).toLocaleString()}</div>
    <div style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:1rem; max-width:400px; margin:0 auto 1rem auto; text-align:left;">
      <div><b>Title:</b> ${escapeHtml(bookTitle)}</div>
      <div><b>Author:</b> ${escapeHtml(bookAuthor)}</div>
      <div><b>Recorded Price:</b> ${priceText}</div>
      <div><b>Availability:</b> <span class="badge badge-danger">SOLD OUT</span></div>
    </div>
    <div style="display:flex; justify-content:center; gap:0.5rem;">
      <button class="btn btn-primary btn-sm" onclick="window.print()">🖨️ Print Receipt</button>
      <button class="btn btn-outline btn-sm" onclick="document.getElementById('saleReceiptContainer').style.display='none'">Dismiss</button>
    </div>
  `;
}

/* =========================================================================
   7. UNASSIGNED BOOKS SECTION (Req 1.7)
   ========================================================================= */

let selectedUnassignedBookIds = new Set();

function initUnassigned() {
  const searchInput = document.getElementById('unassignedSearchInput');
  const chkAll = document.getElementById('chkSelectAllUnassigned');
  const btnOpenModal = document.getElementById('btnOpenBulkAssignModal');
  const btnBulkDelete = document.getElementById('btnBulkDeleteUnassigned');
  const modal = document.getElementById('modalBulkAssign');
  const closeModalBtn = document.getElementById('btnCloseModalBulkAssign');
  const cancelModalBtn = document.getElementById('btnCancelBulkAssign');
  const formBulkAssign = document.getElementById('formBulkAssign');

  if (!searchInput) return;

  let debounce = null;
  const triggerSearch = () => {
    clearTimeout(debounce);
    debounce = setTimeout(fetchUnassigned, 200);
  };

  searchInput.addEventListener('input', triggerSearch);
  searchInput.addEventListener('keyup', triggerSearch);
  searchInput.addEventListener('search', triggerSearch);
  searchInput.addEventListener('change', triggerSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(debounce);
      fetchUnassigned();
    }
  });

  if (chkAll) {
    chkAll.addEventListener('change', () => {
      const checkboxes = document.querySelectorAll('.chk-unassigned-item');
      checkboxes.forEach(chk => {
        chk.checked = chkAll.checked;
        const bid = chk.getAttribute('data-bid');
        if (chkAll.checked) selectedUnassignedBookIds.add(bid);
        else selectedUnassignedBookIds.delete(bid);
      });
      updateBulkAssignButtonState();
    });
  }

  if (btnBulkDelete) {
    btnBulkDelete.addEventListener('click', deleteBulkUnassigned);
  }

  btnOpenModal.addEventListener('click', async () => {
    const selectedBids = Array.from(selectedUnassignedBookIds);
    if (selectedBids.length === 0) return;

    // Check if user already typed individual locations into the table row inputs
    const inlineAssignments = [];
    let anyRowFilled = false;
    let missingFieldBids = [];

    for (const bid of selectedBids) {
      const rInput = document.getElementById(`rack_${bid}`);
      const cInput = document.getElementById(`col_${bid}`);
      const pInput = document.getElementById(`pos_${bid}`);
      const r = rInput ? rInput.value.trim() : '';
      const c = cInput ? cInput.value.trim() : '';
      const p = pInput ? pInput.value.trim() : '';

      if (r || c || p) {
        anyRowFilled = true;
        if (!r || !c || !p) {
          missingFieldBids.push(bid);
        } else {
          inlineAssignments.push({ book_id: bid, rack: r, column_num: c, position: p });
        }
      }
    }

    // If individual row inputs were typed, save them directly without opening the modal!
    if (anyRowFilled) {
      if (missingFieldBids.length > 0) {
        alert('Please fill in Rack, Column, and Position for all selected books, or clear the row inputs to apply one shared location.');
        return;
      }
      try {
        const res = await fetch('/api/books/assign-location-bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignments: inlineAssignments })
        });
        const data = await res.json();
        if (data.success) {
          alert(`🎉 Successfully assigned locations for ${data.updated_count} books!`);
          selectedUnassignedBookIds.clear();
          fetchUnassigned();
          fetchStats();
        } else {
          alert('Error: ' + (data.error || 'Failed to update locations'));
        }
      } catch (err) {
        alert('Error: ' + err.message);
      }
      return;
    }

    // Otherwise, open the modal to assign one shared location to all selected books
    document.getElementById('modalSelectedCount').textContent = selectedUnassignedBookIds.size;
    modal.style.display = 'flex';
  });

  closeModalBtn.addEventListener('click', () => modal.style.display = 'none');
  cancelModalBtn.addEventListener('click', () => modal.style.display = 'none');

  formBulkAssign.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rack = document.getElementById('bulkRack').value;
    const col = document.getElementById('bulkColumn').value;
    const pos = document.getElementById('bulkPosition').value;

    const assignments = Array.from(selectedUnassignedBookIds).map(bid => ({
      book_id: bid,
      rack: rack,
      column_num: col,
      position: pos
    }));

    try {
      const res = await fetch('/api/books/assign-location-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments: assignments })
      });
      const data = await res.json();
      if (data.success) {
        alert(`🎉 Updated locations for ${data.updated_count} books!`);
        modal.style.display = 'none';
        formBulkAssign.reset();
        selectedUnassignedBookIds.clear();
        fetchUnassigned();
        fetchStats();
      } else {
        alert('Error: ' + data.error);
      }
    } catch (err) {
      alert('Error: ' + err.message);
    }
  });
}

async function fetchUnassigned() {
  const searchInput = document.getElementById('unassignedSearchInput');
  const query = searchInput ? searchInput.value.trim() : '';
  const tbody = document.getElementById('tbodyUnassigned');
  if (!tbody) return;

  // Preserve any typed input values so they are not wiped out
  const cachedInputs = {};
  document.querySelectorAll('input[id^="rack_"]').forEach(el => {
    const bid = el.id.replace('rack_', '');
    const cEl = document.getElementById(`col_${bid}`);
    const pEl = document.getElementById(`pos_${bid}`);
    if (el.value || (cEl && cEl.value) || (pEl && pEl.value)) {
      cachedInputs[bid] = {
        rack: el.value,
        col: cEl ? cEl.value : '',
        pos: pEl ? pEl.value : ''
      };
    }
  });

  try {
    const res = await fetch(`/api/unassigned?q=${encodeURIComponent(query)}`);
    const data = await res.json();

    const label = document.getElementById('unassignedCountLabel');
    if (label) label.textContent = data.total;

    // Only update tab badge if not searching, or keep in sync
    const badge = document.getElementById('tabUnassignedBadge');
    if (badge && !query) badge.textContent = data.total;

    if (!data.books || data.books.length === 0) {
      if (query) {
        tbody.innerHTML = `
          <tr class="empty-row">
            <td colspan="6" style="padding: 2.2rem 1rem; text-align: center;">
              <div style="font-size: 1.1rem; font-weight: 600; color: var(--text, #1e293b); margin-bottom: 0.4rem;">
                🔍 No unassigned books matching "<b>${escapeHtml(query)}</b>"
              </div>
              <div style="font-size: 0.85rem; color: var(--text-muted, #64748b); max-width: 480px; margin: 0 auto 1.1rem auto; line-height: 1.4;">
                This section only shows newly added books <b>waiting for a shelf assignment</b>. If this book already has a shelf location, search for it on the main <b>Search</b> tab.
              </div>
              <button type="button" class="btn btn-sm btn-primary" onclick="switchToSearchTab('${escapeHtml(query.replace(/'/g, "\\'"))}')">
                🔍 Search All Shelves for "${escapeHtml(query)}"
              </button>
            </td>
          </tr>
        `;
      } else {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="6">✅ No unassigned books! All inventory copies have recorded shelf locations.</td></tr>';
      }
      return;
    }

    tbody.innerHTML = data.books.map(b => `
      <tr>
        <td><input type="checkbox" class="chk-unassigned-item" data-bid="${escapeHtml(b.book_id)}" ${selectedUnassignedBookIds.has(b.book_id) ? 'checked' : ''} onchange="toggleUnassignedSelect('${escapeHtml(b.book_id)}', this.checked)"></td>
        <td><span class="copy-id-box">${escapeHtml(b.book_id)}</span></td>
        <td><b>${escapeHtml(b.title)}</b></td>
        <td>${escapeHtml(b.author)}</td>
        <td>
          <div style="display:flex; gap:0.3rem; align-items:center;">
            <input type="text" id="rack_${b.book_id}" placeholder="Rack" style="width:70px; padding:0.3rem 0.5rem; font-size:0.85rem;">
            <input type="text" id="col_${b.book_id}" placeholder="Col" style="width:50px; padding:0.3rem 0.5rem; font-size:0.85rem;">
            <input type="text" id="pos_${b.book_id}" placeholder="Pos" style="width:50px; padding:0.3rem 0.5rem; font-size:0.85rem;">
            <button class="btn btn-sm btn-primary" onclick="assignSingleInline('${escapeHtml(b.book_id)}')">Save</button>
          </div>
        </td>
        <td>
          <button class="btn btn-sm btn-danger" onclick="deleteSingleUnassigned('${escapeHtml(b.book_id)}', '${escapeHtml(b.title)}')" title="Delete this unassigned book">🗑️</button>
        </td>
      </tr>
    `).join('');

    // Restore cached inputs for books that still exist in the list
    for (const [bid, vals] of Object.entries(cachedInputs)) {
      const rEl = document.getElementById(`rack_${bid}`);
      const cEl = document.getElementById(`col_${bid}`);
      const pEl = document.getElementById(`pos_${bid}`);
      if (rEl && vals.rack) rEl.value = vals.rack;
      if (cEl && vals.col) cEl.value = vals.col;
      if (pEl && vals.pos) pEl.value = vals.pos;
    }
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Error loading unassigned books: ${err.message}</td></tr>`;
  }
}

window.switchToSearchTab = function(q = '') {
  const searchTabBtn = document.querySelector('.tab-btn[data-tab="tabSearch"]');
  if (searchTabBtn) searchTabBtn.click();
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    if (q) {
      searchInput.value = q;
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    searchInput.focus();
  }
};

function toggleUnassignedSelect(bid, isChecked) {
  if (isChecked) selectedUnassignedBookIds.add(bid);
  else selectedUnassignedBookIds.delete(bid);
  updateBulkAssignButtonState();
}

function updateBulkAssignButtonState() {
  const btn = document.getElementById('btnOpenBulkAssignModal');
  const btnDelete = document.getElementById('btnBulkDeleteUnassigned');
  const count = selectedUnassignedBookIds.size;
  if (btn) {
    btn.disabled = count === 0;
    btn.textContent = `📍 Assign ${count} Selected`;
  }
  if (btnDelete) {
    btnDelete.disabled = count === 0;
    btnDelete.textContent = `🗑️ Delete ${count} Selected`;
  }
}

async function assignSingleInline(bid) {
  const rack = document.getElementById(`rack_${bid}`).value;
  const col = document.getElementById(`col_${bid}`).value;
  const pos = document.getElementById(`pos_${bid}`).value;

  if (!rack || !col || !pos) {
    alert('Please enter Rack, Column, and Position.');
    return;
  }

  try {
    const res = await fetch('/api/books/assign-location', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: bid, rack: rack, column_num: col, position: pos })
    });
    const data = await res.json();
    if (data.success) {
      alert(`Location assigned: ${data.book.location_english}`);
      fetchUnassigned();
      fetchStats();
    } else {
      alert('Error: ' + data.error);
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function deleteSingleUnassigned(bookId, title) {
  if (!confirm(`Are you sure you want to delete "${title}" (${bookId}) from unassigned inventory?`)) {
    return;
  }
  try {
    const res = await fetch('/api/books/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_id: bookId })
    });
    const data = await res.json();
    if (data.success) {
      selectedUnassignedBookIds.delete(bookId);
      updateBulkAssignButtonState();
      fetchUnassigned();
      fetchStats();
    } else {
      alert('Delete failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Network error deleting book: ' + err.message);
  }
}

async function deleteBulkUnassigned() {
  const count = selectedUnassignedBookIds.size;
  if (count === 0) return;
  if (!confirm(`Are you sure you want to delete ${count} selected unassigned book(s)?`)) {
    return;
  }
  try {
    const res = await fetch('/api/books/delete-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book_ids: Array.from(selectedUnassignedBookIds) })
    });
    const data = await res.json();
    if (data.success) {
      selectedUnassignedBookIds.clear();
      updateBulkAssignButtonState();
      fetchUnassigned();
      fetchStats();
    } else {
      alert('Bulk delete failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Network error during bulk delete: ' + err.message);
  }
}

/* =========================================================================
   8. SALES TRANSACTIONS & GOOGLE SHEETS SYNC (Req 1.8)
   ========================================================================= */

function initHistoryAndSync() {
  const syncBtn = document.getElementById('btnSyncNow');
  const manualSyncBtn = document.getElementById('btnManualSync');
  const backupBtn = document.getElementById('btnCreateBackup');
  const downloadCsvBtn = document.getElementById('btnDownloadCsv');

  const doSync = async () => {
    try {
      const res = await fetch('/api/sync/trigger', { method: 'POST' });
      const data = await res.json();
      alert(`Sync Complete!\n\n${data.message}`);
      fetchStats();
    } catch (err) {
      alert('Sync failed: ' + err.message);
    }
  };

  syncBtn.addEventListener('click', doSync);
  manualSyncBtn.addEventListener('click', doSync);

  backupBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/sync/backup', { method: 'POST' });
      const data = await res.json();
      alert(`✅ Snapshot Backup Created!\n\nLocation:\n${data.backup_file}`);
    } catch (err) {
      alert('Backup failed: ' + err.message);
    }
  });

  downloadCsvBtn.addEventListener('click', () => {
    window.location.href = '/api/export/csv';
  });
}

async function fetchSalesAndAudit() {
  // 1. Fetch Sales
  try {
    const res = await fetch('/api/sales');
    const data = await res.json();
    const tbody = document.getElementById('tbodySales');

    if (!data.sales || data.sales.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No sales recorded yet. Serve a customer in POS tab!</td></tr>';
    } else {
      tbody.innerHTML = data.sales.map(s => `
        <tr>
          <td><span class="copy-id-box">${escapeHtml(s.transaction_ref)}</span></td>
          <td>${new Date(s.sold_at).toLocaleString()}</td>
          <td><b>${escapeHtml(s.book_id)}</b></td>
          <td>${escapeHtml(s.title)}</td>
          <td>${escapeHtml(s.author)}</td>
          <td><b>${s.selling_price !== null ? `₹${parseFloat(s.selling_price).toFixed(2)}` : 'Not recorded'}</b></td>
          <td>${escapeHtml(s.sold_by || 'Staff')}</td>
        </tr>
      `).join('');
    }
  } catch (err) {
    console.error('Failed to load sales history:', err);
  }

  // 2. Fetch Audit Logs
  try {
    const res = await fetch('/api/audit');
    const data = await res.json();
    const tbody = document.getElementById('tbodyAudit');

    if (!data.audit_logs || data.audit_logs.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No audit entries.</td></tr>';
    } else {
      tbody.innerHTML = data.audit_logs.map(log => `
        <tr>
          <td>${new Date(log.timestamp).toLocaleTimeString()}</td>
          <td><span class="badge badge-info">${escapeHtml(log.action)}</span></td>
          <td><span class="copy-id-box">${escapeHtml(log.book_id)}</span></td>
          <td>${escapeHtml(log.user)}</td>
          <td>${escapeHtml(log.notes || '')}</td>
        </tr>
      `).join('');
    }
  } catch (err) {
    console.error('Failed to load audit history:', err);
  }
}

/* =========================================================================
   CART & MULTI-BOOK ORDER CONTROLLER
   ========================================================================= */

let storeCart = [];

function loadStoreCart() {
  try {
    const raw = localStorage.getItem('bookmark_store_cart');
    if (raw) storeCart = JSON.parse(raw);
    if (!Array.isArray(storeCart)) storeCart = [];
  } catch (e) {
    storeCart = [];
  }
  updateCartBadge();
}

function saveStoreCart() {
  try {
    localStorage.setItem('bookmark_store_cart', JSON.stringify(storeCart));
  } catch (e) {}
  updateCartBadge();
}

function isBookInCart(bookId) {
  return storeCart.some(item => item.book_id === bookId);
}

function toggleCartBook(bookData) {
  const idx = storeCart.findIndex(item => item.book_id === bookData.book_id);
  if (idx >= 0) {
    storeCart.splice(idx, 1);
  } else {
    storeCart.push(bookData);
  }
  saveStoreCart();
  updateAllCartButtonStates();
  if (currentTab === 'tabCart') {
    renderCartTab();
  }
}

function removeFromCart(bookId) {
  storeCart = storeCart.filter(item => item.book_id !== bookId);
  saveStoreCart();
  updateAllCartButtonStates();
  if (currentTab === 'tabCart') {
    renderCartTab();
  }
}

function clearStoreCart() {
  storeCart = [];
  saveStoreCart();
  updateAllCartButtonStates();
  if (currentTab === 'tabCart') {
    renderCartTab();
  }
}

function updateCartBadge() {
  const badge = document.getElementById('tabCartBadge');
  if (badge) {
    badge.textContent = storeCart.length;
  }
}

function updateAllCartButtonStates() {
  document.querySelectorAll('.btn-toggle-cart').forEach(btn => {
    const bid = btn.getAttribute('data-bid');
    const inCart = isBookInCart(bid);
    if (inCart) {
      btn.classList.add('active');
      btn.style.background = '#059669';
      btn.style.color = '#ffffff';
      btn.style.borderColor = '#059669';
      btn.innerHTML = '<span>✓ In Cart</span>';
      btn.title = 'Remove from cart';
    } else {
      btn.classList.remove('active');
      btn.style.background = '#ffffff';
      btn.style.color = '#047857';
      btn.style.borderColor = '#10b981';
      btn.innerHTML = '<span>🛒 Add to Cart</span>';
      btn.title = 'Add to cart';
    }
  });
}

function renderCartTab() {
  const emptyView = document.getElementById('cartEmptyView');
  const contentView = document.getElementById('cartContentView');
  const itemsContainer = document.getElementById('cartItemsList');
  const countText = document.getElementById('cartItemsCountText');
  const summaryCount = document.getElementById('summaryTotalBooks');
  const countPill = document.getElementById('priceMenuBookCountPill');
  const costInput = document.getElementById('cartTotalCostInput');
  const liveTotal = document.getElementById('cartPriceMenuLiveTotal');

  if (!emptyView || !contentView || !itemsContainer) return;

  if (storeCart.length === 0) {
    emptyView.style.display = 'block';
    contentView.style.display = 'none';
    return;
  }

  emptyView.style.display = 'none';
  contentView.style.display = 'block';

  if (countText) countText.textContent = storeCart.length;
  if (summaryCount) summaryCount.textContent = `${storeCart.length} ${storeCart.length === 1 ? 'book' : 'books'}`;
  if (countPill) countPill.textContent = `${storeCart.length} ${storeCart.length === 1 ? 'Book' : 'Books'} Selected`;

  if (costInput && liveTotal) {
    const val = parseFloat(costInput.value);
    liveTotal.textContent = (!isNaN(val) && val >= 0) ? `₹${val.toFixed(2)}` : '₹0.00';
  }

  itemsContainer.innerHTML = storeCart.map(item => {
    const cleanTitle = cleanBookTitle(item.title || '');
    const cleanAuthor = escapeHtml(item.author || 'Author');
    const genre = item.genre || '';
    const coverHtml = getBookCoverHtml(cleanTitle, item.author, genre, item.image_url);
    const locText = (item.location_english || 'Location Unassigned').replace(/->/g, '→');

    return `
      <div class="cart-item-card" data-bid="${escapeHtml(item.book_id)}">
        <div style="display: flex; gap: 0.95rem; align-items: center;">
          <div style="width: 52px; height: 74px; flex-shrink: 0; border-radius: 6px; overflow: hidden; box-shadow: 0 2px 6px rgba(0,0,0,0.1);">
            ${coverHtml}
          </div>
          <div style="flex: 1; min-width: 0;">
            <h4 style="margin: 0 0 0.2rem 0; font-size: 0.98rem; font-weight: 700; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              ${escapeHtml(cleanTitle)}
            </h4>
            <div style="font-size: 0.82rem; color: var(--text-muted); margin-bottom: 0.4rem;">
              by <b>${cleanAuthor}</b>
            </div>
            <div style="font-size: 0.82rem; font-weight: 700; color: #064e3b; display: inline-flex; align-items: center; gap: 0.3rem; background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 9999px; padding: 0.22rem 0.65rem;">
              <span>📍</span> ${escapeHtml(locText)}
            </div>
          </div>
          <button type="button" class="btn btn-sm btn-outline btn-remove-cart-item" data-bid="${escapeHtml(item.book_id)}" title="Remove from cart" style="color: #ef4444; border-color: #fca5a5; padding: 0.4rem 0.65rem; border-radius: 8px; cursor: pointer; flex-shrink: 0;">
            <span>🗑️ Remove</span>
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Wire remove buttons
  itemsContainer.querySelectorAll('.btn-remove-cart-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const bid = btn.getAttribute('data-bid');
      removeFromCart(bid);
    });
  });

  resolveLazyCovers();
}

function initCart() {
  loadStoreCart();

  const costInput = document.getElementById('cartTotalCostInput');
  const liveTotal = document.getElementById('cartPriceMenuLiveTotal');
  if (costInput && liveTotal) {
    costInput.addEventListener('input', () => {
      const val = parseFloat(costInput.value);
      liveTotal.textContent = (!isNaN(val) && val >= 0) ? `₹${val.toFixed(2)}` : '₹0.00';
    });
  }

  const btnAddMore = document.getElementById('btnCartAddMore');
  if (btnAddMore) {
    btnAddMore.addEventListener('click', () => {
      switchToSearchTab('');
    });
  }

  const btnClear = document.getElementById('btnClearCart');
  if (btnClear) {
    btnClear.addEventListener('click', () => {
      if (storeCart.length === 0) return;
      if (confirm('Are you sure you want to clear all books from your cart?')) {
        clearStoreCart();
      }
    });
  }

  const btnPlaceOrder = document.getElementById('btnPlaceCartOrder');
  if (btnPlaceOrder) {
    btnPlaceOrder.addEventListener('click', async () => {
      if (storeCart.length === 0) {
        alert('Your cart is empty. Add books before placing an order.');
        return;
      }

      const costVal = costInput ? costInput.value.trim() : '';
      if (!costVal) {
        alert('Please enter the Total Transaction amount in rupees (₹).');
        if (costInput) costInput.focus();
        return;
      }

      const totalCost = parseFloat(costVal);
      if (isNaN(totalCost) || totalCost < 0) {
        alert('Please enter a valid positive amount.');
        if (costInput) costInput.focus();
        return;
      }

      const notesInput = document.getElementById('cartOrderNotes');
      const orderNotes = notesInput ? notesInput.value.trim() : '';

      // Distribute total cost evenly across items
      const numItems = storeCart.length;
      const basePrice = Math.floor((totalCost / numItems) * 100) / 100;
      const remainder = Math.round((totalCost - (basePrice * numItems)) * 100) / 100;

      const itemsToSell = storeCart.map((item, index) => {
        let p = basePrice;
        if (index === numItems - 1) {
          p = Math.round((p + remainder) * 100) / 100;
        }
        return {
          book_id: item.book_id,
          selling_price: p,
          notes: orderNotes
        };
      });

      btnPlaceOrder.disabled = true;
      btnPlaceOrder.innerHTML = `<span>⏳</span> Processing Order...`;

      try {
        const res = await fetch('/api/books/sell', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            books: itemsToSell,
            total_amount: totalCost,
            notes: orderNotes,
            user: 'Staff'
          })
        });

        const data = await res.json();
        if (res.ok && data.success) {
          const soldBids = new Set(itemsToSell.map(x => x.book_id));

          // Immediately update in-memory active view so every member of books is SOLD OUT
          if (window.currentSearchResultsData && Array.isArray(window.currentSearchResultsData.exact_matches)) {
            window.currentSearchResultsData.exact_matches.forEach(group => {
              if (soldBids.has(group.book_id)) {
                group.status = 'SOLD OUT';
              }
              if (group.copies && Array.isArray(group.copies)) {
                group.copies.forEach(c => {
                  if (soldBids.has(c.book_id)) {
                    c.status = 'SOLD OUT';
                  }
                });
              }
            });
            renderSearchResults(window.currentSearchResultsData);
          }

          // Clear client search cache so fresh requests don't show old available status
          clearSearchCache();

          // Clear cart
          clearStoreCart();
          if (costInput) costInput.value = '';
          if (notesInput) notesInput.value = '';
          if (liveTotal) liveTotal.textContent = '₹0.00';

          fetchStats();

          // Refresh current search if query exists
          const searchInput = document.getElementById('searchQuery');
          if (searchInput && searchInput.value.trim()) {
            performSearch(searchInput.value.trim());
          }

          // Reload genre books if genre controller exists
          if (typeof loadGenreBooks === 'function') {
            loadGenreBooks();
          }

          renderDigitalReceipt(data);
          alert(`✅ Order Completed!\n\nAll ${data.count} books are now marked SOLD OUT.\nTotal Transaction: ₹${parseFloat(totalCost).toFixed(2)}`);
        } else {
          alert('Could not complete order: ' + (data.error || 'Server error'));
        }
      } catch (err) {
        alert('Order processing error: ' + err.message);
      } finally {
        btnPlaceOrder.disabled = false;
        btnPlaceOrder.innerHTML = `<span>⚡</span> Place Order &amp; Mark SOLD OUT`;
      }
    });
  }
}

// Utility
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

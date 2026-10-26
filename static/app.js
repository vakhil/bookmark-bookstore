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
  initTabs();
  initStats();
  initSearch();
  initGenreTab();
  initAdvisorTab();
  initSingleAdd();
  initBatchA();
  initBatchB();
  initPOS();
  initUnassigned();
  initHistoryAndSync();

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

      if (tabId === 'tabGenre') loadGenreTab();
      if (tabId === 'tabAdvisor') {
        const inp = document.getElementById('advisorQuestionInput');
        if (inp) inp.focus();
      }
      if (tabId === 'tabUnassigned') fetchUnassigned();
      if (tabId === 'tabHistory') fetchSalesAndAudit();
      if (tabId === 'tabSell') document.getElementById('posSearchInput').focus();
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
      safeSet('statRevenue', `$${data.stats.total_revenue.toFixed(2)}`);
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

function initStats() {
  // Poll stats every 15 seconds
  setInterval(fetchStats, 15000);

  const btnReload = document.getElementById('btnReloadSheet');
  if (btnReload) {
    btnReload.addEventListener('click', async () => {
      btnReload.disabled = true;
      btnReload.textContent = '⏳ Syncing...';
      try {
        const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1-b8dp2W_1z1BT_2vAxpAMYTIP68CiyQf5z-Hal33JrU/export?format=csv&gid=0';
        let csvText = '';
        try {
          const fetchRes = await fetch(SHEET_CSV_URL);
          if (fetchRes.ok) {
            csvText = await fetchRes.text();
          }
        } catch (e) {
          console.warn('Browser direct fetch note:', e);
        }

        const res = await fetch('/api/sync/reload-sheet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csv_content: csvText })
        });
        const data = await res.json();
        if (data.success) {
          alert(`🎉 Sync Complete!\n\n${data.message}`);
          fetchStats();
          const searchInput = document.getElementById('searchInput');
          if (searchInput && searchInput.value.trim()) {
            performSearch(searchInput.value.trim());
          }
        } else {
          alert('Sync notice: ' + (data.error || 'Could not reload sheet.'));
        }
      } catch (err) {
        alert('Sync error: ' + err.message);
      } finally {
        btnReload.disabled = false;
        btnReload.textContent = '🔄 Refresh Sheet';
      }
    });
  }
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
  const cameraInput = document.getElementById('cameraSearchInput');
  const modePills = document.querySelectorAll('.search-mode-pill');

  // Search mode pill selection (All, Title, Author)
  modePills.forEach(pill => {
    pill.addEventListener('click', () => {
      modePills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentSearchType = pill.getAttribute('data-type') || 'all';

      if (currentSearchType === 'author') {
        input.placeholder = "Type author's name (e.g. Tony Robbins, Scott Young)...";
      } else if (currentSearchType === 'title') {
        input.placeholder = "Type book title (e.g. Awaken the Giant Within)...";
      } else {
        input.placeholder = "Search by title, author, or Book ID (e.g. BK-10151)...";
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
    }, 250);
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.style.display = 'none';
    performSearch('');
  });

  // Live Webcam button for Search
  const btnSearchLive = document.getElementById('btnSearchLiveCamera');
  if (btnSearchLive) {
    btnSearchLive.addEventListener('click', () => {
      if (typeof window.openLiveCamera === 'function') {
        window.openLiveCamera('search');
      }
    });
  }

  // Photo search via camera or file upload (Req 2.5)
  const cameraSearchFileInput = document.getElementById('cameraSearchFileInput');
  const handleSearchFile = async (file) => {
    if (!file) return;
    await processCoverSearchImage(file, file.name);
    if (cameraInput) cameraInput.value = '';
    if (cameraSearchFileInput) cameraSearchFileInput.value = '';
  };

  if (cameraInput) {
    cameraInput.addEventListener('change', (e) => handleSearchFile(e.target.files[0]));
  }
  if (cameraSearchFileInput) {
    cameraSearchFileInput.addEventListener('change', (e) => handleSearchFile(e.target.files[0]));
  }
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

async function performSearch(query) {
  const container = document.getElementById('searchResultsContainer');
  if (!query || !query.trim()) {
    const hint = currentSearchType === 'author' 
      ? "Enter an author's name above to see all their books." 
      : (currentSearchType === 'title' 
          ? "Enter a book title above." 
          : "Enter a book title, author, niche genre, or Inventory ID above.");
    container.innerHTML = `<div class="empty-state-card">${hint}</div>`;
    return;
  }

  container.innerHTML = '<div class="photo-meta">Searching live inventory records...</div>';

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(currentSearchType)}`);
    const data = await res.json();
    renderSearchResults(data);
  } catch (err) {
    container.innerHTML = `<div class="alert alert-danger">Error searching inventory: ${err.message}</div>`;
  }
}

function renderSearchResults(data) {
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

  let badgeText = 'EXACT MATCH';
  let categoryTitle = `Matching Books (${exact_matches.length})`;
  if (search_type === 'author') {
    badgeText = 'AUTHOR MATCH';
    categoryTitle = `✍️ Books by Author "${escapeHtml(query)}" (${exact_matches.length})`;
  } else if (search_type === 'title') {
    badgeText = 'TITLE MATCH';
    categoryTitle = `📖 Books Matching Title "${escapeHtml(query)}" (${exact_matches.length})`;
  }

  // Exact Matches Only
  const block = document.createElement('div');
  block.className = 'results-category-block';
  block.innerHTML = `
    <div class="category-header exact-header">
      <span class="badge badge-success">${badgeText}</span>
      <h3 class="category-title">${categoryTitle}</h3>
    </div>
  `;
  exact_matches.forEach(item => block.appendChild(createBookCard(item, 'exact')));
  container.appendChild(block);
}

function createBookCard(bookGroup, matchType) {
  const card = document.createElement('div');
  card.className = 'book-card-item';

  const isSoldOut = bookGroup.available_copies === 0;

  let copiesHtml = bookGroup.copies.map(copy => {
    const cleanNotes = (copy.notes || '').replace(/\[idempotency:[^\]]+\]/g, '').trim();
    return `
    <div class="copy-row">
      <div class="copy-id-status">
        <span class="copy-id-box">${escapeHtml(copy.book_id)}</span>
        <span class="badge ${copy.status === 'Available' ? 'badge-success' : 'badge-danger'}">
          ${copy.status}
        </span>
      </div>
      <div class="copy-location-box">
        📍 <b>${escapeHtml(copy.location_english)}</b>
        ${cleanNotes ? `<small class="copy-notes">(${escapeHtml(cleanNotes)})</small>` : ''}
      </div>
      <div class="copy-actions">
        ${copy.status === 'Available' ? `
          <button class="btn btn-sm btn-success btn-sell-copy" data-bid="${escapeHtml(copy.book_id)}">
            ⚡ Sell Copy
          </button>
        ` : `
          <button class="btn btn-sm btn-outline" disabled>Sold Out</button>
        `}
      </div>
    </div>
  `;
  }).join('');

  card.innerHTML = `
    <div class="book-card-main">
      <div>
        <div class="book-title">${escapeHtml(bookGroup.title)}</div>
        <div class="book-author">by <b>${escapeHtml(bookGroup.author)}</b></div>
        <div class="book-genre-tags">
          ${bookGroup.simple_genre ? `<span class="chip simple-genre-chip">${escapeHtml(bookGroup.simple_genre)}</span>` : ''}
          ${bookGroup.genre ? `<span class="chip">${escapeHtml(bookGroup.genre)}</span>` : ''}
          <span class="chip">${escapeHtml(bookGroup.language || 'English')}</span>
        </div>
      </div>
      <div>
        <span class="copies-summary-badge ${isSoldOut ? 'sold-out' : ''}">
          ${bookGroup.available_copies} of ${bookGroup.total_copies} Copies Available
        </span>
      </div>
    </div>

    <div class="physical-copies-list">
      <div style="font-size:0.78rem; font-weight:700; color:#4b5563; text-transform:uppercase;">Physical Copies & Locations:</div>
      ${copiesHtml}
    </div>
  `;

  // Attach direct event listeners to eliminate inline quote escaping issues
  card.querySelectorAll('.btn-sell-copy').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const bid = btn.getAttribute('data-bid');
      const copyObj = bookGroup.copies.find(c => c.book_id === bid);
      const loc = copyObj ? copyObj.location_english : '';
      openSaleModalForCopy(bid, bookGroup.title, bookGroup.author, loc);
    });
  });

  return card;
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

  const chk = document.getElementById('chkGenreAvailableOnly');
  const availOnly = chk ? chk.checked : true;

  try {
    const res = await fetch(`/api/books/by-genre?genre=${encodeURIComponent(genreName)}&available_only=${availOnly}`);
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

  safeSet('genreBooksCountBadge', `${filtered.length} Book${filtered.length === 1 ? '' : 's'}`);

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

  const chkAvail = document.getElementById('chkGenreAvailableOnly');
  if (chkAvail) {
    chkAvail.addEventListener('change', () => {
      const g = document.getElementById('genreSelect')?.value;
      if (g) fetchBooksForGenre(g);
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

function initSingleAdd() {
  const form = document.getElementById('formSingleBook');
  const cameraInput = document.getElementById('singleBookCamera');
  const previewBox = document.getElementById('singlePhotoPreview');
  const previewImg = document.getElementById('singlePhotoImg');
  const ocrStatus = document.getElementById('singleOcrStatus');

  const rackInput = document.getElementById('singleRack');
  const colInput = document.getElementById('singleColumn');
  const posInput = document.getElementById('singlePosition');
  const locPreview = document.getElementById('singleLocationEnglishPreview');

  // Live Location Preview (Req 1.6)
  function updateLocPreview() {
    const rack = rackInput.value.trim();
    const col = colInput.value.trim();
    const pos = posInput.value.trim();
    if (!rack || !col || !pos) {
      locPreview.innerHTML = 'English Location: <span class="highlight">Unassigned</span>';
    } else {
      let posText = pos;
      if (pos === '1') posText = 'On top of the rack';
      else if (pos === '2') posText = '2nd book from top';
      else if (pos === '3') posText = '3rd book from top';
      else if (pos === '4') posText = '4th book from top';
      else if (pos === '5') posText = '5th book from top';
      else if (!isNaN(pos)) posText = `${pos}th book from top`;
      locPreview.innerHTML = `English Location: <span class="highlight">${escapeHtml(rack)} → ${escapeHtml(col)} → ${escapeHtml(posText)}</span>`;
    }
  }

  rackInput.addEventListener('input', updateLocPreview);
  colInput.addEventListener('input', updateLocPreview);
  posInput.addEventListener('input', updateLocPreview);

  // Setup Live Camera Viewfinder & File Upload (Req 1.1 Option A)
  initLiveCamera();

  const fileInput = document.getElementById('singleBookFile');
  const handleSingleImage = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      processBookImageOCR(reader.result, file.name);
    };
    reader.readAsDataURL(file);
    if (cameraInput) cameraInput.value = '';
    if (fileInput) fileInput.value = '';
  };

  if (cameraInput) cameraInput.addEventListener('change', (e) => handleSingleImage(e.target.files[0]));
  if (fileInput) fileInput.addEventListener('change', (e) => handleSingleImage(e.target.files[0]));

  // Title duplicate check on blur
  document.getElementById('singleTitle').addEventListener('blur', () => {
    checkDuplicateTitle(document.getElementById('singleTitle').value);
  });

  // Form Submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const saveBtn = document.getElementById('btnSaveSingleBook');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving to Inventory & Google Sheets...';

    const payload = {
      title: document.getElementById('singleTitle').value,
      author: document.getElementById('singleAuthor').value,
      genre: document.getElementById('singleGenre').value,
      language: document.getElementById('singleLanguage').value,
      rack: document.getElementById('singleRack').value,
      column_num: document.getElementById('singleColumn').value,
      position: document.getElementById('singlePosition').value,
      notes: document.getElementById('singleNotes').value,
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
        alert(`🎉 Book Successfully Added!\n\nInventory ID: ${data.book.book_id}\nTitle: ${data.book.title}\nLocation: ${data.book.location_english}`);
        form.reset();
        previewBox.style.display = 'none';
        updateLocPreview();
        fetchStats();
        // Showcase in search
        setSearch(data.book.book_id);
      } else {
        alert('Error adding book: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Network or server error: ' + err.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '💾 Save Book to Inventory & Google Sheets';
    }
  });
}

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

  const btnToggleKey = document.getElementById('btnToggleGoogleKey');
  const keyWrap = document.getElementById('googleKeyInputWrap');
  const inputKey = document.getElementById('inputGoogleApiKey');
  const btnSaveKey = document.getElementById('btnSaveGoogleKey');

  // Load and auto-sync Google Gemini API key from server
  fetch('/api/config/google-key')
    .then(r => r.json())
    .then(data => {
      if (data.google_api_key) {
        localStorage.setItem('google_vision_api_key', data.google_api_key);
        if (inputKey) inputKey.value = data.google_api_key;
      }
    })
    .catch(() => {});

  const savedKey = localStorage.getItem('google_vision_api_key') || '';
  if (savedKey) inputKey.value = savedKey;

  btnToggleKey.addEventListener('click', () => {
    keyWrap.style.display = keyWrap.style.display === 'flex' ? 'none' : 'flex';
  });

  btnSaveKey.addEventListener('click', () => {
    const k = inputKey.value.trim();
    localStorage.setItem('google_vision_api_key', k);
    alert(k ? '✅ Google Cloud Vision / Gemini API Key saved!' : 'Key cleared.');
    keyWrap.style.display = 'none';
  });

  let currentLiveCameraMode = 'single';
  const modalTitle = document.getElementById('liveCameraModalTitle');
  const doneBatchABtn = document.getElementById('btnDoneLiveBatchA');
  const countDoneSpan = document.getElementById('countDoneBatchA');
  const wrapAutoScan = document.getElementById('wrapAutoScan');

  function updateBatchADoneCount() {
    if (countDoneSpan) countDoneSpan.textContent = batchBooksA.length;
  }

  window.openLiveCamera = async function(mode = 'single') {
    currentLiveCameraMode = mode;
    modal.style.display = 'flex';
    hudBanner.style.display = 'none';

    if (doneBatchABtn) doneBatchABtn.style.display = (mode === 'batchA') ? 'inline-flex' : 'none';
    if (wrapAutoScan) wrapAutoScan.style.display = (mode === 'single') ? 'inline-flex' : 'none';

    if (mode === 'batchA') {
      if (modalTitle) modalTitle.textContent = '📸 Workflow A: Rapid Batch Photos';
      guideStatus.textContent = 'Hold book in frame & tap Snap. Snaps one after another!';
      snapBtn.textContent = `📸 Snap Book #${batchBooksA.length + 1}`;
      updateBatchADoneCount();
    } else if (mode === 'batchB') {
      if (modalTitle) modalTitle.textContent = '📸 Workflow B: Shelf / Stack Photo';
      guideStatus.textContent = 'Align entire stack of books (spines stacked vertically) in frame';
      snapBtn.textContent = '📸 Snap Stack Photo';
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

  closeBtn.addEventListener('click', () => {
    stopCameraStream();
    modal.style.display = 'none';
  });

  switchBtn.addEventListener('click', async () => {
    currentCameraFacing = currentCameraFacing === 'environment' ? 'user' : 'environment';
    stopCameraStream();
    await startCameraStream();
  });

  // Continuous Video Detection Toggle
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

  btnUseDetected.addEventListener('click', () => {
    if (!latestDetectedBook) return;
    stopCameraStream();
    modal.style.display = 'none';
    applyDetectedBookToForm(latestDetectedBook);
  });

  snapBtn.addEventListener('click', async () => {
    if (!video.videoWidth) {
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
    } else if (currentLiveCameraMode === 'batchB') {
      stopCameraStream();
      modal.style.display = 'none';
      processStackPhoto(dataUrl, 'stack_photo.jpg');
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

  function fallbackToNativeCamera(mode) {
    if (mode === 'single') {
      const cam = document.getElementById('singleBookCamera');
      if (cam) cam.click();
    } else if (mode === 'batchA') {
      const cam = document.getElementById('batchCameraInput');
      if (cam) cam.click();
    } else if (mode === 'batchB') {
      const cam = document.getElementById('multiBookCameraInput');
      if (cam) cam.click();
    } else if (mode === 'pos') {
      const cam = document.getElementById('posCameraInput');
      if (cam) cam.click();
    } else if (mode === 'search') {
      const cam = document.getElementById('cameraSearchInput');
      if (cam) cam.click();
    }
  }

  async function startCameraStream() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const isSecure = window.isSecureContext || location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
      let msg = '';
      if (!isSecure) {
        msg = '🔒 Camera Stream Requires HTTPS\n\n' +
          'Web browsers strictly restrict live video streaming (getUserMedia) to Secure Contexts (HTTPS or localhost).\n\n' +
          '👉 You have 3 easy solutions:\n' +
          '1. Open the local HTTPS server: https://' + location.hostname + ':8443/\n' +
          '2. Open the official cloud deployment: https://book-store-advanced.vercel.app\n' +
          '3. Or use the "📱 Phone Camera" button, which opens your camera shutter directly over local HTTP!';
      } else {
        msg = 'Unable to access camera: Camera permissions are denied or no camera device is connected.';
      }
      alert(msg);
      modal.style.display = 'none';
      fallbackToNativeCamera(currentLiveCameraMode);
      return;
    }

    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: currentCameraFacing },
          width: { ideal: 1920, min: 1280 },
          height: { ideal: 1080, min: 720 }
        },
        audio: false
      });
      video.srcObject = cameraStream;
      if (autoScanChk.checked) {
        startContinuousVideoScan();
      }
    } catch (err) {
      alert('Unable to access camera: ' + err.message + '\n\nPlease ensure camera permissions are granted in your browser, or use the "📱 Phone Camera" or "Upload Book Photo" button.');
      modal.style.display = 'none';
      fallbackToNativeCamera(currentLiveCameraMode);
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
          const googleKey = localStorage.getItem('google_vision_api_key') || '';
          const res = await fetch('/api/books/ocr-extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw_text: frameText, image_data: frameDataUrl, google_api_key: googleKey })
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
  const matchBadge = document.getElementById('singleMatchBadge');
  const ocrStatus = document.getElementById('singleOcrStatus');
  const previewBox = document.getElementById('singlePhotoPreview');

  previewBox.style.display = 'block';
  document.getElementById('singleTitle').value = cand.title;
  if (cand.author) document.getElementById('singleAuthor').value = cand.author;
  if (cand.genre) document.getElementById('singleGenre').value = cand.genre;
  if (cand.language) document.getElementById('singleLanguage').value = cand.language;

  matchBadge.style.display = 'block';
  matchBadge.innerHTML = `✅ <b>Detected via Google Video Engine:</b> "${escapeHtml(cand.title)}" by <b>${escapeHtml(cand.author)}</b>`;
  ocrStatus.textContent = '✅ Book detected in video stream and filled below!';
  checkDuplicateTitle(cand.title);
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
  const previewBox = document.getElementById('singlePhotoPreview');
  const previewImg = document.getElementById('singlePhotoImg');
  const ocrStatus = document.getElementById('singleOcrStatus');
  const progressWrap = document.getElementById('ocrProgressWrap');
  const progressFill = document.getElementById('ocrProgressFill');
  const rawTextWrap = document.getElementById('singleOcrRawTextWrap');
  const rawTextElem = document.getElementById('singleOcrRawText');
  const matchBadge = document.getElementById('singleMatchBadge');

  previewBox.style.display = 'block';
  previewImg.src = imageDataUrl;
  progressWrap.style.display = 'block';
  progressFill.style.width = '20%';
  ocrStatus.textContent = 'Processing image...';
  rawTextWrap.style.display = 'none';
  matchBadge.style.display = 'none';

  let geminiDetected = null;
  const rawKey = (localStorage.getItem('google_vision_api_key') || '').trim();
  const googleKey = rawKey.length > 15 ? rawKey : 'AQ.Ab8RN6LlJMtfmbF5D-ab_GRLfZUOw02vTua6nA9IbRKtZE6L_w';

  // 1. First Priority: Direct Google Gemini Multimodal Vision AI
  if (googleKey && imageDataUrl) {
    try {
      ocrStatus.textContent = '🌟 Recognizing book with Google Gemini Vision AI...';
      progressFill.style.width = '55%';

      const cleanB64 = imageDataUrl.includes(',') ? imageDataUrl.split(',')[1] : imageDataUrl;
      const mime = (imageDataUrl.match(/data:(image\/[a-zA-Z]+);base64,/) || [])[1] || 'image/jpeg';

      const prompt = `You are an automated bookstore scanner. Look at this book cover photograph.
Identify:
1. "title": Exact main book title.
2. "author": Primary author name.
3. "genre": Likely genre or category.
4. "language": Book language (default "English").
5. "confidence": "high", "medium", or "low".
Return strictly valid JSON with these keys and no markdown or extra text.`;

      const gRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${googleKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': googleKey
        },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inlineData: { mimeType: mime, data: cleanB64 } }
            ]
          }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
        })
      });

      if (gRes.ok) {
        const gData = await gRes.json();
        const rawContent = gData.candidates?.[0]?.content?.parts?.[0]?.text;
        if (rawContent) {
          const parsed = JSON.parse(rawContent.replace(/^```[a-z]*\n|\n```$/g, '').trim());
          if (parsed && parsed.title) {
            geminiDetected = parsed;
          }
        }
      }
    } catch (gErr) {
      console.warn('Google Gemini API notice:', gErr);
    }
  }

  // If Google Gemini recognized the book, populate immediately!
  if (geminiDetected && geminiDetected.title) {
    progressWrap.style.display = 'none';
    document.getElementById('singleTitle').value = geminiDetected.title;
    if (geminiDetected.author) document.getElementById('singleAuthor').value = geminiDetected.author;
    if (geminiDetected.genre) document.getElementById('singleGenre').value = geminiDetected.genre;
    if (geminiDetected.language) document.getElementById('singleLanguage').value = geminiDetected.language || 'English';

    matchBadge.style.display = 'block';
    matchBadge.innerHTML = `🌟 <b>Identified via Google Gemini Vision AI:</b> "${escapeHtml(geminiDetected.title)}" by <b>${escapeHtml(geminiDetected.author || 'Author')}</b>`;
    ocrStatus.textContent = '✅ Book identified via Google Gemini Vision AI! Details filled below.';
    checkDuplicateTitle(geminiDetected.title);
    return;
  }

  // 2. Optical OCR Fallback if Gemini unavailable
  let extractedText = '';
  if (window.Tesseract) {
    try {
      ocrStatus.textContent = 'Reading text from book cover...';
      progressFill.style.width = '40%';
      const processedImage = await preprocessImageForOCR(imageDataUrl);

      const result = await Tesseract.recognize(
        processedImage,
        'eng',
        {
          logger: m => {
            if (m.status === 'recognizing text') {
              const pct = Math.min(90, Math.round(40 + (m.progress || 0) * 50));
              progressFill.style.width = `${pct}%`;
              ocrStatus.textContent = `Reading text from book cover... ${pct}%`;
            }
          }
        }
      );
      extractedText = (result.data.text || '').trim();
    } catch (err) {
      console.warn('In-browser OCR encountered warning:', err);
    }
  }

  // 3. Fallback to filename hints if OCR empty
  let payloadText = extractedText;
  if (!payloadText && filenameHint) {
    payloadText = filenameHint.replace(/\.[^/.]+$/, "").replace(/[_\-]/g, " ");
  }

  progressFill.style.width = '92%';
  ocrStatus.textContent = 'Analyzing and extracting book details...';

  try {
    const res = await fetch('/api/books/ocr-extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw_text: payloadText,
        image_data: imageDataUrl,
        google_api_key: googleKey
      })
    });
    const cand = await res.json();

    progressWrap.style.display = 'none';

    if (payloadText) {
      rawTextWrap.style.display = 'block';
      rawTextElem.textContent = payloadText;
    }

    if (cand.title && cand.title.length > 2) {
      // 4. Cross-reference with Global Book Catalog if needed
      if (!cand.matched_existing) {
        const globalLookup = await searchGlobalBookCatalog(cand.title + ' ' + (cand.author || '')) || await searchGlobalBookCatalog(cand.title);
        if (globalLookup && globalLookup.title) {
          cand.title = globalLookup.title;
          if (globalLookup.author) cand.author = globalLookup.author;
          if (globalLookup.genre && !cand.genre) cand.genre = globalLookup.genre;
          cand.engine = 'Global Book Catalog (Open Library)';
        }
      }

      document.getElementById('singleTitle').value = cand.title;
      if (cand.author) document.getElementById('singleAuthor').value = cand.author;
      if (cand.genre) document.getElementById('singleGenre').value = cand.genre;
      if (cand.language) document.getElementById('singleLanguage').value = cand.language;

      if (cand.matched_existing) {
        matchBadge.style.display = 'block';
        matchBadge.innerHTML = `✅ <b>Verified Catalog Match:</b> "${escapeHtml(cand.title)}" by <b>${escapeHtml(cand.author)}</b>`;
        ocrStatus.textContent = '✅ Book identified from bookstore inventory!';
      } else {
        matchBadge.style.display = 'block';
        matchBadge.innerHTML = `📘 <b>Identified Book:</b> "${escapeHtml(cand.title)}" by <b>${escapeHtml(cand.author || 'Author')}</b>`;
        ocrStatus.textContent = '✅ Book cover identified! Details filled below.';
      }

      checkDuplicateTitle(cand.title);
    } else {
      ocrStatus.textContent = '⚠️ Could not clearly extract title from image. Please enter manually.';
    }
  } catch (err) {
    progressWrap.style.display = 'none';
    ocrStatus.textContent = 'Error processing book text: ' + err.message;
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

  saveBatchBtn.addEventListener('click', async () => {
    if (batchBooksA.length === 0) return;
    saveBatchBtn.disabled = true;
    saveBatchBtn.textContent = 'Saving Batch to Google Sheets...';

    try {
      const res = await fetch('/api/books/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ books: batchBooksA })
      });
      const data = await res.json();
      if (data.success) {
        alert(`🎉 Batch Successfully Saved!\n\n${data.count} physical books added with unique Inventory IDs to Google Sheets.`);
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
      saveBatchBtn.textContent = '💾 Save All to Google Sheets';
    }
  });
}

function renderBatchTableA() {
  const tbody = document.getElementById('tbodyBatchA');
  const countSpan = document.getElementById('batchCount');
  const saveCountSpan = document.getElementById('batchCountSave');
  const saveBtn = document.getElementById('btnSaveBatchA');

  countSpan.textContent = batchBooksA.length;
  saveCountSpan.textContent = batchBooksA.length;
  saveBtn.disabled = batchBooksA.length === 0;

  if (batchBooksA.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No books in batch. Snap books one after another using "Webcam" or "Snap Next Book".</td></tr>';
    return;
  }

  tbody.innerHTML = batchBooksA.map((item, idx) => `
    <tr>
      <td><img src="${item.photo}" style="width:40px; height:50px; object-fit:cover; border-radius:4px;"></td>
      <td><input type="text" value="${escapeHtml(item.title)}" onchange="updateBatchItemA(${idx}, 'title', this.value)" style="width:100%;"></td>
      <td><input type="text" value="${escapeHtml(item.author)}" onchange="updateBatchItemA(${idx}, 'author', this.value)" style="width:100%;"></td>
      <td><input type="text" value="${escapeHtml(item.genre)}" onchange="updateBatchItemA(${idx}, 'genre', this.value)" style="width:100%;"></td>
      <td>
        <input type="text" placeholder="Rack" value="${escapeHtml(item.rack)}" onchange="updateBatchItemA(${idx}, 'rack', this.value)" style="width:60px;">
        <input type="text" placeholder="Col" value="${escapeHtml(item.column_num)}" onchange="updateBatchItemA(${idx}, 'column_num', this.value)" style="width:50px;">
        <input type="text" placeholder="Pos" value="${escapeHtml(item.position)}" onchange="updateBatchItemA(${idx}, 'position', this.value)" style="width:50px;">
      </td>
      <td>
        ${item.flag_uncertain ? `<span class="badge badge-warning">⚠️ ${escapeHtml(item.warning || 'Verify')}</span>` : `<span class="badge badge-success">Confidence: High</span>`}
      </td>
      <td>
        <button class="btn btn-sm btn-outline" onclick="removeBatchItemA(${idx})">🗑️</button>
      </td>
    </tr>
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

async function processStackPhoto(base64Data, filename = 'stack.jpg') {
  const previewWrap = document.getElementById('multiPhotoPreviewWrap');
  const previewImg = document.getElementById('multiPhotoImg');
  const statusLbl = document.getElementById('multiPhotoStatus');

  previewWrap.style.display = 'block';
  previewImg.src = base64Data;
  statusLbl.textContent = '🔍 Reading stack of books (detecting spines from top to bottom)...';

  let ocrLines = [];
  if (window.Tesseract) {
    try {
      statusLbl.textContent = '🔍 Extracting text lines from spines...';
      const ocrRes = await Tesseract.recognize(base64Data, 'eng');
      const text = ocrRes.data?.text || '';
      ocrLines = text.split('\n').map(l => l.trim()).filter(l => l.length >= 2);
    } catch (err) {
      console.warn('Tesseract stack OCR notice:', err);
    }
  }

  statusLbl.textContent = '📚 Segmenting individual book spines...';

  // Group text into spine blocks (lines of text for each book spine in the stack)
  let blocks = [];
  if (ocrLines.length > 0) {
    let curr = [];
    for (let i = 0; i < ocrLines.length; i++) {
      curr.push(ocrLines[i]);
      if (curr.length >= 2 || i === ocrLines.length - 1) {
        blocks.push(curr.join('\n'));
        curr = [];
      }
    }
  }

  const rawPayload = blocks.length > 0 ? blocks.join('\n---\n') : (ocrLines.join('\n') || filename.replace(/\.[^/.]+$/, ""));

  try {
    const res = await fetch('/api/books/ocr-extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw_text: rawPayload,
        multiple: true,
        spine_mode: true,
        image_data: base64Data
      })
    });
    const data = await res.json();
    batchCandidatesB = (data.candidates || []).map((cand, idx) => ({
      ...cand,
      position: idx + 1, // Spine 1 is top of stack, Spine 2 is 2nd from top, etc.
      skipped: false
    }));

    if (batchCandidatesB.length === 0) {
      statusLbl.textContent = '⚠️ No clear book spines detected in stack. Please verify or take a closer photo.';
    } else {
      statusLbl.textContent = `✅ Successfully detected ${batchCandidatesB.length} books in stack (ordered top to bottom).`;
    }
    renderBatchTableB();
  } catch (err) {
    statusLbl.textContent = 'Error processing stack: ' + err.message;
  }
}

function initBatchB() {
  const cameraInput = document.getElementById('multiBookCameraInput');
  const fileInput = document.getElementById('multiBookFileInput');
  const liveCameraBtn = document.getElementById('btnBatchBLiveCamera');
  const previewWrap = document.getElementById('multiPhotoPreviewWrap');
  const previewImg = document.getElementById('multiPhotoImg');
  const statusLbl = document.getElementById('multiPhotoStatus');
  const saveBtn = document.getElementById('btnSaveBatchB');

  // Mode switcher tabs
  const modeBtns = document.querySelectorAll('.mode-btn');
  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      modeBtns.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.mode-content').forEach(c => c.style.display = 'none');

      btn.classList.add('active');
      const mode = btn.getAttribute('data-mode');
      if (mode === 'singleAdd') document.getElementById('sectionSingleAdd').style.display = 'block';
      if (mode === 'bulkA') document.getElementById('sectionBulkA').style.display = 'block';
      if (mode === 'bulkB') document.getElementById('sectionBulkB').style.display = 'block';
    });
  });

  if (liveCameraBtn) {
    liveCameraBtn.addEventListener('click', () => {
      if (typeof window.openLiveCamera === 'function') {
        window.openLiveCamera('batchB');
      }
    });
  }

  const handleBatchBFile = async (file) => {
    if (!file) return;
    try {
      const downscaledB64 = await downscaleImage(file, 1600, 0.88);
      await processStackPhoto(downscaledB64, file.name);
      if (cameraInput) cameraInput.value = '';
      if (fileInput) fileInput.value = '';
    } catch (err) {
      alert('Error reading stack photo: ' + err.message);
    }
  };

  if (cameraInput) cameraInput.addEventListener('change', (e) => handleBatchBFile(e.target.files[0]));
  if (fileInput) fileInput.addEventListener('change', (e) => handleBatchBFile(e.target.files[0]));

  saveBtn.addEventListener('click', async () => {
    const validBooks = batchCandidatesB.filter(b => b.title && b.title.trim() && !b.skipped);
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
        alert(`🎉 Successfully confirmed and saved ${data.count} books to Google Sheets!`);
        batchCandidatesB = [];
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

function renderBatchTableB() {
  const tbody = document.getElementById('tbodyBatchB');
  const countSpan = document.getElementById('multiCandidateCount');
  const saveBtn = document.getElementById('btnSaveBatchB');

  const validCount = batchCandidatesB.filter(b => !b.skipped).length;
  countSpan.textContent = validCount;
  saveBtn.disabled = validCount === 0;

  if (batchCandidatesB.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Photograph a shelf row or stack of books to detect individual titles.</td></tr>';
    return;
  }

  tbody.innerHTML = batchCandidatesB.map((cand, idx) => `
    <tr style="${cand.skipped ? 'opacity: 0.5; text-decoration: line-through;' : ''}">
      <td><b>#${idx + 1}</b></td>
      <td><input type="text" value="${escapeHtml(cand.title)}" onchange="updateBatchItemB(${idx}, 'title', this.value)" style="width:100%;"></td>
      <td><input type="text" value="${escapeHtml(cand.author)}" onchange="updateBatchItemB(${idx}, 'author', this.value)" style="width:100%;"></td>
      <td><input type="text" value="${escapeHtml(cand.genre)}" onchange="updateBatchItemB(${idx}, 'genre', this.value)" style="width:100%;"></td>
      <td>
        <input type="text" placeholder="Rack 50" value="${escapeHtml(cand.rack || '')}" onchange="updateBatchItemB(${idx}, 'rack', this.value)" style="width:70px;">
        <input type="text" placeholder="Col 1" value="${escapeHtml(cand.column_num || '')}" onchange="updateBatchItemB(${idx}, 'column_num', this.value)" style="width:50px;">
      </td>
      <td>
        ${cand.flag_uncertain ? `<span class="badge badge-warning">⚠️ ${escapeHtml(cand.warning || 'Uncertain spine')}</span>` : `<span class="badge badge-success">Spine Detected</span>`}
        ${cand.existing_in_inventory ? `<div style="font-size:0.75rem; color:#2563eb; margin-top:0.2rem;">Copy of existing title</div>` : ''}
      </td>
      <td>
        <button class="btn btn-sm ${cand.skipped ? 'btn-primary' : 'btn-outline'}" onclick="toggleSkipCandidateB(${idx})">
          ${cand.skipped ? 'Restore' : 'Skip'}
        </button>
      </td>
    </tr>
  `).join('');
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
   6. SELLING WORKFLOW (POS) (Req 3)
   ========================================================================= */

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

function initPOS() {
  const searchInput = document.getElementById('posSearchInput');
  const drawer = document.getElementById('saleDrawer');
  const closeBtn = document.getElementById('btnCloseSaleDrawer');
  const confirmBtn = document.getElementById('btnConfirmSale');
  const cameraInput = document.getElementById('posCameraInput');
  const fileInput = document.getElementById('posFileInput');
  const liveCameraBtn = document.getElementById('btnPosLiveCamera');

  if (liveCameraBtn) {
    liveCameraBtn.addEventListener('click', () => {
      if (typeof window.openLiveCamera === 'function') {
        window.openLiveCamera('pos');
      }
    });
  }

  let posDebounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(posDebounce);
    posDebounce = setTimeout(() => {
      searchPOS(searchInput.value);
    }, 250);
  });

  const handlePosFile = async (file) => {
    if (!file) return;
    await processPosSearchImage(file, file.name);
    if (cameraInput) cameraInput.value = '';
    if (fileInput) fileInput.value = '';
  };

  if (cameraInput) cameraInput.addEventListener('change', (e) => handlePosFile(e.target.files[0]));
  if (fileInput) fileInput.addEventListener('change', (e) => handlePosFile(e.target.files[0]));

  closeBtn.addEventListener('click', () => {
    drawer.style.display = 'none';
    activeSaleCopy = null;
  });

  // Also close when clicking outside modal card on backdrop
  drawer.addEventListener('click', (e) => {
    if (e.target === drawer) {
      drawer.style.display = 'none';
      activeSaleCopy = null;
    }
  });

  confirmBtn.addEventListener('click', async () => {
    if (!activeSaleCopy) return;

    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Processing Sale & Updating Google Sheets...';

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
        alert(`✅ Sale Confirmed!\n\n"${soldTitle}" (${soldBid})\nMarked SOLD OUT and synced to Google Sheets.\nTransaction Ref: ${data.transaction_ref}`);
      } else {
        alert('Cannot complete sale: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Network error completing sale: ' + err.message);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = '✅ Complete Sale & Mark SOLD OUT in Google Sheets';
    }
  });
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

    container.innerHTML = allMatches.map(group => `
      <div class="book-card-item">
        <div class="book-card-main">
          <div>
            <div class="book-title">${escapeHtml(group.title)}</div>
            <div class="book-author">by ${escapeHtml(group.author)}</div>
          </div>
          <span class="copies-summary-badge ${group.available_copies === 0 ? 'sold-out' : ''}">
            ${group.available_copies} of ${group.total_copies} Available
          </span>
        </div>
        <div class="physical-copies-list">
          ${group.copies.map(copy => `
            <div class="copy-row">
              <div>
                <span class="copy-id-box">${escapeHtml(copy.book_id)}</span>
                <span class="badge ${copy.status === 'Available' ? 'badge-success' : 'badge-danger'}">
                  ${copy.status}
                </span>
                <span style="font-size:0.88rem; margin-left:0.5rem;">📍 ${escapeHtml(copy.location_english)}</span>
              </div>
              <div>
                ${copy.status === 'Available' ? `
                  <button class="btn btn-sm btn-success btn-pos-sell" data-bid="${escapeHtml(copy.book_id)}">
                    ⚡ Select for Sale
                  </button>
                ` : `
                  <button class="btn btn-sm btn-outline" disabled>SOLD OUT</button>
                `}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.btn-pos-sell').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bid = btn.getAttribute('data-bid');
        for (const group of allMatches) {
          const c = group.copies.find(x => x.book_id === bid);
          if (c) {
            openSaleModalForCopy(bid, group.title, group.author, c.location_english);
            break;
          }
        }
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="alert alert-danger">Error: ${err.message}</div>`;
  }
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
  container.style.display = 'block';

  const priceText = saleData.selling_price !== null ? `$${parseFloat(saleData.selling_price).toFixed(2)}` : 'Not recorded (Price omitted)';

  container.innerHTML = `
    <div class="receipt-title">✅ Sale Confirmed & Marked SOLD OUT</div>
    <div class="receipt-meta">Transaction Ref: <b>${escapeHtml(saleData.transaction_ref)}</b> | Time: ${new Date(saleData.sold_at).toLocaleString()}</div>
    <div style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:1rem; max-width:400px; margin:0 auto 1rem auto; text-align:left;">
      <div><b>Title:</b> ${escapeHtml(saleData.book.title)}</div>
      <div><b>Author:</b> ${escapeHtml(saleData.book.author)}</div>
      <div><b>Inventory ID:</b> ${escapeHtml(saleData.book.book_id)}</div>
      <div><b>Recorded Price:</b> ${priceText}</div>
      <div><b>Availability:</b> <span class="badge badge-danger">SOLD OUT</span> (Synced to Google Sheets)</div>
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

  let debounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(fetchUnassigned, 250);
  });

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

  if (btnBulkDelete) {
    btnBulkDelete.addEventListener('click', deleteBulkUnassigned);
  }

  btnOpenModal.addEventListener('click', () => {
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
        alert(`🎉 Updated locations for ${data.updated_count} books in Google Sheets!`);
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
  const query = document.getElementById('unassignedSearchInput').value;
  const tbody = document.getElementById('tbodyUnassigned');

  try {
    const res = await fetch(`/api/unassigned?q=${encodeURIComponent(query)}`);
    const data = await res.json();

    document.getElementById('unassignedCountLabel').textContent = data.total;
    const badge = document.getElementById('tabUnassignedBadge');
    if (badge) badge.textContent = data.total;

    if (data.books.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">✅ No unassigned books! All inventory copies have recorded shelf locations.</td></tr>';
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
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Error loading unassigned books: ${err.message}</td></tr>`;
  }
}

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
          <td><b>${s.selling_price !== null ? `$${parseFloat(s.selling_price).toFixed(2)}` : 'Not recorded'}</b></td>
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

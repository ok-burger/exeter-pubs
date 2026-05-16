/* ============================================================
   Exeter Pubs — app logic
   Phase 8: Personal reviews stored in localStorage. Each pub
   can have one review (date, rating, with, notes). UI: button
   on each card opens a modal. "Visited" tri-state filter chip.
   Settings dialog for export/import/wipe.
   ============================================================ */

// ----- Storage -----

const REVIEWS_KEY = 'exeter-pubs:reviews:v1';

const reviewStore = {
  cache: null,

  load() {
    if (this.cache !== null) return this.cache;
    try {
      const raw = localStorage.getItem(REVIEWS_KEY);
      this.cache = raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.warn('Failed to read reviews from storage:', e);
      this.cache = {};
    }
    return this.cache;
  },

  save() {
    try {
      localStorage.setItem(REVIEWS_KEY, JSON.stringify(this.cache));
      return true;
    } catch (e) {
      console.error('Failed to save reviews:', e);
      return false;
    }
  },

  get(pubId) {
    return this.load()[pubId] || null;
  },

  set(pubId, review) {
    this.load()[pubId] = { ...review, updated_at: new Date().toISOString() };
    return this.save();
  },

  delete(pubId) {
    delete this.load()[pubId];
    return this.save();
  },

  count() {
    return Object.keys(this.load()).length;
  },

  exportAll() {
    return {
      version: 1,
      exported_at: new Date().toISOString(),
      reviews: this.load()
    };
  },

  importAll(data) {
    if (!data || typeof data.reviews !== 'object') {
      throw new Error('Invalid file: expected { reviews: {...} }');
    }
    this.cache = { ...this.cache, ...data.reviews };
    return this.save();
  },

  wipeAll() {
    this.cache = {};
    localStorage.removeItem(REVIEWS_KEY);
  }
};

// ----- App state -----
const appState = {
  pubs: [],
  userLocation: null,
  map: null,
  pubMarkers: {},
  markerOnMap: {},
  userMarker: null,
  activeFilters: new Set(),
  visitedFilter: 'off',  // 'off' | 'visited' | 'unvisited'
  areaFilter: 'greater-exeter',  // 'greater-exeter' | 'all' | <area name>
  searchTerm: '',
  activeView: 'map',
  editingPubId: null,
  // Crawl state
  activeCrawl: null,        // { id, name, stops: [pubId,...], createdAt }
  crawlMarkers: [],
  crawlPolyline: null,
  plannerStops: 4,
  plannerRadius: 1000,
  plannerMap: null,
  plannerCircle: null,
  plannerCentreMarker: null,
};

// Areas considered part of "Greater Exeter" (the default view).
// Anything outside this list is in the wider catchment.
const GREATER_EXETER_AREAS = new Set([
  'Exeter', 'Heavitree', 'St Thomas', 'Exwick', 'Whipton', 'Pinhoe',
  'Wonford', 'Alphington', 'Topsham', 'Ide', 'Sowton', 'Ebford'
]);

const WALKING_METRES_PER_SECOND = 1.4;
const EXETER_CENTRE = { lat: 50.7236, lon: -3.5339 };

const CANONICAL_TAG_ORDER = [
  'Real Ale', 'Garden', 'Dog Friendly', 'Food',
  'Traditional', 'Live Music', 'Sports', 'Family Friendly'
];

// ----- Entry point -----
init();

async function init() {
  initMap();
  const pubs = await loadPubs();
  if (!pubs) return;
  appState.pubs = pubs;
  addPubMarkers(pubs);
  buildAreaSelect(pubs);
  bindAreaSelect();
  buildFilterChips(pubs);
  fitMapToPubs();
  applyFiltersAndRender();
  bindFindMeButton();
  bindClearFiltersButton();
  bindSearchInput();
  bindViewToggle();
  bindReviewDialog();
  bindSettingsDialog();
  bindCrawlPlanner();
  bindCrawlPanel();
  bindAddStopDialog();
  bindWelcomeDialog();
  maybeShowWelcomeOnFirstVisit();
  // Restore crawl from URL hash if present
  const fromHash = parseCrawlHash();
  if (fromHash) {
    setActiveCrawl(fromHash);
  }
}

// ----- Area filter -----

function buildAreaSelect(pubs) {
  const select = document.getElementById('area-select');
  if (!select) return;

  // Count pubs per area
  const counts = new Map();
  pubs.forEach(p => {
    const area = p.area || 'Exeter';
    counts.set(area, (counts.get(area) || 0) + 1);
  });

  const greaterCount = pubs.filter(p => GREATER_EXETER_AREAS.has(p.area)).length;
  const allCount = pubs.length;

  // Sort individual areas: greater-exeter ones first (alpha), then catchment ones (alpha)
  const allAreas = [...counts.keys()];
  const cityAreas = allAreas.filter(a => GREATER_EXETER_AREAS.has(a)).sort();
  const wideAreas = allAreas.filter(a => !GREATER_EXETER_AREAS.has(a)).sort();

  const opts = [
    `<option value="greater-exeter">Greater Exeter (${greaterCount})</option>`,
    `<option value="all">All catchment (${allCount})</option>`,
    `<optgroup label="City &amp; suburbs">`,
    ...cityAreas.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)} (${counts.get(a)})</option>`),
    `</optgroup>`,
    `<optgroup label="Wider catchment">`,
    ...wideAreas.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)} (${counts.get(a)})</option>`),
    `</optgroup>`
  ];
  select.innerHTML = opts.join('');
  select.value = appState.areaFilter;
}

function bindAreaSelect() {
  const select = document.getElementById('area-select');
  if (!select) return;
  select.addEventListener('change', (e) => {
    appState.areaFilter = e.target.value;
    applyFiltersAndRender();
    refitMapToVisible();
  });
}

function pubMatchesArea(pub) {
  const f = appState.areaFilter;
  if (f === 'all') return true;
  if (f === 'greater-exeter') return GREATER_EXETER_AREAS.has(pub.area);
  return pub.area === f;
}

function refitMapToVisible() {
  if (!appState.map) return;
  const visible = appState.pubs.filter(p =>
    pubMatchesArea(p) && pubMatchesFilters(p) && pubMatchesSearch(p)
  );
  if (visible.length === 0) return;
  const bounds = L.latLngBounds(visible.map(p => [p.lat, p.lon]));
  appState.map.fitBounds(bounds, { padding: [30, 30] });
}

// ----- View toggle -----

function bindViewToggle() {
  document.getElementById('view-map-btn').addEventListener('click', () => setActiveView('map'));
  document.getElementById('view-list-btn').addEventListener('click', () => setActiveView('list'));
}

function setActiveView(view) {
  if (view !== 'map' && view !== 'list') return;
  appState.activeView = view;

  const mapBtn = document.getElementById('view-map-btn');
  const listBtn = document.getElementById('view-list-btn');
  mapBtn.classList.toggle('active', view === 'map');
  listBtn.classList.toggle('active', view === 'list');
  mapBtn.setAttribute('aria-selected', view === 'map' ? 'true' : 'false');
  listBtn.setAttribute('aria-selected', view === 'list' ? 'true' : 'false');

  document.getElementById('view-map').classList.toggle('view-active', view === 'map');
  document.getElementById('view-list').classList.toggle('view-active', view === 'list');

  if (view === 'map' && appState.map) {
    setTimeout(() => appState.map.invalidateSize(), 50);
  }
}

// ----- Data loading -----

async function loadPubs() {
  try {
    const response = await fetch('pubs.json');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} — is pubs.json in the same folder?`);
    }
    const data = await response.json();
    if (!Array.isArray(data.pubs)) {
      throw new Error("pubs.json doesn't have a 'pubs' array.");
    }
    return data.pubs;
  } catch (e) {
    showError(e.message);
    return null;
  }
}

// ----- Map setup -----

function initMap() {
  appState.map = L.map('map', {
    zoomControl: true,
    scrollWheelZoom: false
  }).setView([EXETER_CENTRE.lat, EXETER_CENTRE.lon], 14);

  appState.map.on('click', () => appState.map.scrollWheelZoom.enable());
  appState.map.on('mouseout', () => appState.map.scrollWheelZoom.disable());

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(appState.map);
}

function addPubMarkers(pubs) {
  pubs.forEach(pub => {
    const marker = L.marker([pub.lat, pub.lon]).addTo(appState.map);
    marker.bindPopup(buildPopupHTML(pub));
    marker.on('popupopen', () => attachPopupCardLink(pub.id));
    appState.pubMarkers[pub.id] = marker;
    appState.markerOnMap[pub.id] = true;
  });
}

function buildPopupHTML(pub) {
  const review = reviewStore.get(pub.id);
  const reviewBit = review && review.rating
    ? `<p class="popup-meta">${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)} — your visit</p>`
    : '';

  const tagsHTML = (pub.tags && pub.tags.length)
    ? `<div class="popup-tags">${pub.tags.map(t => `<span class="popup-tag">${escapeHtml(t)}</span>`).join('')}</div>`
    : '';

  const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${pub.lat},${pub.lon}`;

  return `
    <div class="popup-content">
      <h3 class="popup-name">${escapeHtml(pub.name)}</h3>
      ${pub.address ? `<p class="popup-meta">${escapeHtml(pub.address)}</p>` : ''}
      ${reviewBit}
      ${tagsHTML}
      <a class="popup-link" href="#${pub.id}" data-scroll-to="${pub.id}">View details ↓</a>
      &nbsp;·&nbsp;
      <a class="popup-link" href="${directionsUrl}" target="_blank" rel="noopener">Directions →</a>
    </div>
  `;
}

function attachPopupCardLink(pubId) {
  setTimeout(() => {
    const link = document.querySelector(`.popup-link[data-scroll-to="${pubId}"]`);
    if (!link) return;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      jumpToPubInList(pubId);
    });
  }, 10);
}

function refreshPopupContent(pubId) {
  const marker = appState.pubMarkers[pubId];
  const pub = appState.pubs.find(p => p.id === pubId);
  if (!marker || !pub) return;
  marker.setPopupContent(buildPopupHTML(pub));
}

function fitMapToPubs() {
  const initiallyVisible = appState.pubs.filter(pubMatchesArea);
  const target = initiallyVisible.length > 0 ? initiallyVisible : appState.pubs;
  const bounds = L.latLngBounds(target.map(p => [p.lat, p.lon]));
  appState.map.fitBounds(bounds, { padding: [30, 30] });
}

function updateMapMarkerVisibility(visiblePubIds) {
  Object.entries(appState.pubMarkers).forEach(([id, marker]) => {
    const shouldBeVisible = visiblePubIds.has(id);
    const isVisible = appState.markerOnMap[id];
    if (shouldBeVisible && !isVisible) {
      marker.addTo(appState.map);
      appState.markerOnMap[id] = true;
    } else if (!shouldBeVisible && isVisible) {
      appState.map.removeLayer(marker);
      appState.markerOnMap[id] = false;
    }
  });
}

// ----- Search -----

function bindSearchInput() {
  const input = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear-btn');

  input.addEventListener('input', (e) => {
    appState.searchTerm = e.target.value.trim();
    clearBtn.hidden = appState.searchTerm.length === 0;
    applyFiltersAndRender();
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    appState.searchTerm = '';
    clearBtn.hidden = true;
    input.focus();
    applyFiltersAndRender();
  });
}

function pubMatchesSearch(pub) {
  if (!appState.searchTerm) return true;
  const term = appState.searchTerm.toLowerCase();
  const review = reviewStore.get(pub.id);
  const haystack = [
    pub.name,
    pub.address || '',
    pub.notes || '',
    review ? review.notes || '' : '',
    review ? review.with || '' : ''
  ].join(' ').toLowerCase();
  return haystack.includes(term);
}

// ----- Filters -----

function buildFilterChips(pubs) {
  const allTags = new Set();
  pubs.forEach(pub => (pub.tags || []).forEach(t => allTags.add(t)));

  document.getElementById('filters').hidden = false;

  const container = document.getElementById('filter-chips');
  container.innerHTML = '';

  // Visited chip first — tri-state special chip
  const visitedChip = document.createElement('button');
  visitedChip.type = 'button';
  visitedChip.className = 'chip chip-personal';
  visitedChip.id = 'chip-visited';
  visitedChip.textContent = 'Visited';
  visitedChip.addEventListener('click', toggleVisitedFilter);
  container.appendChild(visitedChip);

  if (allTags.size === 0) return;

  const sortedTags = [
    ...CANONICAL_TAG_ORDER.filter(t => allTags.has(t)),
    ...[...allTags].filter(t => !CANONICAL_TAG_ORDER.includes(t)).sort()
  ];

  sortedTags.forEach(tag => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = tag;
    chip.dataset.tag = tag;
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => toggleFilter(tag));
    container.appendChild(chip);
  });
}

function toggleFilter(tag) {
  if (appState.activeFilters.has(tag)) {
    appState.activeFilters.delete(tag);
  } else {
    appState.activeFilters.add(tag);
  }
  applyFiltersAndRender();
}

function toggleVisitedFilter() {
  // Cycle off → visited → unvisited → off
  const order = ['off', 'visited', 'unvisited'];
  const next = order[(order.indexOf(appState.visitedFilter) + 1) % order.length];
  appState.visitedFilter = next;
  applyFiltersAndRender();
}

function bindClearFiltersButton() {
  document.getElementById('clear-filters-btn').addEventListener('click', () => {
    appState.activeFilters.clear();
    appState.visitedFilter = 'off';
    appState.areaFilter = 'greater-exeter';
    appState.searchTerm = '';
    const input = document.getElementById('search-input');
    input.value = '';
    document.getElementById('search-clear-btn').hidden = true;
    const areaSelect = document.getElementById('area-select');
    if (areaSelect) areaSelect.value = 'greater-exeter';
    applyFiltersAndRender();
    refitMapToVisible();
  });
}

function pubMatchesFilters(pub) {
  // Tag filters (AND)
  if (appState.activeFilters.size > 0) {
    const pubTags = new Set(pub.tags || []);
    for (const tag of appState.activeFilters) {
      if (!pubTags.has(tag)) return false;
    }
  }
  // Visited filter
  if (appState.visitedFilter === 'visited' && !reviewStore.get(pub.id)) return false;
  if (appState.visitedFilter === 'unvisited' && reviewStore.get(pub.id)) return false;
  return true;
}

function applyFiltersAndRender() {
  const filtered = appState.pubs
    .filter(pubMatchesArea)
    .filter(pubMatchesSearch)
    .filter(pubMatchesFilters);

  const sorted = appState.userLocation
    ? sortByDistance(filtered, appState.userLocation)
    : sortByName(filtered);

  // Tag chip visual state
  document.querySelectorAll('.chip[data-tag]').forEach(chip => {
    const isActive = appState.activeFilters.has(chip.dataset.tag);
    chip.classList.toggle('active', isActive);
    chip.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });

  // Visited chip visual state
  const visitedChip = document.getElementById('chip-visited');
  if (visitedChip) {
    visitedChip.classList.remove('active', 'active-inverse');
    if (appState.visitedFilter === 'visited') {
      visitedChip.classList.add('active');
      visitedChip.textContent = 'Visited ✓';
    } else if (appState.visitedFilter === 'unvisited') {
      visitedChip.classList.add('active-inverse');
      visitedChip.textContent = 'Unvisited';
    } else {
      visitedChip.textContent = 'Visited';
    }
  }

  updateFilterMeta(filtered.length, appState.pubs.length);

  const visibleIds = new Set(filtered.map(p => p.id));
  updateMapMarkerVisibility(visibleIds);

  renderPubs(sorted);
}

function updateFilterMeta(matched, total) {
  const count = document.getElementById('filter-count');
  const clearBtn = document.getElementById('clear-filters-btn');
  const isFiltering = appState.activeFilters.size > 0
    || appState.searchTerm.length > 0
    || appState.visitedFilter !== 'off'
    || appState.areaFilter !== 'greater-exeter';

  // Always be honest about visible vs total when they differ
  if (matched === total) {
    count.textContent = `${total} pubs`;
    clearBtn.hidden = !isFiltering;
  } else {
    count.textContent = `${matched} of ${total} match`;
    clearBtn.hidden = !isFiltering;
  }
}

// ----- Geolocation -----

function bindFindMeButton() {
  document.getElementById('find-me-btn').addEventListener('click', requestUserLocation);
}

function requestUserLocation() {
  const btn = document.getElementById('find-me-btn');
  const btnText = document.getElementById('find-me-text');
  const status = document.getElementById('location-status');

  if (!('geolocation' in navigator)) {
    showLocationError("Your browser doesn't support location services.");
    return;
  }

  btn.disabled = true;
  btnText.textContent = 'Locating you…';
  status.hidden = true;

  navigator.geolocation.getCurrentPosition(
    (position) => onLocationSuccess(position),
    (error) => onLocationError(error),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

function onLocationSuccess(position) {
  const btn = document.getElementById('find-me-btn');
  const btnText = document.getElementById('find-me-text');
  const status = document.getElementById('location-status');

  appState.userLocation = {
    lat: position.coords.latitude,
    lon: position.coords.longitude
  };

  const accuracy = Math.round(position.coords.accuracy);

  btn.disabled = false;
  btnText.textContent = 'Update my location';
  status.hidden = false;
  status.classList.remove('error');
  status.textContent = `Located you (±${accuracy}m). Pubs sorted by distance.`;

  addOrUpdateUserMarker(appState.userLocation);
  appState.map.setView([appState.userLocation.lat, appState.userLocation.lon], 15);
  applyFiltersAndRender();
}

function addOrUpdateUserMarker(loc) {
  const userIcon = L.divIcon({
    className: '',
    html: '<div class="user-marker" aria-hidden="true"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });

  if (appState.userMarker) {
    appState.userMarker.setLatLng([loc.lat, loc.lon]);
  } else {
    appState.userMarker = L.marker([loc.lat, loc.lon], { icon: userIcon, zIndexOffset: 1000 })
      .addTo(appState.map)
      .bindPopup('You are here');
  }
}

function onLocationError(error) {
  let message;
  switch (error.code) {
    case error.PERMISSION_DENIED:
      message = "Location access denied. Click the lock icon in your browser's address bar to allow it.";
      break;
    case error.POSITION_UNAVAILABLE:
      message = "Couldn't determine your location. Try moving somewhere with better signal.";
      break;
    case error.TIMEOUT:
      message = "Location request timed out. Please try again.";
      break;
    default:
      message = "Something went wrong getting your location.";
  }
  showLocationError(message);
}

function showLocationError(message) {
  const btn = document.getElementById('find-me-btn');
  const btnText = document.getElementById('find-me-text');
  const status = document.getElementById('location-status');

  btn.disabled = false;
  btnText.textContent = 'Try again';
  status.hidden = false;
  status.classList.add('error');
  status.textContent = message;
}

// ----- Distance maths -----

function haversineDistance(lat1, lon1, lat2, lon2) {
  const EARTH_RADIUS_METRES = 6371000;
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METRES * c;
}

function formatDistance(metres) {
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

function formatWalkingTime(metres) {
  const seconds = metres / WALKING_METRES_PER_SECOND;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `~${minutes} min walk`;
}

// ----- Sorting -----

function sortByName(pubs) {
  return [...pubs].sort((a, b) => a.name.localeCompare(b.name));
}

function sortByDistance(pubs, userLocation) {
  return [...pubs]
    .map(pub => ({
      ...pub,
      distanceMetres: haversineDistance(userLocation.lat, userLocation.lon, pub.lat, pub.lon)
    }))
    .sort((a, b) => a.distanceMetres - b.distanceMetres);
}

// ----- Rendering -----

function renderPubs(pubs) {
  const status = document.getElementById('status');
  const list = document.getElementById('pub-list');

  if (pubs.length === 0) {
    list.innerHTML = '';
    status.className = 'status empty';
    status.textContent = buildEmptyMessage();
    status.hidden = false;
    return;
  }

  status.hidden = true;
  list.innerHTML = pubs.map(pubCardHTML).join('');

  // Card click → switch to map view + open marker popup
  list.querySelectorAll('.pub-card').forEach(card => {
    card.addEventListener('click', (e) => {
      // Don't hijack child interactions
      if (e.target.closest('.directions-link, .btn-notes')) return;
      const pubId = card.dataset.pubId;
      jumpToPubOnMap(pubId);
    });
  });

  // My-notes button click → open dialog
  list.querySelectorAll('.btn-notes').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pubId = btn.dataset.pubId;
      openReviewDialog(pubId);
    });
  });
}

function buildEmptyMessage() {
  const hasSearch = appState.searchTerm.length > 0;
  const hasTagFilters = appState.activeFilters.size > 0;
  const hasVisitFilter = appState.visitedFilter !== 'off';
  const filtersInPlay = [hasSearch, hasTagFilters, hasVisitFilter].filter(Boolean).length;

  if (filtersInPlay >= 2) return 'No pubs match your filters. Try removing one.';
  if (hasSearch) return `No pubs match "${appState.searchTerm}".`;
  if (hasTagFilters) return 'No pubs match these tag filters. Try removing some.';
  if (hasVisitFilter) {
    return appState.visitedFilter === 'visited'
      ? "You haven't reviewed any pubs yet — tap a card and add some notes."
      : "You've reviewed every pub in the dataset (impressive).";
  }
  return 'No pubs to show.';
}

function pubCardHTML(pub) {
  const term = appState.searchTerm;
  const review = reviewStore.get(pub.id);

  const nameHTML = highlightMatch(pub.name, term);

  const areaBadge = pub.area
    ? `<span class="area-badge">${escapeHtml(pub.area)}</span>`
    : '';

  const address = pub.address
    ? `<p class="address">${highlightMatch(pub.address, term)}</p>`
    : '';

  const tags = (pub.tags && pub.tags.length)
    ? `<div class="tags">${pub.tags.map(t => {
        const matched = appState.activeFilters.has(t) ? ' matched' : '';
        return `<span class="tag${matched}">${escapeHtml(t)}</span>`;
      }).join('')}</div>`
    : '';

  const notes = pub.notes
    ? `<p class="notes">${highlightMatch(pub.notes, term)}</p>`
    : '';

  const reviewPreview = review ? buildReviewPreviewHTML(review, term) : '';

  const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${pub.lat},${pub.lon}`;

  const distanceText = (pub.distanceMetres != null)
    ? `<span class="distance has-value">${formatDistance(pub.distanceMetres)} · ${formatWalkingTime(pub.distanceMetres)}</span>`
    : `<span class="distance">Tap "Find pubs near me" for distance</span>`;

  const notesBtnLabel = review
    ? `${stars(review.rating)} My notes`
    : '+ Add my notes';
  const notesBtnClass = review ? 'btn-notes has-review' : 'btn-notes';

  return `
    <li class="pub-card${review ? ' reviewed' : ''}" id="${pub.id}" data-pub-id="${pub.id}">
      <h2 class="pub-name">${nameHTML}</h2>
      ${areaBadge}
      ${address}
      <div class="pub-meta">
        ${distanceText}
      </div>
      ${tags}
      ${notes}
      ${reviewPreview}
      <div class="card-actions">
        <button class="${notesBtnClass}" data-pub-id="${pub.id}" type="button">${notesBtnLabel}</button>
        <a class="directions-link" href="${directionsUrl}" target="_blank" rel="noopener">Get directions →</a>
      </div>
    </li>
  `;
}

function buildReviewPreviewHTML(review, term) {
  const dateText = review.visited_on ? formatPrettyDate(review.visited_on) : '';
  const snippet = review.notes ? `<p class="review-snippet">${highlightMatch(review.notes, term)}</p>` : '';
  return `
    <div class="review-preview">
      <div class="review-preview-header">
        <span class="review-stars-display" aria-label="${review.rating || 0} out of 5 stars">${stars(review.rating)}</span>
        ${dateText ? `<span class="review-date">${escapeHtml(dateText)}</span>` : ''}
      </div>
      ${snippet}
    </div>
  `;
}

function stars(n) {
  const rating = Math.max(0, Math.min(5, Number(n) || 0));
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

function formatPrettyDate(iso) {
  // iso is "YYYY-MM-DD"
  try {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (e) {
    return iso;
  }
}

// ----- Review dialog -----

let pendingRating = 0;

function bindReviewDialog() {
  const dlg = document.getElementById('review-dialog');

  document.getElementById('review-save-btn').addEventListener('click', saveReview);
  document.getElementById('review-cancel-btn').addEventListener('click', () => dlg.close());
  document.getElementById('review-delete-btn').addEventListener('click', deleteReview);

  // Star input
  const starsContainer = document.getElementById('review-stars');
  starsContainer.addEventListener('click', (e) => {
    const star = e.target.closest('.star');
    if (!star) return;
    pendingRating = Number(star.dataset.value);
    renderStarsInput();
  });
  document.getElementById('review-stars-clear').addEventListener('click', () => {
    pendingRating = 0;
    renderStarsInput();
  });

  // Click outside (on backdrop) closes the dialog
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
}

function renderStarsInput() {
  document.querySelectorAll('#review-stars .star').forEach(star => {
    const v = Number(star.dataset.value);
    star.classList.toggle('filled', v <= pendingRating);
    star.textContent = v <= pendingRating ? '★' : '☆';
  });
}

function openReviewDialog(pubId) {
  const pub = appState.pubs.find(p => p.id === pubId);
  if (!pub) return;
  appState.editingPubId = pubId;

  const existing = reviewStore.get(pubId);

  document.getElementById('review-dialog-subtitle').textContent = pub.name;

  document.getElementById('review-date').value = existing && existing.visited_on
    ? existing.visited_on
    : todayISO();

  pendingRating = existing && existing.rating ? existing.rating : 0;
  renderStarsInput();

  document.getElementById('review-with').value = existing ? existing.with || '' : '';
  document.getElementById('review-notes').value = existing ? existing.notes || '' : '';

  document.getElementById('review-delete-btn').hidden = !existing;

  document.getElementById('review-dialog').showModal();
}

function saveReview() {
  const pubId = appState.editingPubId;
  if (!pubId) return;

  const review = {
    visited_on: document.getElementById('review-date').value,
    rating: pendingRating || null,
    with: document.getElementById('review-with').value.trim(),
    notes: document.getElementById('review-notes').value.trim(),
  };

  // Require at least one of: rating, notes
  if (!review.rating && !review.notes) {
    alert('Add a rating or a note before saving.');
    return;
  }

  const ok = reviewStore.set(pubId, review);
  if (!ok) {
    alert("Couldn't save — your browser blocked storage. Try again or check your settings.");
    return;
  }

  document.getElementById('review-dialog').close();
  refreshPopupContent(pubId);
  applyFiltersAndRender();
}

function deleteReview() {
  const pubId = appState.editingPubId;
  if (!pubId) return;
  if (!confirm('Delete your notes for this pub?')) return;
  reviewStore.delete(pubId);
  document.getElementById('review-dialog').close();
  refreshPopupContent(pubId);
  applyFiltersAndRender();
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ----- Settings dialog -----

function bindSettingsDialog() {
  const dlg = document.getElementById('settings-dialog');

  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('settings-close-btn').addEventListener('click', () => dlg.close());
  document.getElementById('settings-export-btn').addEventListener('click', exportReviews);
  document.getElementById('settings-import-input').addEventListener('change', importReviews);
  document.getElementById('settings-wipe-btn').addEventListener('click', wipeReviews);

  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
}

function openSettings() {
  setSettingsNote('', null);
  document.getElementById('settings-stat').textContent =
    `${reviewStore.count()} review${reviewStore.count() === 1 ? '' : 's'} saved on this device.`;
  document.getElementById('settings-dialog').showModal();
}

function setSettingsNote(message, type) {
  const note = document.getElementById('settings-note');
  if (!message) {
    note.hidden = true;
    return;
  }
  note.textContent = message;
  note.className = 'settings-note ' + (type || '');
  note.hidden = false;
}

function exportReviews() {
  const data = reviewStore.exportAll();
  if (Object.keys(data.reviews).length === 0) {
    setSettingsNote("No reviews to export yet.", 'error');
    return;
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = todayISO();
  a.href = url;
  a.download = `exeter-pubs-reviews-${stamp}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  setSettingsNote(`Exported ${Object.keys(data.reviews).length} reviews.`, 'success');
}

async function importReviews(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const before = reviewStore.count();
    reviewStore.importAll(data);
    const after = reviewStore.count();
    setSettingsNote(`Imported. You now have ${after} reviews (added ${after - before}).`, 'success');
    document.getElementById('settings-stat').textContent =
      `${after} review${after === 1 ? '' : 's'} saved on this device.`;
    applyFiltersAndRender();
  } catch (err) {
    setSettingsNote(`Import failed: ${err.message}`, 'error');
  } finally {
    e.target.value = '';  // allow re-importing same file
  }
}

function wipeReviews() {
  if (reviewStore.count() === 0) {
    setSettingsNote("Nothing to wipe.", 'error');
    return;
  }
  if (!confirm(`Delete all ${reviewStore.count()} reviews on this device? This cannot be undone.`)) return;
  reviewStore.wipeAll();
  setSettingsNote("All reviews wiped.", 'success');
  document.getElementById('settings-stat').textContent = '0 reviews saved on this device.';
  applyFiltersAndRender();
}

// ----- Cross-view navigation -----

function jumpToPubOnMap(pubId) {
  const marker = appState.pubMarkers[pubId];
  if (!marker) return;
  setActiveView('map');
  setTimeout(() => {
    appState.map.setView(marker.getLatLng(), 17, { animate: true });
    marker.openPopup();
  }, 120);
}

function jumpToPubInList(pubId) {
  setActiveView('list');
  setTimeout(() => {
    const card = document.getElementById(pubId);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card.classList.add('highlighted');
    setTimeout(() => card.classList.remove('highlighted'), 1800);
  }, 80);
}

// ----- Pub crawl picker -----

const CRAWLS_KEY = 'exeter-pubs:crawls:v1';

const crawlStore = {
  cache: null,
  load() {
    if (this.cache !== null) return this.cache;
    try {
      const raw = localStorage.getItem(CRAWLS_KEY);
      this.cache = raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.warn('Failed to read crawls from storage:', e);
      this.cache = {};
    }
    return this.cache;
  },
  save() {
    try {
      localStorage.setItem(CRAWLS_KEY, JSON.stringify(this.cache));
      return true;
    } catch (e) {
      console.error('Failed to save crawls:', e);
      return false;
    }
  },
  set(crawl) {
    this.load()[crawl.id] = crawl;
    return this.save();
  },
  delete(id) {
    delete this.load()[id];
    return this.save();
  },
  list() {
    return Object.values(this.load()).sort((a, b) =>
      (b.createdAt || '').localeCompare(a.createdAt || '')
    );
  }
};

function bindCrawlPlanner() {
  document.getElementById('plan-crawl-btn').addEventListener('click', openCrawlPlanner);

  const dlg = document.getElementById('crawl-planner-dialog');
  document.getElementById('crawl-planner-cancel').addEventListener('click', () => dlg.close());
  document.getElementById('crawl-planner-generate').addEventListener('click', onGenerateCrawl);
  document.getElementById('crawl-saved-btn').addEventListener('click', openSavedCrawls);

  // Stops chooser
  document.getElementById('crawl-stops-input').addEventListener('click', (e) => {
    const btn = e.target.closest('.stops-btn');
    if (!btn) return;
    appState.plannerStops = Number(btn.dataset.stops);
    document.querySelectorAll('#crawl-stops-input .stops-btn').forEach(b =>
      b.classList.toggle('active', b === btn));
  });

  // Radius slider + no-limit toggle
  const slider = document.getElementById('crawl-radius-slider');
  const nolimit = document.getElementById('crawl-radius-nolimit');
  slider.addEventListener('input', () => {
    appState.plannerRadius = Number(slider.value);
    updateRadiusDisplay();
    updatePlannerRadiusCircle();
  });
  nolimit.addEventListener('change', () => {
    if (nolimit.checked) {
      appState.plannerRadius = 0;
      slider.disabled = true;
    } else {
      slider.disabled = false;
      appState.plannerRadius = Number(slider.value);
    }
    updateRadiusDisplay();
    updatePlannerRadiusCircle();
  });

  // Anchor radio toggles select enable/disable + recenter the mini-map
  dlg.querySelectorAll('input[name="crawl-start"]').forEach(r => {
    r.addEventListener('change', () => {
      const useAnchor = dlg.querySelector('input[name="crawl-start"]:checked').value === 'anchor';
      document.getElementById('crawl-anchor-select').disabled = !useAnchor;
      recenterPlannerMap();
    });
  });
  document.getElementById('crawl-anchor-select').addEventListener('change', recenterPlannerMap);

  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

  // Saved crawls dialog
  const sdlg = document.getElementById('saved-crawls-dialog');
  document.getElementById('saved-crawls-close').addEventListener('click', () => sdlg.close());
  sdlg.addEventListener('click', (e) => { if (e.target === sdlg) sdlg.close(); });
}

function openCrawlPlanner() {
  const dlg = document.getElementById('crawl-planner-dialog');

  // Refresh anchor select with currently-filtered visible pubs
  const visible = appState.pubs
    .filter(pubMatchesArea)
    .filter(pubMatchesFilters)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const select = document.getElementById('crawl-anchor-select');
  select.innerHTML = visible.map(p =>
    `<option value="${p.id}">${escapeHtml(p.name)} — ${escapeHtml(p.area || '')}</option>`
  ).join('');

  // Disable location option if no fix yet
  const hasLoc = !!appState.userLocation;
  const locRadio = document.getElementById('crawl-start-location');
  const locHint = document.getElementById('crawl-start-location-hint');
  locRadio.disabled = !hasLoc;
  locHint.hidden = hasLoc;
  if (!hasLoc) {
    document.querySelector('input[name="crawl-start"][value="anchor"]').checked = true;
    select.disabled = false;
  } else {
    locRadio.checked = true;
    select.disabled = true;
  }

  // Sync slider with current state
  const slider = document.getElementById('crawl-radius-slider');
  const nolimit = document.getElementById('crawl-radius-nolimit');
  if (appState.plannerRadius === 0) {
    nolimit.checked = true;
    slider.disabled = true;
  } else {
    nolimit.checked = false;
    slider.disabled = false;
    slider.value = appState.plannerRadius;
  }
  updateRadiusDisplay();

  setCrawlPlannerNote('', null);
  dlg.showModal();

  // Initialise the mini-map after the dialog is visible (Leaflet needs a sized container)
  setTimeout(() => {
    ensurePlannerMap();
    recenterPlannerMap();
    updatePlannerRadiusCircle();
  }, 50);
}

function updateRadiusDisplay() {
  const valueEl = document.getElementById('crawl-radius-value');
  const hintEl = document.getElementById('crawl-radius-hint');
  if (appState.plannerRadius === 0) {
    valueEl.textContent = 'No limit';
    hintEl.textContent = 'Any venue qualifies — the crawl might span the full catchment.';
  } else {
    const m = appState.plannerRadius;
    const km = (m / 1000).toFixed(m >= 1000 ? 1 : 2);
    const walkMin = Math.max(1, Math.round(m / WALKING_METRES_PER_SECOND / 60));
    valueEl.textContent = m >= 1000 ? `${km} km` : `${m} m`;
    hintEl.textContent = `Straight-line radius — about a ${walkMin} min walk as the crow flies. Real walking is usually a bit further.`;
  }
}

function ensurePlannerMap() {
  if (appState.plannerMap) {
    appState.plannerMap.invalidateSize();
    return;
  }
  const container = document.getElementById('crawl-radius-map');
  if (!container) return;
  appState.plannerMap = L.map(container, {
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    touchZoom: false,
    tap: false
  }).setView([EXETER_CENTRE.lat, EXETER_CENTRE.lon], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18
  }).addTo(appState.plannerMap);
}

function getPlannerCentre() {
  const dlg = document.getElementById('crawl-planner-dialog');
  const useLocation = dlg.querySelector('input[name="crawl-start"]:checked').value === 'location';
  if (useLocation && appState.userLocation) {
    return { lat: appState.userLocation.lat, lon: appState.userLocation.lon };
  }
  const anchorId = document.getElementById('crawl-anchor-select').value;
  const pub = appState.pubs.find(p => p.id === anchorId);
  if (pub) return { lat: pub.lat, lon: pub.lon };
  return EXETER_CENTRE;
}

function recenterPlannerMap() {
  if (!appState.plannerMap) return;
  const c = getPlannerCentre();
  appState.plannerMap.setView([c.lat, c.lon], 13, { animate: false });
  updatePlannerRadiusCircle();
}

function updatePlannerRadiusCircle() {
  if (!appState.plannerMap) return;
  const c = getPlannerCentre();

  if (appState.plannerCircle) {
    appState.plannerMap.removeLayer(appState.plannerCircle);
    appState.plannerCircle = null;
  }
  if (appState.plannerCentreMarker) {
    appState.plannerMap.removeLayer(appState.plannerCentreMarker);
    appState.plannerCentreMarker = null;
  }

  // Always show the centre marker
  const centreIcon = L.divIcon({
    className: '',
    html: '<div class="planner-centre-marker"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });
  appState.plannerCentreMarker = L.marker([c.lat, c.lon], { icon: centreIcon })
    .addTo(appState.plannerMap);

  if (appState.plannerRadius > 0) {
    appState.plannerCircle = L.circle([c.lat, c.lon], {
      radius: appState.plannerRadius,
      color: '#6b2832',
      weight: 2,
      fillColor: '#b88a3a',
      fillOpacity: 0.18
    }).addTo(appState.plannerMap);
    // Frame the map to the circle (with padding)
    appState.plannerMap.fitBounds(appState.plannerCircle.getBounds(), { padding: [10, 10], animate: false });
  } else {
    appState.plannerMap.setView([c.lat, c.lon], 11, { animate: false });
  }
}

function setCrawlPlannerNote(msg, type) {
  const note = document.getElementById('crawl-planner-note');
  if (!msg) { note.hidden = true; return; }
  note.textContent = msg;
  note.className = 'settings-note ' + (type || '');
  note.hidden = false;
}

function onGenerateCrawl() {
  const dlg = document.getElementById('crawl-planner-dialog');
  const useLocation = dlg.querySelector('input[name="crawl-start"]:checked').value === 'location';
  const venueTypes = [...document.querySelectorAll('#crawl-venue-types input:checked')]
    .map(i => i.value);

  if (venueTypes.length === 0) {
    setCrawlPlannerNote('Pick at least one venue type.', 'error');
    return;
  }

  let anchor;
  if (useLocation && appState.userLocation) {
    anchor = { lat: appState.userLocation.lat, lon: appState.userLocation.lon };
  } else {
    const anchorId = document.getElementById('crawl-anchor-select').value;
    const anchorPub = appState.pubs.find(p => p.id === anchorId);
    if (!anchorPub) { setCrawlPlannerNote('Pick a starting pub.', 'error'); return; }
    anchor = { lat: anchorPub.lat, lon: anchorPub.lon, id: anchorPub.id };
  }

  const crawl = generateCrawl({
    stops: appState.plannerStops,
    radiusM: appState.plannerRadius,
    venueTypes,
    anchor
  });

  if (!crawl) {
    setCrawlPlannerNote('Not enough venues match in that radius. Try widening it.', 'error');
    return;
  }

  setActiveCrawl(crawl);
  dlg.close();
}

function generateCrawl({ stops, radiusM, venueTypes, anchor }) {
  const types = new Set(venueTypes);
  // Pool: matching venue type, optionally within radius of anchor
  let pool = appState.pubs.filter(p => types.has(p.venue_type || 'pub'));
  if (radiusM > 0) {
    pool = pool.filter(p =>
      haversineDistance(anchor.lat, anchor.lon, p.lat, p.lon) <= radiusM
    );
  }

  if (pool.length < stops) return null;

  // If anchor is a pub, lock it as the first stop. Shuffle only the rest.
  let firstStop = null;
  if (anchor.id) {
    firstStop = pool.find(p => p.id === anchor.id);
    if (firstStop) {
      pool = pool.filter(p => p.id !== firstStop.id);
    }
  }

  const remaining = stops - (firstStop ? 1 : 0);
  const sampled = sampleRandom(pool, remaining);
  const shuffledRest = shuffle(sampled);
  const ordered = firstStop ? [firstStop, ...shuffledRest] : shuffledRest;

  return {
    id: 'crawl-' + Math.random().toString(36).slice(2, 9),
    name: '',
    stops: ordered.map(p => p.id),
    createdAt: new Date().toISOString()
  };
}

function sampleRandom(arr, n) {
  const copy = arr.slice();
  const out = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function setActiveCrawl(crawl) {
  appState.activeCrawl = crawl;
  renderActiveCrawl();
  drawCrawlOnMap(crawl);
  setActiveView('map');
}

function clearActiveCrawl() {
  appState.activeCrawl = null;
  document.getElementById('crawl-panel').hidden = true;
  clearCrawlFromMap();
  // Strip the hash without reloading
  if (location.hash.startsWith('#crawl=')) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

function renderActiveCrawl() {
  const crawl = appState.activeCrawl;
  if (!crawl) return;
  const panel = document.getElementById('crawl-panel');
  const stopsByPub = crawl.stops.map(id => appState.pubs.find(p => p.id === id)).filter(Boolean);

  const nameInput = document.getElementById('crawl-name-input');
  // Only sync from state if the input isn't focused, so we don't clobber the user mid-type
  if (document.activeElement !== nameInput) {
    nameInput.value = crawl.name || '';
  }

  // Compute total walking distance
  let totalM = 0;
  for (let i = 1; i < stopsByPub.length; i++) {
    totalM += haversineDistance(
      stopsByPub[i - 1].lat, stopsByPub[i - 1].lon,
      stopsByPub[i].lat,     stopsByPub[i].lon
    );
  }
  const meta = `${stopsByPub.length} stops · ${formatDistance(totalM)} total walk · ${formatWalkingTime(totalM)}`;
  document.getElementById('crawl-panel-meta').textContent = meta;

  const list = document.getElementById('crawl-stops');
  list.innerHTML = stopsByPub.map((p, i) => {
    let legHTML = '';
    if (i > 0) {
      const prev = stopsByPub[i - 1];
      const d = haversineDistance(prev.lat, prev.lon, p.lat, p.lon);
      legHTML = `<span class="crawl-leg">↳ ${formatDistance(d)} · ${formatWalkingTime(d)}</span>`;
    }
    return `
      <li class="crawl-stop" data-pub-id="${p.id}" data-index="${i}" title="Drag to reorder, tap to view on map">
        <span class="crawl-drag-handle" aria-hidden="true">⋮⋮</span>
        <span class="crawl-num">${i + 1}</span>
        <div class="crawl-stop-body">
          <span class="crawl-stop-name">${escapeHtml(p.name)}</span>
          <span class="crawl-stop-meta">${escapeHtml(p.area || '')}${p.address ? ' · ' + escapeHtml(p.address) : ''}</span>
          ${legHTML}
        </div>
        <button class="crawl-stop-remove" type="button" aria-label="Remove this stop" title="Remove">×</button>
      </li>
    `;
  }).join('');

  // Stop interactions: remove button + tap/drag combo on the whole card
  list.querySelectorAll('.crawl-stop').forEach(li => {
    const pubId = li.dataset.pubId;
    li.querySelector('.crawl-stop-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeStopFromCrawl(pubId);
    });
  });

  bindCrawlStopInteractions(list);

  panel.hidden = false;
}

// ----- Crawl editing -----

function removeStopFromCrawl(pubId) {
  const crawl = appState.activeCrawl;
  if (!crawl) return;
  if (crawl.stops.length <= 2) {
    alert('A crawl needs at least 2 stops. Add another pub before removing this one, or clear the whole crawl.');
    return;
  }
  crawl.stops = crawl.stops.filter(id => id !== pubId);
  persistCrawlIfSaved(crawl);
  renderActiveCrawl();
  drawCrawlOnMap(crawl);
}

function addStopToCrawl(pubId) {
  const crawl = appState.activeCrawl;
  if (!crawl) return;
  if (crawl.stops.includes(pubId)) return;
  crawl.stops.push(pubId);
  persistCrawlIfSaved(crawl);
  renderActiveCrawl();
  drawCrawlOnMap(crawl);
}

function persistCrawlIfSaved(crawl) {
  // Only update storage if the crawl is already saved
  const saved = crawlStore.load();
  if (saved[crawl.id]) {
    crawlStore.set(crawl);
  }
}

// ----- Add-a-stop dialog -----

function openAddStopDialog() {
  const crawl = appState.activeCrawl;
  if (!crawl) return;
  const dlg = document.getElementById('add-stop-dialog');
  const input = document.getElementById('add-stop-search');
  input.value = '';
  renderAddStopList('');
  dlg.showModal();
  setTimeout(() => input.focus(), 50);
}

function renderAddStopList(term) {
  const crawl = appState.activeCrawl;
  if (!crawl) return;
  const list = document.getElementById('add-stop-list');
  const empty = document.getElementById('add-stop-empty');
  const inCrawl = new Set(crawl.stops);
  const t = term.trim().toLowerCase();

  const lastStop = appState.pubs.find(p => p.id === crawl.stops[crawl.stops.length - 1]);

  let candidates = appState.pubs.filter(p => !inCrawl.has(p.id));
  if (t) {
    candidates = candidates.filter(p =>
      p.name.toLowerCase().includes(t) ||
      (p.area || '').toLowerCase().includes(t) ||
      (p.address || '').toLowerCase().includes(t)
    );
  }

  // Sort by distance from last stop (or name if no anchor)
  if (lastStop) {
    candidates.forEach(p => {
      p._addStopDist = haversineDistance(lastStop.lat, lastStop.lon, p.lat, p.lon);
    });
    candidates.sort((a, b) => a._addStopDist - b._addStopDist);
  } else {
    candidates.sort((a, b) => a.name.localeCompare(b.name));
  }

  candidates = candidates.slice(0, 80);

  if (candidates.length === 0) {
    list.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  list.innerHTML = candidates.map(p => {
    const dist = (p._addStopDist != null)
      ? `<span class="add-stop-dist">${formatDistance(p._addStopDist)} from last stop</span>`
      : '';
    return `
      <li class="add-stop-item" data-pub-id="${p.id}">
        <div class="add-stop-body">
          <span class="add-stop-name">${escapeHtml(p.name)}</span>
          <span class="add-stop-meta">${escapeHtml(p.area || '')}${p.address ? ' · ' + escapeHtml(p.address) : ''}</span>
          ${dist}
        </div>
        <span class="add-stop-add">+</span>
      </li>
    `;
  }).join('');

  list.querySelectorAll('.add-stop-item').forEach(li => {
    li.addEventListener('click', () => {
      addStopToCrawl(li.dataset.pubId);
      document.getElementById('add-stop-dialog').close();
    });
  });
}

function bindAddStopDialog() {
  const dlg = document.getElementById('add-stop-dialog');
  document.getElementById('add-stop-cancel').addEventListener('click', () => dlg.close());
  document.getElementById('add-stop-search').addEventListener('input', (e) => {
    renderAddStopList(e.target.value);
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}

// ----- Stop tap/drag (pointer events, works on touch + mouse) -----
// Approach: when the user starts dragging a stop, we lift a "ghost" clone
// that follows the cursor. The original card stays in DOM as a faded slot
// so it's clear where it currently sits in the order. As the cursor crosses
// other cards' midpoints, we re-insert the original in DOM and FLIP-animate
// the displaced siblings into their new positions.

const DRAG_THRESHOLD_PX = 5;
const ANIM_MS = 180;

// Drag state lives at module scope so it can be tracked & cleaned up
// across re-renders of the crawl list. The per-render bindCrawlStopInteractions
// only wires the pointerdown listeners on the new stop elements.
const dragSystem = {
  t: null,
  listEl: null,
  initialized: false
};

function initDragSystemOnce() {
  if (dragSystem.initialized) return;
  dragSystem.initialized = true;

  // Window-level safety nets — catch pointer releases that don't reach
  // the captured element (cursor outside viewport, browser drop, alt-tab).
  window.addEventListener('pointerup', (e) => dragOnWindowEnd(e));
  window.addEventListener('pointercancel', (e) => dragOnWindowEnd(e));
  window.addEventListener('blur', () => dragAbort());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) dragAbort();
  });
}

function bindCrawlStopInteractions(listEl) {
  initDragSystemOnce();
  dragSystem.listEl = listEl;

  // Defensive sweep: kill any orphaned ghosts/dragging states from a
  // previous render or interrupted drag.
  killAllGhosts();

  listEl.querySelectorAll('.crawl-stop').forEach(stop => {
    stop.addEventListener('pointerdown', dragOnPointerDown);
  });
}

function dragOnPointerDown(e) {
  const stop = e.currentTarget;
  if (e.target.closest('.crawl-stop-remove')) return;
  if (e.button !== undefined && e.button !== 0) return;

  // Always purge any prior state before starting a new drag
  dragAbort();

  const rect = stop.getBoundingClientRect();
  dragSystem.t = {
    stop,
    pubId: stop.dataset.pubId,
    startX: e.clientX,
    startY: e.clientY,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
    startWidth: rect.width,
    startLeft: rect.left,
    startTop: rect.top,
    pointerId: e.pointerId,
    dragging: false,
    ghost: null
  };
  try { stop.setPointerCapture(e.pointerId); } catch (_) {}
  stop.addEventListener('pointermove', dragOnMove);
  stop.addEventListener('pointerup', dragOnUp);
  stop.addEventListener('pointercancel', dragOnUp);
}

function dragOnMove(e) {
  const t = dragSystem.t;
  const listEl = dragSystem.listEl;
  if (!t || !listEl) return;
  const dx = e.clientX - t.startX;
  const dy = e.clientY - t.startY;

  if (!t.dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
    dragEnter();
    e.preventDefault();
  }
  if (!t.dragging) return;
  e.preventDefault();

  // Keep ghost glued to the cursor
  t.ghost.style.left = (e.clientX - t.offsetX) + 'px';
  t.ghost.style.top = (e.clientY - t.offsetY) + 'px';

  // SWAP COOLDOWN: while sibling FLIP animations are still running, their
  // getBoundingClientRect() returns the in-flight visual position (with
  // transform), not the final layout position. A still cursor over a card
  // sliding underneath it would otherwise re-trigger swaps every frame —
  // which felt like "the card is sticking on invisible elements".
  if (t.lastSwapAt && performance.now() - t.lastSwapAt < ANIM_MS) return;

  const target = findInsertPosition(listEl, t.stop, e.clientY);
  if (!target) return;

  const { targetStop, insertBefore } = target;
  const desiredAnchor = insertBefore ? targetStop : targetStop.nextElementSibling;
  if (t.stop === desiredAnchor) return;
  if (t.stop.nextElementSibling === desiredAnchor) return;

  const before = snapshotRects(listEl);
  targetStop.parentNode.insertBefore(t.stop, desiredAnchor || null);
  flipAnimate(listEl, before, t.stop);
  refreshCrawlLegs(listEl);
  t.lastSwapAt = performance.now();
}

function dragOnUp() {
  const t = dragSystem.t;
  const listEl = dragSystem.listEl;
  if (!t) return;
  const wasDragging = t.dragging;
  const pubId = t.pubId;

  if (wasDragging && listEl) {
    const newOrder = [...listEl.querySelectorAll('.crawl-stop')].map(el => el.dataset.pubId);
    const crawl = appState.activeCrawl;
    if (crawl && JSON.stringify(newOrder) !== JSON.stringify(crawl.stops)) {
      crawl.stops = newOrder;
      persistCrawlIfSaved(crawl);
      refreshCrawlLegs(listEl);
      drawCrawlOnMap(crawl);
    }
  }

  dragCleanup();

  if (!wasDragging) {
    jumpToPubOnMap(pubId);
  }
}

function dragOnWindowEnd(e) {
  const t = dragSystem.t;
  if (!t) return;
  if (e.pointerId !== undefined && t.pointerId !== undefined && e.pointerId !== t.pointerId) return;
  dragOnUp();
}

function dragAbort() {
  killAllGhosts();
  const t = dragSystem.t;
  if (t) {
    try { t.stop.releasePointerCapture(t.pointerId); } catch (_) {}
    t.stop.removeEventListener('pointermove', dragOnMove);
    t.stop.removeEventListener('pointerup', dragOnUp);
    t.stop.removeEventListener('pointercancel', dragOnUp);
    dragSystem.t = null;
  }
}

function dragEnter() {
  const t = dragSystem.t;
  if (!t) return;
  t.dragging = true;
  const stop = t.stop;
  stop.classList.add('dragging');

  const ghost = stop.cloneNode(true);
  ghost.classList.add('crawl-stop-ghost');
  ghost.classList.remove('dragging');
  ghost.style.position = 'fixed';
  ghost.style.left = t.startLeft + 'px';
  ghost.style.top = t.startTop + 'px';
  ghost.style.width = t.startWidth + 'px';
  ghost.style.margin = '0';
  ghost.style.pointerEvents = 'none';
  ghost.style.zIndex = '9999';
  ghost.querySelectorAll('button').forEach(b => b.remove());
  document.body.appendChild(ghost);
  t.ghost = ghost;
}

function dragCleanup() {
  // Single source of truth for ending a drag. Always kills any ghosts
  // (defensive), strips dragging classes, removes listeners, releases
  // capture, and nulls the tracking object.
  killAllGhosts();
  const t = dragSystem.t;
  if (t) {
    const { stop, pointerId } = t;
    stop.removeEventListener('pointermove', dragOnMove);
    stop.removeEventListener('pointerup', dragOnUp);
    stop.removeEventListener('pointercancel', dragOnUp);
    try { stop.releasePointerCapture(pointerId); } catch (_) {}
    dragSystem.t = null;
  }
}

// Page-level helper — removes every ghost regardless of which drag
// created it. Called defensively from multiple cleanup paths.
function killAllGhosts() {
  document.querySelectorAll('.crawl-stop-ghost').forEach(g => g.remove());
  document.querySelectorAll('.crawl-stop.dragging').forEach(s => s.classList.remove('dragging'));
}

// Walk siblings top-to-bottom, find the first whose midpoint is below the cursor.
// Insert *before* that one. If cursor is below them all, insert after the last.
// Works regardless of inter-card gaps.
function findInsertPosition(listEl, draggingStop, clientY) {
  const stops = [...listEl.querySelectorAll('.crawl-stop')].filter(s => s !== draggingStop);
  if (stops.length === 0) return null;
  for (const stop of stops) {
    const rect = stop.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      return { targetStop: stop, insertBefore: true };
    }
  }
  return { targetStop: stops[stops.length - 1], insertBefore: false };
}

function snapshotRects(listEl) {
  const m = new Map();
  listEl.querySelectorAll('.crawl-stop').forEach(el => {
    m.set(el.dataset.pubId, el.getBoundingClientRect());
  });
  return m;
}

// FLIP technique: items have already been re-inserted in DOM. We compute
// the deltas from their "before" positions and animate them back to zero.
function flipAnimate(listEl, beforeRects, skipEl) {
  listEl.querySelectorAll('.crawl-stop').forEach(el => {
    if (el === skipEl) return;  // dragging card is positioned by the ghost
    const before = beforeRects.get(el.dataset.pubId);
    if (!before) return;
    const after = el.getBoundingClientRect();
    const dx = before.left - after.left;
    const dy = before.top - after.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    // Force reflow then transition to zero
    void el.offsetHeight;
    el.style.transition = `transform ${ANIM_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
    el.style.transform = '';
  });
}

// After a drag-and-drop, the per-card leg distances (↳ 350m) are stale
// because the order changed. Recompute and patch them in place without
// a full re-render (which would tear down our DOM).
function refreshCrawlLegs(listEl) {
  const stops = [...listEl.querySelectorAll('.crawl-stop')];
  let prev = null;
  stops.forEach((el, i) => {
    el.querySelector('.crawl-num').textContent = i + 1;
    const pub = appState.pubs.find(p => p.id === el.dataset.pubId);
    let legEl = el.querySelector('.crawl-leg');
    if (i === 0) {
      if (legEl) legEl.remove();
    } else if (pub && prev) {
      const d = haversineDistance(prev.lat, prev.lon, pub.lat, pub.lon);
      const text = `↳ ${formatDistance(d)} · ${formatWalkingTime(d)}`;
      if (legEl) {
        legEl.textContent = text;
      } else {
        legEl = document.createElement('span');
        legEl.className = 'crawl-leg';
        legEl.textContent = text;
        el.querySelector('.crawl-stop-body').appendChild(legEl);
      }
    }
    if (pub) prev = pub;
  });
  // Update header meta
  let totalM = 0;
  const allPubs = stops.map(el => appState.pubs.find(p => p.id === el.dataset.pubId)).filter(Boolean);
  for (let i = 1; i < allPubs.length; i++) {
    totalM += haversineDistance(allPubs[i-1].lat, allPubs[i-1].lon, allPubs[i].lat, allPubs[i].lon);
  }
  const meta = `${allPubs.length} stops · ${formatDistance(totalM)} total walk · ${formatWalkingTime(totalM)}`;
  document.getElementById('crawl-panel-meta').textContent = meta;
}

function bindCrawlPanel() {
  document.getElementById('crawl-clear-btn').addEventListener('click', clearActiveCrawl);
  document.getElementById('crawl-add-stop-btn').addEventListener('click', openAddStopDialog);
  const nameInput = document.getElementById('crawl-name-input');
  nameInput.addEventListener('input', () => {
    if (!appState.activeCrawl) return;
    appState.activeCrawl.name = nameInput.value.trim();
    persistCrawlIfSaved(appState.activeCrawl);
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
  });
  document.getElementById('crawl-shuffle-btn').addEventListener('click', () => {
    if (!appState.activeCrawl) return;
    appState.activeCrawl.stops = shuffle(appState.activeCrawl.stops);
    persistCrawlIfSaved(appState.activeCrawl);
    renderActiveCrawl();
    drawCrawlOnMap(appState.activeCrawl);
  });
  document.getElementById('crawl-save-btn').addEventListener('click', saveCurrentCrawl);
  document.getElementById('crawl-share-btn').addEventListener('click', shareCurrentCrawl);
}

function saveCurrentCrawl() {
  const crawl = appState.activeCrawl;
  if (!crawl) return;
  // Use the name from the input (already in state); fall back to a dated default
  if (!crawl.name) {
    crawl.name = `Crawl from ${new Date(crawl.createdAt).toLocaleDateString('en-GB')}`;
  }
  crawlStore.set(crawl);
  renderActiveCrawl();
  flashSaveConfirmation(crawl.name);
}

function flashSaveConfirmation(name) {
  // Non-blocking confirmation that fades out
  const btn = document.getElementById('crawl-save-btn');
  const orig = btn.textContent;
  btn.textContent = `✓ Saved "${name.length > 24 ? name.slice(0, 24) + '…' : name}"`;
  btn.classList.add('btn-confirmed');
  setTimeout(() => {
    btn.textContent = orig;
    btn.classList.remove('btn-confirmed');
  }, 2200);
}

function shareCurrentCrawl() {
  const crawl = appState.activeCrawl;
  if (!crawl) return;
  const url = buildCrawlShareUrl(crawl);
  // Update the address bar
  history.replaceState(null, '', '#' + url.split('#')[1]);
  if (navigator.share) {
    navigator.share({
      title: crawl.name || 'A pub crawl',
      text: 'A pub crawl from the Exeter Pubs app',
      url
    }).catch(() => copyShareUrl(url));
  } else {
    copyShareUrl(url);
  }
}

function copyShareUrl(url) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(
      () => alert('Share link copied to clipboard.'),
      () => prompt('Copy this share link:', url)
    );
  } else {
    prompt('Copy this share link:', url);
  }
}

function buildCrawlShareUrl(crawl) {
  const ids = crawl.stops.join(',');
  return `${location.origin}${location.pathname}#crawl=${ids}`;
}

function parseCrawlHash() {
  const hash = location.hash;
  if (!hash.startsWith('#crawl=')) return null;
  const ids = hash.slice('#crawl='.length).split(',').filter(Boolean);
  const valid = ids.filter(id => appState.pubs.some(p => p.id === id));
  if (valid.length < 2) return null;
  return {
    id: 'shared-' + Math.random().toString(36).slice(2, 9),
    name: 'Shared crawl',
    stops: valid,
    createdAt: new Date().toISOString()
  };
}

function drawCrawlOnMap(crawl) {
  clearCrawlFromMap();
  const stops = crawl.stops.map(id => appState.pubs.find(p => p.id === id)).filter(Boolean);
  if (stops.length === 0) return;

  // Numbered markers
  stops.forEach((p, i) => {
    const icon = L.divIcon({
      className: '',
      html: `<div class="crawl-marker">${i + 1}</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });
    const marker = L.marker([p.lat, p.lon], { icon, zIndexOffset: 800 })
      .addTo(appState.map)
      .bindPopup(`<strong>${i + 1}. ${escapeHtml(p.name)}</strong><br>${escapeHtml(p.address || '')}`);
    appState.crawlMarkers.push(marker);
  });

  // Polyline connecting them in order
  const latlngs = stops.map(p => [p.lat, p.lon]);
  appState.crawlPolyline = L.polyline(latlngs, {
    color: '#6b2832',
    weight: 4,
    opacity: 0.7,
    dashArray: '8 8'
  }).addTo(appState.map);

  // Fit the map to the crawl
  appState.map.fitBounds(L.latLngBounds(latlngs), { padding: [60, 60] });
}

function clearCrawlFromMap() {
  appState.crawlMarkers.forEach(m => appState.map.removeLayer(m));
  appState.crawlMarkers = [];
  if (appState.crawlPolyline) {
    appState.map.removeLayer(appState.crawlPolyline);
    appState.crawlPolyline = null;
  }
}

function openSavedCrawls() {
  const dlg = document.getElementById('saved-crawls-dialog');
  const list = document.getElementById('saved-crawls-list');
  const empty = document.getElementById('saved-crawls-empty');
  const saved = crawlStore.list();

  if (saved.length === 0) {
    list.innerHTML = '';
    empty.hidden = false;
  } else {
    empty.hidden = true;
    list.innerHTML = saved.map(c => {
      const names = c.stops
        .map(id => appState.pubs.find(p => p.id === id))
        .filter(Boolean)
        .map(p => p.name)
        .join(' → ');
      const date = c.createdAt ? new Date(c.createdAt).toLocaleDateString('en-GB') : '';
      return `
        <li class="saved-crawl" data-crawl-id="${c.id}">
          <div class="saved-crawl-body">
            <h3 class="saved-crawl-name">${escapeHtml(c.name || 'Unnamed crawl')}</h3>
            <p class="saved-crawl-meta">${c.stops.length} stops · ${escapeHtml(date)}</p>
            <p class="saved-crawl-list">${escapeHtml(names)}</p>
          </div>
          <div class="saved-crawl-actions">
            <button class="btn btn-ghost btn-small" data-action="load">Load</button>
            <button class="btn btn-ghost btn-small btn-danger" data-action="delete">Delete</button>
          </div>
        </li>
      `;
    }).join('');

    list.querySelectorAll('.saved-crawl').forEach(li => {
      const id = li.dataset.crawlId;
      li.querySelector('[data-action="load"]').addEventListener('click', () => {
        const crawl = crawlStore.load()[id];
        if (crawl) {
          setActiveCrawl(crawl);
          dlg.close();
          document.getElementById('crawl-planner-dialog').close();
        }
      });
      li.querySelector('[data-action="delete"]').addEventListener('click', () => {
        if (!confirm('Delete this saved crawl?')) return;
        crawlStore.delete(id);
        openSavedCrawls();
      });
    });
  }

  dlg.showModal();
}

// ----- Welcome / Help -----

const WELCOMED_KEY = 'exeter-pubs:welcomed:v1';

function bindWelcomeDialog() {
  const dlg = document.getElementById('welcome-dialog');
  document.getElementById('help-btn').addEventListener('click', () => dlg.showModal());
  document.getElementById('welcome-close-btn').addEventListener('click', () => {
    markAsWelcomed();
    dlg.close();
  });
  dlg.addEventListener('close', markAsWelcomed);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

  // Feedback link — placeholder. Replace href with mailto:... when you have an address.
  document.getElementById('welcome-feedback-link').addEventListener('click', (e) => {
    e.preventDefault();
    alert("Feedback link not configured yet. Update the welcome dialog with your email or contact form when you're ready.");
  });
}

function maybeShowWelcomeOnFirstVisit() {
  // Don't auto-open if a shared crawl is in the URL — let the user see that first
  if (location.hash.startsWith('#crawl=')) return;
  try {
    if (localStorage.getItem(WELCOMED_KEY)) return;
  } catch (_) { return; }
  document.getElementById('welcome-dialog').showModal();
}

function markAsWelcomed() {
  try { localStorage.setItem(WELCOMED_KEY, new Date().toISOString()); } catch (_) {}
}

// ----- Helpers -----

function showError(message) {
  const status = document.getElementById('status');
  status.className = 'status error';
  status.textContent = `Couldn't load pubs: ${message}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function highlightMatch(text, term) {
  const safeText = escapeHtml(text);
  if (!term) return safeText;

  const lowerText = text.toLowerCase();
  const lowerTerm = term.toLowerCase();
  const parts = [];
  let lastIndex = 0;
  let i = lowerText.indexOf(lowerTerm);

  while (i !== -1) {
    if (i > lastIndex) parts.push(escapeHtml(text.substring(lastIndex, i)));
    parts.push(`<mark class="search-match">${escapeHtml(text.substring(i, i + term.length))}</mark>`);
    lastIndex = i + term.length;
    i = lowerText.indexOf(lowerTerm, lastIndex);
  }

  if (lastIndex < text.length) parts.push(escapeHtml(text.substring(lastIndex)));
  return parts.join('');
}

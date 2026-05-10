/* ============================================================
   Exeter Pubs — app logic
   Adds free-text search across name/address/notes, combinable
   with tag filters. Highlights matched text in the cards.
   ============================================================ */

// ----- App state -----
const appState = {
  pubs: [],
  userLocation: null,
  map: null,
  pubMarkers: {},
  markerOnMap: {},
  userMarker: null,
  activeFilters: new Set(),
  searchTerm: '',
  activeView: 'map',
};

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
  fitMapToPubs();
  buildFilterChips(pubs);
  applyFiltersAndRender();
  bindFindMeButton();
  bindClearFiltersButton();
  bindSearchInput();
  bindViewToggle();
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
  const tagsHTML = (pub.tags && pub.tags.length)
    ? `<div class="popup-tags">${pub.tags.map(t => `<span class="popup-tag">${escapeHtml(t)}</span>`).join('')}</div>`
    : '';

  const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${pub.lat},${pub.lon}`;

  return `
    <div class="popup-content">
      <h3 class="popup-name">${escapeHtml(pub.name)}</h3>
      ${pub.address ? `<p class="popup-meta">${escapeHtml(pub.address)}</p>` : ''}
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

function fitMapToPubs() {
  const bounds = L.latLngBounds(appState.pubs.map(p => [p.lat, p.lon]));
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
  const haystack = [pub.name, pub.address || '', pub.notes || '']
    .join(' ')
    .toLowerCase();
  return haystack.includes(term);
}

// ----- Filters -----

function buildFilterChips(pubs) {
  const allTags = new Set();
  pubs.forEach(pub => (pub.tags || []).forEach(t => allTags.add(t)));

  // Always show the panel — search input lives here even if there are no tags
  document.getElementById('filters').hidden = false;

  if (allTags.size === 0) return;

  const sortedTags = [
    ...CANONICAL_TAG_ORDER.filter(t => allTags.has(t)),
    ...[...allTags].filter(t => !CANONICAL_TAG_ORDER.includes(t)).sort()
  ];

  const container = document.getElementById('filter-chips');
  container.innerHTML = '';
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

function bindClearFiltersButton() {
  document.getElementById('clear-filters-btn').addEventListener('click', () => {
    // Clear all: search + tag filters together
    appState.activeFilters.clear();
    appState.searchTerm = '';
    const input = document.getElementById('search-input');
    input.value = '';
    document.getElementById('search-clear-btn').hidden = true;
    applyFiltersAndRender();
  });
}

function pubMatchesFilters(pub) {
  if (appState.activeFilters.size === 0) return true;
  const pubTags = new Set(pub.tags || []);
  for (const tag of appState.activeFilters) {
    if (!pubTags.has(tag)) return false;
  }
  return true;
}

function applyFiltersAndRender() {
  // Apply both search AND tag filters
  const filtered = appState.pubs
    .filter(pubMatchesSearch)
    .filter(pubMatchesFilters);

  const sorted = appState.userLocation
    ? sortByDistance(filtered, appState.userLocation)
    : sortByName(filtered);

  document.querySelectorAll('.chip').forEach(chip => {
    const isActive = appState.activeFilters.has(chip.dataset.tag);
    chip.classList.toggle('active', isActive);
    chip.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });

  updateFilterMeta(filtered.length, appState.pubs.length);

  const visibleIds = new Set(filtered.map(p => p.id));
  updateMapMarkerVisibility(visibleIds);

  renderPubs(sorted);
}

function updateFilterMeta(matched, total) {
  const count = document.getElementById('filter-count');
  const clearBtn = document.getElementById('clear-filters-btn');
  const isFiltering = appState.activeFilters.size > 0 || appState.searchTerm.length > 0;

  if (isFiltering) {
    count.textContent = `${matched} of ${total} match`;
    clearBtn.hidden = false;
  } else {
    count.textContent = `${total} pubs`;
    clearBtn.hidden = true;
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

  list.querySelectorAll('.pub-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.directions-link')) return;
      const pubId = card.dataset.pubId;
      jumpToPubOnMap(pubId);
    });
  });
}

function buildEmptyMessage() {
  const hasSearch = appState.searchTerm.length > 0;
  const hasFilters = appState.activeFilters.size > 0;
  if (hasSearch && hasFilters) return 'No pubs match your search and filters. Try removing one.';
  if (hasSearch) return `No pubs match "${appState.searchTerm}".`;
  if (hasFilters) return 'No pubs match these filters. Try removing some.';
  return 'No pubs to show.';
}

function pubCardHTML(pub) {
  const term = appState.searchTerm;

  const nameHTML = highlightMatch(pub.name, term);

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

  const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${pub.lat},${pub.lon}`;

  const distanceText = (pub.distanceMetres != null)
    ? `<span class="distance has-value">${formatDistance(pub.distanceMetres)} · ${formatWalkingTime(pub.distanceMetres)}</span>`
    : `<span class="distance">Tap "Find pubs near me" for distance</span>`;

  return `
    <li class="pub-card" id="${pub.id}" data-pub-id="${pub.id}">
      <h2 class="pub-name">${nameHTML}</h2>
      ${address}
      <div class="pub-meta">
        ${distanceText}
      </div>
      ${tags}
      ${notes}
      <a class="directions-link" href="${directionsUrl}" target="_blank" rel="noopener">Get directions →</a>
    </li>
  `;
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

/**
 * Returns HTML-safe text with all occurrences of `term` wrapped in
 * <mark class="search-match">. Case-insensitive. Returns escaped text
 * unchanged if there's no search term or no match.
 */
function highlightMatch(text, term) {
  const safeText = escapeHtml(text);
  if (!term) return safeText;

  const lowerText = text.toLowerCase();
  const lowerTerm = term.toLowerCase();
  const parts = [];
  let lastIndex = 0;
  let i = lowerText.indexOf(lowerTerm);

  while (i !== -1) {
    if (i > lastIndex) {
      parts.push(escapeHtml(text.substring(lastIndex, i)));
    }
    parts.push(`<mark class="search-match">${escapeHtml(text.substring(i, i + term.length))}</mark>`);
    lastIndex = i + term.length;
    i = lowerText.indexOf(lowerTerm, lastIndex);
  }

  if (lastIndex < text.length) {
    parts.push(escapeHtml(text.substring(lastIndex)));
  }

  return parts.join('');
}

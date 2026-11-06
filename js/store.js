/* Renders the store from products.json: books, file grid, search, cards and deep links. */
(function () {
  'use strict';

  var ART = {
    lens: '<ellipse cx="80" cy="60" rx="13" ry="32"></ellipse><path d="M42 28H80M42 92H80"></path><path d="M60 28v64M66 28v64M72 28v64" stroke-opacity="0.5"></path><ellipse cx="42" cy="60" rx="13" ry="32" fill="#20252B"></ellipse><ellipse cx="42" cy="60" rx="7" ry="18"></ellipse><path d="M26 38h-6v44h6M98 38h6v44h-6" stroke-opacity="0.6"></path>',
    gear: [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map(function (a) {
      return '<rect x="56" y="18" width="8" height="10" fill="#20252B" transform="rotate(' + a + ' 60 60)"></rect>';
    }).join('') + '<circle cx="60" cy="60" r="32" fill="#20252B"></circle><circle cx="60" cy="60" r="16"></circle><circle cx="60" cy="60" r="24" stroke-opacity="0.4"></circle>',
    cap: '<circle cx="60" cy="60" r="38" fill="#20252B"></circle><circle cx="60" cy="60" r="30"></circle><rect x="16" y="52" width="8" height="16" fill="#20252B"></rect><rect x="96" y="52" width="8" height="16" fill="#20252B"></rect><path d="M48 60h24" stroke-opacity="0.5"></path>',
    aperture: '<circle cx="60" cy="60" r="38" fill="#20252B"></circle><ellipse cx="60" cy="60" rx="10" ry="24"></ellipse><circle cx="60" cy="60" r="32" stroke-opacity="0.35"></circle>',
    part: '<path d="M28 84V44a8 8 0 018-8h48a8 8 0 018 8v16H64v24z" fill="#20252B"></path><circle cx="46" cy="50" r="5"></circle><circle cx="78" cy="48" r="4"></circle><path d="M64 60v24" stroke-opacity="0.5"></path>',
    preset: '<rect x="24" y="30" width="72" height="60" fill="#20252B"></rect><path d="M34 46h52M34 60h52M34 74h52" stroke-opacity="0.45"></path><circle cx="50" cy="46" r="4" fill="#C9CDD2"></circle><circle cx="72" cy="60" r="4" fill="#C9CDD2"></circle><circle cx="42" cy="74" r="4" fill="#C9CDD2"></circle>',
    lut: '<path d="M60 26l30 16-30 16-30-16z" fill="#3A2A2A"></path><path d="M30 42v34l30 16V58z" fill="#24352A"></path><path d="M90 42v34L60 92V58z" fill="#23304A"></path><path d="M60 26l30 16v34L60 92 30 76V42zM60 58l30-16M60 58L30 42M60 58v34"></path>'
  };
  var ICON_CLOSE = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg>';
  var ICON_DOWNLOAD = '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"></path><path d="M7 10l5 5 5-5"></path><path d="M5 20h14"></path></svg>';
  var ICON_BOOK = '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h7a2 2 0 012 2v12a2 2 0 00-2-2H3z"></path><path d="M21 5h-7a2 2 0 00-2 2v12a2 2 0 012-2h7z"></path></svg>';
  var ICON_VIDEO = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14"></rect><path d="M10 9l5 3-5 3z"></path></svg>';
  var MORE_VIDEOS_SHOWN = 2;

  var data, gridItems, itemsById = {}, booksById = {}, catLabels = {};
  var state = { q: '', cat: 'all', item: null, book: null, only: null };
  var preferredVideo = null;
  var lastFocus = null;
  var viewer = null;
  var viewerScript = null;
  var el = {};

  function $(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtSize(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
    return Math.max(1, Math.round(bytes / 1e3)) + ' KB';
  }

  function artSvg(it) {
    return '<svg aria-hidden="true" viewBox="0 0 120 120" stroke="#C9CDD2" stroke-width="1.25" fill="none" stroke-linecap="round" stroke-linejoin="round">' + (ART[it.art] || ART.part) + '</svg>';
  }

  /* Books */
  function renderBooks() {
    el.books.innerHTML = data.books.map(function (b) {
      return '<button class="book ' + esc(b.color) + '" data-book="' + esc(b.id) + '" aria-label="Open ' + esc(b.title) + '">' +
        '<img class="cover" src="' + esc(b.cover) + '" alt="">' +
        '<span class="book-title">' + esc(b.title) + '</span></button>';
    }).join('');
  }

  function openModal(html) {
    lastFocus = document.activeElement;
    el.modal.innerHTML = html;
    el.modal.hidden = false;
    document.body.style.overflow = 'hidden';
    var close = el.modal.querySelector('[data-close]');
    if (close) close.focus();
  }

  function closeModal() {
    if (viewer) { viewer.destroy(); viewer = null; }
    state.book = null;
    state.item = null;
    el.modal.hidden = true;
    el.modal.innerHTML = '';
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
    syncUrl();
  }

  function openBook(id) {
    var b = booksById[id];
    if (!b) return;
    state.book = id;
    // One button per file: browsers often block a single click that starts two downloads.
    var bonus = b.bonus.map(function (file, i) {
      var name = b.bonus.length > 1 ? 'Bonus Part ' + (i + 1) : 'Bonus Material';
      return '<a class="btn btn-line btn-bonus" href="' + esc(file.url) + '"><span class="bonus-label"><span>' + name + '</span><span class="bonus-sep"> · </span><span>' + fmtSize(file.size) + '</span></span></a>';
    }).join('');
    var meta = 'PDF · ' + fmtSize(b.pdfSize) + ' · ' + b.displayPages + ' pages';
    var description = b.description.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
    openModal(
      '<div class="dialog book-card" role="dialog" aria-modal="true" aria-label="' + esc(b.title) + '">' +
      '<div class="book-card-cover ' + esc(b.color) + '"><img src="' + esc(b.cover) + '" alt=""></div>' +
      '<div class="dialog-body"><div class="card-head"><h2 class="dialog-title">' + esc(b.fullTitle) + '</h2>' +
      '<button class="icon-btn" data-close aria-label="Close">' + ICON_CLOSE + '</button></div>' +
      (b.tagline ? '<p class="book-card-tagline">' + esc(b.tagline) + '</p>' : '') +
      '<div class="book-card-desc">' + description + '</div>' +
      '<div class="book-card-meta">' + meta + '</div>' +
      '<div class="book-card-actions"><button class="btn btn-primary" data-read="' + esc(b.id) + '">' + ICON_BOOK + 'Read online</button>' +
      '<div class="book-card-row"><a class="btn btn-line" href="' + esc(b.pdf) + '" download="' + esc(b.downloadName) + '">Download PDF</a>' + bonus + '</div></div>' +
      '</div></div>'
    );
    syncUrl();
  }

  /* File grid */
  // A new order on each page load. It's a copy because deep links rely on data.items staying
  // in its set order. Tiles with the same image, like the presets, get moved apart.
  function shuffledItems() {
    var list = data.items.slice();
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var held = list[i]; list[i] = list[j]; list[j] = held;
    }
    for (var k = 1; k < list.length; k++) {
      if (list[k].thumb !== list[k - 1].thumb) continue;
      for (var m = k + 1; m < list.length; m++) {
        if (list[m].thumb !== list[k - 1].thumb) {
          var other = list[k]; list[k] = list[m]; list[m] = other;
          break;
        }
      }
    }
    return list;
  }

  function filtered() {
    var q = state.q.toLowerCase().trim();
    return gridItems.filter(function (it) {
      if (state.only && state.only.indexOf(it.id) === -1) return false;
      if (state.cat !== 'all' && it.category !== state.cat) return false;
      if (!q) return true;
      var hay = [it.name, it.format, it.description, it.contents, it.downloadName, catLabels[it.category]].concat(it.tags).join(' ').toLowerCase();
      return q.split(/\s+/).every(function (word) { return hay.indexOf(word) !== -1; });
    });
  }

  function renderChips() {
    var cats = [{ id: 'all', label: 'All' }].concat(data.categories);
    el.chips.innerHTML = cats.map(function (c) {
      return '<button class="chip" data-cat="' + esc(c.id) + '" aria-pressed="' + (state.cat === c.id) + '">' + esc(c.label) + '</button>';
    }).join('');
  }

  function renderGrid() {
    var list = filtered();
    el.grid.innerHTML = list.map(function (it) {
      var visual = it.thumb ? '<img src="' + esc(it.thumb) + '" alt="" loading="lazy">' : artSvg(it);
      return '<button class="tile" data-item="' + esc(it.id) + '" aria-haspopup="dialog" title="' + esc(it.name) + '">' +
        '<span class="tile-art">' + visual + (it.models.length ? '<span class="tile-3d" aria-label="3D model">3D</span>' : '') + '</span>' +
        '<span class="tile-text"><span class="tile-name">' + esc(it.name) + '</span>' +
        '<span class="tile-meta">' + esc(it.format) + ' · ' + fmtSize(it.size) + '</span></span></button>';
    }).join('');
    el.count.textContent = list.length + ' of ' + data.items.length;
    el.empty.hidden = list.length > 0;
  }

  /* Item card */
  function openItem(id) {
    var it = itemsById[id];
    if (!it) return;
    state.item = id;
    var videos = it.videos.slice();
    if (preferredVideo && videos.indexOf(preferredVideo) > 0) {
      videos.splice(videos.indexOf(preferredVideo), 1);
      videos.unshift(preferredVideo);
    }
    var visual = it.thumb
      ? '<img class="viewer-poster" src="' + esc(it.thumb) + '" alt="">'
      : '<span class="viewer-art">' + artSvg(it) + '</span>';
    var pane = '<div class="viewer" id="viewer"><div class="viewer-stage">' + visual + '</div>';
    if (it.models.length) {
      pane += '<div class="viewer-status" aria-hidden="true"><span class="viewer-hint">Drag to rotate · scroll to zoom</span><span class="viewer-loading">Loading 3D model…</span></div>';
      if (it.models.length > 1) {
        pane += '<div class="viewer-parts" role="group" aria-label="Choose a part">' + it.models.map(function (m, i) {
          return '<button class="chip" data-part="' + i + '" aria-pressed="' + (i === 0) + '">' + esc(m.name) + '</button>';
        }).join('') + '</div>';
      }
    }
    pane += '</div>';

    var body = '<div class="card-head"><div class="card-titles"><div class="card-cat">' + esc(catLabels[it.category]) + '</div>' +
      '<h2 class="dialog-title">' + esc(it.name) + '</h2></div>' +
      '<button class="icon-btn" data-close aria-label="Close">' + ICON_CLOSE + '</button></div>' +
      '<div class="card-meta">' + esc(it.format) + ' · ' + fmtSize(it.size) + ' · ' + esc(it.contents) + '</div>';
    if (it.description) body += '<p class="card-desc">' + esc(it.description) + '</p>';
    if (videos.length) {
      body += '<button class="video" data-video="' + esc(videos[0]) + '" aria-label="Play ' + esc(data.videoTitles[videos[0]] || 'video') + '">' +
        '<img src="https://i.ytimg.com/vi/' + esc(videos[0]) + '/hqdefault.jpg" alt="">' +
        '<span class="video-play" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="#ECEDEE"><path d="M8 5l12 7-12 7z"></path></svg></span></button>';
      body += '<div class="card-links">' + videos.slice(0, 1 + MORE_VIDEOS_SHOWN).map(function (v) {
        return '<a href="https://www.youtube.com/watch?v=' + esc(v) + '" target="_blank" rel="noopener">' +
          esc(data.videoTitles[v] || 'Related video') + '</a>';
      }).join('');
      if (videos.length > 1 + MORE_VIDEOS_SHOWN) body += '<span>+' + (videos.length - 1 - MORE_VIDEOS_SHOWN) + ' more videos use this file</span>';
      body += '</div>';
    }
    body += '<a class="btn btn-primary card-download" href="' + esc(it.file) + '" download="' + esc(it.downloadName) + '">' + ICON_DOWNLOAD +
      'Download ' + esc(it.format) + ' · ' + fmtSize(it.size) + '</a>';

    openModal('<div class="dialog item-card" role="dialog" aria-modal="true" aria-label="' + esc(it.name) + '">' + pane + '<div class="dialog-body">' + body + '</div></div>');
    syncUrl();
    if (it.models.length) startViewer(it);
  }

  function loadViewerScript() {
    if (!viewerScript) {
      viewerScript = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = 'js/viewer.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }
    return viewerScript;
  }

  function startViewer(it) {
    loadViewerScript().then(function () {
      var host = $('viewer');
      // The card may have been closed, or swapped for another, while the script loaded.
      if (!host || state.item !== it.id) return;
      viewer = window.StoreViewer.mount(host, it.models, it.name);
      if (viewer) viewer.show(0);
    });
  }

  /* Keeps an open card or book shareable. */
  function syncUrl() {
    var query = state.book ? '?book=' + encodeURIComponent(state.book)
      : state.item ? '?item=' + encodeURIComponent(state.item)
      : state.cat !== 'all' ? '?cat=' + encodeURIComponent(state.cat)
      : '';
    history.replaceState(null, '', location.pathname + query);
  }

  function showNotice(videoId) {
    var title = data.videoTitles[videoId];
    el.notice.innerHTML = ICON_VIDEO + '<span>Opened from YouTube' + (title ? ': “' + esc(title) + '”' : '') + '.</span>' +
      (state.only && state.only.length > 1 ? '<button data-show-all>Show all files</button>' : '');
    el.notice.hidden = false;
  }

  function applyDeepLink() {
    var params = new URLSearchParams(location.search);
    var cat = params.get('cat');
    var item = params.get('item');
    var book = params.get('book');
    var video = params.get('v');
    if (cat && catLabels[cat]) state.cat = cat;
    if (video) {
      var items = data.items.filter(function (it) { return it.videos.indexOf(video) !== -1; });
      var books = data.books.filter(function (b) { return b.videos.indexOf(video) !== -1; });
      preferredVideo = video;
      if (items.length > 1) state.only = items.map(function (it) { return it.id; });
      // No match is fine: the store just opens as normal, with no notice.
      if (items.length || books.length) showNotice(video);
      renderChips();
      renderGrid();
      if (items.length) openItem(items[0].id);
      else if (books.length) openBook(books[0].id);
      return;
    }
    renderChips();
    renderGrid();
    if (item && itemsById[item]) openItem(item);
    else if (book && booksById[book]) openBook(book);
    else if (cat && catLabels[cat]) document.querySelector('.files').scrollIntoView();
  }

  function startReader(id) {
    var book = booksById[id];
    var opener = document.activeElement;
    var load = window.StoreReader ? Promise.resolve() : new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'js/reader.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
    load.then(function () {
      window.StoreReader.open(book, function () { if (opener && opener.focus) opener.focus(); });
    });
  }

  function trapTab(event, container) {
    var focusable = container.querySelectorAll('a[href], button:not([disabled]), input, canvas');
    if (!focusable.length) return;
    var first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault(); }
    else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault(); }
  }

  function bindEvents() {
    el.books.addEventListener('click', function (e) {
      var b = e.target.closest('[data-book]');
      if (b) openBook(b.dataset.book);
    });

    el.chips.addEventListener('click', function (e) {
      var c = e.target.closest('[data-cat]');
      if (!c) return;
      state.cat = c.dataset.cat;
      state.only = null;
      el.notice.hidden = true;
      renderChips();
      renderGrid();
      syncUrl();
    });

    el.search.addEventListener('input', function () {
      state.q = el.search.value;
      state.only = null;
      el.notice.hidden = true;
      renderGrid();
    });

    el.notice.addEventListener('click', function (e) {
      if (!e.target.closest('[data-show-all]')) return;
      state.only = null;
      el.notice.hidden = true;
      renderGrid();
    });

    el.grid.addEventListener('click', function (e) {
      var t = e.target.closest('[data-item]');
      if (t) openItem(t.dataset.item);
    });
    // Image errors don't bubble, so listen while they travel down. A failed image becomes line art.
    el.grid.addEventListener('error', function (e) {
      var tile = e.target.closest && e.target.closest('[data-item]');
      if (tile && e.target.tagName === 'IMG') e.target.outerHTML = artSvg(itemsById[tile.dataset.item]);
    }, true);

    el.modal.addEventListener('click', function (e) {
      if (e.target === el.modal || e.target.closest('[data-close]')) { closeModal(); return; }
      var read = e.target.closest('[data-read]');
      if (read) { startReader(read.dataset.read); return; }
      if (e.target.closest('[aria-disabled="true"]')) { e.preventDefault(); return; }
      var part = e.target.closest('[data-part]');
      if (part && viewer) {
        Array.prototype.forEach.call(el.modal.querySelectorAll('[data-part]'), function (b) {
          b.setAttribute('aria-pressed', b === part);
        });
        viewer.show(Number(part.dataset.part));
        return;
      }
      var play = e.target.closest('[data-video]');
      if (play) {
        var frame = document.createElement('iframe');
        frame.className = 'video-frame';
        frame.title = play.getAttribute('aria-label');
        frame.allow = 'autoplay; encrypted-media; picture-in-picture';
        frame.allowFullscreen = true;
        frame.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(play.dataset.video) + '?autoplay=1&rel=0';
        play.replaceWith(frame);
      }
    });

    document.addEventListener('keydown', function (e) {
      if (document.querySelector('.reader') || el.modal.hidden) return;
      if (e.key === 'Escape') closeModal();
      else if (e.key === 'Tab') trapTab(e, el.modal);
    });
  }

  function init() {
    // Set before the data loads, or the browser restores the old scroll position over a deep link's.
    if (location.search) history.scrollRestoration = 'manual';
    el = {
      books: $('books'), chips: $('chips'), search: $('search'), count: $('count'), notice: $('notice'),
      grid: $('grid'), empty: $('empty'), modal: $('modal')
    };
    fetch('products.json').then(function (r) { return r.json(); }).then(function (json) {
      data = json;
      gridItems = shuffledItems();
      data.items.forEach(function (it) { itemsById[it.id] = it; });
      data.books.forEach(function (b) { booksById[b.id] = b; });
      data.categories.forEach(function (c) { catLabels[c.id] = c.label; });
      renderBooks();
      bindEvents();
      applyDeepLink();
    });
  }

  init();
})();

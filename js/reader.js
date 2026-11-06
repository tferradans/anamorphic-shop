/* Full-screen PDF reader. Loaded on first use, and it loads pdf.js only then. */
(function () {
  'use strict';

  // pdf.js 4.4.168, self-hosted. Resolved against the page, so it works under any base path.
  var PDFJS = new URL('vendor/pdfjs/', document.baseURI).href;
  var WIDE = '(min-width: 900px)';
  var ZOOM_STEP = 1.25;
  var ZOOM_MAX = 4;
  var ICON_CLOSE = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg>';
  var ICON_PREV = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M15 6l-6 6 6 6"></path></svg>';
  var ICON_NEXT = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M9 6l6 6-6 6"></path></svg>';

  var libPromise = null;

  function loadLib() {
    if (!libPromise) {
      libPromise = import(PDFJS + 'pdf.min.mjs').then(function (lib) {
        lib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
        return lib;
      });
    }
    return libPromise;
  }

  function open(book, onClose) {
    var root = document.createElement('div');
    root.className = 'reader';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', book.fullTitle + ', reader');
    root.innerHTML =
      '<div class="reader-bar"><div class="reader-title"></div><div class="reader-count" aria-live="polite"></div>' +
      '<div class="reader-zoom"><button class="icon-btn" data-zoom="out" aria-label="Zoom out">&minus;</button><button class="icon-btn" data-zoom="in" aria-label="Zoom in">+</button></div>' +
      '<a class="btn btn-line" data-download>Download</a>' +
      '<button class="icon-btn" data-close aria-label="Close reader">' + ICON_CLOSE + '</button></div>' +
      '<div class="reader-body"><button class="icon-btn reader-nav prev" data-prev aria-label="Previous page">' + ICON_PREV + '</button>' +
      '<div class="reader-stage"><div class="reader-status">Loading ' + book.pages + ' pages…</div></div>' +
      '<button class="icon-btn reader-nav next" data-next aria-label="Next page">' + ICON_NEXT + '</button></div>';
    root.querySelector('.reader-title').textContent = book.fullTitle;
    var download = root.querySelector('[data-download]');
    download.href = book.pdf;
    download.download = book.downloadName;
    document.body.appendChild(root);
    var bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    var stage = root.querySelector('.reader-stage');
    var count = root.querySelector('.reader-count');
    var prev = root.querySelector('[data-prev]');
    var next = root.querySelector('[data-next]');
    var pdf = null, loadingTask = null;
    var page = 1, zoom = 1;
    var generation = 0;
    var closed = false;

    /* The pages to show together. Spread PDFs and narrow screens show one at a time. */
    function currentPages() {
      if (book.spreads || !window.matchMedia(WIDE).matches || page === 1) return [page];
      var left = page % 2 === 0 ? page : page - 1;
      return left + 1 <= pdf.numPages ? [left, left + 1] : [left];
    }

    function render() {
      if (!pdf) return;
      var current = generation = generation + 1;
      var numbers = currentPages();
      page = numbers[0];
      count.textContent = 'Page ' + numbers.join('–') + ' / ' + pdf.numPages;
      prev.disabled = page <= 1;
      next.disabled = numbers[numbers.length - 1] >= pdf.numPages;
      Promise.all(numbers.map(function (n) { return pdf.getPage(n); })).then(function (pages) {
        if (current !== generation || closed) return;
        var base = pages.map(function (p) { return p.getViewport({ scale: 1 }); });
        var totalWidth = base.reduce(function (sum, v) { return sum + v.width; }, 0) + (base.length - 1) * 2;
        var tallest = Math.max.apply(null, base.map(function (v) { return v.height; }));
        var fit = Math.min(stage.clientWidth / totalWidth, stage.clientHeight / tallest);
        var scale = fit * zoom;
        var ratio = window.devicePixelRatio || 1;
        var holder = document.createElement('div');
        holder.className = 'reader-pages';
        var jobs = pages.map(function (p) {
          var viewport = p.getViewport({ scale: scale * ratio });
          var canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = Math.floor(viewport.width / ratio) + 'px';
          canvas.style.height = Math.floor(viewport.height / ratio) + 'px';
          holder.appendChild(canvas);
          return p.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
        });
        return Promise.all(jobs).then(function () {
          if (current !== generation || closed) return;
          stage.innerHTML = '';
          stage.appendChild(holder);
          stage.scrollTop = 0;
          stage.scrollLeft = 0;
        });
      }).catch(function (err) {
        if (err && err.name === 'RenderingCancelledException') return;
        if (current === generation && !closed) fail();
      });
    }

    function fail() {
      stage.innerHTML = '<div class="reader-status">This book could not be opened here. You can still download it.</div>';
    }

    function step(direction) {
      if (!pdf) return;
      var numbers = currentPages();
      var target = direction > 0 ? numbers[numbers.length - 1] + 1 : numbers[0] - 1;
      if (target < 1 || target > pdf.numPages) return;
      page = target;
      render();
    }

    function setZoom(direction) {
      zoom = direction === 'in' ? Math.min(ZOOM_MAX, zoom * ZOOM_STEP) : Math.max(1, zoom / ZOOM_STEP);
      render();
    }

    function close() {
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      if (loadingTask) loadingTask.destroy();
      root.remove();
      document.body.style.overflow = bodyOverflow;
      if (onClose) onClose();
    }

    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'Tab') {
        var focusable = root.querySelectorAll('a[href], button:not([disabled])');
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
      }
    }

    var resizeTimer;
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(render, 150);
    }

    root.addEventListener('click', function (e) {
      if (e.target.closest('[data-close]')) close();
      else if (e.target.closest('[data-prev]')) step(-1);
      else if (e.target.closest('[data-next]')) step(1);
      else {
        var z = e.target.closest('[data-zoom]');
        if (z) setZoom(z.dataset.zoom);
      }
    });
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    root.querySelector('[data-close]').focus();

    loadLib().then(function (lib) {
      if (closed) return;
      loadingTask = lib.getDocument({ url: book.pdf });
      return loadingTask.promise.then(function (doc) {
        if (closed) return;
        pdf = doc;
        render();
      });
    }).catch(function () { if (!closed) fail(); });
  }

  window.StoreReader = { open: open };
})();

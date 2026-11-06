/* Small rotatable STL viewer in plain WebGL. Loaded the first time a card has a 3D model. */
(function () {
  'use strict';

  var VERTEX = [
    'attribute vec3 aPosition;',
    'attribute vec3 aNormal;',
    'uniform mat4 uView;',
    'uniform mat4 uProjection;',
    'varying vec3 vNormal;',
    'void main() {',
    '  vec4 eye = uView * vec4(aPosition, 1.0);',
    '  vNormal = mat3(uView) * aNormal;',
    '  gl_Position = uProjection * eye;',
    '}'
  ].join('\n');

  var FRAGMENT = [
    'precision mediump float;',
    'varying vec3 vNormal;',
    'void main() {',
    '  vec3 n = normalize(vNormal);',
    '  if (!gl_FrontFacing) n = -n;',
    '  float key = max(dot(n, normalize(vec3(-0.4, 0.5, 0.77))), 0.0);',
    '  float fill = max(dot(n, normalize(vec3(0.7, -0.2, 0.3))), 0.0);',
    '  vec3 base = vec3(0.79, 0.80, 0.82);',
    '  gl_FragColor = vec4(base * (0.26 + 0.62 * key + 0.22 * fill), 1.0);',
    '}'
  ].join('\n');

  var START_YAW = -35 * Math.PI / 180;
  var START_PITCH = 25 * Math.PI / 180;
  var FOV = 30 * Math.PI / 180;
  var MAX_PITCH = 89 * Math.PI / 180;
  var ZOOM_MIN = 0.6;
  var ZOOM_MAX = 6;
  var cache = {};

  /* Models are binary STL: the build script converts them all. */
  function parseStl(buffer) {
    var view = new DataView(buffer);
    var count = view.getUint32(80, true);
    var data = new Float32Array(count * 18);
    var min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    var offset = 84, out = 0;
    for (var t = 0; t < count; t++) {
      offset += 12;
      var p = [];
      for (var i = 0; i < 9; i++) { p.push(view.getFloat32(offset, true)); offset += 4; }
      offset += 2;
      var ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2];
      var vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      for (var v = 0; v < 3; v++) {
        for (var a = 0; a < 3; a++) {
          var value = p[v * 3 + a];
          if (value < min[a]) min[a] = value;
          if (value > max[a]) max[a] = value;
          data[out++] = value;
        }
        data[out++] = nx / len; data[out++] = ny / len; data[out++] = nz / len;
      }
    }
    var center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    var dx = max[0] - min[0], dy = max[1] - min[1], dz = max[2] - min[2];
    return { data: data, count: count * 3, center: center, radius: Math.sqrt(dx * dx + dy * dy + dz * dz) / 2 || 1 };
  }

  function loadModel(url) {
    if (!cache[url]) {
      cache[url] = fetch(url).then(function (r) {
        if (!r.ok) throw new Error('model ' + r.status);
        return r.arrayBuffer();
      }).then(parseStl);
      cache[url].catch(function () { delete cache[url]; });
    }
    return cache[url];
  }

  function multiply(a, b) {
    var out = new Float32Array(16);
    for (var c = 0; c < 4; c++) {
      for (var r = 0; r < 4; r++) {
        out[c * 4 + r] = a[r] * b[c * 4] + a[r + 4] * b[c * 4 + 1] + a[r + 8] * b[c * 4 + 2] + a[r + 12] * b[c * 4 + 3];
      }
    }
    return out;
  }
  function translate(x, y, z) { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]); }
  function rotateX(a) { var c = Math.cos(a), s = Math.sin(a); return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]); }
  function rotateZ(a) { var c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }
  function perspective(fov, aspect, near, far) {
    var f = 1 / Math.tan(fov / 2);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0]);
  }

  function compile(gl, type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  }

  /* Returns a controller, or null when WebGL isn't available, so the image stays. */
  function mount(host, models, itemName) {
    var canvas = document.createElement('canvas');
    canvas.className = 'viewer-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '3D model of ' + itemName + '. Drag or use the arrow keys to rotate.');
    var gl = canvas.getContext('webgl', { antialias: true, alpha: true, preserveDrawingBuffer: true });
    if (!gl) return null;

    var program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    gl.useProgram(program);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);

    var buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    var aPosition = gl.getAttribLocation(program, 'aPosition');
    var aNormal = gl.getAttribLocation(program, 'aNormal');
    gl.enableVertexAttribArray(aPosition);
    gl.enableVertexAttribArray(aNormal);
    gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 24, 12);
    var uView = gl.getUniformLocation(program, 'uView');
    var uProjection = gl.getUniformLocation(program, 'uProjection');

    var model = null, yaw = START_YAW, pitch = START_PITCH, zoom = 1;
    var request = 0, destroyed = false;
    var pointers = {}, pinchDistance = 0;

    function draw() {
      if (destroyed) return;
      var ratio = window.devicePixelRatio || 1;
      var width = Math.round(canvas.clientWidth * ratio), height = Math.round(canvas.clientHeight * ratio);
      if (!width || !height) return;
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      gl.viewport(0, 0, width, height);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!model) return;
      var aspect = width / height;
      // Fit the whole model whichever side of the frame is tighter.
      var fit = model.radius / Math.sin(Math.min(FOV, 2 * Math.atan(Math.tan(FOV / 2) * aspect)) / 2);
      var distance = fit * 1.02 / zoom;
      var view = multiply(translate(0, 0, -distance), multiply(rotateX(pitch - Math.PI / 2), multiply(rotateZ(yaw), translate(-model.center[0], -model.center[1], -model.center[2]))));
      gl.uniformMatrix4fv(uView, false, view);
      gl.uniformMatrix4fv(uProjection, false, perspective(FOV, aspect, Math.max(distance - model.radius * 2, distance / 100), distance + model.radius * 2));
      gl.drawArrays(gl.TRIANGLES, 0, model.count);
    }

    function rotate(dx, dy) {
      yaw += dx;
      pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch + dy));
      draw();
    }

    function setZoom(value) {
      zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value));
      draw();
    }

    function reset() {
      yaw = START_YAW; pitch = START_PITCH; zoom = 1;
      draw();
    }

    function show(index) {
      var current = ++request;
      host.classList.add('is-loading');
      return loadModel(models[index].file).then(function (loaded) {
        if (destroyed || current !== request) return;
        model = loaded;
        gl.bufferData(gl.ARRAY_BUFFER, loaded.data, gl.STATIC_DRAW);
        host.classList.remove('is-loading');
        host.classList.add('is-ready');
        reset();
      }).catch(function () {
        if (!destroyed && current === request) { host.classList.remove('is-loading'); host.classList.add('is-failed'); }
      });
    }

    canvas.addEventListener('pointerdown', function (e) {
      canvas.setPointerCapture(e.pointerId);
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      pinchDistance = 0;
      canvas.classList.add('is-dragging');
    });
    canvas.addEventListener('pointermove', function (e) {
      var last = pointers[e.pointerId];
      if (!last) return;
      var ids = Object.keys(pointers);
      if (ids.length === 2) {
        pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
        var a = pointers[ids[0]], b = pointers[ids[1]];
        var d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDistance) setZoom(zoom * d / pinchDistance);
        pinchDistance = d;
        return;
      }
      rotate((e.clientX - last.x) * 0.01, (e.clientY - last.y) * 0.01);
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    });
    function release(e) {
      delete pointers[e.pointerId];
      pinchDistance = 0;
      if (!Object.keys(pointers).length) canvas.classList.remove('is-dragging');
    }
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      setZoom(zoom * Math.exp(-e.deltaY * 0.001));
    }, { passive: false });
    canvas.addEventListener('dblclick', reset);
    canvas.addEventListener('keydown', function (e) {
      var step = 0.15;
      if (e.key === 'ArrowLeft') rotate(-step, 0);
      else if (e.key === 'ArrowRight') rotate(step, 0);
      else if (e.key === 'ArrowUp') rotate(0, -step);
      else if (e.key === 'ArrowDown') rotate(0, step);
      else if (e.key === '+' || e.key === '=') setZoom(zoom * 1.2);
      else if (e.key === '-') setZoom(zoom / 1.2);
      else return;
      e.preventDefault();
    });

    var observer = window.ResizeObserver ? new ResizeObserver(draw) : null;
    if (observer) observer.observe(canvas);
    host.querySelector('.viewer-stage').appendChild(canvas);

    return {
      show: show,
      destroy: function () {
        destroyed = true;
        if (observer) observer.disconnect();
        var lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
        canvas.remove();
      }
    };
  }

  window.StoreViewer = { mount: mount };
})();

/* Real camera + MediaPipe HandLandmarker.
 * One persistent <div class="cam"> (video + landmark overlay) that the views move into
 * whichever screen needs it, so the live stream is never torn down by re-rendering. */

const CONNECTIONS = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

export class Camera {
  constructor() {
    this.state = 'off';          // off | starting | on | error
    this.error = '';
    this.handPresent = false;
    this.onFrame = null;         // (landmarks|null, tMs) => void
    this.onState = null;         // () => void
    this.landmarker = null;
    this.stream = null;
    this.lastVideoTime = -1;
    this.node = document.createElement('div');
    this.node.className = 'cam';
    this.node.innerHTML = `
      <video class="camvideo" playsinline muted autoplay></video>
      <canvas class="camcanvas"></canvas>
      <svg class="sil" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><circle cx="200" cy="105" r="42"/><path d="M110 300c0-62 40-95 90-95s90 33 90 95z"/></svg>
      <div class="guide"></div>
      <div class="chip-top"><span class="dot"></span><span class="chip-text"></span></div>
      <div class="cap"></div>`;
    this.video = this.node.querySelector('video');
    this.canvas = this.node.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.chipText = this.node.querySelector('.chip-text');
    this.chipDot = this.node.querySelector('.chip-top .dot');
    this.cap = this.node.querySelector('.cap');
    this.paint();
  }

  /** Update the little status chip + classes without re-rendering anything. */
  paint(extra) {
    const n = this.node;
    n.classList.toggle('liveveo', this.state === 'on');
    n.classList.toggle('hand-on', this.state === 'on' && this.handPresent);
    let text, dot = '';
    if (this.state === 'off') text = 'Camera off · کیمرہ بند ہے';
    else if (this.state === 'starting') { text = 'Starting camera… · کیمرہ شروع ہو رہا ہے'; dot = 'live'; }
    else if (this.state === 'error') text = 'Camera unavailable · کیمرہ دستیاب نہیں';
    else if (this.handPresent) { text = 'Hand detected · ہاتھ نظر آ گیا'; dot = 'live'; }
    else { text = 'Show your hand · اپنا ہاتھ دکھائیں'; dot = 'idle'; }
    this.chipText.textContent = extra || text;
    this.chipDot.className = 'dot ' + dot;
    this.cap.textContent = this.state === 'error' ? this.error : this.state === 'on' ? 'Live camera · MediaPipe hand tracking' : '';
  }

  _set(state, error = '') { this.state = state; this.error = error; this.paint(); if (this.onState) this.onState(); }

  async _loadLandmarker() {
    if (this.landmarker) return this.landmarker;
    const { FilesetResolver, HandLandmarker } = await import('/vendor/mediapipe/vision_bundle.mjs');
    const fileset = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
    const make = delegate => HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: '/vendor/mediapipe/hand_landmarker.task', delegate },
      runningMode: 'VIDEO', numHands: 1,
      minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    try { this.landmarker = await make('GPU'); } catch { this.landmarker = await make('CPU'); }
    return this.landmarker;
  }

  async start() {
    if (this.state === 'on' || this.state === 'starting') return;
    this._set('starting');
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw Object.assign(new Error('insecure'), { name: 'InsecureContext' });
      }
      const [landmarker, stream] = await Promise.all([
        this._loadLandmarker(),
        navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false }),
      ]);
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();
      this.lastVideoTime = -1;
      this._set('on');
      this._loop();
    } catch (e) {
      const name = e && e.name;
      const msg = name === 'NotAllowedError' || name === 'SecurityError' ? 'Camera permission was denied. Allow camera access in the browser address bar, then try again.'
        : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'No camera was found on this device.'
        : name === 'NotReadableError' ? 'The camera is in use by another app or tab. Close it and try again.'
        : name === 'InsecureContext' ? 'The camera needs a secure page: open this app at http://localhost:3000 (or over HTTPS).'
        : 'Could not start hand tracking: ' + (e && e.message ? e.message : e);
      this.stop(); this._set('error', msg);
    }
  }

  stop() {
    this._running = false;
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    this.video.srcObject = null;
    this.handPresent = false;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.state !== 'error') this._set('off');
  }

  /** Re-attach after the node has been moved in the DOM (moving a <video> pauses it). */
  resume() { if (this.state === 'on' && this.video.paused) this.video.play().catch(() => {}); }

  _loop() {
    this._running = true;
    const step = () => {
      if (!this._running) return;
      const v = this.video;
      if (v.readyState >= 2 && v.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = v.currentTime;
        let lm = null;
        try {
          const res = this.landmarker.detectForVideo(v, performance.now());
          lm = res.landmarks && res.landmarks[0] ? res.landmarks[0] : null;
        } catch { /* a dropped frame is fine */ }
        this._frame(lm, performance.now());
      }
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step); else requestAnimationFrame(step);
    };
    step();
  }

  _frame(lm, t) {
    const present = !!lm;
    if (present !== this.handPresent) { this.handPresent = present; this.paint(); }
    this._draw(lm);
    if (this.onFrame) this.onFrame(lm, t);
  }

  /** Test hook: feed landmarks as if the detector had produced them. */
  inject(lm, t = performance.now()) { this._frame(lm, t); }

  _draw(lm) {
    const c = this.canvas, v = this.video;
    if (v.videoWidth && (c.width !== v.videoWidth || c.height !== v.videoHeight)) { c.width = v.videoWidth; c.height = v.videoHeight; }
    const g = this.ctx; g.clearRect(0, 0, c.width, c.height);
    if (!lm) return;
    const W = c.width, H = c.height;
    g.lineWidth = Math.max(2, W / 200); g.strokeStyle = 'rgba(143,227,240,.95)'; g.lineCap = 'round';
    g.beginPath();
    for (const [a, b] of CONNECTIONS) { g.moveTo(lm[a].x * W, lm[a].y * H); g.lineTo(lm[b].x * W, lm[b].y * H); }
    g.stroke();
    g.fillStyle = '#ffffff'; g.strokeStyle = '#0b7285'; g.lineWidth = 1.5;
    for (const p of lm) { g.beginPath(); g.arc(p.x * W, p.y * H, Math.max(3, W / 130), 0, 7); g.fill(); g.stroke(); }
  }
}

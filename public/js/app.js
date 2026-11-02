// Small behaviours shared by every page.

// Press "/" anywhere (outside a text box) to jump to the global search.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = document.activeElement;
  if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
  e.preventDefault();
  document.getElementById('global-search')?.focus();
});

const csrfToken = () => document.querySelector('meta[name="csrf-token"]')?.content ?? '';
const getJson = (url) => fetch(url, { headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : Promise.reject(r)));

/** Same rules as src/core/vehicle-format.js: "kda123a" → "KDA 123A". */
function formatReg(input) {
  const compact = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!compact) return '';
  const m = /^([A-Z]{2,3})(\d{1,4})([A-Z]?)$/.exec(compact);
  return m ? `${m[1]} ${m[2]}${m[3]}` : String(input).toUpperCase().trim().replace(/\s+/g, ' ');
}

/** Same as regLooksUsual() in src/core/vehicle-format.js: KDA 123A, ZF 1234, GKB 123A. */
const regLooksUsual = (reg) => /^(K[A-Z]{2} \d{3}[A-Z]|Z[A-Z] \d{4}|GK[A-Z] \d{3}[A-Z])$/.test(reg);

/**
 * Phone photos are 3–6 MB: shrink to 1600 px JPEG (about 300 KB) before uploading, so it's quick
 * on a slow workshop connection. Drawing on a canvas also drops the location data.
 * If the browser can't read the file (e.g. HEIC on Android), send it as it is and let the server decide.
 */
async function shrinkPhoto(file, size = 1600) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return (await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8))) ?? file;
  } catch {
    return file;
  }
}

// Searchable dropdowns: any <select data-tom-select> becomes a Tom Select.
// With data-tom-url="/api/…" it asks the server as you type; the endpoint
// answers ?q=… with JSON: [{ "value": "12", "label": "Mwangi Transporters" }, …]
function initSearchableSelects(root = document) {
  if (!window.TomSelect) return;
  root.querySelectorAll('select[data-tom-select]:not(.tomselected)').forEach((el) => {
    const url = el.dataset.tomUrl;
    const options = {
      maxOptions: 50,
      // The empty first <option> stays in the form (so nothing chosen sends ""), but Tom Select
      // shows its text as a placeholder that clears when you type, not as a chosen item.
      placeholder: el.dataset.placeholder,
      allowEmptyOption: false,
      plugins: el.multiple ? ['remove_button'] : [],
      render: { no_results: () => '<div class="no-results">No matches. Check the spelling.</div>' },
    };
    // data-tom-create="customer": typing a name that isn't found offers "+ Add new customer",
    // which opens the quick-add window (customers/views/quick-add.ejs) and selects the result.
    if (el.dataset.tomCreate) {
      options.create = (input, done) => {
        window.dispatchEvent(new CustomEvent(`jt:quick-add-${el.dataset.tomCreate}`, { detail: { name: input, done } }));
      };
      options.createOnBlur = false;
      options.render.option_create = (data, escape) => `<div class="create"><i class="bi bi-plus-lg"></i> Add new ${escape(el.dataset.tomCreate)} “${escape(data.input)}”</div>`;
    }
    if (url) {
      Object.assign(options, {
        valueField: 'value',
        labelField: 'label',
        searchField: ['label'],
        shouldLoad: (query) => query.length >= 2,
        load(query, callback) {
          fetch(`${url}?q=${encodeURIComponent(query)}`, { headers: { Accept: 'application/json' } })
            .then((res) => res.json())
            .then(callback)
            .catch(() => callback());
        },
      });
    }
    new window.TomSelect(el, options);
  });
}
initSearchableSelects();

// ---------- Alpine components used by several pages ----------
// Registered before Alpine starts (this file loads before Alpine's deferred script runs).
document.addEventListener('alpine:init', () => {
  const { Alpine } = window;

  // Top-bar search: suggestions as you type, Enter opens the full results page.
  Alpine.data('globalSearch', () => ({
    q: '', results: [], open: false, active: 0, timer: null,
    find() {
      clearTimeout(this.timer);
      if (this.q.trim().length < 2) { this.results = []; this.open = false; return; }
      this.timer = setTimeout(async () => {
        try {
          this.results = (await getJson(`/api/search?q=${encodeURIComponent(this.q)}`)).results;
          this.active = 0;
          this.open = true;
        } catch { this.open = false; }
      }, 200);
    },
    move(step) { if (this.results.length) this.active = (this.active + step + this.results.length) % this.results.length; },
    go(e) {
      const pick = this.open && this.results[this.active];
      if (pick) { e.preventDefault(); window.location.href = pick.url; }
      // otherwise the form submits to /search
    },
  }));

  // "Existing customer: ABC Transport. Use this?" under a phone field.
  Alpine.data('phoneCheck', (exceptId = null) => ({
    matches: [],
    async check(phone) {
      if (String(phone).replace(/\D/g, '').length < 9) { this.matches = []; return; }
      try {
        const { matches } = await getJson(`/api/customers/check-phone?phone=${encodeURIComponent(phone)}${exceptId ? `&except=${exceptId}` : ''}`);
        this.matches = matches;
      } catch { this.matches = []; }
    },
  }));

  // Vehicle form: tidy the reg, warn about duplicates, load the customer's contacts.
  Alpine.data('vehicleForm', ({ vehicleId = null, contacts = [], contactId = '' } = {}) => ({
    reg: '', duplicate: null, contacts, contactId: String(contactId ?? ''),
    tidyReg(el) { el.value = formatReg(el.value); this.checkDuplicate(); },
    async checkDuplicate() {
      const reg = this.$refs.reg?.value ?? '';
      const chassis = this.$refs.chassis?.value ?? '';
      if (!reg && !chassis) { this.duplicate = null; return; }
      try {
        const params = new URLSearchParams({ reg, chassis, except: vehicleId ?? '' });
        this.duplicate = (await getJson(`/api/vehicles/check?${params}`)).match;
      } catch { this.duplicate = null; }
    },
    async customerChanged(id) {
      this.contactId = '';
      this.contacts = id ? await getJson(`/api/customers/${id}/contacts`).catch(() => []) : [];
    },
  }));

  // Check-in form: chosen vehicle's details, usual contact, odometer warning, item rows.
  Alpine.data('checkinForm', ({ mode = 'existing', vehicle = null, issueTag = false, odometer = '', odometerBroken = false, fuel = '', rows = [] } = {}) => ({
    mode, vehicle, issueTag, odometer, odometerBroken, fuel, rows, regOdd: false,
    get odometerLow() {
      const last = this.vehicle?.lastVisit?.odometer;
      const now = Number(String(this.odometer).replace(/\D/g, ''));
      return this.mode === 'existing' && !this.odometerBroken && last != null && now > 0 && now < last;
    },
    fmtDate: (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    tidyReg(el) {
      el.value = formatReg(el.value);
      this.regOdd = el.value !== '' && !regLooksUsual(el.value);
    },
    async vehicleChanged(id) {
      this.vehicle = id ? await getJson(`/api/check-in/vehicles/${id}`).catch(() => null) : null;
      // Fill in who usually brings it, unless someone is already chosen.
      const contact = this.$refs.contact?.tomselect;
      if (this.vehicle?.contact && contact && !contact.getValue()) {
        contact.addOption(this.vehicle.contact);
        contact.setValue(String(this.vehicle.contact.value), true);
      }
    },
    addRow(description = '') {
      this.rows.push({ description, quantity: '1' });
      if (!description) this.$nextTick(() => this.$root.querySelector('.jt-items-row:last-child input')?.focus());
    },
    // A quick pick fills the first empty row, adds one more to an existing row, or adds a row.
    addPreset(name) {
      const same = this.rows.find((r) => r.description.trim().toLowerCase() === name.toLowerCase());
      if (same) { same.quantity = String((Number(same.quantity) || 0) + 1); return; }
      const empty = this.rows.find((r) => !r.description.trim());
      if (empty) empty.description = name;
      else this.addRow(name);
    },
    removeRow(i) {
      this.rows.splice(i, 1);
      if (!this.rows.length) this.rows.push({ description: '', quantity: '1' });
    },
  }));

  // Signature box: draw with a finger, stylus or mouse; sent as a PNG data URL.
  // Strokes are kept so the drawing survives the box being resized (phone rotated).
  Alpine.data('signaturePad', () => ({
    strokes: [], current: null, empty: true, missing: false, busy: false, ctx: null,
    init() {
      this.resize();
      new ResizeObserver(() => this.resize()).observe(this.$refs.canvas);
    },
    resize() {
      const canvas = this.$refs.canvas;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = canvas.offsetWidth * ratio;
      canvas.height = canvas.offsetHeight * ratio;
      this.ctx = canvas.getContext('2d');
      this.ctx.scale(ratio, ratio);
      this.redraw();
    },
    point(e) {
      const r = this.$refs.canvas.getBoundingClientRect();
      // Stored as fractions of the box, so a resize keeps the shape.
      return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
    },
    start(e) {
      e.preventDefault();
      this.$refs.canvas.setPointerCapture?.(e.pointerId);
      this.current = [this.point(e)];
      this.strokes.push(this.current);
    },
    move(e) {
      if (!this.current) return;
      this.current.push(this.point(e));
      this.redraw();
    },
    end() {
      if (!this.current) return;
      if (this.current.length === 1) this.current.push(this.current[0]); // a dot
      this.current = null;
      this.empty = false;
      this.missing = false;
    },
    redraw() {
      const { ctx } = this;
      const w = this.$refs.canvas.offsetWidth, h = this.$refs.canvas.offsetHeight;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#0b1a5c';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const stroke of this.strokes) {
        ctx.beginPath();
        stroke.forEach(([x, y], i) => {
          const [px, py] = [x * w, y * h];
          if (i === 0) { ctx.moveTo(px, py); return; }
          // Smooth: curve through the midpoints between samples.
          const [lx, ly] = stroke[i - 1];
          ctx.quadraticCurveTo(lx * w, ly * h, (lx * w + px) / 2, (ly * h + py) / 2);
        });
        ctx.stroke();
      }
    },
    clear() {
      this.strokes = [];
      this.empty = true;
      this.redraw();
    },
    submit(e) {
      if (this.empty) { e.preventDefault(); this.missing = true; return; }
      this.$refs.output.value = this.$refs.canvas.toDataURL('image/png');
      this.busy = true;
    },
  }));

  // Check-in photos (checkins/views/photos.ejs): each photo is shrunk, then uploaded on its own,
  // one at a time, so a dropped connection loses one photo and it can be tried again.
  Alpine.data('checkinPhotos', ({ url, max, photos = [] }) => ({
    url, max, photos, queue: [], message: '', busy: false,
    get room() { return this.max - this.photos.length - this.queue.length; },
    add(files) {
      this.message = '';
      const chosen = [...files];
      const fits = chosen.slice(0, Math.max(this.room, 0));
      if (fits.length < chosen.length) this.message = `A check-in can have up to ${this.max} photos, so ${chosen.length - fits.length} weren’t added.`;
      for (const file of fits) this.queue.push({ key: `${Date.now()}-${Math.random()}`, file, preview: URL.createObjectURL(file), error: '' });
      this.pump();
    },
    async pump() {
      if (this.busy) return;
      this.busy = true;
      try {
        for (let u; (u = this.queue.find((x) => !x.error));) await this.send(u);
      } finally {
        this.busy = false;
      }
    },
    async send(u) {
      try {
        const body = new FormData();
        body.append('photo', await shrinkPhoto(u.file), 'photo.jpg');
        const res = await fetch(this.url, { method: 'POST', body, headers: { Accept: 'application/json', 'x-csrf-token': csrfToken() } });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? 'Not saved. Reload the page and try again.');
        this.photos.push(json);
        this.drop(u);
      } catch (err) {
        u.error = err instanceof TypeError ? 'No connection.' : err.message; // fetch throws TypeError when offline
      }
    },
    retry(u) {
      u.error = '';
      this.pump();
    },
    drop(u) {
      URL.revokeObjectURL(u.preview);
      this.queue = this.queue.filter((x) => x !== u);
    },
    async remove(p) {
      if (!confirm('Delete this photo?')) return;
      this.message = '';
      const res = await fetch(`${this.url}/${p.id}/delete`, { method: 'POST', headers: { Accept: 'application/json', 'x-csrf-token': csrfToken() } }).catch(() => null);
      const json = await res?.json().catch(() => ({}));
      if (res?.ok) this.photos = this.photos.filter((x) => x.id !== p.id);
      else this.message = json?.error ?? 'The photo wasn’t deleted. Check the connection and try again.';
    },
  }));

  // Quick add customer window: opened from a searchable customer dropdown.
  Alpine.data('quickAddCustomer', () => ({
    name: '', phone: '', category: 'individual', errors: {}, busy: false, matches: [], done: null, modal: null,
    open({ name, done }) {
      Object.assign(this, { name, phone: '', category: 'individual', errors: {}, matches: [], done });
      this.modal ??= window.bootstrap.Modal.getOrCreateInstance(this.$el);
      this.modal.show();
      setTimeout(() => this.$refs.phone?.focus(), 300);
    },
    async checkPhone() {
      if (this.phone.replace(/\D/g, '').length < 9) { this.matches = []; return; }
      this.matches = (await getJson(`/api/customers/check-phone?phone=${encodeURIComponent(this.phone)}`).catch(() => ({ matches: [] }))).matches;
    },
    use(match) { this.finish({ value: match.id, label: `${match.name} (${match.number})` }); },
    async save() {
      this.busy = true;
      try {
        const res = await fetch('/api/customers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': csrfToken() },
          body: JSON.stringify({ name: this.name, phone: this.phone, category: this.category }),
        });
        const body = await res.json();
        if (!res.ok) { this.errors = body.errors ?? { name: 'Could not save. Try again.' }; return; }
        this.finish(body);
      } catch {
        this.errors = { name: 'No connection. Check the network and try again.' };
      } finally {
        this.busy = false;
      }
    },
    finish(option) {
      const done = this.done;
      this.done = null;
      this.modal.hide();
      done?.(option);
    },
    cancelled() { this.done?.(); this.done = null; }, // closing the window without saving
  }));
});

// Copy buttons: <button data-copy="text to copy">
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    const original = btn.innerHTML;
    btn.innerHTML = '<i class="bi bi-check2"></i>Copied';
    setTimeout(() => { btn.innerHTML = original; }, 1500);
  } catch {
    /* clipboard blocked: the text is still on screen to copy by hand */
  }
});

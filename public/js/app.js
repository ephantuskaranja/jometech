// Small behaviours shared by every page.

// Press "/" anywhere (outside a text box) to jump to the global search.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = document.activeElement;
  if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
  e.preventDefault();
  document.getElementById('global-search')?.focus();
});

// A success/info message closes itself when its time bar runs out (CSS: .jt-toast;
// pointing at it or focusing it pauses the bar). Warnings and errors stay until closed.
document.querySelectorAll('.jt-flash[data-autoclose]').forEach((el) => {
  el.addEventListener('animationend', () => bootstrap.Alert.getOrCreateInstance(el).close(), { once: true });
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

// ---------- Numbers with thousands separators while typing ----------
// Any <input data-number> shows 3000 as 3,000 as you type (data-number="decimal" also
// allows two decimals: 12,500.50). The server strips the commas again when it reads the form.

/** "1234567.891" → "1,234,567.89" (decimal) or "1,234,567" (whole numbers). */
function groupDigits(value, decimal) {
  const s = String(value).replace(decimal ? /[^\d.]/g : /\D/g, '');
  const [whole, ...rest] = s.split('.');
  const fraction = decimal && s.includes('.') ? `.${rest.join('').slice(0, 2)}` : '';
  return whole.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',') + fraction;
}

// Capture phase: runs before Alpine's x-model listener, so the model gets the formatted value too.
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || !el.matches('[data-number]')) return;
  const decimal = el.dataset.number === 'decimal';
  const counts = decimal ? /[\d.]/ : /\d/;
  // Keep the cursor after the same digit it was after, though commas come and go.
  const caret = el.selectionStart ?? el.value.length;
  const digitsBefore = [...el.value.slice(0, caret)].filter((c) => counts.test(c)).length;
  const next = groupDigits(el.value, decimal);
  if (next === el.value) return;
  el.value = next;
  let pos = 0;
  for (let seen = 0; pos < next.length && seen < digitsBefore; pos++) if (counts.test(next[pos])) seen++;
  el.setSelectionRange(pos, pos);
}, true);

// Values already in the page (after a form error, or when editing) get their commas too.
// Something that isn't a number (a mistake shown with its error) is left as typed, to be corrected.
document.querySelectorAll('input[data-number]').forEach((el) => {
  if (/^[\d,.\s]+$/.test(el.value)) el.value = groupDigits(el.value, el.dataset.number === 'decimal');
});

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
    // data-tom-create-as="bank" opens it with that type of customer chosen ("Add new bank").
    if (el.dataset.tomCreate) {
      const as = el.dataset.tomCreateAs;
      options.create = (input, done) => {
        window.dispatchEvent(new CustomEvent(`jt:quick-add-${el.dataset.tomCreate}`, { detail: { name: input, done, category: as } }));
      };
      options.createOnBlur = false;
      options.render.option_create = (data, escape) => `<div class="create"><i class="bi bi-plus-lg"></i> Add new ${escape(as ?? el.dataset.tomCreate)} “${escape(data.input)}”</div>`;
    }
    // data-tom-free: a name that isn't in the list can be used as typed ("Use “Eunice”"),
    // sent as "name:Eunice" for the server to keep as plain text.
    if (el.dataset.tomFree) {
      options.create = (input) => ({ value: `name:${input.trim()}`, label: `${input.trim()} (not a saved contact)` });
      options.createOnBlur = true;
      options.render.option_create = (data, escape) => `<div class="create"><i class="bi bi-person-plus"></i> Use “${escape(data.input)}” (not a saved contact)</div>`;
      options.render.no_results = () => '<div class="no-results">Not found. Keep typing the full name to use it.</div>';
    }
    if (url) {
      Object.assign(options, {
        valueField: 'value',
        labelField: 'label',
        searchField: ['label'],
        // data-tom-preload: a short list (e.g. banks) that opens in full on click, before any typing.
        ...('tomPreload' in el.dataset ? { preload: 'focus', shouldLoad: () => true } : { shouldLoad: (query) => query.length >= 2 }),
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
  Alpine.data('checkinForm', ({ mode = 'existing', vehicle = null, issueTag = false, odometer = '', odometerBroken = false, fuel = '', rows = [], freeName = false } = {}) => ({
    mode, vehicle, issueTag, odometer, odometerBroken, fuel, rows, regOdd: false,
    freeName, // "brought in by" is a typed name, not a saved contact: ask for their phone
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

  // Enquiry form (enquiries/views/form.ejs): the customer's vehicles, and "this phone is a customer".
  Alpine.data('enquiryForm', ({ hasCustomer = false, vehicles = [], workType = '' } = {}) => ({
    hasCustomer, vehicles, workType, match: null,
    async customerChanged(id) {
      this.hasCustomer = Boolean(id);
      this.match = null;
      this.vehicles = id ? await getJson(`/api/enquiries/vehicles?customer_id=${id}`).catch(() => []) : [];
    },
    async checkPhone(phone) {
      if (this.hasCustomer || phone.replace(/\D/g, '').length < 9) { this.match = null; return; }
      const { matches } = await getJson(`/api/customers/check-phone?phone=${encodeURIComponent(phone)}`).catch(() => ({ matches: [] }));
      this.match = matches[0] ?? null;
    },
    useMatch() {
      const ts = this.$refs.customer.tomselect;
      ts.addOption({ value: this.match.id, label: `${this.match.name} (${this.match.number})` });
      ts.setValue(this.match.id); // fires change → customerChanged
    },
  }));

  // Proforma form (proformas/views/form.ejs): line rows with a running total (VAT included),
  // the customer's vehicles, and "start from another proforma".
  Alpine.data('proformaForm', ({ rows = [], vehicles = [], hasCustomer = false, vatRate = 16, enquiryId = '' } = {}) => {
    let next = 0;
    const num = (v) => Number(String(v ?? '').replace(/[,\s]/g, '')) || 0;
    // Prices from the server (a copy, a draft) show as 800,000 like typed ones.
    const grouped = (v) => (/^\d+(\.\d+)?$/.test(String(v)) ? num(v).toLocaleString('en-KE', { maximumFractionDigits: 2 }) : v);
    const row = (r = {}) => ({ key: next++, quantity: '1', unit: 'Unit', description: '', ...r, unit_price: grouped(r.unit_price ?? '') });
    return {
      rows: rows.map(row), vehicles, hasCustomer,
      amount: (r) => Math.round(num(r.quantity === '' ? 1 : r.quantity) * num(r.unit_price) * 100) / 100,
      get total() { return Math.round(this.rows.reduce((sum, r) => sum + this.amount(r), 0) * 100) / 100; },
      get vat() { return Math.round((this.total * vatRate / (100 + vatRate)) * 100) / 100; },
      money: (n) => n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      addRow() {
        this.rows.push(row());
        this.$nextTick(() => this.$root.querySelector('.jt-lines-row:last-child textarea')?.focus());
      },
      removeRow(i) {
        this.rows.splice(i, 1);
        if (!this.rows.length) this.rows.push(row());
      },
      async customerChanged(id) {
        this.hasCustomer = Boolean(id);
        this.vehicles = id ? await getJson(`/api/proformas/vehicles?customer_id=${id}`).catch(() => []) : [];
      },
      // Reloads the form with that proforma's lines and notes; keeps the customer and enquiry chosen here.
      copyFrom(el) {
        const id = el.value;
        if (!id) return;
        if (this.rows.some((r) => r.description.trim()) && !window.confirm('Replace the lines you have typed with the copied ones?')) {
          el.tomselect?.clear(true);
          return;
        }
        const params = new URLSearchParams({ copy: id });
        const customer = this.$refs.customer?.value;
        if (customer) params.set('customer_id', customer);
        if (enquiryId) params.set('enquiry', enquiryId);
        window.location.href = `/proformas/new?${params}`;
      },
    };
  });

  // Job form (jobs/views/form.ejs): work rows and the customer's vehicles.
  Alpine.data('jobForm', ({ rows = [], vehicles = [], hasCustomer = false } = {}) => {
    let next = 0;
    const row = (r = {}) => ({ key: next++, quantity: '1', unit: 'Unit', description: '', ...r });
    return {
      rows: rows.map(row), vehicles, hasCustomer,
      addRow() {
        this.rows.push(row());
        this.$nextTick(() => this.$root.querySelector('.jt-lines-row:last-child textarea')?.focus());
      },
      removeRow(i) {
        this.rows.splice(i, 1);
        if (!this.rows.length) this.rows.push(row());
      },
      async customerChanged(id) {
        this.hasCustomer = Boolean(id);
        this.vehicles = id ? await getJson(`/api/jobs/vehicles?customer_id=${id}`).catch(() => []) : [];
      },
    };
  });

  // Job type form (job-types/views/form.ejs): a list of steps to add to, remove from and reorder.
  Alpine.data('jobTypeForm', ({ rows = [] } = {}) => {
    let next = 0;
    const row = (name = '') => ({ key: next++, name });
    return {
      rows: rows.map(row),
      addRow(after) {
        this.rows.splice(after + 1, 0, row());
        this.$nextTick(() => this.$root.querySelectorAll('.jt-step-row input')[after + 1]?.focus());
      },
      removeRow(i) {
        this.rows.splice(i, 1);
        if (!this.rows.length) this.rows.push(row());
      },
      move(i, by) {
        const [item] = this.rows.splice(i, 1);
        this.rows.splice(i + by, 0, item);
      },
    };
  });

  // Item page (items/views/show.ejs): what a plate of any size comes to. The server does the sums.
  Alpine.data('sheetCalc', ({ url }) => ({
    length: '', width: '', unit: 'ft', pieces: '1', result: null, timer: null,
    fixed: (n) => n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    work() {
      clearTimeout(this.timer);
      this.timer = setTimeout(async () => {
        const params = new URLSearchParams({ length: this.length, width: this.width, unit: this.unit, pieces: this.pieces });
        this.result = await getJson(`${url}?${params}`).catch(() => null);
      }, 200);
    },
  }));

  // Purchase order form (purchasing/views/form.ejs): find an item by typing its name; plates ask for a size.
  // The sums here are only for showing; the server works out what is saved.
  Alpine.data('purchaseOrderForm', ({ rows = [], items = [], orderDate = '' } = {}) => {
    let next = 0;
    const num = (v) => Number(String(v ?? '').replace(/[,\s]/g, '')) || 0;
    const row = (r = {}) => ({ key: next++, item_id: '', item_name: '', quantity: '', length: '', width: '', size_unit: 'ft', for: '', price: '', ...r });
    return {
      rows: rows.map(row), items, orderDate,
      itemOf(r) { return this.items.find((i) => String(i.id) === String(r.item_id)) ?? null; },
      isArea(r) { return this.itemOf(r)?.priced_by === 'area'; },
      unitOf(r) { return this.itemOf(r)?.unit ?? ''; },
      lastPrice(r) { return this.itemOf(r)?.current_price ?? null; },
      pick(r) {
        const typed = r.item_name.trim().toLowerCase();
        r.item_id = this.items.find((i) => i.name.toLowerCase() === typed)?.id ?? '';
      },
      area(r) {
        const each = num(r.length) * num(r.width) / (r.size_unit === 'mm' ? 304.8 * 304.8 : 1);
        return each * num(r.quantity);
      },
      amount(r) {
        if (!r.item_id) return 0;
        const billed = this.isArea(r) ? this.area(r) : num(r.quantity);
        return Math.round(billed * num(r.price) * 100) / 100;
      },
      get total() { return this.rows.reduce((sum, r) => sum + this.amount(r), 0); },
      money: (n) => n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      useLast(r) { r.price = String(this.lastPrice(r)); },
      addRow() { this.rows.push(row()); },
      removeRow(i) {
        this.rows.splice(i, 1);
        if (!this.rows.length) this.rows.push(row());
      },
      addItem(r) {
        window.dispatchEvent(new CustomEvent('jt:quick-add-item', { detail: { name: r.item_name.trim(), done: (item) => {
          this.items.push(item);
          r.item_name = item.name;
          r.item_id = item.id;
        } } }));
      },
    };
  });

  // Quick add windows on the purchase order: post the fields, show any errors, hand back what was made.
  const quickAdd = ({ url, fields, focus }) => () => ({
    ...fields(), errors: {}, busy: false, done: null, modal: null,
    open({ name, done }) {
      Object.assign(this, fields(), { name, errors: {}, done });
      this.modal ??= window.bootstrap.Modal.getOrCreateInstance(this.$el);
      this.modal.show();
      setTimeout(() => this.$el.querySelector(focus)?.focus(), 300);
    },
    async save() {
      this.busy = true;
      try {
        const body = Object.fromEntries(Object.keys(fields()).map((k) => [k, this[k]]));
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': csrfToken() },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok) { this.errors = json.errors ?? { name: 'Could not save. Try again.' }; return; }
        const done = this.done;
        this.done = null;
        this.modal.hide();
        done?.(json);
      } catch {
        this.errors = { name: 'No connection. Check the network and try again.' };
      } finally {
        this.busy = false;
      }
    },
    cancelled() {
      // Tom Select waits to be told; the item window has nothing to undo.
      const done = this.done;
      this.done = null;
      if (done && url === '/api/suppliers') done();
    },
  });
  Alpine.data('quickAddSupplier', quickAdd({ url: '/api/suppliers', focus: '#qas-phone', fields: () => ({ name: '', phone: '' }) }));
  Alpine.data('quickAddItem', quickAdd({ url: '/api/items', focus: '#qai-category', fields: () => ({ name: '', category: '', priced_by: 'unit', unit: 'Pc', thickness_mm: '' }) }));

  // Receiving goods (stock/views/receive.ejs): running totals, and transport shared by value.
  // The sums here are only for showing; the server works out what is saved.
  Alpine.data('receiveForm', ({ rows = [], transport = '' } = {}) => {
    const num = (v) => Number(String(v ?? '').replace(/[,\s]/g, '')) || 0;
    return {
      rows, transport,
      stockQty(r) { return num(r.quantity) * (r.area ?? 1); },
      goods(r) { return Math.round(this.stockQty(r) * num(r.price) * 100) / 100; },
      get goodsTotal() { return this.rows.reduce((sum, r) => sum + this.goods(r), 0); },
      get transportNum() { return num(this.transport); },
      share(r) { return this.goodsTotal ? Math.round((this.transportNum * this.goods(r) / this.goodsTotal) * 100) / 100 : 0; },
      money: (n) => n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      clearAll() { this.rows.forEach((r) => { r.quantity = ''; }); },
    };
  });

  // Issuing materials (issues/views/form.ejs): find what is in stock here by typing.
  // The sums here are only for showing; the server works out what is saved.
  // A file upload form (attendance/views/import.ejs): sent with fetch so the CSRF token can go in a header
  // (the server reads the body as a file, after the token is checked). The answer says where to go next.
  Alpine.data('uploadForm', () => ({
    busy: false, error: '',
    async send(form) {
      this.busy = true;
      this.error = '';
      try {
        const token = document.querySelector('meta[name="csrf-token"]')?.content ?? '';
        const res = await fetch(form.action, { method: 'POST', body: new FormData(form), headers: { 'x-csrf-token': token, Accept: 'application/json' } });
        const json = await res.json();
        window.location.href = json.go;
      } catch {
        this.busy = false;
        this.error = 'The file couldn’t be sent. Check the connection and try again.';
      }
    },
  }));

  // A payslip to WhatsApp (payroll/views/show.ejs). On a phone: the share sheet, with the PDF attached.
  // Elsewhere a page can't attach a file to WhatsApp: it saves the PDF and opens the person's chat.
  Alpine.data('shareSlip', ({ url, name, phone = '' }) => ({
    note: '',
    async send() {
      try {
        const blob = await (await fetch(url)).blob();
        const file = new File([blob], name, { type: 'application/pdf' });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: name });
          return;
        }
      } catch (err) {
        if (err.name === 'AbortError') return; // they closed the share sheet
      }
      window.location.href = url;
      const digits = phone.replace(/\D/g, '');
      if (digits) window.open(`https://wa.me/${digits}`, '_blank', 'noopener');
      this.note = 'PDF saved: attach it in WhatsApp';
    },
  }));

  Alpine.data('issueForm', ({ rows = [], stock = [] } = {}) => {
    let next = 0;
    const num = (v) => Number(String(v ?? '').replace(/[,\s]/g, '')) || 0;
    const row = (r = {}) => ({ key: next++, balance_id: '', label: '', quantity: '', open: false, active: 0, ...r });
    return {
      rows: rows.map(row), stock,
      stockOf(r) { return this.stock.find((s) => String(s.id) === String(r.balance_id)) ?? null; },
      pick(r) {
        const typed = r.label.trim().toLowerCase();
        r.balance_id = this.stock.find((s) => s.label.toLowerCase() === typed)?.id ?? '';
      },
      // The search list under each item box: every typed word somewhere in the name ("4 plate" finds "Plate 4 mm, 8 × 4 ft").
      matches(r) {
        const words = r.label.toLowerCase().split(/\s+/).filter(Boolean);
        return this.stock.filter((s) => words.every((w) => s.label.toLowerCase().includes(w))).slice(0, 30);
      },
      choose(r, s) {
        r.label = s.label;
        r.balance_id = s.id;
        r.open = false;
      },
      move(r, step) {
        const n = this.matches(r).length;
        if (!n) return;
        if (!r.open) { r.open = true; return; }
        r.active = (r.active + step + n) % n;
      },
      enter(r, e) {
        const list = this.matches(r);
        if (!r.open || !list.length) return;
        e.preventDefault(); // choose, don't submit the form
        this.choose(r, list[r.active] ?? list[0]);
      },
      tooMany(r) { const s = this.stockOf(r); return Boolean(s) && num(r.quantity) > s.available; },
      cost(r) {
        const s = this.stockOf(r);
        return s ? Math.round(num(r.quantity) * (s.area ?? 1) * s.avg_cost * 100) / 100 : 0;
      },
      get total() { return this.rows.reduce((sum, r) => sum + this.cost(r), 0); },
      money: (n) => n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      addRow() { this.rows.push(row()); },
      removeRow(i) {
        this.rows.splice(i, 1);
        if (!this.rows.length) this.rows.push(row());
      },
    };
  });

  // A masked personal detail (partials/masked.ejs): Show asks the server for it (which records
  // the look in the history), and it hides itself again after 20 seconds.
  Alpine.data('hiddenDetail', (url) => ({
    shown: null, timer: null,
    async toggle() {
      if (this.shown) return this.hide();
      const res = await fetch(url, { method: 'POST', headers: { Accept: 'application/json', 'x-csrf-token': csrfToken() } }).catch(() => null);
      if (!res?.ok) return;
      this.shown = (await res.json()).value;
      this.timer = setTimeout(() => this.hide(), 20_000);
    },
    hide() { clearTimeout(this.timer); this.shown = null; },
  }));

  // Visitor sign-in (visitors/views/form.ejs): a known phone number fills in the rest.
  Alpine.data('visitorForm', ({ purpose = '' } = {}) => ({
    purpose, returning: '',
    async lookup(phone) {
      if (phone.replace(/\D/g, '').length < 9) return;
      const last = await getJson(`/api/visitors/last?phone=${encodeURIComponent(phone)}`).catch(() => null);
      if (!last) { this.returning = ''; return; }
      // Fill only empty boxes: never overwrite what the guard already typed.
      for (const key of ['name', 'company', 'vehicle_reg']) {
        const el = this.$refs[key];
        if (el && !el.value && last[key]) el.value = last[key];
      }
      // The ID number itself never comes back (privacy): left blank, the one on file is kept.
      const id = this.$refs.id_no;
      if (id) id.placeholder = last.id_end ? `On file: ****${last.id_end}. Leave blank to keep it` : '';
      // Who they saw last time, if still on the staff list and the guard hasn't changed it from "Reception".
      const host = this.$refs.host?.tomselect;
      if (host && last.host && host.getValue() === 'Reception' && host.options[last.host]) host.setValue(last.host, true);
      if (!this.purpose && last.purpose) this.purpose = last.purpose;
      const when = new Date(last.arrived_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      this.returning = `Welcome back: ${last.name} last visited on ${when}. Check the details are still right.`;
    },
    tidyReg(el) { el.value = formatReg(el.value); },
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
    open({ name, done, category }) {
      Object.assign(this, { name, phone: '', category: category ?? 'individual', errors: {}, matches: [], done });
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

  // Recording a payment (invoices/views/payments.ejs): more than is still owed asks first,
  // showing how much becomes the customer's credit, and needs a reason. due = { owed, against } or null.
  Alpine.data('paymentExcess', (due) => ({
    due, confirming: false, excess: 0,
    money: (n) => Number(n ?? 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    check(event) {
      if (!this.due) return;
      const amount = Number(String(this.$refs.amount.value).replace(/,/g, ''));
      this.excess = Math.round((amount - this.due.owed) * 100) / 100;
      if (!(this.excess > 0)) { this.confirming = false; return; }
      if (!this.confirming || !this.$refs.reason.value.trim()) {
        event.preventDefault();
        this.confirming = true;
        this.$nextTick(() => this.$refs.reason.focus());
      }
    },
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

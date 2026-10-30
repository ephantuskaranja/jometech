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

// Searchable dropdowns: any <select data-tom-select> becomes a Tom Select.
// With data-tom-url="/api/…" it asks the server as you type; the endpoint
// answers ?q=… with JSON: [{ "value": "12", "label": "Mwangi Transporters" }, …]
function initSearchableSelects(root = document) {
  if (!window.TomSelect) return;
  root.querySelectorAll('select[data-tom-select]:not(.tomselected)').forEach((el) => {
    const url = el.dataset.tomUrl;
    const options = {
      maxOptions: 50,
      placeholder: el.dataset.placeholder,
      allowEmptyOption: true,
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

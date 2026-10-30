// Small behaviours shared by every page.

// Press "/" anywhere (outside a text box) to jump to the global search.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = document.activeElement;
  if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
  e.preventDefault();
  document.getElementById('global-search')?.focus();
});

// Search results arrive with the customers & vehicles module; until then the
// form stays on the page instead of loading a "not found" page.
document.getElementById('global-search-form')?.addEventListener('submit', (e) => e.preventDefault());

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

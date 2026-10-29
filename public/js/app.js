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

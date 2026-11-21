// Printable documents (job card, invoice, proforma, receiving and release notes, orders):
// the "Print or save as PDF" button.
document.querySelector('[data-print]')?.addEventListener('click', () => window.print());

// Empty lines (rows kept for writing in by hand) are left off the page unless asked for, so a
// printout has only what is filled in. The choice is remembered on this device.
(() => {
  const pads = document.querySelectorAll('.jt-pad-row');
  if (!pads.length) return;
  const KEY = 'jt-print-blank-rows';
  let keep = false;
  try { keep = localStorage.getItem(KEY) === '1'; } catch { /* storage blocked: leave them off */ }
  const apply = () => document.body.classList.toggle('keep-blank', keep);
  const label = document.createElement('label');
  label.className = 'blank-toggle';
  label.innerHTML = '<input type="checkbox"> Blank lines to write in by hand';
  const box = label.querySelector('input');
  box.checked = keep;
  box.addEventListener('change', () => {
    keep = box.checked;
    try { localStorage.setItem(KEY, keep ? '1' : '0'); } catch { /* ignore */ }
    apply();
  });
  document.querySelector('[data-print]')?.before(label);
  apply();
})();

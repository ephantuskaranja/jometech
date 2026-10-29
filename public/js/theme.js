// Light / dark / match-device theme switch.
//
// Loaded in <head> as a normal (blocking) script so the theme is set before
// the page is drawn; that's what stops a white flash in dark mode.
// Bootstrap 5.3 does the rest: every component reads data-bs-theme on <html>.
//
// The choice is kept in this browser for now. Once login exists it will also
// be saved to the user's account so it follows them to other devices.
(() => {
  const KEY = 'jt-theme';
  const ICONS = { light: 'bi-sun', dark: 'bi-moon-stars', system: 'bi-circle-half' };
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  const read = () => {
    try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; }
  };
  const save = (mode) => {
    try { localStorage.setItem(KEY, mode); } catch { /* private mode: still works for this page */ }
  };
  const resolve = (mode) => (mode === 'system' ? (media.matches ? 'dark' : 'light') : mode);

  const apply = (mode) => {
    document.documentElement.setAttribute('data-bs-theme', resolve(mode));
  };

  // Tick the chosen option in the menu and show its icon on the button.
  const showChoice = (mode) => {
    document.querySelectorAll('[data-theme-value]').forEach((el) => {
      const on = el.dataset.themeValue === mode;
      el.classList.toggle('active', on);
      el.setAttribute('aria-pressed', String(on));
    });
    document.querySelectorAll('[data-theme-icon]').forEach((el) => {
      el.className = `bi ${ICONS[mode]}`;
    });
  };

  apply(read());

  // Follow the device when it switches (e.g. at sunset) if "Match device" is chosen.
  media.addEventListener('change', () => {
    if (read() === 'system') apply('system');
  });

  document.addEventListener('DOMContentLoaded', () => showChoice(read()));

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-value]');
    if (!btn) return;
    const mode = btn.dataset.themeValue;
    save(mode);
    apply(mode);
    showChoice(mode);
  });
})();

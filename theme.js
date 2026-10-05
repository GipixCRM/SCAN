// Общая тема для панели, таблицы и страницы инструкции.
(() => {
  const STORAGE_KEY = 'uiTheme';
  const DARK = 'dark';
  const LIGHT = 'light';
  const root = document.documentElement;

  const normalize = value => value === LIGHT ? LIGHT : DARK;
  const storage = () => globalThis.chrome?.storage?.local ?? null;

  function updateControls(theme) {
    const isLight = theme === LIGHT;
    const action = isLight ? 'Включить тёмную тему' : 'Включить белую тему';
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      button.setAttribute('aria-pressed', String(isLight));
      button.setAttribute('aria-label', action);
      button.title = action;
      const icon = button.querySelector('[data-theme-icon]');
      if (icon) icon.textContent = isLight ? '☾' : '☼';
      const label = button.querySelector('[data-theme-label]');
      if (label) label.textContent = action;
    });
  }

  function apply(theme) {
    const value = normalize(theme);
    root.dataset.theme = value;
    root.style.colorScheme = value;
    updateControls(value);
    return value;
  }

  async function read() {
    const area = storage();
    if (!area) return DARK;
    try {
      const stored = await area.get(STORAGE_KEY);
      return normalize(stored?.[STORAGE_KEY]);
    } catch {
      return DARK;
    }
  }

  async function set(theme) {
    const value = apply(theme);
    const area = storage();
    if (!area) return;
    try { await area.set({ [STORAGE_KEY]: value }); } catch { /* страница может быть открыта вне расширения */ }
  }

  function init() {
    apply(root.dataset.theme || DARK);
    read().then(apply);
    document.addEventListener('click', event => {
      const button = event.target.closest?.('[data-theme-toggle]');
      if (!button) return;
      set(root.dataset.theme === LIGHT ? DARK : LIGHT);
    });
    globalThis.chrome?.storage?.onChanged?.addListener(changes => {
      const next = changes?.[STORAGE_KEY]?.newValue;
      if (next === LIGHT || next === DARK) apply(next);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();

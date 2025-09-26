// --- Dark mode toggle ---
const themeToggle = document.getElementById('themeToggle');
if (themeToggle) {
  const savedTheme = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
  themeToggle.checked = savedTheme === 'dark';

  themeToggle.addEventListener('change', () => {
    const theme = themeToggle.checked ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  });
}

// --- Language switcher ---
const langSelect = document.getElementById('langSelect');
if (langSelect) {
  fetch('/api/languages')
    .then(res => res.json())
    .then(langs => {
      // fallback if no posts yet
      if (!langs.length) langs = ['en'];

      const allLangs = {
        en: 'English',
        hi: 'Hindi',
        te: 'Telugu',
        ml: 'Malayalam',
        ta: 'Tamil',
        kn: 'Kannada',
        bn: 'Bangla',
        gu: 'Gujarati',
        mr: 'Marathi'
      };

      // clear existing options
      langSelect.innerHTML = '';

      langs.forEach(code => {
        if (allLangs[code]) {
          const opt = document.createElement('option');
          opt.value = code;
          opt.textContent = allLangs[code];
          langSelect.appendChild(opt);
        }
      });

      // pick saved lang if still available, otherwise default to first
      const savedLang = localStorage.getItem('lang') || 'en';
      langSelect.value = langs.includes(savedLang) ? savedLang : langs[0];

      const applyLang = (lang) => {
        const dict = (window.I18N && window.I18N[lang]) || window.I18N.en;
        document.querySelectorAll('[data-i18n]').forEach(el => {
          const key = el.getAttribute('data-i18n');
          const txt = key.split('.').reduce((o,k)=>o && o[k], dict);
          if (typeof txt === 'string') el.textContent = txt;
        });
      };

      applyLang(langSelect.value);

      langSelect.addEventListener('change', () => {
        localStorage.setItem('lang', langSelect.value);
        applyLang(langSelect.value);

        // 🔄 reload feed for this language
        if (typeof window.loadFeed === 'function') {
          document.getElementById('feed').innerHTML = '';
          window.loadFeed(langSelect.value);
        }
      });
    });
}

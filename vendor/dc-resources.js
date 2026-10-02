/* Arahkan runtime dc (support.js) ke salinan React lokal, bukan unpkg.com.
   File diambil dari node_modules dan identik byte-per-byte dengan versi CDN
   (hash cocok dengan SRI di support.js). Harus dimuat SEBELUM support.js. */
window.__resources = {
  "https://unpkg.com/react@18.3.1/umd/react.production.min.js": "/vendor/react.production.min.js",
  "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js": "/vendor/react-dom.production.min.js"
};

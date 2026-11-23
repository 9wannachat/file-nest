// Applies the saved Light/Dark/System choice before first paint (no flash).
// Loaded as a same-origin classic script because the CSP forbids inline scripts.
// Keep in sync with src/web/theme.tsx.
(function () {
  var t = "system";
  try {
    t = localStorage.getItem("filenest-theme") || "system";
  } catch (e) {}
  var dark = t === "dark" || (t !== "light" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  var root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
})();

/**
 * Offline desktop feature gate (logged-out, wide viewport).
 */
(function (global) {
  "use strict";

  const DESKTOP_QUERY = "(min-width: 1181px)";
  let deps = null;

  function isDesktopWebsite() {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia(DESKTOP_QUERY).matches &&
      !document.documentElement.classList.contains("mobile-gate")
    );
  }

  function isFeatureAllowed() {
    if (!deps || (typeof deps.isLoggedIn === "function" && deps.isLoggedIn())) {
      return false;
    }
    return isDesktopWebsite();
  }

  function refreshVisibility() {
    if (typeof deps.onVisibilityChange === "function") {
      deps.onVisibilityChange(isFeatureAllowed());
    }
  }

  function init(options) {
    deps = options || {};
    refreshVisibility();
    if (typeof window.matchMedia === "function") {
      const mq = window.matchMedia(DESKTOP_QUERY);
      const onChange = function () {
        refreshVisibility();
      };
      if (typeof mq.addEventListener === "function") {
        mq.addEventListener("change", onChange);
      } else if (typeof mq.addListener === "function") {
        mq.addListener(onChange);
      }
    }
  }

  global.UndertwigLocalDesktop = {
    init: init,
    refreshVisibility: refreshVisibility,
    isFeatureAllowed: isFeatureAllowed,
    isDesktopWebsite: isDesktopWebsite,
  };
})(window);

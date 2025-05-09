"use strict";

// The original monolith also uses `const { parse } = require("cookie");` directly in some handlers.
// That direct usage will remain in those handlers. This `parseCookies` is a helper used by `refreshToken`.

function parseCookies(cookieHeader = "") {
    const cookies = {};
    if (!cookieHeader) {
      return cookies;
    }
    cookieHeader.split(';').forEach(cookie => {
      let parts = cookie.match(/(.*?)=(.*)$/)
      if(parts) {
          let key = parts[1].trim();
          let value = decodeURIComponent(parts[2].trim());
          cookies[key] = value;
      }
    });
    return cookies;
  }

  function buildRefreshTokenCookie(token, rememberMe = true) {
    const baseCookie = `refreshToken=${token}; HttpOnly; Secure; Path=/; SameSite=None; Domain=.justtodothings.com`;

    if (rememberMe) {
        // Persistent cookie for 30 days
        const maxAge = 60 * 60 * 24 * 30;
        return `${baseCookie}; Max-Age=${maxAge}`;
    } else {
        // Session cookie (no Max-Age or Expires)
        return baseCookie;
    }
}

module.exports = {
    parseCookies,
    buildRefreshTokenCookie
};
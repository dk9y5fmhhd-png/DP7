'use strict';

// One way to report a failed request. A form sent from the browser goes back to
// the page it came from and shows a toast. Anything else (a visited address, a
// script call) gets the error page with its status code.

function backTo(req) {
  try {
    const from = new URL(req.get('referer'));
    if (from.host !== req.get('host')) return '/';
    // Upload results are drawn on the POST address, which cannot be visited.
    return from.pathname.replace(/^\/upload\/(customers|deposits)\/?$/, '/upload') + from.search;
  } catch {
    return req.session?.user ? '/' : '/login';
  }
}

const isFormPost = (req) => !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
  && String(req.get('accept') || '').includes('text/html');

function fail(req, res, status, { title, heading, message, ...rest }) {
  if (isFormPost(req) && req.session) {
    req.session.flash = { type: 'error', message };
    return res.redirect(303, backTo(req));
  }
  return res.status(status).render('error', { title, heading, message, ...rest });
}

module.exports = { fail, backTo };

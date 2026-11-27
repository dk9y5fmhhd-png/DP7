// Calling and WhatsApp happen in a pop-up, so the caller never leaves the list.
(function () {
  var text = function (name) { return document.body.dataset[name] || ''; };

  function open(className) {
    var dlg = document.createElement('dialog');
    dlg.className = 'form-dialog ' + (className || '');
    dlg.addEventListener('close', function () { dlg.remove(); });
    document.body.appendChild(dlg);
    return dlg;
  }

  // Sends a form and shows the answer as a toast. Resolves true on success.
  function submit(url, fields) {
    return fetch(url, { method: 'POST', headers: { accept: 'application/json' }, body: new URLSearchParams(fields) })
      .then(function (r) { return r.json(); })
      .then(function (r) { UI.toast(r.message, r.ok ? 'success' : 'error'); return r.ok; })
      .catch(function () { UI.toast(text('tStale'), 'error'); return false; });
  }

  function busy(button, label) {
    var before = button.innerHTML;
    button.disabled = true;
    button.textContent = label;
    return function () { button.disabled = false; button.innerHTML = before; };
  }

  function el(tag, className, content) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (content) node.textContent = content;
    return node;
  }

  function callBox(button) {
    var form = button.closest('form');
    var username = button.getAttribute('data-dial');
    var dlg = open('call-dialog');
    var head = el('div', 'dialog-head');
    head.appendChild(el('h3', '', text('tCallTitle').replace('{username}', username)));
    var x = el('button', 'close-x', '×');
    x.type = 'button';
    x.setAttribute('data-close', '');
    x.setAttribute('aria-label', text('tClose'));
    head.appendChild(x);
    var body = el('div', 'dialog-body');
    var tile = el('div', 'dial-tile');
    var mark = el('span', 'dial-mark');
    mark.innerHTML = button.innerHTML;
    mark.querySelectorAll('span').forEach(function (s) { s.remove(); });
    Array.prototype.slice.call(mark.childNodes).forEach(function (n) { if (n.nodeType === 3) n.remove(); });
    var info = el('div');
    info.appendChild(el('strong', '', 'TeleCMI'));
    info.appendChild(el('div', 'muted tiny', button.getAttribute('data-mobile')));
    info.appendChild(el('div', 'muted tiny', text('tCallHint')));
    tile.appendChild(mark); tile.appendChild(info);
    body.appendChild(tile);
    var foot = el('div', 'dialog-foot');
    var no = el('button', 'btn btn-ghost', text('tCancel'));
    no.type = 'button';
    no.setAttribute('data-close', '');
    var yes = el('button', 'btn btn-primary', text('tCallNow'));
    yes.type = 'button';
    foot.appendChild(no); foot.appendChild(yes);
    dlg.appendChild(head); dlg.appendChild(body); dlg.appendChild(foot);
    yes.addEventListener('click', function () {
      var restore = busy(yes, text('tCalling'));
      submit(form.action, { csrf_token: form.elements.csrf_token.value, username: username }).then(function (ok) {
        if (ok) dlg.close(); else restore();
      });
    });
    dlg.showModal();
    yes.focus();
  }

  function whatsappBox(link) {
    fetch(link.getAttribute('href') + '/dialog')
      .then(function (r) { if (!r.ok) throw new Error(); return r.text(); })
      .then(function (html) {
        var dlg = open('wa-dialog');
        dlg.innerHTML = html; // our own server's page fragment
        dlg.querySelectorAll('.wa-send').forEach(WA.sender);
        dlg.querySelectorAll('.wa-send, .wa-reply').forEach(function (form) {
          form.addEventListener('submit', function (e) {
            e.preventDefault();
            var restore = busy(form.querySelector('[type=submit]'), form.querySelector('[type=submit]').dataset.busy);
            submit(form.getAttribute('action'), new FormData(form)).then(function (ok) {
              if (ok) dlg.close(); else restore();
            });
          });
        });
        dlg.showModal();
        var thread = dlg.querySelector('.thread');
        if (thread) thread.scrollTop = thread.scrollHeight;
      })
      .catch(function () { UI.toast(text('tStale'), 'error'); });
  }

  document.addEventListener('click', function (e) {
    var dial = e.target.closest('[data-dial]');
    if (dial) { e.preventDefault(); callBox(dial); return; }
    var wa = e.target.closest('[data-wa]');
    if (wa && !(e.metaKey || e.ctrlKey || e.shiftKey)) { e.preventDefault(); whatsappBox(wa); }
  });
})();

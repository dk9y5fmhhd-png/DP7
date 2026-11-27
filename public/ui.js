// One style for every message and question: toasts and a confirm dialog.
(function () {
  var text = function (name, fallback) { return document.body.dataset[name] || fallback; };
  var LIFE = { success: 4500, info: 6000, error: 10000 };

  function toast(message, type) {
    type = LIFE[type] ? type : 'info';
    var box = document.getElementById('toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toasts';
      box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    var item = document.createElement('div');
    item.className = 'toast toast-' + type;
    item.setAttribute('role', type === 'error' ? 'alert' : 'status');
    var mark = document.createElement('span');
    mark.className = 'toast-mark';
    mark.textContent = type === 'success' ? '\u2713' : type === 'error' ? '!' : 'i';
    var line = document.createElement('span');
    line.className = 'toast-text';
    line.textContent = message;
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', text('tClose', 'Close'));
    close.textContent = '\u00d7';
    item.appendChild(mark); item.appendChild(line); item.appendChild(close);
    box.appendChild(item);

    var timer;
    var remove = function () { item.remove(); };
    var start = function () { timer = setTimeout(remove, LIFE[type]); };
    close.addEventListener('click', remove);
    // Stays while it is being read.
    item.addEventListener('mouseenter', function () { clearTimeout(timer); });
    item.addEventListener('mouseleave', start);
    start();
  }

  // Resolves true only when the confirm button is pressed.
  function confirmBox(message, danger) {
    return new Promise(function (resolve) {
      var dlg = document.createElement('dialog');
      dlg.className = 'ui-confirm';
      var head = document.createElement('div');
      head.className = 'dialog-head';
      var title = document.createElement('h3');
      title.textContent = text('tConfirmTitle', 'Please confirm');
      head.appendChild(title);
      var body = document.createElement('div');
      body.className = 'dialog-body';
      body.textContent = message;
      var foot = document.createElement('div');
      foot.className = 'dialog-foot';
      var no = document.createElement('button');
      no.type = 'button';
      no.className = 'btn btn-ghost';
      no.textContent = text('tCancel', 'Cancel');
      var yes = document.createElement('button');
      yes.type = 'button';
      yes.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
      yes.textContent = text('tConfirm', 'Confirm');
      foot.appendChild(no); foot.appendChild(yes);
      dlg.appendChild(head); dlg.appendChild(body); dlg.appendChild(foot);
      document.body.appendChild(dlg);
      var answer = false;
      no.addEventListener('click', function () { dlg.close(); });
      yes.addEventListener('click', function () { answer = true; dlg.close(); });
      dlg.addEventListener('close', function () { dlg.remove(); resolve(answer); });
      dlg.showModal();
      (danger ? no : yes).focus();
    });
  }

  window.UI = { toast: toast, confirm: confirmBox };

  // data-open="dialogId" opens a form dialog; data-close shuts the one it is in.
  document.addEventListener('click', function (e) {
    var open = e.target.closest('[data-open]');
    if (open) { var dlg = document.getElementById(open.getAttribute('data-open')); if (dlg) dlg.showModal(); return; }
    var close = e.target.closest('[data-close]');
    if (close) close.closest('dialog').close();
  });

  // Any button with data-confirm asks first, then does what it normally does.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-confirm]');
    if (!btn) return;
    if (btn.dataset.confirmed) { delete btn.dataset.confirmed; return; }
    e.preventDefault();
    e.stopPropagation();
    var danger = btn.classList.contains('btn-danger');
    confirmBox(btn.getAttribute('data-confirm'), danger).then(function (ok) {
      if (!ok) return;
      btn.dataset.confirmed = '1';
      btn.click();
    });
  }, true);

  // Server messages arrive in the page and are shown as toasts.
  document.querySelectorAll('.flash[data-toast]').forEach(function (flash) {
    var type = flash.classList.contains('flash-success') ? 'success' : flash.classList.contains('flash-error') ? 'error' : 'info';
    toast(flash.textContent.trim(), type);
    flash.remove();
  });
})();

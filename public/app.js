// DP7 — tiny progressive-enhancement helpers (no framework, no CDN)

function openFollowup(username) {
  var dlg = document.getElementById('followupDialog');
  if (!dlg) return;
  document.getElementById('fu_username').value = username;
  document.getElementById('fu_who').textContent = username;
  var action = document.getElementById('fu_action');
  if (action) action.value = '';
  dlg.showModal();
}

// "All" checkbox → ticks/unticks the rest of the group
document.addEventListener('change', function (e) {
  var el = e.target;
  if (el.matches('[data-check-all]')) {
    var scope = el.closest('[data-check-scope]') || document;
    scope.querySelectorAll('input[type="checkbox"][data-checkable]').forEach(function (cb) {
      cb.checked = el.checked;
    });
  }
});

// Level band rows: add / remove
function addLevelRow() {
  var body = document.getElementById('levelRows');
  if (!body) return;
  var tr = document.createElement('tr');
  tr.innerHTML =
    '<td><input type="hidden" name="level_id" value=""><input type="text" name="level_name" maxlength="40" placeholder="Level name" style="width:100%"></td>' +
    '<td><input type="number" name="level_min" min="0" step="1" placeholder="0" style="width:100%"></td>' +
    '<td><input type="number" name="level_max" min="0" step="1" placeholder="blank = and above" style="width:100%"></td>' +
    '<td class="right"><button type="button" class="btn btn-danger btn-sm" onclick="this.closest(\'tr\').remove()">Remove</button></td>';
  body.appendChild(tr);
}

// Destructive confirmations
document.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-confirm]');
  if (!btn) return;
  if (!window.confirm(btn.getAttribute('data-confirm'))) {
    e.preventDefault();
    e.stopPropagation();
  }
});

// Print button
document.addEventListener('click', function (e) {
  if (e.target.closest('[data-print]')) {
    e.preventDefault();
    window.print();
  }
});

// Auto-submit filters on change (selects only, never date inputs mid-typing)
document.addEventListener('change', function (e) {
  var el = e.target;
  if (el.matches('select[data-autosubmit]') && el.form) el.form.submit();
});

// Copy to clipboard (report links / usernames)
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-copy]');
  if (!el) return;
  e.preventDefault();
  var text = el.getAttribute('data-copy');
  if (navigator.clipboard) navigator.clipboard.writeText(text);
});


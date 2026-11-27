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

/* ---------------------- Excel / CSV drop zone ---------------------- */

function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function showPickedFile(dz, file) {
  if (!dz || !file) return;
  var title = dz.querySelector('.dz-title');
  var sub = dz.querySelector('.dz-sub');
  if (title) title.textContent = file.name;
  if (sub) sub.textContent = humanSize(file.size) + ' · press the button below to save';
  dz.classList.add('has-file');
}

document.addEventListener('change', function (e) {
  var input = e.target;
  if (input.type !== 'file') return;
  var dz = input.closest('.dropzone');
  if (dz && input.files && input.files[0]) showPickedFile(dz, input.files[0]);
});

// drag & drop (file input ke upar opacity 0 hai, lekin drop bhi kaam kare)
document.addEventListener('dragover', function (e) {
  var dz = e.target.closest && e.target.closest('.dropzone');
  if (!dz) return;
  e.preventDefault();
  dz.classList.add('dragover');
});
document.addEventListener('dragleave', function (e) {
  var dz = e.target.closest && e.target.closest('.dropzone');
  if (!dz) return;
  dz.classList.remove('dragover');
});
document.addEventListener('drop', function (e) {
  var dz = e.target.closest && e.target.closest('.dropzone');
  if (!dz) return;
  e.preventDefault();
  dz.classList.remove('dragover');
  var input = dz.querySelector('input[type="file"]');
  if (!input || !e.dataTransfer || !e.dataTransfer.files.length) return;
  input.files = e.dataTransfer.files;
  showPickedFile(dz, e.dataTransfer.files[0]);
});

// file chuni bina submit karne par batao
document.addEventListener('submit', function (e) {
  var form = e.target;
  if (form.id !== 'uploadForm') return;
  var input = form.querySelector('input[type="file"]');
  if (input && input.required && (!input.files || !input.files.length)) {
    e.preventDefault();
    alert('Pehle Excel ya CSV file chunein.');
    return;
  }
  var btn = form.querySelector('button[type="submit"]:focus');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Uploading…';
  }
});



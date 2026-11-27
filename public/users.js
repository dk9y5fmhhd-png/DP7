// Users page: shows which TeleCMI account an agent ID calls with, and tests a login.
(function () {
  var data = JSON.parse(document.getElementById('telecmiDirectory').textContent);

  function describe(box) {
    var input = box.querySelector('[name=telecmi_agent_id]');
    var line = box.querySelector('.telecmi-account');
    var id = input.value.replace(/\s/g, '');
    var appId = (id.match(/_(\d+)$/) || [])[1];
    var parts = [];
    var bad = false;
    if (id) {
      var account = data.accounts.filter(function (a) { return appId ? a.app_id === appId : a.is_active; })[0];
      // App IDs are long: anything shorter is still being typed.
      if (appId && appId.length >= 6 && !account) { parts.push(data.text.noApp.replace('{id}', appId)); bad = true; }
      if (account && !account.is_active) { parts.push(data.text.off.replace('{name}', account.label)); bad = true; }
      if (account && account.is_active) parts.push(data.text.uses.replace('{name}', account.label));
      var shared = data.users.filter(function (u) { return u.agent === id && String(u.id) !== box.dataset.user; });
      if (shared.length) parts.push(data.text.shared.replace('{names}', shared.map(function (u) { return u.name; }).join(', ')));
    }
    line.textContent = parts.join(' · ');
    line.style.color = bad ? 'var(--danger)' : '';
  }

  document.querySelectorAll('.telecmi-fields').forEach(function (box) {
    var input = box.querySelector('[name=telecmi_agent_id]');
    input.addEventListener('input', function () { input.value = input.value.replace(/\s/g, ''); describe(box); });
    describe(box);

    box.querySelector('.telecmi-test').addEventListener('click', function () {
      var out = box.querySelector('.telecmi-result');
      out.textContent = data.text.testing;
      out.style.color = '';
      var body = new URLSearchParams({
        csrf_token: box.closest('form').querySelector('[name=csrf_token]').value,
        user_id: box.dataset.user,
        telecmi_agent_id: input.value,
        telecmi_password: box.querySelector('[name=telecmi_password]').value
      });
      fetch('/users/telecmi-test', { method: 'POST', body: body })
        .then(function (r) { return r.json(); })
        .then(function (r) { out.textContent = ''; UI.toast(r.message, r.ok ? 'success' : 'error'); })
        .catch(function () { out.textContent = ''; UI.toast(data.text.failed, 'error'); });
    });
  });
})();

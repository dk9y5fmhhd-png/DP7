// WhatsApp templates: the editor, and the fields and live preview when sending.
(function () {
  // Text built from text nodes (never HTML). `value(n)` gives what to show for {n}.
  function show(box, body, value) {
    box.textContent = '';
    body.split(/(\{[1-9]\})/).forEach(function (part) {
      var m = /^\{([1-9])\}$/.exec(part);
      if (m) {
        var shown = value ? value(Number(m[1])) : '';
        if (shown) box.appendChild(document.createTextNode(shown));
        else {
          var mark = document.createElement('mark');
          mark.textContent = value ? box.dataset.blank + ' ' + m[1] : part;
          box.appendChild(mark);
        }
      } else if (part) box.appendChild(document.createTextNode(part));
    });
  }

  function editor(form) {
    var area = form.querySelector('textarea[name=body]');
    var count = form.querySelector('.tpl-count');
    var preview = form.querySelector('.tpl-preview');
    function draw() { count.textContent = area.value.length + ' / ' + area.maxLength; show(preview, area.value); }
    area.addEventListener('input', draw);
    // Until the writer has clicked into the text, a new value goes at the end.
    var touched = false;
    area.addEventListener('focus', function () { touched = true; });
    form.querySelector('.tpl-insert').addEventListener('click', function () {
      var used = (area.value.match(/\{[1-9]\}/g) || []).map(function (v) { return Number(v[1]); });
      var value = '{' + Math.min(9, Math.max.apply(null, [0].concat(used)) + 1) + '}';
      if (touched) area.setRangeText(value, area.selectionStart, area.selectionEnd, 'end');
      else area.value += (area.value && !/\s$/.test(area.value) ? ' ' : '') + value;
      area.focus();
      draw();
    });
    draw();
  }

  // One input per value in the chosen template; the preview fills in as you type.
  function sender(form) {
    var select = form.querySelector('select[name=template_id]');
    var box = form.querySelector('.wa-values');
    var preview = form.querySelector('.wa-preview');
    preview.dataset.blank = box.dataset.label;
    var body = '';
    var inputs = {};
    function paint() { show(preview, body, function (n) { return inputs[n] ? inputs[n].value.trim() : ''; }); }
    function build() {
      body = select.options[select.selectedIndex].dataset.body;
      var used = (body.match(/\{[1-9]\}/g) || []).map(function (v) { return Number(v[1]); });
      var max = Math.max.apply(null, [0].concat(used));
      box.textContent = '';
      inputs = {};
      for (var i = 1; i <= max; i++) {
        var group = document.createElement('div');
        group.className = 'form-group';
        var input = document.createElement('input');
        input.type = 'text';
        input.name = 'value';
        input.maxLength = 200;
        input.autocomplete = 'off';
        // Values keep their position; a number the template skips stays hidden.
        if (used.indexOf(i) === -1) { input.type = 'hidden'; group.hidden = true; }
        else {
          input.required = true;
          var label = document.createElement('label');
          label.textContent = box.dataset.label + ' ' + i;
          group.appendChild(label);
        }
        group.appendChild(input);
        box.appendChild(group);
        inputs[i] = input;
        input.addEventListener('input', paint);
      }
      paint();
    }
    select.addEventListener('change', build);
    build();
  }

  window.WA = { sender: sender };
  document.querySelectorAll('.tpl-form').forEach(editor);
  document.querySelectorAll('.wa-send').forEach(sender);
  document.querySelectorAll('[data-template-preview]').forEach(function (box) { show(box, box.textContent); });
})();

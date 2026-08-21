/*
 * Drag to reorder, as a progressive enhancement.
 *
 * The up and down buttons in the markup are the accessible baseline: they are
 * real form posts, they work with JavaScript disabled, and they are keyboard
 * operable. SortableJS still has no keyboard or ARIA support, which is why
 * this is hand rolled and why the buttons are not optional.
 *
 * The endpoint takes the whole ordered list rather than a delta, so the request
 * is idempotent and safe to retry.
 */
(function () {
  'use strict';

  var table = document.getElementById('project-table');
  if (!table) return;

  var tbody = table.querySelector('tbody');
  var status = document.getElementById('reorder-status');
  var csrf = table.getAttribute('data-csrf');
  var dragged = null;

  function say(text) { if (status) status.textContent = text; }

  function currentIds() {
    return Array.prototype.map.call(
      tbody.querySelectorAll('tr[data-id]'),
      function (tr) { return Number(tr.getAttribute('data-id')); }
    );
  }

  tbody.addEventListener('dragstart', function (e) {
    var tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    dragged = tr;
    tr.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox refuses to start a drag unless some data is set.
    try { e.dataTransfer.setData('text/plain', tr.getAttribute('data-id')); } catch (err) { /* ignore */ }
  });

  tbody.addEventListener('dragover', function (e) {
    if (!dragged) return;
    e.preventDefault();
    var over = e.target.closest('tr[data-id]');
    if (!over || over === dragged) return;

    var box = over.getBoundingClientRect();
    var below = (e.clientY - box.top) / box.height > 0.5;
    tbody.insertBefore(dragged, below ? over.nextSibling : over);
  });

  tbody.addEventListener('dragend', function () {
    if (!dragged) return;
    dragged.classList.remove('dragging');
    dragged = null;
    save();
  });

  function save() {
    var ids = currentIds();
    say('Saving order');
    fetch('/admin/projects/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ ids: ids }),
      credentials: 'same-origin'
    })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (out) {
        say(out && out.ok
          ? 'Order saved, ' + ids.length + ' projects'
          : 'Could not save the order. Reload and use the arrows instead.');
      })
      .catch(function () {
        say('Could not save the order. Reload and use the arrows instead.');
      });
  }
})();

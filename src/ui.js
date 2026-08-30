export function toast(message, duration = 2200) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), duration);
}

export function promptDialog(title, defaultValue = '') {
  return new Promise((resolve) => {
    const dlg = document.getElementById('prompt-dialog');
    document.getElementById('prompt-title').textContent = title;
    const input = document.getElementById('prompt-input');
    input.value = defaultValue;
    dlg.showModal();
    input.focus();

    function cleanup(result) {
      dlg.close();
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    const okBtn = document.getElementById('prompt-ok');
    const cancelBtn = document.getElementById('prompt-cancel');
    function onOk() { cleanup(input.value.trim() || null); }
    function onCancel() { cleanup(null); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

export function renderPhotoPreviews(container, photos) {
  container.innerHTML = '';
  for (const p of photos) {
    // supports both the current {blob, name} shape and a bare Blob for
    // anything stored before filenames were kept
    const blob = p && p.blob ? p.blob : p;
    const name = p && p.name ? p.name : null;

    const wrap = document.createElement('div');
    wrap.style.textAlign = 'center';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    wrap.appendChild(img);
    if (name) {
      const cap = document.createElement('div');
      cap.textContent = name;
      cap.style.fontSize = '10px';
      cap.style.opacity = '0.65';
      cap.style.maxWidth = '64px';
      cap.style.overflow = 'hidden';
      cap.style.textOverflow = 'ellipsis';
      cap.style.whiteSpace = 'nowrap';
      wrap.appendChild(cap);
    }
    container.appendChild(wrap);
  }
}

export function listItem({ title, meta, kindLabel, kindClass, onClick, onDelete }) {
  const row = document.createElement('div');
  row.className = 'list-item';

  const left = document.createElement('div');
  const titleEl = document.createElement('div');
  titleEl.textContent = title;
  const metaEl = document.createElement('div');
  metaEl.className = 'meta';
  metaEl.textContent = meta || '';
  left.appendChild(titleEl);
  if (meta) left.appendChild(metaEl);

  const right = document.createElement('div');
  right.className = 'row-buttons';
  const tag = document.createElement('span');
  tag.className = `kind-tag ${kindClass || ''}`;
  tag.textContent = kindLabel;
  right.appendChild(tag);

  if (onDelete) {
    const delBtn = document.createElement('button');
    delBtn.className = 'btn';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); onDelete(); });
    right.appendChild(delBtn);
  }

  row.appendChild(left);
  row.appendChild(right);
  if (onClick) row.addEventListener('click', onClick);
  return row;
}

export function togglePanel(id, open) {
  const el = document.getElementById(id);
  if (open === undefined) el.classList.toggle('open');
  else el.classList.toggle('open', open);
}

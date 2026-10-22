import * as Core from './core.mjs';

(() => {
  'use strict';
  const AREAS = { trabajo: 'Trabajo', cas: 'CAS y trámites', familia: 'Familia', personal: 'Personal', auto: 'Auto', ocio: 'Ocio', otros: 'Otros' };
  const TASK_STATUS = { pending: 'Por hacer', doing: 'En curso', done: 'Hecho' };
  const PROJECT_STATUS = { 'por-confirmar': 'Por confirmar', 'en-curso': 'En curso', cerrado: 'Cerrado' };
  const STORAGE_KEY = 'chinitex.workspace.v1';
  const SUGGESTIONS = [
    { id: 'models', title: 'Reunir mis modelos de trabajo', area: 'trabajo', detail: 'Conservar el modelo elegido, su fuente y la última versión.', query: 'modelo' },
    { id: 'followup', title: 'Actualizar un trámite laboral', area: 'cas', detail: 'Reunir lo presentado, el cargo y la siguiente actuación confirmada.', query: 'CAS' },
    { id: 'car', title: 'Ordenar el mantenimiento del auto', area: 'auto', detail: 'Guardar servicios, documentos y próximas revisiones.', query: 'auto' },
    { id: 'family', title: 'Preparar una actividad para mis hijos', area: 'familia', detail: 'Elegir una actividad breve adecuada para cada nivel.', query: 'ejercicios' },
    { id: 'rest', title: 'Reservar un momento de descanso', area: 'ocio', detail: 'Elegir música, una salida o una actividad que disfrute.', query: 'música' },
  ];
  const view = document.getElementById('view');
  const searchInput = document.getElementById('global-search');
  const importInput = document.getElementById('import-files');
  let bootstrap = { archive: [] };
  try { bootstrap = JSON.parse(document.getElementById('archive-data')?.textContent || '{"archive":[]}'); } catch { /* Empty build remains usable. */ }
  let archive = Array.isArray(bootstrap.archive) ? bootstrap.archive : [];
  let workspace = Core.createEmptyState();
  let storageAvailable = true;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) workspace = Core.sanitizeState(JSON.parse(saved));
  } catch { storageAvailable = false; }
  let currentView = 'home';
  let filters = { query: '', area: 'all', modelsOnly: false, bookmarkedOnly: false, sort: 'recent' };
  let visibleResults = 24;
  let toastTimer;
  let searchTimer;

  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'value') node.value = value;
      else if (key === 'checked' || key === 'selected' || key === 'disabled') node[key] = Boolean(value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    const append = child => {
      if (child === null || child === undefined || child === false) return;
      if (Array.isArray(child)) child.forEach(append);
      else node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    };
    children.forEach(append);
    return node;
  }
  function button(label, action, className = 'button secondary', attrs = {}) {
    return h('button', { type: 'button', class: className, onclick: action, ...attrs }, label);
  }
  const uid = () => globalThis.crypto?.randomUUID?.() || `item-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const textDate = seconds => {
    if (!Number.isFinite(seconds)) return 'Sin fecha';
    const date = new Date(seconds * 1000);
    if (!Number.isFinite(date.getTime())) return 'Sin fecha';
    return new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', day: 'numeric', month: 'short', year: 'numeric' }).format(date);
  };
  const dueText = date => date ? date.split('-').reverse().join('/') : 'Sin fecha asignada';
  const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Lima' }).format(new Date());
  function toast(message) {
    const target = document.getElementById('toast');
    target.textContent = message;
    target.hidden = false;
    target.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { target.classList.remove('visible'); target.hidden = true; }, 5500);
  }
  function persist() {
    workspace = Core.sanitizeState(workspace);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace)); storageAvailable = true; }
    catch { storageAvailable = false; toast('Tus cambios siguen en esta sesión. Usa Guardar copia para conservarlos.'); }
  }
  function navigate(name) {
    currentView = name;
    for (const nav of document.querySelectorAll('[data-view]')) {
      const selected = nav.dataset.view === name;
      nav.classList.remove('is-active');
      nav.classList.toggle('active', selected);
      if (selected) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current');
    }
    document.getElementById('page-title').textContent = { home: 'Tu espacio', library: 'Biblioteca', projects: 'Proyectos', week: 'Mi semana' }[name];
    render();
  }
  function goSearch(query, options = {}) {
    filters = { ...filters, query, area: 'all', modelsOnly: false, bookmarkedOnly: false, ...options };
    searchInput.value = query;
    visibleResults = 24;
    navigate('library');
  }
  function tags(conversation) {
    return h('div', { class: 'row' }, Core.categories(conversation).map(area => h('span', { class: `pill area-${area}` }, AREAS[area] || area)));
  }
  function sectionHeading(title, action) {
    return h('div', { class: 'section-heading' }, h('h2', {}, title), action);
  }
  function empty(title, text, action) {
    return h('div', { class: 'empty-state' }, h('span', { class: 'empty-symbol', 'aria-hidden': 'true' }, '✦'), h('h3', {}, title), h('p', { class: 'muted' }, text), action);
  }
  function sourceSnippet(conversation) {
    const tokens = Core.normalizeText(filters.query).split(/\s+/).filter(Boolean);
    const message = conversation.messages.find(m => tokens.length && tokens.every(t => Core.normalizeText(m.text).includes(t))) || conversation.messages.find(m => m.text?.trim());
    if (!message) return 'Este chat contiene mensajes sin texto extraíble.';
    let start = 0;
    if (tokens.length) start = Math.max(0, Core.normalizeText(message.text).indexOf(tokens[0]) - 65);
    const excerpt = message.text.slice(start, start + 220).replace(/\s+/g, ' ');
    return `${start ? '…' : ''}${excerpt}${message.text.length > start + 220 ? '…' : ''}`;
  }
  function toggleBookmark(id) {
    workspace.bookmarks = workspace.bookmarks.includes(id) ? workspace.bookmarks.filter(x => x !== id) : [...workspace.bookmarks, id];
    persist();
    render();
  }
  function conversationCard(conversation) {
    const saved = workspace.bookmarks.includes(conversation.id);
    return h('article', { class: 'conversation-card card' },
      h('div', { class: 'row card-heading' },
        button(conversation.title, () => openReader(conversation), 'conversation-title'),
        button(saved ? '★' : '☆', () => toggleBookmark(conversation.id), `button ghost bookmark ${saved ? 'saved' : ''}`, { 'aria-label': `${saved ? 'Quitar referencia' : 'Guardar referencia'}: ${conversation.title}`, 'aria-pressed': String(saved) })),
      h('p', { class: 'source-label' }, `${textDate(conversation.updatedAt || conversation.createdAt)} · ${conversation.userMessageCount} mensajes tuyos`),
      h('p', { class: 'excerpt' }, sourceSnippet(conversation)),
      tags(conversation),
      h('div', { class: 'modal-actions' }, button('Leer mensajes', () => openReader(conversation), 'button secondary small'), button('Usar en proyecto', () => openProjectEditor(null, conversation), 'button ghost small')));
  }
  function renderHome() {
    const latest = archive.length ? Math.max(...archive.map(c => c.updatedAt || c.createdAt || 0)) : null;
    const modelCount = archive.filter(Core.isModelCandidate).length;
    const activeTasks = workspace.tasks.filter(t => t.status !== 'done');
    view.append(h('section', { class: 'hero card' },
      h('div', { class: 'hero-copy' }, h('span', { class: 'eyebrow' }, 'CHINITEX / TU CENTRO PERSONAL'), h('h2', {}, 'Tu información, lista para trabajar.'), h('p', {}, 'Encuentra lo que ya trabajaste, conserva tus referencias y elige tu siguiente paso.'),
        h('div', { class: 'row' }, button('Explorar mi biblioteca', () => goSearch(''), 'button primary'), button('Crear mi primera ficha', () => openProjectEditor(), 'button secondary'))),
      h('div', { class: 'hero-aside' }, h('span', { class: 'hero-number' }, archive.length.toLocaleString('es-PE')), h('strong', {}, 'conversaciones a mano'), h('span', { class: 'muted' }, latest ? `Historial hasta ${textDate(latest)}` : 'Importa tu exportación para empezar'))));
    view.append(h('section', { class: 'stats-grid', 'aria-label': 'Resumen de tu espacio' },
      stat('Conversaciones', archive.length, 'Busca también dentro de tus mensajes', () => goSearch('')),
      stat('Modelos y antecedentes', modelCount, 'Referencias para revisar y conservar', () => goSearch('', { modelsOnly: true })),
      stat('Referencias guardadas', workspace.bookmarks.filter(id => archive.some(c => c.id === id)).length, 'Las que marcaste con una estrella', () => goSearch('', { bookmarkedOnly: true })),
      stat('Tareas abiertas', activeTasks.length, 'Solo las que tú añadiste', () => navigate('week'))));
    const availableSuggestions = SUGGESTIONS.filter(s => !workspace.dismissedSuggestions.includes(s.id));
    view.append(h('section', {}, sectionHeading('Un buen siguiente paso', h('span', { class: 'source-label' }, 'Sugerencias · sin fecha asignada')),
      h('p', { class: 'muted' }, 'Elige lo que siga vigente. Una conversación antigua no significa que la tarea esté pendiente.'),
      availableSuggestions.length ? h('div', { class: 'suggestions-grid' }, availableSuggestions.map(s => h('article', { class: 'suggestion-card card' },
        h('span', { class: 'pill' }, AREAS[s.area]), h('h3', {}, s.title), h('p', { class: 'muted' }, s.detail),
        h('div', { class: 'row' }, button('Añadir a mi tablero', () => openTaskEditor(null, s), 'button primary small'), button('Ver antecedentes', () => goSearch(s.query), 'button ghost small'))))) :
      empty('Ya elegiste tus primeros pasos', 'Puedes crear más tareas cuando las necesites.', button('Nueva tarea', () => openTaskEditor(), 'button primary'))));
    view.append(h('section', { class: 'split' },
      h('div', { class: 'card' }, sectionHeading('Tu tablero', button('Ver todo', () => navigate('week'), 'button ghost small')),
        activeTasks.length ? h('div', { class: 'stack' }, activeTasks.slice(0, 3).map(task => taskCard(task, true))) : h('p', { class: 'muted' }, 'Tu tablero empieza vacío. Añade una tarea propia o elige una de las sugerencias.')),
      h('div', { class: 'card' }, sectionHeading('Tu forma de trabajar'), h('ul', { class: 'working-list' },
        h('li', {}, 'Conserva el modelo y separa los datos reales del proyecto.'), h('li', {}, 'Anota la fuente y la última versión antes de continuar.'), h('li', {}, 'Asigna fechas solo cuando estén confirmadas.')),
        h('p', { class: 'source-label' }, 'Tus tareas y fichas se guardan en este navegador. Guardar copia descarga el historial y tus cambios.'))));
    if (!storageAvailable) view.prepend(h('p', { class: 'notice', role: 'status' }, 'El navegador no permite guardar cambios aquí. Mantén una copia descargada.'));
  }
  function stat(label, value, detail, action) {
    return h('button', { type: 'button', class: 'stat card', onclick: action }, h('span', { class: 'stat-label' }, label), h('strong', { class: 'stat-value' }, value.toLocaleString('es-PE')), h('span', { class: 'source-label' }, detail));
  }
  function renderLibrary() {
    const result = Core.searchArchive(archive, { ...filters, bookmarks: workspace.bookmarks });
    const areaSelect = h('select', { id: 'library-area', 'aria-label': 'Filtrar por área', onchange: e => { filters.area = e.target.value; visibleResults = 24; render(); } },
      h('option', { value: 'all' }, 'Todas las áreas'), Object.entries(AREAS).map(([id, label]) => h('option', { value: id }, label)));
    areaSelect.value = filters.area;
    const sortSelect = h('select', { id: 'library-sort', 'aria-label': 'Ordenar conversaciones', onchange: e => { filters.sort = e.target.value; render(); } }, h('option', { value: 'recent' }, 'Más recientes'), h('option', { value: 'oldest' }, 'Más antiguas'), h('option', { value: 'title' }, 'Por título'));
    sortSelect.value = filters.sort;
    view.append(h('div', { class: 'library-intro' }, h('p', { class: 'muted' }, 'Busca en títulos y en el texto de tus mensajes. Los temas son orientativos; las referencias no certifican modelos aprobados ni estados vigentes.')),
      h('div', { class: 'toolbar card' }, areaSelect, sortSelect,
        h('label', { class: 'check-label' }, h('input', { id: 'models-only', type: 'checkbox', checked: filters.modelsOnly, onchange: e => { filters.modelsOnly = e.target.checked; visibleResults = 24; render(); } }), 'Modelos y antecedentes'),
        h('label', { class: 'check-label' }, h('input', { id: 'bookmarked-only', type: 'checkbox', checked: filters.bookmarkedOnly, onchange: e => { filters.bookmarkedOnly = e.target.checked; visibleResults = 24; render(); } }), 'Mis referencias'),
        button('Limpiar filtros', () => goSearch(''), 'button ghost small')),
      h('div', { class: 'section-heading' }, h('h2', { id: 'result-count', 'aria-live': 'polite' }, `${result.length} ${result.length === 1 ? 'conversación' : 'conversaciones'}`), filters.query ? h('span', { class: 'pill' }, `Búsqueda: ${filters.query}`) : h('span', { class: 'source-label' }, `${archive.length} en tu biblioteca`)));
    if (!archive.length) { view.append(empty('Tu biblioteca está lista para recibir tus chats', 'Pulsa Importar y selecciona los archivos JSON de tu exportación. Puedes seleccionar varios a la vez.', button('Importar conversaciones', () => importInput.click(), 'button primary'))); return; }
    if (!result.length) { view.append(empty('No encontré coincidencias', 'Prueba menos palabras o elimina los filtros de área y referencias.', button('Ver toda la biblioteca', () => goSearch(''), 'button secondary'))); return; }
    view.append(h('div', { class: 'conversation-grid' }, result.slice(0, visibleResults).map(conversationCard)));
    if (result.length > visibleResults) view.append(h('div', { class: 'load-more' }, button(`Mostrar más · ${Math.min(visibleResults, result.length)} de ${result.length}`, () => { visibleResults += 24; render(); }, 'button secondary')));
  }
  function createDialog(title, wide = false) {
    const dialog = h('dialog', { class: wide ? 'reader-dialog' : 'editor-dialog', 'aria-label': title });
    const body = h('div', { class: 'dialog-body' });
    dialog.append(h('div', { class: 'modal-header' }, h('h2', {}, title), button('Cerrar', () => dialog.close(), 'button ghost small', { 'aria-label': `Cerrar ${title}` })), body);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.addEventListener('click', e => { if (e.target === dialog) { const rect = dialog.getBoundingClientRect(); if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) dialog.close(); } });
    document.body.append(dialog);
    return { dialog, body, show: () => dialog.showModal() };
  }
  function openReader(conversation) {
    const modal = createDialog(conversation.title, true);
    const meta = h('div', { class: 'reader-meta' }, tags(conversation), h('p', { class: 'source-label' }, `${conversation.source || 'Exportación importada'} · ${conversation.userMessageCount} registros de mensajes tuyos · ${textDate(conversation.createdAt)}`), h('p', { class: 'muted' }, 'Se muestran tus mensajes, incluidas las ramas conservadas. Los PDF, imágenes y respuestas de ChatGPT no están incluidos aquí.'));
    const saved = workspace.bookmarks.includes(conversation.id);
    const saveButton = button(saved ? '★ Referencia guardada' : '☆ Guardar referencia', () => {
      toggleBookmark(conversation.id);
      const nowSaved = workspace.bookmarks.includes(conversation.id);
      saveButton.textContent = nowSaved ? '★ Referencia guardada' : '☆ Guardar referencia';
      saveButton.setAttribute('aria-pressed', String(nowSaved));
    }, 'button secondary small', { 'aria-pressed': String(saved) });
    const search = h('input', { type: 'search', placeholder: 'Filtrar mensajes de este chat', 'aria-label': 'Filtrar mensajes de este chat' });
    const counter = h('p', { class: 'source-label', 'aria-live': 'polite' });
    const list = h('div', { class: 'message-list' });
    const footer = h('div', { class: 'load-more' });
    let limit = 30;
    function paintMessages() {
      const tokens = Core.normalizeText(search.value).split(/\s+/).filter(Boolean);
      const messages = conversation.messages.filter(m => tokens.every(t => Core.normalizeText(m.text).includes(t)));
      counter.textContent = `${messages.length} mensajes con texto${tokens.length ? ' coincidentes' : ''}`;
      list.replaceChildren(...messages.slice(0, limit).map(m => h('article', { class: 'message' }, h('div', { class: 'row' }, h('span', { class: 'source-label' }, textDate(m.createdAt)), !m.active ? h('span', { class: 'pill' }, 'Otra rama') : null), h('p', { class: 'message-text' }, m.text))));
      footer.replaceChildren();
      if (messages.length > limit) footer.append(button('Cargar más mensajes', () => { limit += 30; paintMessages(); }, 'button secondary'));
      if (!messages.length) list.append(empty('No hay mensajes con ese texto', 'Prueba otra palabra. Las coincidencias globales también pueden estar repartidas entre mensajes.'));
    }
    search.addEventListener('input', () => { limit = 30; paintMessages(); });
    modal.body.append(meta, h('div', { class: 'row' }, saveButton, button('Crear ficha de proyecto', () => { modal.dialog.close(); openProjectEditor(null, conversation); }, 'button primary small')), h('div', { class: 'reader-search' }, search), counter, list, footer);
    paintMessages();
    modal.show();
  }
  function field(label, name, value = '', options = {}) {
    const input = options.multiline ? h('textarea', { name, id: `edit-${name}`, rows: options.rows || 3, maxlength: options.maxlength || 20000 }, value) : h('input', { name, id: `edit-${name}`, type: options.type || 'text', value, required: options.required, maxlength: options.maxlength || 500, placeholder: options.placeholder || '' });
    return h('div', { class: `field ${options.full ? 'full' : ''}` }, h('label', { for: `edit-${name}` }, label), input);
  }
  function selectField(label, name, entries, value) {
    const select = h('select', { name, id: `edit-${name}` }, Object.entries(entries).map(([id, text]) => h('option', { value: id }, text)));
    select.value = value;
    return h('div', { class: 'field' }, h('label', { for: `edit-${name}` }, label), select);
  }
  function openTaskEditor(existing = null, suggestion = null) {
    const task = existing || { title: suggestion?.title || '', area: suggestion?.area || 'trabajo', status: 'pending', due: '', notes: suggestion?.detail || '' };
    const modal = createDialog(existing ? 'Editar tarea' : 'Nueva tarea');
    const form = h('form', { class: 'stack' },
      field('Qué quieres hacer', 'title', task.title, { required: true, maxlength: 240, placeholder: 'Una siguiente acción concreta' }),
      h('div', { class: 'form-grid' }, selectField('Área', 'area', AREAS, task.area), selectField('Estado', 'status', TASK_STATUS, task.status), field('Fecha, si ya está confirmada', 'due', task.due, { type: 'date' })),
      field('Notas o fuente', 'notes', task.notes, { multiline: true }),
      h('div', { class: 'modal-actions' }, existing ? button('Eliminar tarea', () => { if (confirm('¿Eliminar esta tarea?')) { workspace.tasks = workspace.tasks.filter(t => t.id !== existing.id); persist(); modal.dialog.close(); render(); toast('Tarea eliminada.'); } }, 'button ghost danger') : null,
        button('Cancelar', () => modal.dialog.close(), 'button secondary'), h('button', { type: 'submit', class: 'button primary' }, 'Guardar tarea')));
    form.addEventListener('submit', e => {
      e.preventDefault();
      const values = new FormData(form);
      const title = String(values.get('title') || '').trim();
      if (!title) { form.elements.title.setCustomValidity('Escribe una acción concreta.'); form.elements.title.reportValidity(); return; }
      const next = { id: existing?.id || uid(), title, area: values.get('area'), status: values.get('status'), due: values.get('due'), notes: String(values.get('notes') || '').trim(), createdAt: existing?.createdAt || Date.now() };
      workspace.tasks = existing ? workspace.tasks.map(t => t.id === existing.id ? next : t) : [...workspace.tasks, next];
      if (suggestion && !workspace.dismissedSuggestions.includes(suggestion.id)) workspace.dismissedSuggestions.push(suggestion.id);
      persist(); modal.dialog.close(); render(); toast('Tarea guardada en tu tablero.');
    });
    form.elements.title.addEventListener('input', () => form.elements.title.setCustomValidity(''));
    modal.body.append(form); modal.show(); form.elements.title.focus();
  }
  function taskCard(task, compact = false) {
    const select = h('select', { class: 'task-status', 'aria-label': `Estado de ${task.title}`, onchange: e => {
      workspace.tasks = workspace.tasks.map(t => t.id === task.id ? { ...t, status: e.target.value } : t); persist(); render();
    } }, Object.entries(TASK_STATUS).map(([value, label]) => h('option', { value }, label)));
    select.value = task.status;
    const overdue = task.due && task.due < today() && task.status !== 'done';
    return h('article', { class: `task-card ${compact ? 'compact' : ''}` }, h('span', { class: 'pill' }, AREAS[task.area] || 'Otros'), h('h3', {}, task.title), h('p', { class: `source-label ${overdue ? 'overdue' : ''}` }, `${overdue ? 'Fecha pasada · ' : ''}${dueText(task.due)}`), !compact && task.notes ? h('p', { class: 'muted notes-text' }, task.notes) : null, h('div', { class: 'row' }, select, button('Editar', () => openTaskEditor(task), 'button ghost small')));
  }
  function renderWeek() {
    view.append(h('div', { class: 'section-heading' }, h('div', {}, h('h2', {}, 'Tu siguiente paso, a la vista'), h('p', { class: 'muted' }, 'Aquí están todas las tareas que añadiste. Las sugerencias del inicio no cuentan como compromisos.')), button('Nueva tarea', () => openTaskEditor(), 'button primary')));
    view.append(h('div', { class: 'kanban' }, Object.entries(TASK_STATUS).map(([status, label]) => {
      const tasks = workspace.tasks.filter(t => t.status === status).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
      return h('section', { class: 'kanban-column', 'aria-label': label }, h('div', { class: 'section-heading' }, h('h3', {}, label), h('span', { class: 'count' }, tasks.length)), tasks.length ? h('div', { class: 'stack' }, tasks.map(t => taskCard(t))) : h('p', { class: 'empty-column muted' }, status === 'pending' ? 'Añade una acción que quieras realizar.' : status === 'doing' ? 'Cambia el estado de una tarea cuando empieces.' : 'Tus avances aparecerán aquí.'));
    })));
  }
  function openProjectEditor(existing = null, conversation = null) {
    const project = existing || { name: '', cui: '', role: '', version: '', status: 'por-confirmar', nextAction: '', source: conversation ? `${conversation.title} · ${conversation.source}` : '', notes: '' };
    const modal = createDialog(existing ? 'Editar ficha de proyecto' : 'Nueva ficha de proyecto');
    const form = h('form', { class: 'stack' }, h('p', { class: 'muted' }, 'Conserva la fuente. Completa solo datos confirmados del proyecto real.'),
      field('Nombre del proyecto', 'name', project.name, { required: true, maxlength: 300 }),
      h('div', { class: 'form-grid' }, field('CUI, si corresponde', 'cui', project.cui, { maxlength: 40 }), field('Tu función o designación', 'role', project.role), field('Última versión', 'version', project.version, { maxlength: 120 }), selectField('Estado confirmado', 'status', PROJECT_STATUS, project.status)),
      field('Siguiente acción', 'nextAction', project.nextAction), field('Documento, referencia o enlace de origen', 'source', project.source, { multiline: true, rows: 2, maxlength: 2000 }), field('Datos por comprobar y notas', 'notes', project.notes, { multiline: true }),
      h('div', { class: 'modal-actions' }, existing ? button('Eliminar ficha', () => { if (confirm('¿Eliminar esta ficha de proyecto?')) { workspace.projects = workspace.projects.filter(p => p.id !== existing.id); persist(); modal.dialog.close(); render(); toast('Ficha eliminada.'); } }, 'button ghost danger') : null,
        button('Cancelar', () => modal.dialog.close(), 'button secondary'), h('button', { type: 'submit', class: 'button primary' }, 'Guardar ficha')));
    form.addEventListener('submit', e => {
      e.preventDefault(); const data = new FormData(form); const name = String(data.get('name') || '').trim();
      if (!name) { form.elements.name.setCustomValidity('Escribe el nombre del proyecto.'); form.elements.name.reportValidity(); return; }
      const next = { id: existing?.id || uid(), name, cui: String(data.get('cui') || '').trim(), role: String(data.get('role') || '').trim(), version: String(data.get('version') || '').trim(), status: data.get('status'), nextAction: String(data.get('nextAction') || '').trim(), source: String(data.get('source') || '').trim(), notes: String(data.get('notes') || '').trim() };
      workspace.projects = existing ? workspace.projects.map(p => p.id === existing.id ? next : p) : [...workspace.projects, next];
      persist(); modal.dialog.close(); navigate('projects'); toast('Ficha de proyecto guardada.');
    });
    form.elements.name.addEventListener('input', () => form.elements.name.setCustomValidity(''));
    modal.body.append(form); modal.show(); form.elements.name.focus();
  }
  function downloadFile(name, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const link = h('a', { href: url, download: name });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  function exportProject(project) {
    const fields = [['CUI', project.cui], ['Función o designación', project.role], ['Última versión', project.version], ['Estado', PROJECT_STATUS[project.status]], ['Siguiente acción', project.nextAction], ['Fuente', project.source], ['Notas y datos por comprobar', project.notes]];
    const content = `# ${project.name}\n\n${fields.map(([key, value]) => `**${key}:** ${value || 'Por confirmar'}`).join('\n\n')}\n\nGenerado en Chinitex. Los campos reflejan lo registrado por su usuario.\n`;
    const safeName = project.name.replace(/[^\p{L}\p{N} -]/gu, '').trim().slice(0, 60) || 'proyecto';
    downloadFile(`Ficha-${safeName}.md`, content, 'text/markdown;charset=utf-8'); toast('Ficha descargada.');
  }
  function renderProjects() {
    view.append(h('div', { class: 'section-heading' }, h('div', {}, h('h2', {}, 'Cada proyecto con su fuente'), h('p', { class: 'muted' }, 'Las fichas las completas tú. Una referencia del historial puede servir de antecedente o de modelo.')), button('Nueva ficha', () => openProjectEditor(), 'button primary')));
    if (!workspace.projects.length) { view.append(empty('Tu primer proyecto empieza aquí', 'Registra la fuente, la versión actual y una siguiente acción. También puedes crear una ficha desde una conversación.', button('Crear ficha de proyecto', () => openProjectEditor(), 'button primary'))); return; }
    const cards = workspace.projects.map(project => h('article', { class: 'project-card card' }, h('span', { class: 'pill' }, PROJECT_STATUS[project.status]), h('h3', {}, project.name),
      h('dl', { class: 'project-facts' }, h('dt', {}, 'CUI'), h('dd', {}, project.cui || 'No registrado'), h('dt', {}, 'Función'), h('dd', {}, project.role || 'Por confirmar'), h('dt', {}, 'Versión'), h('dd', {}, project.version || 'Por confirmar')),
      h('div', { class: 'project-next' }, h('span', { class: 'source-label' }, 'SIGUIENTE ACCIÓN'), h('p', {}, project.nextAction || 'Por definir')),
      h('p', { class: 'source-label source-text' }, `Fuente: ${project.source || 'Por registrar'}`),
      h('div', { class: 'row' }, button('Editar ficha', () => openProjectEditor(project), 'button secondary small'), button('Descargar ficha', () => exportProject(project), 'button ghost small'))));
    view.append(h('div', { class: 'project-grid' }, cards));
  }
  function render() {
    view.replaceChildren();
    if (currentView === 'home') renderHome();
    else if (currentView === 'library') renderLibrary();
    else if (currentView === 'projects') renderProjects();
    else renderWeek();
  }
  async function importFiles(files) {
    if (!files.length) return;
    const trigger = document.getElementById('import-trigger'); trigger.disabled = true; trigger.textContent = 'Leyendo archivos…';
    try {
      const imported = []; const backups = []; let ignored = 0;
      for (const file of files) {
        let data;
        try { data = JSON.parse(await file.text()); } catch { throw new Error(`No pude leer ${file.name} como JSON válido. No se cambió tu biblioteca.`); }
        if (data?.format === 'chinitex-backup') { backups.push(Core.parseBackup(data)); continue; }
        const normalized = Core.extractConversations(data, file.name);
        if (normalized.length) imported.push(...normalized); else ignored++;
      }
      if (backups.length) {
        if (backups.length !== 1 || imported.length || files.length !== 1) throw new Error('Para restaurar una copia, selecciona solo ese archivo.');
        if (!confirm('¿Restaurar esta copia? Reemplazará la biblioteca, las tareas y las fichas actuales.')) return;
        archive = backups[0].archive; workspace = backups[0].state; persist(); filters = { ...filters, query: '', area: 'all', modelsOnly: false, bookmarkedOnly: false }; searchInput.value = ''; navigate('home'); toast('Copia restaurada. Tu historial y tus cambios están disponibles.');
      } else {
        if (!imported.length) throw new Error('No encontré conversaciones en esos archivos. Selecciona los JSON conversations de tu exportación.');
        const before = archive.length; archive = Core.mergeConversations(archive, imported); visibleResults = 24; navigate('library');
        toast(`${archive.length} conversaciones disponibles · ${archive.length - before} nuevas${ignored ? ` · ${ignored} archivos auxiliares omitidos` : ''}. Guarda una copia para conservar la importación.`);
      }
    } catch (error) { toast(error.message || 'No pude importar los archivos. Tu biblioteca sigue igual.'); }
    finally { trigger.disabled = false; trigger.textContent = 'Importar'; importInput.value = ''; }
  }
  for (const nav of document.querySelectorAll('[data-view]')) nav.addEventListener('click', () => navigate(nav.dataset.view));
  document.getElementById('import-trigger').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', () => importFiles([...importInput.files]));
  document.getElementById('export-backup').addEventListener('click', () => {
    const backup = Core.makeBackup(archive, workspace);
    downloadFile(`Chinitex-copia-${today()}.json`, JSON.stringify(backup), 'application/json;charset=utf-8'); toast('Copia descargada con tu historial, tareas, fichas y referencias.');
  });
  document.getElementById('quick-task').addEventListener('click', () => openTaskEditor());
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { filters.query = searchInput.value; visibleResults = 24; navigate('library'); }, 140);
  });
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(searchTimer); filters.query = searchInput.value; visibleResults = 24; navigate('library'); } });
  navigate('home');
})();

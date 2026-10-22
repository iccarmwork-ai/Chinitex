import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeText,
  extractConversations,
  categories,
  isModelCandidate,
  searchArchive,
  mergeConversations,
  createEmptyState,
  sanitizeState,
  makeBackup,
  parseBackup,
} from '../src/core.mjs';

function message(id, role, parts, contentType = 'text') {
  return {
    id,
    author: { role },
    create_time: 100,
    content: { content_type: contentType, parts },
  };
}

function exportedConversation() {
  return {
    id: 'conversation-a',
    title: 'Modelo de informe de prueba',
    create_time: 90,
    update_time: 150,
    current_node: 'answer-2',
    mapping: {
      root: { id: 'root', parent: null, message: null },
      'user-1': {
        parent: 'root',
        message: message('user-1', 'user', ['Comprueba la suma.']),
      },
      'answer-1': {
        parent: 'user-1',
        message: message('answer-1', 'assistant', ['Respuesta exclusiva del asistente.']),
      },
      'user-2': {
        parent: 'answer-1',
        message: message('user-2', 'user', ['Revisa también la unidad.']),
      },
      'answer-2': {
        parent: 'user-2',
        message: message('answer-2', 'assistant', ['Razonamiento que no debe importarse.'], 'thoughts'),
      },
      alternative: {
        parent: 'answer-1',
        message: message('alternative', 'user', ['Alternativa histórica del usuario.']),
      },
      'image-only': {
        parent: 'root',
        message: message('image-only', 'user', [{ content_type: 'image_asset_pointer', asset_pointer: 'synthetic-image' }], 'multimodal_text'),
      },
    },
  };
}

function conversation(id, title, text, updatedAt = 100) {
  return {
    id,
    title,
    createdAt: 90,
    updatedAt,
    source: 'synthetic.json',
    userMessageCount: 1,
    messages: [{ id: `${id}-message`, createdAt: 100, text, active: true }],
  };
}

test('normaliza tildes y mayúsculas para recuperar texto en español', () => {
  assert.equal(normalizeText('REVISIÓN de ÍTEMS y UNIDAD'), 'revision de items y unidad');
  assert.equal(normalizeText('cancio\u0301n'), 'cancion');
});

test('importa solo texto de usuario y conserva la distinción de ramas', () => {
  const [result] = extractConversations([exportedConversation()], 'conversations-test.json');
  assert.equal(result.id, 'conversation-a');
  assert.equal(result.source, 'conversations-test.json');
  assert.equal(result.createdAt, 90);
  assert.equal(result.updatedAt, 150);
  assert.equal(result.userMessageCount, 4);
  assert.equal(result.messages.length, 3);
  const byId = new Map(result.messages.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('user-1').active, true);
  assert.equal(byId.get('user-2').active, true);
  assert.equal(byId.get('alternative').active, false);
  assert.equal(byId.has('image-only'), false);
  assert.equal(result.messages.some((entry) => /asistente|razonamiento/i.test(entry.text)), false);
});

test('extrae transcripciones y piezas textuales sin convertir imágenes en texto', () => {
  const raw = exportedConversation();
  raw.mapping['user-2'].message = message('user-2', 'user', [
    'Primera parte.',
    { content_type: 'text', text: 'Segunda parte.' },
    { content_type: 'audio_transcription', transcription: 'Tercera parte.' },
    { content_type: 'image_asset_pointer', asset_pointer: 'ignored-picture' },
    null,
  ], 'multimodal_text');
  const [result] = extractConversations([raw]);
  const text = result.messages.find((entry) => entry.id === 'user-2').text;
  assert.match(text, /Primera parte/);
  assert.match(text, /Segunda parte/);
  assert.match(text, /Tercera parte/);
  assert.doesNotMatch(text, /ignored-picture|object Object/);
});

test('los metadatos auxiliares no se convierten en conversaciones', () => {
  assert.deepEqual(extractConversations({ email: 'synthetic@example.invalid' }), []);
  assert.deepEqual(extractConversations([{ file_name: 'synthetic.pdf' }, { rating: 'thumbs_up' }]), []);
  assert.deepEqual(extractConversations(null), []);
});

test('una cadena de padres cíclica o ausente no bloquea la importación', () => {
  const raw = exportedConversation();
  raw.mapping.root.parent = 'answer-2';
  assert.equal(extractConversations([raw]).length, 1);
  raw.current_node = 'missing-node';
  const [result] = extractConversations([raw]);
  assert.equal(result.messages.every((entry) => entry.active === false), true);
});

test('anula timestamps de exportación que no representan una fecha JavaScript válida', () => {
  const invalidTimes = [1e20, Number.MAX_VALUE, 8_640_000_000_001, Infinity, NaN, '1e20'];
  for (const invalid of invalidTimes) {
    const raw = exportedConversation();
    raw.create_time = invalid;
    raw.update_time = invalid;
    raw.mapping['user-1'].message.create_time = invalid;
    const [result] = extractConversations([raw]);
    assert.equal(result.createdAt, null, `create_time: ${String(invalid)}`);
    assert.equal(result.updatedAt, null, `update_time: ${String(invalid)}`);
    assert.equal(result.messages.find((entry) => entry.id === 'user-1').createdAt, null, `message create_time: ${String(invalid)}`);
  }
  const edge = exportedConversation();
  edge.create_time = 8_640_000_000_000;
  assert.equal(extractConversations([edge])[0].createdAt, 8_640_000_000_000);
});

test('rechaza timestamps no representables al restaurar conversaciones o mensajes de una copia', () => {
  const invalidTimes = [1e20, Number.MAX_VALUE, 8_640_000_000_001, Infinity, NaN, '1e20'];
  for (const invalid of invalidTimes) {
    for (const field of ['createdAt', 'updatedAt', 'messageCreatedAt']) {
      const backup = makeBackup([conversation('date-test', 'Fecha sintética', 'Texto de prueba.')], createEmptyState());
      if (field === 'messageCreatedAt') backup.archive[0].messages[0].createdAt = invalid;
      else backup.archive[0][field] = invalid;
      assert.throws(() => parseBackup(backup), `${field}: ${String(invalid)}`);
    }
  }
});

test('busca por contenido propio con tokens AND, sin depender de tildes ni mayúsculas', () => {
  const archive = [
    conversation('a', 'Modelo de informe', 'Revisión de la suma y la unidad.'),
    conversation('b', 'Compra de vehículo', 'Presupuesto de mantenimiento.'),
  ];
  assert.deepEqual(searchArchive(archive, { query: 'revision UNIDAD' }).map((entry) => entry.id), ['a']);
  assert.deepEqual(searchArchive(archive, { query: 'informe suma' }).map((entry) => entry.id), ['a']);
  assert.deepEqual(searchArchive(archive, { query: 'informe mantenimiento' }), []);
  assert.equal(searchArchive(archive, { query: '   ' }).length, 2);
});

test('las respuestas y pensamientos del asistente no aparecen en resultados', () => {
  const archive = extractConversations([exportedConversation()]);
  assert.deepEqual(searchArchive(archive, { query: 'exclusiva asistente' }), []);
  assert.deepEqual(searchArchive(archive, { query: 'razonamiento' }), []);
  assert.equal(searchArchive(archive, { query: 'alternativa histórica' }).length, 1);
});

test('combina filtros de área, modelos y referencias guardadas', () => {
  const archive = [
    conversation('a', 'Modelo de informe', 'Unidad de medida.'),
    conversation('b', 'CAS: seguimiento de solicitud', 'Revisar el cargo.'),
    conversation('c', 'Mantenimiento de mi auto', 'Revisar el manual.'),
  ];
  assert.deepEqual(searchArchive(archive, { area: 'cas' }).map((entry) => entry.id), ['b']);
  assert.deepEqual(searchArchive(archive, { modelsOnly: true }).map((entry) => entry.id), ['a']);
  assert.deepEqual(searchArchive(archive, { bookmarkedOnly: true, bookmarks: ['c'] }).map((entry) => entry.id), ['c']);
  assert.deepEqual(searchArchive(archive, { modelsOnly: true, bookmarkedOnly: true, bookmarks: ['c'] }), []);
});

test('etiquetas orientativas no confunden una autorización con un automóvil', () => {
  assert.equal(categories(conversation('a', 'Autorizar informe técnico', '')).includes('auto'), false);
  assert.equal(categories(conversation('b', 'Mantenimiento de mi auto', '')).includes('auto'), true);
  assert.equal(categories(conversation('c', 'CAS: seguimiento', '')).includes('cas'), true);
  assert.equal(categories(conversation('d', 'Cascada de consultas', '')).includes('cas'), false);
  assert.equal(isModelCandidate(conversation('e', 'Modelo de informe', '')), true);
  assert.equal(isModelCandidate(conversation('f', 'Mantenimiento del auto', '')), false);
});

test('ordena por actualización reciente sin alterar el archivo de entrada', () => {
  const archive = [conversation('old', 'Informe anterior', '', 100), conversation('new', 'Informe reciente', '', 300)];
  assert.deepEqual(searchArchive(archive).map((entry) => entry.id), ['new', 'old']);
  assert.deepEqual(archive.map((entry) => entry.id), ['old', 'new']);
});

test('fusiona exportaciones por id conservando la versión más reciente', () => {
  const old = conversation('same', 'Título anterior', 'Texto anterior.', 100);
  const current = conversation('same', 'Título actualizado', 'Texto actualizado.', 300);
  const stale = conversation('same', 'Exportación vieja', 'Texto viejo.', 50);
  const merged = mergeConversations([old], [conversation('other', 'Otra conversación', '', 200), current]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((entry) => entry.id === 'same').title, 'Título actualizado');
  const later = mergeConversations(merged, [stale]);
  assert.equal(later.find((entry) => entry.id === 'same').title, 'Título actualizado');
  assert.equal(old.title, 'Título anterior');
});

test('el estado inicial no presenta sugerencias como tareas ya asumidas', () => {
  const state = createEmptyState();
  assert.equal(state.version, 1);
  assert.deepEqual(state.tasks, []);
  assert.deepEqual(state.projects, []);
  assert.deepEqual(state.bookmarks, []);
  assert.deepEqual(state.dismissedSuggestions, []);
});

test('sanea tareas y proyectos preservando datos válidos y seleccionando campos conocidos', () => {
  const state = sanitizeState({
    version: 1,
    unknown: 'must be ignored',
    tasks: [
      { id: 'task-1', title: 'Revisar informe', area: 'trabajo', status: 'doing', due: '2026-11-02', notes: 'Verificar original.', createdAt: 100, html: '<script>ignored</script>' },
      { id: 'task-2', title: 'Fecha sin confirmar', area: 'unknown', status: 'invalid', due: 'not-a-date', notes: '' },
      { id: '', title: '' },
    ],
    projects: [
      { id: 'project-1', name: 'Proyecto sintético', cui: '1234567', role: 'Revisor', version: 'v1', status: 'en-curso', nextAction: 'Comparar documentos', source: 'Documento de prueba', notes: '', secret: 'drop' },
      { id: 'project-2', name: 'Por confirmar', status: 'unknown' },
    ],
    bookmarks: ['conversation-a'],
    dismissedSuggestions: ['suggestion-a'],
  });
  assert.equal(Object.hasOwn(state, 'unknown'), false);
  assert.equal(state.tasks[0].title, 'Revisar informe');
  assert.equal(state.tasks[0].status, 'doing');
  assert.equal(state.tasks[0].due, '2026-11-02');
  assert.equal(Object.hasOwn(state.tasks[0], 'html'), false);
  assert.equal(state.tasks.every((entry) => entry.id && entry.title && ['pending', 'doing', 'done'].includes(entry.status)), true);
  assert.equal(state.tasks.every((entry) => entry.due === '' || /^\d{4}-\d{2}-\d{2}$/.test(entry.due)), true);
  assert.equal(state.projects[0].name, 'Proyecto sintético');
  assert.equal(state.projects[0].status, 'en-curso');
  assert.equal(Object.hasOwn(state.projects[0], 'secret'), false);
  assert.equal(state.projects.every((entry) => ['por-confirmar', 'en-curso', 'cerrado'].includes(entry.status)), true);
});

test('una copia completa conserva archivo, tareas, proyectos y referencias al restaurar', () => {
  const archive = [conversation('a', 'Informe sintético', 'Texto de prueba.')];
  const state = createEmptyState();
  state.tasks.push({ id: 'task-a', title: 'Leer informe', area: 'trabajo', status: 'pending', due: '', notes: '', createdAt: 100 });
  state.projects.push({ id: 'project-a', name: 'Proyecto A', cui: '', role: '', version: '', status: 'por-confirmar', nextAction: '', source: '', notes: '' });
  state.bookmarks.push('a');
  state.dismissedSuggestions.push('suggestion-a');
  const backup = makeBackup(archive, state);
  assert.equal(backup.format, 'chinitex-backup');
  assert.equal(backup.version, 1);
  assert.equal(Number.isNaN(Date.parse(backup.exportedAt)), false);
  const restored = parseBackup(JSON.parse(JSON.stringify(backup)));
  assert.deepEqual(restored.archive, archive);
  assert.deepEqual(restored.state, sanitizeState(state));
});

test('rechaza versiones y estructuras de copia que no puede restaurar con seguridad', () => {
  assert.throws(() => parseBackup(null));
  assert.throws(() => parseBackup({ format: 'another-app', version: 1, archive: [], state: {} }));
  assert.throws(() => parseBackup({ format: 'chinitex-backup', version: 2, archive: [], state: {} }));
  assert.throws(() => parseBackup({ format: 'chinitex-backup', version: 1, archive: 'not-an-array', state: {} }));
  assert.throws(() => parseBackup({ format: 'chinitex-backup', version: 1, archive: [{ id: 'bad', title: 'Sin estructura de mensajes' }], state: {} }));
  const malformed = makeBackup([conversation('a', 'Título', 'Texto.')], createEmptyState());
  malformed.archive[0].messages[0].text = { executable: 'never' };
  assert.throws(() => parseBackup(malformed));
});

test('propiedades especiales de JSON no contaminan prototipos ni reaparecen en el estado', () => {
  const raw = JSON.parse('{"version":1,"__proto__":{"pollutedByChinitex":true},"constructor":{"prototype":{"pollutedByChinitex":true}},"tasks":[{"id":"task-a","title":"Tarea segura","status":"pending","area":"trabajo","due":"","notes":"","createdAt":100,"__proto__":{"pollutedByChinitex":true}}],"projects":[],"bookmarks":[],"dismissedSuggestions":[]}');
  const state = sanitizeState(raw);
  assert.equal({}.pollutedByChinitex, undefined);
  assert.equal(Object.hasOwn(state, '__proto__'), false);
  assert.equal(Object.hasOwn(state, 'constructor'), false);
  assert.equal(Object.hasOwn(state.tasks[0], '__proto__'), false);
  const backup = makeBackup([conversation('a', 'Texto como dato', '<script>not executed</script>')], state);
  const restored = parseBackup(JSON.parse(JSON.stringify(backup)));
  assert.equal(restored.archive[0].messages[0].text, '<script>not executed</script>');
  assert.equal({}.pollutedByChinitex, undefined);
});

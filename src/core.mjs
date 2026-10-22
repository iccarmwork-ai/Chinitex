/**
 * Data-only helpers for Chinitex. Conversation content is never evaluated.
 * Export timestamps are kept in seconds, as provided by ChatGPT.
 */

const AREAS = new Set(['trabajo', 'cas', 'familia', 'personal', 'auto', 'ocio', 'otros']);
const TASK_STATUSES = new Set(['pending', 'doing', 'done']);
const PROJECT_STATUSES = new Set(['por-confirmar', 'en-curso', 'cerrado']);
const NON_USER_TEXT_TYPES = new Set(['thoughts', 'thought', 'reasoning', 'reasoning_recap', 'analysis']);
const searchCache = new WeakMap();

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(object, key) {
  return isRecord(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function text(value, limit = Infinity) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function identifier(value) {
  return text(value, 512).trim();
}

function validSeconds(value) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && Number.isFinite(new Date(value * 1000).getTime());
}

function time(value) {
  if (typeof value === 'number') return validSeconds(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const number = Number(value);
  if (!Number.isNaN(number)) return validSeconds(number) ? number : null;
  const parsed = Date.parse(value);
  return validSeconds(parsed / 1000) ? parsed / 1000 : null;
}

function normalizedTime(value) {
  return value === null || validSeconds(value);
}

export function normalizeText(value) {
  const input = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
  return input.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function userText(content) {
  if (!isRecord(content) || NON_USER_TEXT_TYPES.has(content.content_type)) return '';
  const parts = [];
  if (Array.isArray(content.parts)) {
    for (const part of content.parts) {
      if (typeof part === 'string') {
        parts.push(part);
      } else if (isRecord(part)
        && !NON_USER_TEXT_TYPES.has(part.content_type)
        && !NON_USER_TEXT_TYPES.has(part.type)) {
        if (typeof part.text === 'string') parts.push(part.text);
        if (typeof part.transcription === 'string' && part.transcription !== part.text) {
          parts.push(part.transcription);
        }
      }
    }
  }
  if (parts.length === 0 && typeof content.text === 'string') parts.push(content.text);
  return parts.join('\n').trim();
}

/** Ignores auxiliary export lists that do not contain ChatGPT mappings. */
export function extractConversations(payload, source = '') {
  if (!Array.isArray(payload)) return [];
  const result = [];
  for (const conversation of payload) {
    if (!isRecord(conversation) || !isRecord(conversation.mapping)) continue;
    const id = identifier(conversation.id) || identifier(conversation.conversation_id);
    if (!id) continue;
    const mapping = conversation.mapping;
    const activeNodes = new Set();
    let nodeId = identifier(conversation.current_node);
    while (nodeId && own(mapping, nodeId) && !activeNodes.has(nodeId)) {
      activeNodes.add(nodeId);
      const node = mapping[nodeId];
      nodeId = isRecord(node) ? identifier(node.parent) : '';
    }

    const messages = [];
    let userMessageCount = 0;
    for (const [key, node] of Object.entries(mapping)) {
      if (!isRecord(node) || !isRecord(node.message)) continue;
      const message = node.message;
      if (!isRecord(message.author) || message.author.role !== 'user') continue;
      userMessageCount += 1;
      const body = userText(message.content);
      if (!body) continue;
      messages.push({
        id: identifier(message.id) || `${id}:${key}`,
        createdAt: time(message.create_time),
        text: body,
        active: activeNodes.has(key),
      });
    }

    result.push({
      id,
      title: text(conversation.title).trim() || 'Sin título',
      createdAt: time(conversation.create_time),
      updatedAt: time(conversation.update_time),
      source: text(source),
      userMessageCount,
      messages,
    });
  }
  return result;
}

/** Tags are deliberately derived from titles, not asserted as personal facts. */
export function categories(conversation) {
  const title = normalizeText(conversation?.title);
  const result = [];
  if (/informe|expediente|\btdr\b|presupuesto|contrat|\bcui\b|\bobra\b|obras|consultor|cronograma|partida|proyecto|vial|ingenier|evaluacion|supervision|memorando|conformidad|metrado|\bs10\b|\bproject\b|\bword\b|\bexcel\b|firma|\bpdf\b/.test(title)) result.push('trabajo');
  if (/\bcas\b|laboral|prorroga|vacaciones/.test(title)) result.push('cas');
  if (/famil|hij[oa]|esposa|escolar|primaria|preescolar|ninos?|ninas?|rimas?|adivinanzas|dia del padre|dia de la madre/.test(title)) result.push('familia');
  if (/^change$|rutina|habito|descanso|aliment|desayuno|bajar.{0,20}peso|salud|sueno|movil|celular|tramite|ahorr|\bgastos?\b|suscrip|\bpago\b|prestamo|financiam|tarjeta|interbank/.test(title)) result.push('personal');
  if (/carro|\bautos?\b|vehicul|nissan|\bmarch\b|manejar|conduc|\bsoat\b|brevete/.test(title)) result.push('auto');
  if (/floyd|musica|cancion|album|futbol|mundial|messi|peloteada|aburrimiento|nebulosa|astronom|universo|galax|exorcista|pelicula|lectura|evangelio|laberinto|canicas|receta|chaufa|papas fritas|canchita|cocin|serie/.test(title)) result.push('ocio');
  return result.length ? result : ['otros'];
}

export function isModelCandidate(conversation) {
  return /almacen|guardar|\bmodelos?\b|antecedente|referencia/.test(normalizeText(conversation?.title));
}

function indexedText(conversation) {
  if (!isRecord(conversation)) return '';
  let cached = searchCache.get(conversation);
  if (cached === undefined) {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    cached = normalizeText([text(conversation.title), ...messages.map(message => text(message?.text))].join('\n'));
    searchCache.set(conversation, cached);
  }
  return cached;
}

function latestTime(conversation) {
  return time(conversation?.updatedAt) ?? time(conversation?.createdAt) ?? 0;
}

export function searchArchive(archive, {
  query = '',
  area = 'all',
  modelsOnly = false,
  bookmarkedOnly = false,
  bookmarks = [],
  sort = 'recent',
} = {}) {
  if (!Array.isArray(archive)) return [];
  const tokens = normalizeText(query).trim().split(/\s+/).filter(Boolean);
  const saved = new Set(Array.isArray(bookmarks) ? bookmarks : []);
  const results = archive.filter(conversation => {
    if (!isRecord(conversation)) return false;
    if (area !== 'all' && !categories(conversation).includes(area)) return false;
    if (modelsOnly && !isModelCandidate(conversation)) return false;
    if (bookmarkedOnly && !saved.has(conversation.id)) return false;
    if (tokens.length === 0) return true;
    const haystack = indexedText(conversation);
    return tokens.every(token => haystack.includes(token));
  });
  if (sort === 'title') {
    return results.sort((a, b) => text(a.title).localeCompare(text(b.title), 'es', { numeric: true }));
  }
  if (sort === 'oldest') return results.sort((a, b) => latestTime(a) - latestTime(b));
  if (sort === 'relevance' && tokens.length) {
    const score = conversation => {
      const title = normalizeText(conversation.title);
      return tokens.reduce((sum, token) => sum + (title.includes(token) ? 1 : 0), 0);
    };
    return results.sort((a, b) => score(b) - score(a) || latestTime(b) - latestTime(a));
  }
  return results.sort((a, b) => latestTime(b) - latestTime(a));
}

export function mergeConversations(existing, incoming) {
  const merged = new Map();
  for (const conversation of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!isRecord(conversation) || !identifier(conversation.id)) continue;
    const previous = merged.get(conversation.id);
    if (!previous
      || latestTime(conversation) > latestTime(previous)
      || (latestTime(conversation) === latestTime(previous)
        && (conversation.messages?.length ?? 0) >= (previous.messages?.length ?? 0))) {
      merged.set(conversation.id, conversation);
    }
  }
  return [...merged.values()];
}

export function createEmptyState() {
  return { version: 1, tasks: [], projects: [], bookmarks: [], dismissedSuggestions: [] };
}

function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(identifier).filter(Boolean))];
}

function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : '';
}

export function sanitizeState(input) {
  const state = createEmptyState();
  if (!isRecord(input)) return state;
  const taskIds = new Set();
  for (const candidate of Array.isArray(input.tasks) ? input.tasks : []) {
    if (!isRecord(candidate)) continue;
    const id = identifier(candidate.id);
    const title = text(candidate.title, 500).trim();
    if (!id || !title || taskIds.has(id)) continue;
    taskIds.add(id);
    state.tasks.push({
      id,
      title,
      area: AREAS.has(candidate.area) ? candidate.area : 'personal',
      status: TASK_STATUSES.has(candidate.status) ? candidate.status : 'pending',
      due: calendarDate(candidate.due),
      notes: text(candidate.notes, 20000),
      createdAt: time(candidate.createdAt) ?? 0,
    });
  }
  const projectIds = new Set();
  for (const candidate of Array.isArray(input.projects) ? input.projects : []) {
    if (!isRecord(candidate)) continue;
    const id = identifier(candidate.id);
    const name = text(candidate.name, 500).trim();
    if (!id || !name || projectIds.has(id)) continue;
    projectIds.add(id);
    state.projects.push({
      id,
      name,
      cui: text(candidate.cui, 80).trim(),
      role: text(candidate.role, 500).trim(),
      version: text(candidate.version, 120).trim(),
      status: PROJECT_STATUSES.has(candidate.status) ? candidate.status : 'por-confirmar',
      nextAction: text(candidate.nextAction, 2000),
      source: text(candidate.source, 2000),
      notes: text(candidate.notes, 20000),
    });
  }
  state.bookmarks = uniqueStrings(input.bookmarks);
  state.dismissedSuggestions = uniqueStrings(input.dismissedSuggestions);
  return state;
}

function backupError(detail) {
  return new Error(`La copia de Chinitex no es válida: ${detail}.`);
}

function copyNormalizedArchive(archive) {
  if (!Array.isArray(archive)) throw backupError('falta la lista de conversaciones');
  const clean = [];
  for (const conversation of archive) {
    if (!isRecord(conversation)
      || !identifier(conversation.id)
      || typeof conversation.title !== 'string'
      || typeof conversation.source !== 'string'
      || !normalizedTime(conversation.createdAt)
      || !normalizedTime(conversation.updatedAt)
      || !Array.isArray(conversation.messages)
      || !Number.isSafeInteger(conversation.userMessageCount)
      || conversation.userMessageCount < conversation.messages.length) {
      throw backupError('una conversación tiene campos incompletos o incorrectos');
    }
    const messages = conversation.messages.map(message => {
      if (!isRecord(message)
        || !identifier(message.id)
        || typeof message.text !== 'string'
        || !message.text.trim()
        || !normalizedTime(message.createdAt)
        || typeof message.active !== 'boolean') {
        throw backupError('un mensaje tiene campos incompletos o incorrectos');
      }
      return {
        id: identifier(message.id),
        createdAt: message.createdAt,
        text: message.text,
        active: message.active,
      };
    });
    clean.push({
      id: identifier(conversation.id),
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      source: conversation.source,
      userMessageCount: conversation.userMessageCount,
      messages,
    });
  }
  return mergeConversations([], clean);
}

export function makeBackup(archive, state) {
  return {
    format: 'chinitex-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    archive: copyNormalizedArchive(archive),
    state: sanitizeState(state),
  };
}

export function parseBackup(payload) {
  if (!isRecord(payload) || payload.format !== 'chinitex-backup' || payload.version !== 1) {
    throw backupError('el formato o la versión no son compatibles');
  }
  if (!isRecord(payload.state)) throw backupError('falta el estado de tus proyectos y tareas');
  return {
    archive: copyNormalizedArchive(payload.archive),
    state: sanitizeState(payload.state),
  };
}

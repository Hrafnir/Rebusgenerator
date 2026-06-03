const {
  ensureTeacherFromGoogleProfile,
  getTeacherByEmail,
  getTeacherById,
  listRebuses,
  getRebusDetails,
  createRebus,
  updateRebus,
  deleteRebus,
  createTask,
  deleteTask,
  createStudent,
  updateStudent,
  deleteStudent,
  updateStudentPassword,
  loginStudent,
  getStudentSession,
  recordLocation,
  recordProgress,
  recordSubmission,
  getLiveSnapshot
} = require('../services/rebusService');
const { json, notFound, badRequest, unauthorized, parseJson } = require('./response');
const { config } = require('../config');
const { verifyGoogleIdToken } = require('../services/googleAuth');
const {
  isSupabaseStudentMode,
  loginStudentSupabase,
  getStudentSessionSupabase,
  recordLocationSupabase,
  recordProgressSupabase,
  recordSubmissionSupabase
} = require('../services/supabaseStudentService');
const { parseMultipart } = require('./multipart');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads');
const ALLOWED_UPLOAD_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/webm',
  'audio/x-m4a'
]);

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    json(res, 200, { ok: true, app: 'rebus-platform' });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    json(res, 200, {
      supabaseUrl: config.supabaseUrl,
      supabaseAnonKey: config.supabaseAnonKey,
      googleClientId: config.googleClientId,
      googleMapsApiKey: config.googleMapsApiKey,
      allowDevAuth: config.allowDevAuth
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/google') {
    const body = await parseJson(req);
    if (!body.credential) return badRequest(res, 'Mangler Google credential.'), true;
    try {
      const profile = await verifyGoogleIdToken(body.credential);
      const teacher = ensureTeacherFromGoogleProfile(profile);
      json(res, 200, { teacher });
    } catch (error) {
      json(res, 401, { error: error.message });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/google/dev') {
    if (!config.allowDevAuth) return unauthorized(res), true;
    const body = await parseJson(req);
    const email = body.email || 'teacher@example.com';
    const teacher = ensureTeacherFromGoogleProfile({
      email,
      name: body.name || email.split('@')[0]
    });
    json(res, 200, { teacher, note: 'Dev-login. Byttes med ekte Google OAuth.' });
    return true;
  }

  const teacher = getTeacherFromRequest(req);

  if (url.pathname === '/api/admin/rebuses' && req.method === 'GET') {
    if (!teacher) return unauthorized(res), true;
    json(res, 200, { rebuses: listRebuses(teacher.id) });
    return true;
  }

  if (url.pathname === '/api/admin/rebuses' && req.method === 'POST') {
    if (!teacher) return unauthorized(res), true;
    const rebus = createRebus(teacher.id, await parseJson(req));
    json(res, 201, { rebus });
    return true;
  }

  const rebusMatch = url.pathname.match(/^\/api\/admin\/rebuses\/([^/]+)$/);
  if (rebusMatch && req.method === 'GET') {
    if (!teacher) return unauthorized(res), true;
    const rebus = getRebusDetails(rebusMatch[1], teacher.id);
    if (!rebus) return notFound(res), true;
    json(res, 200, { rebus });
    return true;
  }

  if (rebusMatch && req.method === 'PATCH') {
    if (!teacher) return unauthorized(res), true;
    const rebus = updateRebus(teacher.id, rebusMatch[1], await parseJson(req));
    if (!rebus) return notFound(res), true;
    json(res, 200, { rebus });
    return true;
  }

  if (rebusMatch && req.method === 'DELETE') {
    if (!teacher) return unauthorized(res), true;
    const rebus = deleteRebus(teacher.id, rebusMatch[1]);
    if (!rebus) return notFound(res), true;
    json(res, 200, { rebus });
    return true;
  }

  const taskMatch = url.pathname.match(/^\/api\/admin\/rebuses\/([^/]+)\/tasks$/);
  if (taskMatch && req.method === 'POST') {
    if (!teacher) return unauthorized(res), true;
    const task = createTask(teacher.id, taskMatch[1], await parseJson(req));
    if (!task) return notFound(res), true;
    json(res, 201, { task });
    return true;
  }

  const taskItemMatch = url.pathname.match(/^\/api\/admin\/rebuses\/([^/]+)\/tasks\/([^/]+)$/);
  if (taskItemMatch && req.method === 'DELETE') {
    if (!teacher) return unauthorized(res), true;
    const task = deleteTask(teacher.id, taskItemMatch[1], taskItemMatch[2]);
    if (!task) return notFound(res), true;
    json(res, 200, { task });
    return true;
  }

  const studentMatch = url.pathname.match(/^\/api\/admin\/rebuses\/([^/]+)\/students$/);
  if (studentMatch && req.method === 'POST') {
    if (!teacher) return unauthorized(res), true;
    const student = createStudent(teacher.id, studentMatch[1], await parseJson(req));
    if (!student) return notFound(res), true;
    if (student.error) return badRequest(res, student.error), true;
    json(res, 201, { student });
    return true;
  }

  const studentPasswordMatch = url.pathname.match(/^\/api\/admin\/rebuses\/([^/]+)\/students\/([^/]+)\/password$/);
  if (studentPasswordMatch && req.method === 'PATCH') {
    if (!teacher) return unauthorized(res), true;
    const body = await parseJson(req);
    if (!body.password) return badRequest(res, 'Mangler ny kode.'), true;
    const student = updateStudentPassword(teacher.id, studentPasswordMatch[1], studentPasswordMatch[2], body.password);
    if (!student) return notFound(res), true;
    json(res, 200, { student });
    return true;
  }

  const studentDetailMatch = url.pathname.match(/^\/api\/admin\/rebuses\/([^/]+)\/students\/([^/]+)$/);
  if (studentDetailMatch && req.method === 'PATCH') {
    if (!teacher) return unauthorized(res), true;
    const student = updateStudent(teacher.id, studentDetailMatch[1], studentDetailMatch[2], await parseJson(req));
    if (!student) return notFound(res), true;
    if (student.error) return badRequest(res, student.error), true;
    json(res, 200, { student });
    return true;
  }

  if (studentDetailMatch && req.method === 'DELETE') {
    if (!teacher) return unauthorized(res), true;
    const student = deleteStudent(teacher.id, studentDetailMatch[1], studentDetailMatch[2]);
    if (!student) return notFound(res), true;
    json(res, 200, { student });
    return true;
  }

  if (url.pathname === '/api/admin/live' && req.method === 'GET') {
    if (!teacher) return unauthorized(res), true;
    json(res, 200, getLiveSnapshot(teacher.id));
    return true;
  }

  if (url.pathname === '/api/student/login' && req.method === 'POST') {
    const body = await parseJson(req);
    const session = isSupabaseStudentMode()
      ? await loginStudentSupabase(body.username, body.password, body.rebusId)
      : loginStudent(body.username, body.password, body.rebusId);
    if (!session) return unauthorized(res), true;
    json(res, 200, session);
    return true;
  }

  const sessionMatch = url.pathname.match(/^\/api\/student\/session\/([^/]+)$/);
  if (sessionMatch && req.method === 'GET') {
    const session = isSupabaseStudentMode()
      ? await getStudentSessionSupabase(sessionMatch[1])
      : getStudentSession(sessionMatch[1]);
    if (!session) return unauthorized(res), true;
    json(res, 200, session);
    return true;
  }

  if (url.pathname === '/api/student/location' && req.method === 'POST') {
    const token = getBearerToken(req);
    if (!token) return unauthorized(res), true;
    const body = await parseJson(req);
    const location = isSupabaseStudentMode()
      ? await recordLocationSupabase(token, body)
      : recordLocation(token, body);
    if (!location) return unauthorized(res), true;
    json(res, 201, { location });
    return true;
  }

  if (url.pathname === '/api/student/progress' && req.method === 'POST') {
    const token = getBearerToken(req);
    if (!token) return unauthorized(res), true;
    const body = await parseJson(req);
    const progress = isSupabaseStudentMode()
      ? await recordProgressSupabase(token, body)
      : recordProgress(token, body);
    if (!progress) return badRequest(res, 'Kunne ikke registrere progresjon.'), true;
    json(res, 201, { progress });
    return true;
  }

  if (url.pathname === '/api/student/submissions' && req.method === 'POST') {
    const token = getBearerToken(req);
    if (!token) return unauthorized(res), true;
    let multipart;
    try {
      multipart = await parseMultipart(req, config.uploadMaxBytes);
    } catch (error) {
      return badRequest(res, error.message), true;
    }

    const file = multipart.files.file;
    const taskId = multipart.fields.taskId;
    if (!taskId || !file) return badRequest(res, 'Mangler oppgave eller fil.'), true;
    if (!ALLOWED_UPLOAD_TYPES.has(file.contentType)) {
      return badRequest(res, 'Filtypen er ikke tillatt. Bruk bilde eller video.'), true;
    }

    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const storedName = createStoredFilename(file.filename, file.contentType);
    fs.writeFileSync(path.join(UPLOAD_DIR, storedName), file.buffer);

    const payload = {
      taskId,
      originalName: file.filename,
      storedName,
      contentType: file.contentType,
      size: file.buffer.length,
      note: multipart.fields.note || ''
    };
    const result = isSupabaseStudentMode()
      ? await recordSubmissionSupabase(token, payload)
      : recordSubmission(token, payload);
    if (!result) return badRequest(res, 'Kunne ikke registrere innlevering.'), true;
    json(res, 201, result);
    return true;
  }

  return false;
}

function getTeacherFromRequest(req) {
  const teacherId = req.headers['x-teacher-id'];
  if (teacherId) return getTeacherById(teacherId);
  const email = req.headers['x-teacher-email'];
  if (!email) return null;
  return getTeacherByEmail(email);
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}

function createStoredFilename(originalName, contentType) {
  const fallbackExt = contentType.split('/')[1] || 'bin';
  const ext = path.extname(originalName || '') || `.${fallbackExt}`;
  const safeExt = ext.toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12) || '.bin';
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt}`;
}

module.exports = { handleApi };

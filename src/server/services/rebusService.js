const { createId, nowIso, publicStudent, REBUS_STATUS, TASK_TYPES } = require('../../shared/domain');
const { readDatabase, updateDatabase } = require('../repositories/jsonDatabase');

function getTeacherByEmail(email) {
  const db = readDatabase();
  return db.teachers.find(teacher => teacher.email === email) || null;
}

function getTeacherById(id) {
  const db = readDatabase();
  return db.teachers.find(teacher => teacher.id === id) || null;
}

function ensureTeacherFromGoogleProfile(profile) {
  return updateDatabase(db => {
    let teacher = db.teachers.find(item => item.email === profile.email);
    if (!teacher) {
      teacher = {
        id: createId('teacher'),
        name: profile.name || profile.email,
        email: profile.email,
        provider: 'google',
        googleSubject: profile.googleSubject || null,
        picture: profile.picture || null,
        createdAt: nowIso()
      };
      db.teachers.push(teacher);
    } else {
      teacher.name = profile.name || teacher.name;
      teacher.googleSubject = profile.googleSubject || teacher.googleSubject || null;
      teacher.picture = profile.picture || teacher.picture || null;
    }
    return teacher;
  });
}

function listRebuses(teacherId) {
  const db = readDatabase();
  return db.rebuses
    .filter(rebus => rebus.ownerTeacherId === teacherId)
    .map(rebus => ({
      ...rebus,
      taskCount: db.tasks.filter(task => task.rebusId === rebus.id).length,
      studentCount: db.students.filter(student => student.rebusId === rebus.id).length
    }));
}

function getRebusDetails(rebusId, teacherId) {
  const db = readDatabase();
  const rebus = db.rebuses.find(item => item.id === rebusId && item.ownerTeacherId === teacherId);
  if (!rebus) return null;
  return {
    ...rebus,
    tasks: db.tasks.filter(task => task.rebusId === rebusId).sort((a, b) => a.order - b.order),
    students: db.students.filter(student => student.rebusId === rebusId).map(student => ({
      ...publicStudent(student),
      password: student.password || ''
    }))
  };
}

function createRebus(teacherId, input) {
  return updateDatabase(db => {
    const timestamp = nowIso();
    const rebus = {
      id: createId('rebus'),
      ownerTeacherId: teacherId,
      title: input.title || 'Ny rebus',
      description: input.description || '',
      status: REBUS_STATUS.DRAFT,
      startsAt: input.startsAt || null,
      endsAt: input.endsAt || null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    db.rebuses.push(rebus);
    db.events.push(createEvent('rebus_created', rebus.id, `Rebus opprettet: ${rebus.title}`));
    return rebus;
  });
}

function updateRebus(teacherId, rebusId, input) {
  return updateDatabase(db => {
    const rebus = db.rebuses.find(item => item.id === rebusId && item.ownerTeacherId === teacherId);
    if (!rebus) return null;
    rebus.title = String(input.title || '').trim() || rebus.title;
    rebus.description = String(input.description || '').trim();
    rebus.updatedAt = nowIso();
    db.events.push(createEvent('rebus_updated', rebus.id, `Rebus oppdatert: ${rebus.title}`));
    return rebus;
  });
}

function deleteRebus(teacherId, rebusId) {
  return updateDatabase(db => {
    const rebus = db.rebuses.find(item => item.id === rebusId && item.ownerTeacherId === teacherId);
    if (!rebus) return null;
    const taskIds = new Set(db.tasks.filter(task => task.rebusId === rebusId).map(task => task.id));
    const studentIds = new Set(db.students.filter(student => student.rebusId === rebusId).map(student => student.id));
    db.rebuses = db.rebuses.filter(item => item.id !== rebusId);
    db.tasks = db.tasks.filter(task => task.rebusId !== rebusId);
    db.students = db.students.filter(student => student.rebusId !== rebusId);
    db.sessions = db.sessions.filter(session => !studentIds.has(session.studentId));
    db.progress = db.progress.filter(progress => progress.rebusId !== rebusId && !taskIds.has(progress.taskId));
    db.locations = db.locations.filter(location => location.rebusId !== rebusId);
    db.submissions = db.submissions.filter(submission => submission.rebusId !== rebusId);
    db.events.push(createEvent('rebus_deleted', rebusId, `Rebus slettet: ${rebus.title}`));
    return rebus;
  });
}

function createTask(teacherId, rebusId, input) {
  return updateDatabase(db => {
    const rebus = db.rebuses.find(item => item.id === rebusId && item.ownerTeacherId === teacherId);
    if (!rebus) return null;
    const timestamp = nowIso();
    const order = Number(input.order || db.tasks.filter(task => task.rebusId === rebusId).length + 1);
    const task = {
      id: createId('task'),
      rebusId,
      title: input.title || 'Ny oppgave',
      description: input.description || '',
      type: Object.values(TASK_TYPES).includes(input.type) ? input.type : TASK_TYPES.TEXT,
      prompt: input.prompt || '',
      answer: input.answer || '',
      points: Number(input.points || 0),
      order,
      geofenceRadiusMeters: Number(input.geofenceRadiusMeters || 30),
      location: normalizeLocation(input.location),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    db.tasks.push(task);
    rebus.updatedAt = timestamp;
    db.events.push(createEvent('task_created', rebus.id, `Oppgave lagt til: ${task.title}`, { taskId: task.id }));
    return task;
  });
}

function createStudent(teacherId, rebusId, input) {
  return updateDatabase(db => {
    const rebus = db.rebuses.find(item => item.id === rebusId && item.ownerTeacherId === teacherId);
    if (!rebus) return null;
    const username = String(input.username || '').trim().toLowerCase();
    if (!username || db.students.some(student => student.rebusId === rebusId && student.username === username)) {
      return { error: 'Brukernavn mangler eller finnes allerede.' };
    }
    const student = {
      id: createId('student'),
      rebusId,
      displayName: input.displayName || username,
      username,
      password: input.password || createInviteCode(),
      teamName: input.teamName || null,
      createdAt: nowIso()
    };
    db.students.push(student);
    db.events.push(createEvent('student_created', rebus.id, `Elev opprettet: ${student.displayName}`, { studentId: student.id }));
    return publicStudent(student);
  });
}

function updateStudent(teacherId, rebusId, studentId, input) {
  return updateDatabase(db => {
    const rebus = db.rebuses.find(item => item.id === rebusId && item.ownerTeacherId === teacherId);
    if (!rebus) return null;
    const student = db.students.find(item => item.id === studentId && item.rebusId === rebusId);
    if (!student) return null;
    const username = String(input.username || student.username).trim().toLowerCase();
    if (!username) return { error: 'Brukernavn mangler.' };
    const usernameTaken = db.students.some(item => item.id !== studentId && item.rebusId === rebusId && item.username === username);
    if (usernameTaken) return { error: 'Brukernavnet finnes allerede.' };
    student.displayName = input.displayName || student.displayName;
    student.teamName = input.teamName || student.teamName || null;
    student.username = username;
    return publicStudentWithPassword(student);
  });
}

function deleteStudent(teacherId, rebusId, studentId) {
  return updateDatabase(db => {
    const rebus = db.rebuses.find(item => item.id === rebusId && item.ownerTeacherId === teacherId);
    if (!rebus) return null;
    const student = db.students.find(item => item.id === studentId && item.rebusId === rebusId);
    if (!student) return null;
    db.students = db.students.filter(item => item.id !== studentId);
    db.sessions = db.sessions.filter(session => session.studentId !== studentId);
    db.progress = db.progress.filter(progress => progress.studentId !== studentId);
    db.locations = db.locations.filter(location => location.studentId !== studentId);
    db.submissions = db.submissions.filter(submission => submission.studentId !== studentId);
    db.events.push(createEvent('student_deleted', rebus.id, `Gruppe slettet: ${student.displayName}`, { studentId }));
    return publicStudentWithPassword(student);
  });
}

function updateStudentPassword(teacherId, rebusId, studentId, password) {
  return updateDatabase(db => {
    const rebus = db.rebuses.find(item => item.id === rebusId && item.ownerTeacherId === teacherId);
    if (!rebus) return null;
    const student = db.students.find(item => item.id === studentId && item.rebusId === rebusId);
    if (!student) return null;
    student.password = String(password || '');
    db.events.push(createEvent('student_password_updated', rebus.id, `Kode oppdatert for: ${student.displayName}`, { studentId: student.id }));
    return publicStudentWithPassword(student);
  });
}

function loginStudent(username, password, rebusId) {
  return updateDatabase(db => {
    const student = db.students.find(item =>
      item.username === String(username || '').trim().toLowerCase() &&
      item.password === String(password || '') &&
      (!rebusId || item.rebusId === rebusId)
    );
    if (!student) return null;
    const session = {
      token: createId('session'),
      studentId: student.id,
      createdAt: nowIso(),
      lastSeenAt: nowIso()
    };
    db.sessions.push(session);
    db.events.push(createEvent('student_login', student.rebusId, `${student.displayName} logget inn.`, { studentId: student.id }));
    return buildStudentSession(db, session);
  });
}

function getStudentSession(token) {
  const db = readDatabase();
  const session = db.sessions.find(item => item.token === token);
  if (!session) return null;
  return buildStudentSession(db, session);
}

function recordLocation(token, input) {
  return updateDatabase(db => {
    const session = db.sessions.find(item => item.token === token);
    if (!session) return null;
    const student = db.students.find(item => item.id === session.studentId);
    if (!student) return null;
    const location = {
      id: createId('loc'),
      studentId: student.id,
      rebusId: student.rebusId,
      lat: Number(input.lat),
      lng: Number(input.lng),
      accuracy: input.accuracy ? Number(input.accuracy) : null,
      createdAt: nowIso()
    };
    db.locations.push(location);
    session.lastSeenAt = location.createdAt;
    return location;
  });
}

function recordProgress(token, input) {
  return updateDatabase(db => {
    const session = db.sessions.find(item => item.token === token);
    if (!session) return null;
    const student = db.students.find(item => item.id === session.studentId);
    const task = db.tasks.find(item => item.id === input.taskId && item.rebusId === student?.rebusId);
    if (!student || !task) return null;

    const answer = String(input.answer || '').trim();
    const isArrivalTask = task.type === 'find_destination' || task.type === 'pace_match';
    const correct = isArrivalTask ? true : task.answer ? answer.toLowerCase() === String(task.answer).trim().toLowerCase() : null;
    const answerText = task.type === 'find_destination'
      ? '[FUNNET_FREM] Laget fant riktig sted.'
      : task.type === 'pace_match'
        ? '[JEVN_FART] Fremme. Fart beregnes i Supabase-modus.'
        : answer;
    const progress = {
      id: createId('progress'),
      studentId: student.id,
      rebusId: student.rebusId,
      taskId: task.id,
      answer: answerText,
      status: correct === false ? 'needs_retry' : 'submitted',
      correct,
      pointsAwarded: correct ? task.points : 0,
      createdAt: nowIso()
    };
    db.progress.push(progress);
    db.events.push(createEvent('progress_submitted', student.rebusId, `${student.displayName} leverte ${task.title}.`, {
      studentId: student.id,
      taskId: task.id,
      correct
    }));
    return progress;
  });
}

function recordSubmission(token, input) {
  return updateDatabase(db => {
    const session = db.sessions.find(item => item.token === token);
    if (!session) return null;
    const student = db.students.find(item => item.id === session.studentId);
    const task = db.tasks.find(item => item.id === input.taskId && item.rebusId === student?.rebusId);
    if (!student || !task) return null;

    const submission = {
      id: createId('submission'),
      studentId: student.id,
      rebusId: student.rebusId,
      taskId: task.id,
      type: task.type,
      originalName: input.originalName,
      storedName: input.storedName,
      contentType: input.contentType,
      size: input.size,
      url: `/uploads/${input.storedName}`,
      note: input.note || '',
      status: 'submitted',
      createdAt: nowIso()
    };

    const progress = {
      id: createId('progress'),
      studentId: student.id,
      rebusId: student.rebusId,
      taskId: task.id,
      answer: task.type === 'speed_photo' ? `[RASK_ETAPPE] Bilde levert: ${submission.originalName || 'innlevering'}` : submission.url,
      status: 'submitted',
      correct: task.type === 'speed_photo' ? true : null,
      pointsAwarded: task.type === 'speed_photo' ? Number(task.points || 0) : 0,
      submissionId: submission.id,
      createdAt: submission.createdAt
    };

    db.submissions.push(submission);
    db.progress.push(progress);
    db.events.push(createEvent('submission_created', student.rebusId, `${student.displayName} leverte fil til ${task.title}.`, {
      studentId: student.id,
      taskId: task.id,
      submissionId: submission.id
    }));
    return { submission, progress };
  });
}

function getLiveSnapshot(teacherId) {
  const db = readDatabase();
  const rebusIds = new Set(db.rebuses.filter(rebus => rebus.ownerTeacherId === teacherId).map(rebus => rebus.id));
  const latestByStudent = collection => {
    const map = new Map();
    for (const item of collection) map.set(item.studentId, item);
    return map;
  };
  const latestLocations = latestByStudent(db.locations);
  const latestSubmissions = latestByStudent(db.submissions);
  const studentProgress = db.progress.reduce((acc, item) => {
    if (!acc[item.studentId]) acc[item.studentId] = [];
    acc[item.studentId].push(item);
    return acc;
  }, {});

  return {
    participants: db.students
      .filter(student => rebusIds.has(student.rebusId))
      .map(student => {
        const progress = studentProgress[student.id] || [];
        return {
          ...publicStudent(student),
          completedCount: progress.filter(item => item.correct !== false).length,
          score: progress.reduce((sum, item) => sum + (item.pointsAwarded || 0), 0),
          latestLocation: latestLocations.get(student.id) || null,
          latestProgress: progress[progress.length - 1] || null,
          latestSubmission: latestSubmissions.get(student.id) || null
        };
      }),
    submissions: db.submissions.filter(submission => rebusIds.has(submission.rebusId)).slice(-100),
    events: db.events.filter(event => rebusIds.has(event.rebusId)).slice(-100)
  };
}

function buildStudentSession(db, session) {
  const student = db.students.find(item => item.id === session.studentId);
  if (!student) return null;
  const rebus = db.rebuses.find(item => item.id === student.rebusId);
  const tasks = db.tasks.filter(task => task.rebusId === student.rebusId).sort((a, b) => a.order - b.order);
  const progress = db.progress.filter(item => item.studentId === student.id);
  const submissions = db.submissions.filter(item => item.studentId === student.id);
  return {
    token: session.token,
    student: publicStudent(student),
    rebus,
    tasks: tasks.map(task => ({ ...task, answer: undefined })),
    progress,
    submissions
  };
}

function normalizeLocation(location) {
  if (!location) return null;
  const lat = Number(location.lat);
  const lng = Number(location.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    label: location.label || ''
  };
}

function createInviteCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function publicStudentWithPassword(student) {
  return {
    ...publicStudent(student),
    password: student.password || ''
  };
}

function createEvent(type, rebusId, message, details = {}) {
  return {
    id: createId('event'),
    type,
    rebusId,
    message,
    details,
    createdAt: nowIso()
  };
}

module.exports = {
  ensureTeacherFromGoogleProfile,
  getTeacherByEmail,
  getTeacherById,
  listRebuses,
  getRebusDetails,
  createRebus,
  updateRebus,
  deleteRebus,
  createTask,
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
};
